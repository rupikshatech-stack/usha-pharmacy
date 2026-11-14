import mongoose from 'mongoose';
import { Attribute, Branch, INVOICE_STATUSES, Invoice, SalesReturn, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, branchMatch, bucketPlan, change, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';

/**
 * The Sales Report: every sale of a period, the figures that follow from it, and the five cuts of it people actually
 * ask for (over time, by payment method, by store, by category, by medicine).
 *
 * THE DEFINITIONS (the same ones the overview uses — there is only one set):
 *
 *   Total sales     Σ invoice.total of COMPLETED invoices dated in the period. GST-inclusive: what the customer paid.
 *   Sales returns   Σ returnValue of returns ACCEPTED in the period, scoped to the stores being reported on through
 *                   the invoice each return belongs to. The goods' value, not the refund.
 *   Net sales       Total sales − sales returns.
 *   Discounts       Σ (bill discount + line discounts) on those invoices.
 *   GST             Σ taxTotal, the tax already inside the total — never added on top of it.
 *
 * A cancelled or reversed invoice can be LISTED (it happened, and people need to find it) but contributes nothing to
 * any money figure: every sum is conditional on the invoice being completed. Drafts are never listed at all.
 *
 * Everything is aggregated in MongoDB for one organization, restricted to the stores the person may report on.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');

/** Statuses a sale can be listed under. A draft was never issued, so it is not a document of the period. */
export const SALES_STATUSES = INVOICE_STATUSES.filter((s) => s !== 'draft');
export const SALES_PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Credit'];
export const SALES_SORTABLE = ['date', 'amount', 'invoiceNo', 'customer', 'due'];
const SORT_FIELD = { date: 'invoiceDate', amount: 'total', invoiceNo: 'invoiceNo', customer: 'customer.name', due: 'due' };

/** `true` only for an invoice that is a sale, used to make every money sum conditional. */
const IS_SALE = { $eq: ['$status', 'completed'] };
const whenSale = (expr) => ({ $cond: [IS_SALE, expr, 0] });

/** What the person asked for, narrowed to what the data can answer. */
function filtersFrom(query) {
  return {
    status: query.status || null,
    paymentMode: query.paymentMode || null,
    cashier: query.cashier || null,
    customer: query.customer ? String(query.customer).trim() : null,
    search: query.search ? String(query.search).trim() : null,
  };
}

/** The one $match every part of this report starts from, so no cut of it can answer a different question. */
function salesMatch(orgId, period, branches, f) {
  const match = {
    organizationId: orgId,
    invoiceDate: { $gte: period.start, $lt: period.end },
    status: { $in: f.status ? [f.status] : SALES_STATUSES },
    ...branchMatch(branches),
  };
  if (f.paymentMode) match.paymentType = f.paymentMode;
  if (f.cashier) match.createdBy = oid(f.cashier);
  if (f.customer) {
    const re = new RegExp(escapeRe(f.customer), 'i');
    match.$or = [{ 'customer.name': re }, { 'customer.phone': re }];
  }
  if (f.search) match.invoiceNo = new RegExp(escapeRe(f.search), 'i');
  return match;
}

/** The money and count figures of one period. Sums count only completed invoices; `documents` counts every row. */
const FIGURES = {
  $group: {
    _id: null,
    gross: { $sum: whenSale({ $ifNull: ['$total', 0] }) },
    taxable: { $sum: whenSale({ $ifNull: ['$taxableAmount', 0] }) },
    tax: { $sum: whenSale({ $ifNull: ['$taxTotal', 0] }) },
    discount: { $sum: whenSale({ $add: [{ $ifNull: ['$discount', 0] }, { $ifNull: ['$itemDiscount', 0] }] }) },
    due: { $sum: whenSale({ $ifNull: ['$due', 0] }) },
    units: { $sum: whenSale({ $sum: '$items.quantity' }) },
    invoices: { $sum: { $cond: [IS_SALE, 1, 0] } },
    documents: { $sum: 1 },
  },
};

const readFigures = (r) => ({
  gross: round2(r?.gross),
  taxable: round2(r?.taxable),
  tax: round2(r?.tax),
  discount: round2(r?.discount),
  due: round2(r?.due),
  units: r?.units || 0,
  invoices: r?.invoices || 0,
  documents: r?.documents || 0,
  average: r?.invoices ? round2(r.gross / r.invoices) : 0,
});

/**
 * What customers brought back in a period. A return carries no store of its own, so the store is read from the
 * invoice it belongs to — which is also how the person's store permissions are applied to it.
 */
export async function returnsForPeriod(orgId, period, branches) {
  const [r] = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    ...(branches
      ? [
        { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1 } }] } },
        { $match: { '_inv.branchId': { $in: branches } } },
      ]
      : []),
    { $group: { _id: null, value: { $sum: { $ifNull: ['$returnValue', 0] } }, count: { $sum: 1 } } },
  ]);
  return { value: round2(r?.value), count: r?.count || 0 };
}

/** The headline figures of one period, worked out exactly the same way for the current period and the one before. */
async function periodFigures(orgId, period, branches, f) {
  const [[raw], returned] = await Promise.all([
    Invoice.aggregate([{ $match: salesMatch(orgId, period, branches, f) }, FIGURES]),
    returnsForPeriod(orgId, period, branches),
  ]);
  const figures = readFigures(raw);
  return { ...figures, returns: returned.value, returnCount: returned.count, netSales: round2(figures.gross - returned.value) };
}

/* ------------------------------------------------------------------ the cuts */

/** Sales over time, bucketed to suit the length of the period. A quiet day comes back as a zero, never as a gap. */
const overTime = (plan) => [
  { $group: { _id: plan.truncate('$invoiceDate'), sales: { $sum: whenSale({ $ifNull: ['$total', 0] }) }, invoices: { $sum: { $cond: [IS_SALE, 1, 0] } } } },
];

const groupBy = (key) => [
  { $group: { _id: key, amount: { $sum: whenSale({ $ifNull: ['$total', 0] }) }, invoices: { $sum: { $cond: [IS_SALE, 1, 0] } } } },
  { $sort: { amount: -1 } },
];

/** A share-of-total for a set of rows, so the bars on screen add up to 100%. */
const withShare = (rows) => {
  const total = rows.reduce((n, r) => n + Math.abs(r.amount), 0);
  return rows.map((r) => ({ ...r, share: total ? Math.round((Math.abs(r.amount) / total) * 1000) / 10 : 0 }));
};

/**
 * What sold, by medicine and by category. Only completed invoices are read here: a cancelled bill never moved stock,
 * so counting its lines as "sold" would be wrong. The category lives on the catalogue (an Attribute), not on the
 * invoice line, so it is looked up — a line whose medicine has since been deleted is reported as Uncategorised rather
 * than dropped.
 */
async function byProduct(orgId, period, branches, f, limit = 10) {
  const [out] = await Invoice.aggregate([
    { $match: { ...salesMatch(orgId, period, branches, f), status: 'completed' } },
    { $unwind: '$items' },
    { $lookup: { from: 'medicines', localField: 'items.medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { medicineName: 1, categoryId: 1, manufacturer: 1 } }] } },
    { $set: { _m: { $first: '$_m' } } },
    {
      $facet: {
        medicines: [
          {
            $group: {
              _id: '$items.medicineId',
              name: { $first: { $ifNull: ['$_m.medicineName', '$items.name'] } },
              manufacturer: { $first: { $ifNull: ['$_m.manufacturer', ''] } },
              amount: { $sum: { $ifNull: ['$items.amount', 0] } },
              units: { $sum: { $ifNull: ['$items.quantity', 0] } },
              invoices: { $addToSet: '$_id' },
            },
          },
          { $set: { invoices: { $size: '$invoices' } } },
          { $sort: { amount: -1 } },
          { $limit: limit },
        ],
        categories: [
          { $group: { _id: '$_m.categoryId', amount: { $sum: { $ifNull: ['$items.amount', 0] } }, units: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
          { $sort: { amount: -1 } },
        ],
      },
    },
  ]).allowDiskUse(true);

  const categoryIds = (out?.categories || []).map((c) => c._id).filter(Boolean);
  const names = categoryIds.length
    ? new Map(
      (await Attribute.find({ organizationId: orgId, _id: { $in: categoryIds } }).select('attributeName').lean()).map((a) => [String(a._id), a.attributeName]),
    )
    : new Map();

  return {
    topMedicines: (out?.medicines || []).map((m) => ({
      id: m._id,
      name: m.name,
      manufacturer: m.manufacturer,
      amount: round2(m.amount),
      units: m.units,
      invoices: m.invoices,
    })),
    byCategory: withShare(
      (out?.categories || []).map((c) => ({
        id: c._id || null,
        label: c._id ? names.get(String(c._id)) || 'Unknown category' : 'Uncategorised',
        amount: round2(c.amount),
        units: c.units,
      })),
    ),
  };
}

/* ------------------------------------------------------------------ the table */

const ROW = {
  $project: {
    _id: 0,
    id: '$_id',
    invoiceNo: 1,
    date: '$invoiceDate',
    customerName: { $ifNull: ['$customer.name', 'Walk-in Customer'] },
    customerPhone: { $ifNull: ['$customer.phone', ''] },
    branchId: 1,
    branchName: 1,
    lines: { $size: { $ifNull: ['$items', []] } },
    units: { $sum: '$items.quantity' },
    taxable: { $ifNull: ['$taxableAmount', 0] },
    discount: { $add: [{ $ifNull: ['$discount', 0] }, { $ifNull: ['$itemDiscount', 0] }] },
    tax: { $ifNull: ['$taxTotal', 0] },
    total: { $ifNull: ['$total', 0] },
    paid: { $ifNull: ['$paid', 0] },
    due: { $ifNull: ['$due', 0] },
    status: 1,
    paymentMode: '$paymentType',
    paymentStatus: { $cond: [{ $gt: [{ $ifNull: ['$due', 0] }, 0] }, { $cond: [{ $gt: [{ $ifNull: ['$paid', 0] }, 0] }, 'partially_paid', 'unpaid'] }, 'paid'] },
    isSale: IS_SALE,
    userId: '$createdBy',
  },
};

/** Store and cashier names for the rows on one page — two small queries, after the page has been cut. */
async function decorate(orgId, rows) {
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter(Boolean).map(String))];
  const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean).map(String))];
  const [branches, users] = await Promise.all([
    branchIds.length ? Branch.find({ organizationId: orgId, _id: { $in: branchIds.map(oid) } }).select('name').lean() : [],
    userIds.length ? User.find({ organizationId: orgId, _id: { $in: userIds.map(oid) } }).select('name').lean() : [],
  ]);
  const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  return rows.map((r) => ({
    ...r,
    branchName: branchName.get(String(r.branchId)) || r.branchName || null,
    cashier: r.userId ? userName.get(String(r.userId)) || null : null,
    taxable: round2(r.taxable),
    discount: round2(r.discount),
    tax: round2(r.tax),
    total: round2(r.total),
    paid: round2(r.paid),
    due: round2(r.due),
  }));
}

/** The people who have billed in this period, so the cashier filter offers names rather than a free-text box. */
async function cashierOptions(orgId, period, branches) {
  const ids = (
    await Invoice.distinct('createdBy', {
      organizationId: orgId,
      invoiceDate: { $gte: period.start, $lt: period.end },
      status: { $in: SALES_STATUSES },
      ...branchMatch(branches),
    })
  ).filter(Boolean);
  if (!ids.length) return [];
  const users = await User.find({ organizationId: orgId, _id: { $in: ids } }).select('name').lean();
  return users.map((u) => ({ value: String(u._id), label: u.name })).sort((a, b) => a.label.localeCompare(b.label));
}

/** The one question both the screen and the export ask. */
function prepare(org, user, query) {
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  return { tz, period, branches: reportableBranches(user, query.branchId), filters: filtersFrom(query) };
}

/** The store the report is about, said in words for a file's own header. */
export async function storeLabel(orgId, branchId, branches) {
  if (branchId) return (await Branch.findOne({ organizationId: orgId, _id: oid(branchId) }).select('name').lean())?.name || '—';
  return branches ? 'Your stores' : 'All stores';
}

/* ------------------------------------------------------------------ the report */

/**
 * The Sales Report. One page of invoices, the figures for the WHOLE filtered set, the same figures for the previous
 * period of equal length, and the cuts behind the charts.
 */
export async function getSalesReport(org, user, query = {}) {
  const orgId = org._id;
  const { tz, period, branches, filters } = prepare(org, user, query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = SALES_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;
  const plan = bucketPlan(period, tz);

  const [[facet], current, previous, products, cashiers, stores] = await Promise.all([
    Invoice.aggregate([
      { $match: salesMatch(orgId, period, branches, filters) },
      {
        $facet: {
          rows: [{ $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } }, { $skip: (page - 1) * limit }, { $limit: limit }, ROW],
          total: [{ $count: 'n' }],
          overTime: overTime(plan),
          byPaymentMode: groupBy('$paymentType'),
          byBranch: groupBy('$branchId'),
        },
      },
    ]).allowDiskUse(true),
    periodFigures(orgId, period, branches, filters),
    periodFigures(orgId, period.previous, branches, filters),
    byProduct(orgId, period, branches, filters),
    cashierOptions(orgId, period, branches),
    Branch.find({ organizationId: orgId, ...(branches ? { _id: { $in: branches } } : {}) }).select('name').lean(),
  ]);

  const total = facet?.total?.[0]?.n || 0;
  const bySales = new Map((facet?.overTime || []).map((r) => [plan.keyOf(r._id), r]));
  const storeNames = new Map(stores.map((b) => [String(b._id), b.name]));

  const kpi = (key, label, value, prev, description, format = 'money') => ({ key, label, value, previous: prev, change: change(value, prev), description, format });
  return {
    period: {
      from: period.start.toISOString(),
      to: period.end.toISOString(),
      days: period.days,
      timezone: tz,
      previousFrom: period.previous.start.toISOString(),
      previousTo: period.previous.end.toISOString(),
    },
    filters: { ...filters, branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: {
      statuses: SALES_STATUSES.map((value) => ({ value, label: WORDS(value) })),
      paymentModes: SALES_PAYMENT_MODES.map((value) => ({ value, label: value })),
      cashiers,
      sortBy: SALES_SORTABLE.map((value) => ({ value, label: WORDS(value) })),
    },
    kpis: [
      kpi('totalSales', 'Total sales', current.gross, previous.gross, 'What customers were billed on completed invoices, including GST. Cancelled and reversed invoices are listed but add nothing.'),
      kpi('netSales', 'Net sales', current.netSales, previous.netSales, 'Total sales less the value of everything customers returned in the period.'),
      kpi('invoices', 'Invoices', current.invoices, previous.invoices, 'Completed invoices in the period.', 'number'),
      kpi('averageInvoice', 'Average invoice', current.average, previous.average, 'Total sales divided by the number of completed invoices.'),
      kpi('discounts', 'Total discounts', current.discount, previous.discount, 'Bill-level and line-level discounts given on those invoices.'),
      kpi('gst', 'Total GST', current.tax, previous.tax, 'The GST already inside the invoice totals — it is never added on top.'),
      kpi('salesReturns', 'Sales returns', current.returns, previous.returns, 'The value of goods customers brought back in the period, at what they were sold for.'),
    ],
    totals: { current, previous },
    charts: {
      overTime: {
        bucket: plan.bucket,
        points: plan.keys.map(({ key, at }) => ({ key, at: at.toISOString(), sales: round2(bySales.get(key)?.sales), invoices: bySales.get(key)?.invoices || 0 })),
      },
      byPaymentMode: withShare((facet?.byPaymentMode || []).map((r) => ({ id: r._id || null, label: r._id || 'Not recorded', amount: round2(r.amount), invoices: r.invoices }))),
      byBranch: withShare(
        (facet?.byBranch || []).map((r) => ({
          id: r._id ? String(r._id) : null,
          label: r._id ? storeNames.get(String(r._id)) || 'Unknown store' : 'No store recorded',
          amount: round2(r.amount),
          invoices: r.invoices,
        })),
      ),
      byCategory: products.byCategory,
      topMedicines: products.topMedicines,
    },
    items: await decorate(orgId, facet?.rows || []),
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const COLUMNS = [
  ['Invoice No', (r) => r.invoiceNo],
  ['Date', (r, tz) => localDateTime(r.date, tz)],
  ['Customer', (r) => r.customerName],
  ['Phone', (r) => r.customerPhone],
  ['Store', (r) => r.branchName],
  ['Items', (r) => r.lines],
  ['Units', (r) => r.units],
  ['Taxable (INR)', (r) => r.taxable.toFixed(2)],
  ['Discount (INR)', (r) => r.discount.toFixed(2)],
  ['GST (INR)', (r) => r.tax.toFixed(2)],
  ['Total (INR)', (r) => r.total.toFixed(2)],
  ['Paid (INR)', (r) => r.paid.toFixed(2)],
  ['Outstanding (INR)', (r) => r.due.toFixed(2)],
  ['Invoice status', (r) => r.status],
  ['Payment mode', (r) => r.paymentMode],
  ['Payment status', (r) => WORDS(r.paymentStatus)],
  ['Counts as a sale', (r) => (r.isSale ? 'Yes' : 'No')],
  ['Billed by', (r) => r.cashier],
];

/** The same report as a CSV file: EVERY invoice the filters match, not the page on screen. */
export async function exportSalesReport(org, user, query = {}) {
  const orgId = org._id;
  const { tz, period, branches, filters } = prepare(org, user, query);
  const sortBy = SALES_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const rows = await Invoice.aggregate([
    { $match: salesMatch(orgId, period, branches, filters) },
    { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } },
    { $limit: EXPORT_MAX_ROWS + 1 },
    ROW,
  ]).allowDiskUse(true);

  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} invoices. Choose a shorter period or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = await decorate(orgId, rows);
  const head = exportHeader({
    title: 'Sales Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Invoice status', filters.status ? WORDS(filters.status) : 'Any (except drafts)'],
      ['Payment mode', filters.paymentMode || 'Any'],
      ['Customer', filters.customer || '—'],
      ['Invoice number contains', filters.search || '—'],
    ],
    rows: items.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...items.map((r) => COLUMNS.map(([, read]) => read(r, tz)))]),
    fileName: `usha-sales-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
