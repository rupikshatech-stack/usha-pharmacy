import mongoose from 'mongoose';
import { GoodsReceiptReversal, INVOICE_STATUSES, Invoice, ORDER_STATUSES, Order, REFUND_METHODS, RETURN_STATUSES, SalesReturn, TRANSFER_STATUSES, Transfer, PAYMENT_METHODS, Branch, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, PURCHASE_STATUSES, reportableBranches, resolvePeriod } from './analytics.service.js';
import { reversalAmount } from './analyticsPurchases.service.js';

/**
 * The transaction ledger behind the Daily Transaction Report: every business document of the period in ONE list,
 * read straight from the collections the rest of the system writes. Nothing is copied into a reporting table, so a
 * row here is the document itself and can never drift from it.
 *
 * WHAT A ROW IS, by kind:
 *
 *   sale            an Invoice. Dated by `invoiceDate` (so a back-dated or imported sale lands on the day it happened).
 *                   `amount` is the invoice total, GST included — what the customer was billed.
 *   purchase        an Order placed with a supplier. Dated by `orderDate`; `amount` is `grandTotal`.
 *   salesReturn     a SalesReturn. Dated by `returnDate`; `amount` is the value of the goods that came back
 *                   (`returnValue`), not the refund — a refund that has not been paid out yet is still a return.
 *                   Returns carry no tax breakdown of their own, so taxable/tax/discount are null here; the GST
 *                   report is where return tax is adjusted.
 *   purchaseReturn  a reversed goods receipt (GoodsReceiptReversal) — stock taken back out because the delivery was
 *                   wrong. Dated by `reversedAt`. `amount` is the chargeable units removed valued at the unit cost on
 *                   the purchase-order line they came from (line total ÷ line quantity, so discounts and GST on that
 *                   line are included). Units a store simply REFUSED at the door are recorded on the goods receipt
 *                   itself (rejected / damaged) rather than as a separate return document, so they are not rows here.
 *   transfer        stock moved between this organization's own stores. NEVER trade: `countsAsTrade` is false and the
 *                   money summary ignores it. `amount` is the stock value at what those batches cost, shown so a
 *                   movement can be judged, never as revenue.
 *
 * `countsAsTrade` is what keeps the money honest: only a completed invoice, an order actually placed, an accepted
 * return or a reversal contributes to a total. A draft is never listed at all (nothing was issued); a cancelled or
 * rejected document IS listed — people need to see it happened — but contributes nothing to any total.
 *
 * Isolation and scope: every pipeline starts from `organizationId`, and a person assigned to particular stores sees
 * only those stores' documents. Sales returns and purchase returns carry no store of their own, so theirs is read
 * from the invoice / order they belong to. Day boundaries are the organization's timezone; timestamps are UTC.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The kinds of transaction the report can show, in the order they are offered. */
export const TRANSACTION_TYPES = ['sale', 'purchase', 'salesReturn', 'purchaseReturn', 'transfer'];
export const TRANSACTION_TYPE_LABEL = {
  sale: 'Sale',
  purchase: 'Purchase',
  salesReturn: 'Sales return',
  purchaseReturn: 'Purchase return',
  transfer: 'Stock transfer',
};

/** Statuses a document may be listed under, by kind. A draft is never listed: nothing was issued. */
const LISTED = {
  sale: INVOICE_STATUSES.filter((s) => s !== 'draft'),
  purchase: ORDER_STATUSES.filter((s) => s !== 'draft'),
  salesReturn: [...RETURN_STATUSES],
  purchaseReturn: ['reversed'], // a reversal has no lifecycle: it happened
  transfer: TRANSFER_STATUSES.filter((s) => s !== 'draft'),
};
/** Every status any kind can be filtered by. */
export const LEDGER_STATUSES = [...new Set(Object.values(LISTED).flat())];
/** Every payment or refund method any kind records. */
export const LEDGER_PAYMENT_MODES = [...new Set(['Cash', 'UPI', 'Card', 'Credit', ...PAYMENT_METHODS, ...REFUND_METHODS])];

export const SORTABLE = ['date', 'amount', 'reference', 'type'];

const WORDS = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * The filter vocabulary, published with every page of the report so the dropdowns on screen can only ever offer a
 * value the validator accepts. One source of truth: if a status is added to a model, it appears here by itself.
 */
export const filterOptions = () => ({
  types: TRANSACTION_TYPES.map((value) => ({ value, label: TRANSACTION_TYPE_LABEL[value] })),
  statuses: [...LEDGER_STATUSES].sort().map((value) => ({ value, label: WORDS(value) })),
  paymentModes: LEDGER_PAYMENT_MODES.map((value) => ({ value, label: value })),
  sortBy: SORTABLE.map((value) => ({ value, label: WORDS(value) })),
});

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inBranches = (branches, field = 'branchId') => (branches ? { [field]: { $in: branches } } : {});

/* ------------------------------------------------------------------ one pipeline per kind */

/**
 * Every row has the same shape whatever kind of document it came from, so the list can be sorted, searched, counted
 * and exported once rather than five times. `userId` is resolved to a name after the page is cut.
 */
const sales = (orgId, period, branches, statuses) => ({
  model: Invoice,
  pipeline: [
    { $match: { organizationId: orgId, invoiceDate: { $gte: period.start, $lt: period.end }, status: { $in: statuses }, ...inBranches(branches) } },
    {
      $project: {
        _id: 0,
        type: 'sale',
        id: '$_id',
        reference: '$invoiceNo',
        secondary: null,
        date: '$invoiceDate',
        partyName: { $ifNull: ['$customer.name', 'Walk-in Customer'] },
        partyPhone: { $ifNull: ['$customer.phone', ''] },
        partyKind: 'customer',
        branchId: '$branchId',
        branchName: '$branchName',
        toBranchId: null,
        lines: { $size: { $ifNull: ['$items', []] } },
        units: { $sum: '$items.quantity' },
        taxable: { $ifNull: ['$taxableAmount', 0] },
        discount: { $add: [{ $ifNull: ['$discount', 0] }, { $ifNull: ['$itemDiscount', 0] }] },
        tax: { $ifNull: ['$taxTotal', 0] },
        amount: { $ifNull: ['$total', 0] },
        due: { $ifNull: ['$due', 0] },
        status: '$status',
        paymentMode: '$paymentType',
        paymentStatus: { $cond: [{ $gt: [{ $ifNull: ['$due', 0] }, 0] }, { $cond: [{ $gt: [{ $ifNull: ['$paid', 0] }, 0] }, 'partially_paid', 'unpaid'] }, 'paid'] },
        userId: '$createdBy',
        countsAsTrade: { $eq: ['$status', 'completed'] },
      },
    },
  ],
});

const purchases = (orgId, period, branches, statuses) => ({
  model: Order,
  pipeline: [
    { $match: { organizationId: orgId, orderDate: { $gte: period.start, $lt: period.end }, status: { $in: statuses }, ...inBranches(branches) } },
    {
      $project: {
        _id: 0,
        type: 'purchase',
        id: '$_id',
        reference: '$orderNo',
        secondary: { $ifNull: ['$referenceNo', null] },
        date: '$orderDate',
        partyName: { $ifNull: ['$supplier.name', '—'] },
        partyPhone: { $ifNull: ['$supplier.phone', ''] },
        partyKind: 'supplier',
        branchId: '$branchId',
        branchName: null,
        toBranchId: null,
        lines: { $size: { $ifNull: ['$items', []] } },
        units: { $add: [{ $ifNull: ['$totalQuantity', 0] }, { $ifNull: ['$totalFreeQuantity', 0] }] },
        taxable: { $subtract: [{ $ifNull: ['$subtotal', 0] }, { $ifNull: ['$discountTotal', 0] }] },
        discount: { $add: [{ $ifNull: ['$discountTotal', 0] }, { $ifNull: ['$charges.additionalDiscount', 0] }] },
        tax: { $add: [{ $ifNull: ['$gstTotal', 0] }, { $ifNull: ['$charges.gstAmount', 0] }] },
        amount: { $ifNull: ['$grandTotal', 0] },
        due: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] },
        status: '$status',
        paymentMode: { $ifNull: ['$payment.method', null] },
        paymentStatus: { $ifNull: ['$payment.status', null] },
        userId: '$createdBy',
        countsAsTrade: { $in: ['$status', PURCHASE_STATUSES] },
      },
    },
  ],
});

/** A sales return belongs to the store that made the sale, so its store is read from the invoice. */
const salesReturns = (orgId, period, branches, statuses) => ({
  model: SalesReturn,
  pipeline: [
    { $match: { organizationId: orgId, returnDate: { $gte: period.start, $lt: period.end }, status: { $in: statuses } } },
    { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1, branchName: 1 } }] } },
    { $set: { _inv: { $first: '$_inv' } } },
    ...(branches ? [{ $match: { '_inv.branchId': { $in: branches } } }] : []),
    {
      $project: {
        _id: 0,
        type: 'salesReturn',
        id: '$_id',
        reference: '$returnNo',
        secondary: '$invoiceNo',
        date: '$returnDate',
        partyName: { $ifNull: ['$customer.name', 'Walk-in Customer'] },
        partyPhone: { $ifNull: ['$customer.phone', ''] },
        partyKind: 'customer',
        branchId: '$_inv.branchId',
        branchName: '$_inv.branchName',
        toBranchId: null,
        lines: { $size: { $ifNull: ['$items', []] } },
        units: { $sum: '$items.quantity' },
        taxable: null, // a return carries no tax breakdown of its own
        discount: null,
        tax: null,
        amount: { $ifNull: ['$returnValue', 0] },
        due: { $literal: 0 },
        status: '$status',
        paymentMode: { $ifNull: ['$refund.method', null] },
        paymentStatus: { $ifNull: ['$refund.status', null] },
        userId: '$createdBy',
        countsAsTrade: { $in: ['$status', ACCEPTED_RETURNS] },
      },
    },
  ],
});

/**
 * A reversed goods receipt. Its store and supplier come from the order; its value is the chargeable units removed at
 * the unit cost on the order line they came from — the only cost the system actually recorded for them.
 */
const purchaseReturns = (orgId, period, branches) => ({
  model: GoodsReceiptReversal,
  pipeline: [
    { $match: { organizationId: orgId, reversedAt: { $gte: period.start, $lt: period.end } } },
    { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: '_ord', pipeline: [{ $project: { branchId: 1, 'supplier.name': 1, 'supplier.phone': 1, 'items.medicineId': 1, 'items.quantity': 1, 'items.total': 1 } }] } },
    { $set: { _ord: { $first: '$_ord' } } },
    ...(branches ? [{ $match: { '_ord.branchId': { $in: branches } } }] : []),
    {
      $project: {
        _id: 0,
        type: 'purchaseReturn',
        id: '$_id',
        reference: '$receiptNo',
        secondary: '$orderNo',
        date: '$reversedAt',
        partyName: { $ifNull: ['$_ord.supplier.name', '—'] },
        partyPhone: { $ifNull: ['$_ord.supplier.phone', ''] },
        partyKind: 'supplier',
        branchId: '$_ord.branchId',
        branchName: null,
        toBranchId: null,
        lines: { $size: { $ifNull: ['$lines', []] } },
        units: { $ifNull: ['$totalRemoved', 0] },
        taxable: null,
        discount: null,
        tax: null,
        amount: reversalAmount(),
        due: { $literal: 0 },
        status: 'reversed',
        paymentMode: null,
        paymentStatus: null,
        userId: '$reversedBy',
        countsAsTrade: { $literal: true },
      },
    },
  ],
});

/**
 * Stock moved between this organization's own stores. Never trade — the value shown is what the moved stock cost,
 * so a movement can be judged, and it is excluded from every money total.
 */
const transfers = (orgId, period, branches, statuses) => ({
  model: Transfer,
  pipeline: [
    {
      $match: {
        organizationId: orgId,
        transferDate: { $gte: period.start, $lt: period.end },
        status: { $in: statuses },
        ...(branches ? { $or: [{ fromBranchId: { $in: branches } }, { toBranchId: { $in: branches } }] } : {}),
      },
    },
    { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', as: '_b', pipeline: [{ $project: { purchasePrice: 1 } }] } },
    {
      $project: {
        _id: 0,
        type: 'transfer',
        id: '$_id',
        reference: '$reference',
        secondary: null,
        date: '$transferDate',
        partyName: 'Internal store transfer',
        partyPhone: '',
        partyKind: 'internal',
        branchId: '$fromBranchId',
        branchName: null,
        toBranchId: '$toBranchId',
        lines: { $size: { $ifNull: ['$items', []] } },
        units: { $sum: '$items.quantity' },
        taxable: null,
        discount: null,
        tax: null,
        amount: {
          $round: [
            {
              $reduce: {
                input: { $ifNull: ['$items', []] },
                initialValue: 0,
                in: {
                  $add: [
                    '$$value',
                    {
                      $multiply: [
                        { $ifNull: ['$$this.quantity', 0] },
                        { $ifNull: [{ $first: { $map: { input: { $filter: { input: '$_b', as: 'b', cond: { $eq: ['$$b._id', '$$this.batchId'] } } }, as: 'b', in: { $ifNull: ['$$b.purchasePrice', 0] } } } }, 0] },
                      ],
                    },
                  ],
                },
              },
            },
            2,
          ],
        },
        due: { $literal: 0 },
        status: '$status',
        paymentMode: null,
        paymentStatus: null,
        userId: '$createdBy',
        countsAsTrade: { $literal: false },
      },
    },
  ],
});

/* ------------------------------------------------------------------ the query */

/** The kinds to read, given what was asked for and what each kind can possibly match. */
function sourcesFor(orgId, period, branches, { type, status, paymentMode }) {
  const wanted = type ? [type] : TRANSACTION_TYPES;
  const out = [];
  for (const kind of wanted) {
    const statuses = status ? LISTED[kind].filter((s) => s === status) : LISTED[kind];
    if (!statuses.length) continue; // this kind can never have that status: don't read it at all
    // A payment or refund method is only recorded on sales, purchases and returns.
    if (paymentMode && !['sale', 'purchase', 'salesReturn'].includes(kind)) continue;
    if (kind === 'sale') out.push(sales(orgId, period, branches, statuses));
    if (kind === 'purchase') out.push(purchases(orgId, period, branches, statuses));
    if (kind === 'salesReturn') out.push(salesReturns(orgId, period, branches, statuses));
    if (kind === 'purchaseReturn') out.push(purchaseReturns(orgId, period, branches));
    if (kind === 'transfer') out.push(transfers(orgId, period, branches, statuses));
  }
  return out;
}

/** Filters that can only be applied once every kind looks the same: the search box and the payment method. */
function afterUnion({ search, paymentMode }) {
  const stages = [];
  if (paymentMode) stages.push({ $match: { paymentMode } });
  if (search) {
    const re = new RegExp(escapeRe(search.trim()), 'i');
    stages.push({ $match: { $or: [{ reference: re }, { secondary: re }, { partyName: re }, { partyPhone: re }] } });
  }
  return stages;
}

/** Names for the stores and people on a page of rows — one small query each, after the page has been cut. */
async function decorate(orgId, rows) {
  const branchIds = [...new Set(rows.flatMap((r) => [r.branchId, r.toBranchId]).filter(Boolean).map(String))];
  const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean).map(String))];
  const [branches, users] = await Promise.all([
    branchIds.length ? Branch.find({ organizationId: orgId, _id: { $in: branchIds.map(oid) } }).select('name').lean() : [],
    userIds.length ? User.find({ organizationId: orgId, _id: { $in: userIds.map(oid) } }).select('name').lean() : [],
  ]);
  const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  return rows.map((r) => ({
    ...r,
    typeLabel: TRANSACTION_TYPE_LABEL[r.type],
    branchName: branchName.get(String(r.branchId)) || r.branchName || null,
    toBranchName: r.toBranchId ? branchName.get(String(r.toBranchId)) || null : null,
    who: r.userId ? userName.get(String(r.userId)) || null : null,
    amount: round2(r.amount),
    taxable: r.taxable === null || r.taxable === undefined ? null : round2(r.taxable),
    tax: r.tax === null || r.tax === undefined ? null : round2(r.tax),
    discount: r.discount === null || r.discount === undefined ? null : round2(r.discount),
    due: round2(r.due),
  }));
}

const EMPTY_SUMMARY = () =>
  TRANSACTION_TYPES.map((type) => ({ type, label: TRANSACTION_TYPE_LABEL[type], count: 0, counted: 0, amount: 0, units: 0 }));

/** Runs the union once and returns the page, the per-kind summary and the number of matching documents. */
async function runLedger(orgId, period, branches, filters, { sortBy = 'date', sortDir = 'desc', page = 1, limit = 25, rowsOnly = false, maxRows = 0 } = {}) {
  const sources = sourcesFor(orgId, period, branches, filters);
  if (!sources.length) return { rows: [], summary: EMPTY_SUMMARY(), total: 0 };

  const [first, ...rest] = sources;
  const dir = sortDir === 'asc' ? 1 : -1;
  // A second key, so a page is never ambiguous: documents share a date (a purchase order and a transfer are both
  // dated to the day, so midnight). It follows the chosen direction, which makes the order a total one whose
  // reverse is its exact reverse — otherwise turning the sort around would shuffle the tied rows.
  const sort = { [sortBy]: dir, id: dir };
  const skip = (page - 1) * limit;

  const pipeline = [
    ...first.pipeline,
    ...rest.map((s) => ({ $unionWith: { coll: s.model.collection.name, pipeline: s.pipeline } })),
    ...afterUnion(filters),
    ...(rowsOnly
      ? [{ $sort: sort }, ...(maxRows ? [{ $limit: maxRows }] : [])]
      : [
        {
          $facet: {
            rows: [{ $sort: sort }, { $skip: skip }, { $limit: limit }],
            summary: [
              {
                $group: {
                  _id: '$type',
                  count: { $sum: 1 },
                  counted: { $sum: { $cond: ['$countsAsTrade', 1, 0] } },
                  amount: { $sum: { $cond: ['$countsAsTrade', { $ifNull: ['$amount', 0] }, 0] } },
                  units: { $sum: { $ifNull: ['$units', 0] } },
                },
              },
            ],
            total: [{ $count: 'n' }],
          },
        },
      ]),
  ];

  const out = await first.model.aggregate(pipeline).allowDiskUse(true);
  if (rowsOnly) return { rows: out, summary: EMPTY_SUMMARY(), total: out.length };

  const facet = out[0] || {};
  const byType = new Map((facet.summary || []).map((s) => [s._id, s]));
  return {
    rows: facet.rows || [],
    total: facet.total?.[0]?.n || 0,
    summary: TRANSACTION_TYPES.map((type) => {
      const s = byType.get(type);
      return { type, label: TRANSACTION_TYPE_LABEL[type], count: s?.count || 0, counted: s?.counted || 0, amount: round2(s?.amount), units: s?.units || 0 };
    }),
  };
}

/** Everything the screens and the export share: the period, who may see which store, and the filters as given. */
function prepare(org, user, query) {
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const filters = { type: query.type || null, status: query.status || null, paymentMode: query.paymentMode || null, search: query.search || null };
  return { tz, period, branches, filters };
}

/**
 * A page of the transaction ledger, with the summary for the WHOLE filtered set (not just the page) so the figures on
 * screen describe the question that was asked.
 */
export async function getTransactions(org, user, query = {}) {
  const { tz, period, branches, filters } = prepare(org, user, query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  const { rows, summary, total } = await runLedger(org._id, period, branches, filters, { sortBy, sortDir, page, limit });
  const money = summary.filter((s) => s.type !== 'transfer');
  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz },
    filters: { ...filters, branchId: query.branchId || null, sortBy, sortDir },
    options: filterOptions(),
    summary,
    totals: {
      documents: total,
      // Sales and purchases are opposite directions, so there is no single "total amount" worth printing; these are
      // the two sides, each already net of what came back.
      netSales: round2((money.find((s) => s.type === 'sale')?.amount || 0) - (money.find((s) => s.type === 'salesReturn')?.amount || 0)),
      netPurchases: round2((money.find((s) => s.type === 'purchase')?.amount || 0) - (money.find((s) => s.type === 'purchaseReturn')?.amount || 0)),
    },
    items: await decorate(org._id, rows),
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
  };
}

/** The most rows one export may carry. Beyond this the period is too wide to be a document; narrow it instead. */
export const EXPORT_MAX_ROWS = 20000;

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@\t\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');
const dayOf = (d, tz) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

const EXPORT_COLUMNS = [
  ['Type', (r) => r.typeLabel],
  ['Reference', (r) => r.reference],
  ['Related reference', (r) => r.secondary],
  ['Date', (r, tz) => dayOf(r.date, tz)],
  ['Party', (r) => r.partyName],
  ['Phone', (r) => r.partyPhone],
  ['Store', (r) => (r.toBranchName ? `${r.branchName || '—'} → ${r.toBranchName}` : r.branchName)],
  ['Lines', (r) => r.lines],
  ['Units', (r) => r.units],
  ['Taxable (INR)', (r) => (r.taxable === null ? '' : r.taxable.toFixed(2))],
  ['Discount (INR)', (r) => (r.discount === null ? '' : r.discount.toFixed(2))],
  ['GST (INR)', (r) => (r.tax === null ? '' : r.tax.toFixed(2))],
  ['Amount (INR)', (r) => r.amount.toFixed(2)],
  ['Outstanding (INR)', (r) => r.due.toFixed(2)],
  ['Status', (r) => r.status],
  ['Payment mode', (r) => r.paymentMode],
  ['Payment status', (r) => r.paymentStatus],
  ['Counts as trade', (r) => (r.countsAsTrade ? 'Yes' : 'No')],
  ['Recorded by', (r) => r.who],
];

/**
 * The same ledger as a CSV file: EVERY row the filters match, not the page on screen. The file opens with the
 * organization, the store, the period and the filters, so a printed copy says what it is a report of.
 */
export async function exportTransactions(org, user, query = {}) {
  const { tz, period, branches, filters } = prepare(org, user, query);
  const sortBy = SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  const { rows } = await runLedger(org._id, period, branches, filters, { sortBy, sortDir, rowsOnly: true, maxRows: EXPORT_MAX_ROWS + 1 });
  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} transactions. Choose a shorter period or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = await decorate(org._id, rows);
  const store = query.branchId ? (await Branch.findOne({ organizationId: org._id, _id: oid(query.branchId) }).select('name').lean())?.name || '—' : branches ? 'Your stores' : 'All stores';

  const head = [
    ['Usha Pharmacy — Daily Transaction Report'],
    ['Organization', org.name || ''],
    ['Store', store],
    ['Period', `${dayOf(period.start, tz)} to ${dayOf(new Date(period.end.getTime() - 1), tz)}`],
    ['Timezone', tz],
    ['Transaction type', filters.type ? TRANSACTION_TYPE_LABEL[filters.type] : 'All types'],
    ['Status', filters.status || 'Any'],
    ['Payment mode', filters.paymentMode || 'Any'],
    ['Search', filters.search || '—'],
    ['Generated', dayOf(new Date(), tz)],
    ['Transactions', String(items.length)],
    [],
    EXPORT_COLUMNS.map(([h]) => h),
  ];
  const body = items.map((r) => EXPORT_COLUMNS.map(([, read]) => read(r, tz)));
  const csv = [...head, ...body].map(csvRow).join('\r\n');
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date()).replace(/\//g, '-');
  return { csv, fileName: `usha-transactions-${stamp}.csv`, rows: items.length };
}
