import mongoose from 'mongoose';
import { Branch, GoodsReceiptReversal, ORDER_STATUSES, Order, PAYMENT_METHODS, PAYMENT_STATUSES, Supplier } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { PURCHASE_STATUSES, branchMatch, bucketPlan, change, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';

/**
 * The Purchase Report: what was ordered from suppliers in a period, what is still owed on it, and the cuts of it a
 * buyer asks for (over time, by supplier, by category, by store).
 *
 * THE DEFINITIONS:
 *
 *   Purchase value    Σ order.grandTotal of orders PLACED in the period — pending, approved, ordered, partially
 *                     received or received. A draft is not a purchase (nothing was ordered) and a cancelled order is
 *                     not one either; both may be listed, but neither adds to a money figure.
 *   Purchase orders   How many such orders were placed.
 *   Suppliers         How many distinct suppliers were bought from in the period.
 *   Purchase returns  Reversed goods receipts: stock taken back out because the delivery was wrong, valued at the
 *                     unit cost on the order line the units came from (line total ÷ line quantity, so that line's
 *                     discount and GST are included). Units a store REFUSED at the door are recorded on the goods
 *                     receipt itself, not as a separate document, so they are not counted here.
 *   Supplier owed     Σ payment.remaining on those orders, except where payment is already marked paid. It records
 *                     what was agreed, not a bank balance.
 *
 * Orders are dated by `orderDate`, in the organization's own timezone. Transfers between this organization's own
 * stores are never purchases and appear nowhere in this report.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDS = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');

/** Statuses a purchase can be listed under. A draft was never placed, so it is not a document of the period. */
export const PURCHASE_LISTED_STATUSES = ORDER_STATUSES.filter((s) => s !== 'draft');
export const PURCHASE_SORTABLE = ['date', 'amount', 'orderNo', 'supplier', 'due'];
const SORT_FIELD = { date: 'orderDate', amount: 'grandTotal', orderNo: 'orderNo', supplier: 'supplier.name', due: 'payment.remaining' };

/** `true` only for an order that is a purchase actually placed, used to make every money sum conditional. */
const IS_PURCHASE = { $in: ['$status', PURCHASE_STATUSES] };
const whenPurchase = (expr) => ({ $cond: [IS_PURCHASE, expr, 0] });
/** What is still owed on an order: nothing once payment is marked paid. */
const OWED = { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] };
/** The taxable value of an order: the goods, after the discounts given on them, before GST. */
const TAXABLE = { $subtract: [{ $ifNull: ['$subtotal', 0] }, { $ifNull: ['$discountTotal', 0] }] };
const GST = { $add: [{ $ifNull: ['$gstTotal', 0] }, { $ifNull: ['$charges.gstAmount', 0] }] };

function filtersFrom(query) {
  return {
    status: query.status || null,
    paymentStatus: query.paymentStatus || null,
    supplierId: query.supplierId || null,
    search: query.search ? String(query.search).trim() : null,
  };
}

/** The one $match every part of this report starts from. */
function purchaseMatch(orgId, period, branches, f) {
  const match = {
    organizationId: orgId,
    orderDate: { $gte: period.start, $lt: period.end },
    status: { $in: f.status ? [f.status] : PURCHASE_LISTED_STATUSES },
    ...branchMatch(branches),
  };
  if (f.paymentStatus) match['payment.status'] = f.paymentStatus;
  if (f.supplierId) match['supplier.supplierId'] = oid(f.supplierId);
  if (f.search) {
    const re = new RegExp(escapeRe(f.search), 'i');
    match.$or = [{ orderNo: re }, { referenceNo: re }, { 'supplier.name': re }];
  }
  return match;
}

const FIGURES = {
  $group: {
    _id: null,
    value: { $sum: whenPurchase({ $ifNull: ['$grandTotal', 0] }) },
    taxable: { $sum: whenPurchase(TAXABLE) },
    tax: { $sum: whenPurchase(GST) },
    discount: { $sum: whenPurchase({ $add: [{ $ifNull: ['$discountTotal', 0] }, { $ifNull: ['$charges.additionalDiscount', 0] }] }) },
    owed: { $sum: whenPurchase(OWED) },
    units: { $sum: whenPurchase({ $add: [{ $ifNull: ['$totalQuantity', 0] }, { $ifNull: ['$totalFreeQuantity', 0] }] }) },
    orders: { $sum: { $cond: [IS_PURCHASE, 1, 0] } },
    documents: { $sum: 1 },
    suppliers: { $addToSet: { $cond: [IS_PURCHASE, { $ifNull: ['$supplier.supplierId', '$supplier.name'] }, '$$REMOVE'] } },
  },
};

const readFigures = (r) => ({
  value: round2(r?.value),
  taxable: round2(r?.taxable),
  tax: round2(r?.tax),
  discount: round2(r?.discount),
  owed: round2(r?.owed),
  units: r?.units || 0,
  orders: r?.orders || 0,
  documents: r?.documents || 0,
  suppliers: (r?.suppliers || []).length,
  average: r?.orders ? round2(r.value / r.orders) : 0,
});

/**
 * The value of the units a reversal took back out, read off the purchase order they were ordered on: for each
 * reversed line, the units removed × (that order line's total ÷ its quantity). The order line's total already
 * includes its discount and GST, so this is what the organization was actually charged for those units — the only
 * cost the system ever recorded for them.
 *
 * `orderItems` is the aggregation path to the order's items (the reversal itself stores no prices), so the Daily
 * Transaction Report and this report value a reversal identically rather than each guessing.
 */
export const reversalAmount = (orderItems = '$_ord.items') => ({
  $round: [
    {
      $reduce: {
        input: { $ifNull: ['$lines', []] },
        initialValue: 0,
        in: {
          $add: [
            '$$value',
            {
              $let: {
                vars: { item: { $first: { $filter: { input: { $ifNull: [orderItems, []] }, as: 'it', cond: { $eq: ['$$it.medicineId', '$$this.medicineId'] } } } } },
                in: {
                  $multiply: [
                    { $ifNull: ['$$this.paid', { $ifNull: ['$$this.quantity', 0] }] },
                    { $cond: [{ $gt: [{ $ifNull: ['$$item.quantity', 0] }, 0] }, { $divide: [{ $ifNull: ['$$item.total', 0] }, '$$item.quantity'] }, 0] },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    2,
  ],
});

/** Stock taken back out of a period's deliveries, and what it was charged at. */
export async function purchaseReturnsIn(orgId, period, branches, supplierId = null) {
  const [r] = await GoodsReceiptReversal.aggregate([
    { $match: { organizationId: orgId, reversedAt: { $gte: period.start, $lt: period.end } } },
    {
      $lookup: {
        from: 'orders',
        localField: 'orderId',
        foreignField: '_id',
        as: '_ord',
        pipeline: [{ $project: { branchId: 1, 'supplier.supplierId': 1, 'supplier.name': 1, 'items.medicineId': 1, 'items.quantity': 1, 'items.total': 1 } }],
      },
    },
    { $set: { _ord: { $first: '$_ord' } } },
    ...(branches ? [{ $match: { '_ord.branchId': { $in: branches } } }] : []),
    ...(supplierId ? [{ $match: { '_ord.supplier.supplierId': oid(supplierId) } }] : []),
    { $group: { _id: null, value: { $sum: reversalAmount() }, count: { $sum: 1 }, units: { $sum: { $ifNull: ['$totalRemoved', 0] } } } },
  ]);
  return { value: round2(r?.value), count: r?.count || 0, units: r?.units || 0 };
}

/** The headline figures of one period, worked out the same way for the current period and the one before. */
async function periodFigures(orgId, period, branches, f) {
  const [[raw], returned] = await Promise.all([
    Order.aggregate([{ $match: purchaseMatch(orgId, period, branches, f) }, FIGURES]),
    purchaseReturnsIn(orgId, period, branches, f.supplierId),
  ]);
  const figures = readFigures(raw);
  return { ...figures, returns: returned.value, returnCount: returned.count, netPurchases: round2(figures.value - returned.value) };
}

/* ------------------------------------------------------------------ the cuts */

const overTime = (plan) => [
  { $group: { _id: plan.truncate('$orderDate'), purchases: { $sum: whenPurchase({ $ifNull: ['$grandTotal', 0] }) }, orders: { $sum: { $cond: [IS_PURCHASE, 1, 0] } } } },
];

const groupBy = (key, extra = {}) => [
  { $group: { _id: key, amount: { $sum: whenPurchase({ $ifNull: ['$grandTotal', 0] }) }, orders: { $sum: { $cond: [IS_PURCHASE, 1, 0] } }, ...extra } },
  { $sort: { amount: -1 } },
];

const withShare = (rows) => {
  const total = rows.reduce((n, r) => n + Math.abs(r.amount), 0);
  return rows.map((r) => ({ ...r, share: total ? Math.round((Math.abs(r.amount) / total) * 1000) / 10 : 0 }));
};

/**
 * What was bought, by category. The category is the snapshot the order line itself carries (orders record it at the
 * time they are placed), so a report of what was bought cannot change later because the catalogue was re-filed. A
 * line with no category is reported as Uncategorised rather than dropped.
 */
async function byCategory(orgId, period, branches, f, limit = 12) {
  const rows = await Order.aggregate([
    { $match: purchaseMatch(orgId, period, branches, f) },
    { $match: { status: { $in: PURCHASE_STATUSES } } },
    { $unwind: '$items' },
    { $group: { _id: { $ifNull: ['$items.category', ''] }, amount: { $sum: { $ifNull: ['$items.total', 0] } }, units: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
    { $sort: { amount: -1 } },
    { $limit: limit },
  ]).allowDiskUse(true);
  return withShare(rows.map((r) => ({ id: r._id || null, label: r._id || 'Uncategorised', amount: round2(r.amount), units: r.units })));
}

/* ------------------------------------------------------------------ the table */

const ROW = {
  $project: {
    _id: 0,
    id: '$_id',
    orderNo: 1,
    referenceNo: { $ifNull: ['$referenceNo', null] },
    date: '$orderDate',
    expectedDate: 1,
    supplierId: '$supplier.supplierId',
    supplierName: { $ifNull: ['$supplier.name', '—'] },
    supplierPhone: { $ifNull: ['$supplier.phone', ''] },
    branchId: 1,
    lines: { $size: { $ifNull: ['$items', []] } },
    units: { $add: [{ $ifNull: ['$totalQuantity', 0] }, { $ifNull: ['$totalFreeQuantity', 0] }] },
    taxable: TAXABLE,
    discount: { $add: [{ $ifNull: ['$discountTotal', 0] }, { $ifNull: ['$charges.additionalDiscount', 0] }] },
    tax: GST,
    total: { $ifNull: ['$grandTotal', 0] },
    due: OWED,
    status: 1,
    paymentStatus: { $ifNull: ['$payment.status', null] },
    paymentMethod: { $ifNull: ['$payment.method', null] },
    paymentTerms: { $ifNull: ['$payment.terms', null] },
    isPurchase: IS_PURCHASE,
  },
};

/** Store names for the rows on one page — one small query, after the page has been cut. */
async function decorate(orgId, rows) {
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter(Boolean).map(String))];
  const stores = branchIds.length ? await Branch.find({ organizationId: orgId, _id: { $in: branchIds.map(oid) } }).select('name').lean() : [];
  const branchName = new Map(stores.map((b) => [String(b._id), b.name]));
  return rows.map((r) => ({
    ...r,
    branchName: r.branchId ? branchName.get(String(r.branchId)) || null : null,
    taxable: round2(r.taxable),
    discount: round2(r.discount),
    tax: round2(r.tax),
    total: round2(r.total),
    due: round2(r.due),
  }));
}

/** The suppliers bought from in this period, so the filter offers names rather than a free-text box. */
async function supplierOptions(orgId, period, branches) {
  const ids = (
    await Order.distinct('supplier.supplierId', {
      organizationId: orgId,
      orderDate: { $gte: period.start, $lt: period.end },
      status: { $in: PURCHASE_LISTED_STATUSES },
      ...branchMatch(branches),
    })
  ).filter(Boolean);
  if (!ids.length) return [];
  const suppliers = await Supplier.find({ organizationId: orgId, _id: { $in: ids } }).select('name').lean();
  return suppliers.map((s) => ({ value: String(s._id), label: s.name })).sort((a, b) => a.label.localeCompare(b.label));
}

function prepare(org, user, query) {
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  return { tz, period, branches: reportableBranches(user, query.branchId), filters: filtersFrom(query) };
}

/* ------------------------------------------------------------------ the report */

/** The Purchase Report: one page of orders, the figures for the whole filtered set, and the cuts behind the charts. */
export async function getPurchaseReport(org, user, query = {}) {
  const orgId = org._id;
  const { tz, period, branches, filters } = prepare(org, user, query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = PURCHASE_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;
  const plan = bucketPlan(period, tz);

  const [[facet], current, previous, categories, suppliers, stores] = await Promise.all([
    Order.aggregate([
      { $match: purchaseMatch(orgId, period, branches, filters) },
      {
        $facet: {
          rows: [{ $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } }, { $skip: (page - 1) * limit }, { $limit: limit }, ROW],
          total: [{ $count: 'n' }],
          overTime: overTime(plan),
          bySupplier: [
            ...groupBy({ $ifNull: ['$supplier.supplierId', '$supplier.name'] }, { name: { $first: '$supplier.name' }, owed: { $sum: whenPurchase(OWED) } }),
            { $limit: 12 },
          ],
          byBranch: groupBy('$branchId'),
        },
      },
    ]).allowDiskUse(true),
    periodFigures(orgId, period, branches, filters),
    periodFigures(orgId, period.previous, branches, filters),
    byCategory(orgId, period, branches, filters),
    supplierOptions(orgId, period, branches),
    Branch.find({ organizationId: orgId, ...(branches ? { _id: { $in: branches } } : {}) }).select('name').lean(),
  ]);

  const total = facet?.total?.[0]?.n || 0;
  const byBucket = new Map((facet?.overTime || []).map((r) => [plan.keyOf(r._id), r]));
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
      statuses: PURCHASE_LISTED_STATUSES.map((value) => ({ value, label: WORDS(value) })),
      paymentStatuses: PAYMENT_STATUSES.map((value) => ({ value, label: WORDS(value) })),
      paymentMethods: PAYMENT_METHODS.map((value) => ({ value, label: value })),
      suppliers,
      sortBy: PURCHASE_SORTABLE.map((value) => ({ value, label: WORDS(value) })),
    },
    kpis: [
      kpi('totalPurchases', 'Total purchase value', current.value, previous.value, 'What was ordered from suppliers in the period, including GST. Drafts and cancelled orders are listed but add nothing.'),
      kpi('orders', 'Purchase orders', current.orders, previous.orders, 'Orders actually placed with a supplier in the period.', 'number'),
      kpi('suppliers', 'Suppliers bought from', current.suppliers, previous.suppliers, 'Distinct suppliers on those orders.', 'number'),
      kpi('purchaseReturns', 'Purchase returns', current.returns, previous.returns, 'Deliveries reversed in the period, valued at the unit cost on the order line the stock came from.'),
      kpi('supplierOwed', 'Outstanding supplier payments', current.owed, previous.owed, 'What is still recorded as unpaid on those orders. It records what was agreed, not a bank balance.'),
      kpi('averageOrder', 'Average order value', current.average, previous.average, 'Total purchase value divided by the number of orders placed.'),
      kpi('purchaseGst', 'Purchase GST', current.tax, previous.tax, 'The GST on those orders, including GST charged on shipping and other charges.'),
    ],
    totals: { current, previous },
    charts: {
      overTime: {
        bucket: plan.bucket,
        points: plan.keys.map(({ key, at }) => ({ key, at: at.toISOString(), purchases: round2(byBucket.get(key)?.purchases), orders: byBucket.get(key)?.orders || 0 })),
      },
      bySupplier: withShare(
        (facet?.bySupplier || []).map((r) => ({
          id: typeof r._id === 'object' && r._id ? String(r._id) : null,
          label: r.name || (typeof r._id === 'string' ? r._id : 'Unknown supplier'),
          amount: round2(r.amount),
          orders: r.orders,
          owed: round2(r.owed),
        })),
      ),
      byBranch: withShare(
        (facet?.byBranch || []).map((r) => ({
          id: r._id ? String(r._id) : null,
          label: r._id ? storeNames.get(String(r._id)) || 'Unknown store' : 'No store recorded',
          amount: round2(r.amount),
          orders: r.orders,
        })),
      ),
      byCategory: categories,
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
  ['Order No', (r) => r.orderNo],
  ['Supplier reference', (r) => r.referenceNo],
  ['Supplier', (r) => r.supplierName],
  ['Phone', (r) => r.supplierPhone],
  ['Store', (r) => r.branchName],
  ['Order date', (r, tz) => localDateTime(r.date, tz)],
  ['Expected', (r, tz) => (r.expectedDate ? localDateTime(r.expectedDate, tz) : '')],
  ['Items', (r) => r.lines],
  ['Units', (r) => r.units],
  ['Taxable (INR)', (r) => r.taxable.toFixed(2)],
  ['Discount (INR)', (r) => r.discount.toFixed(2)],
  ['GST (INR)', (r) => r.tax.toFixed(2)],
  ['Total (INR)', (r) => r.total.toFixed(2)],
  ['Outstanding (INR)', (r) => r.due.toFixed(2)],
  ['Order status', (r) => WORDS(r.status)],
  ['Payment status', (r) => WORDS(r.paymentStatus)],
  ['Payment method', (r) => r.paymentMethod],
  ['Payment terms', (r) => WORDS(r.paymentTerms)],
  ['Counts as a purchase', (r) => (r.isPurchase ? 'Yes' : 'No')],
];

/** The same report as a CSV file: EVERY order the filters match, not the page on screen. */
export async function exportPurchaseReport(org, user, query = {}) {
  const orgId = org._id;
  const { tz, period, branches, filters } = prepare(org, user, query);
  const sortBy = PURCHASE_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const rows = await Order.aggregate([
    { $match: purchaseMatch(orgId, period, branches, filters) },
    { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } },
    { $limit: EXPORT_MAX_ROWS + 1 },
    ROW,
  ]).allowDiskUse(true);

  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} orders. Choose a shorter period or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = await decorate(orgId, rows);
  const supplierName = filters.supplierId
    ? (await Supplier.findOne({ organizationId: orgId, _id: oid(filters.supplierId) }).select('name').lean())?.name || '—'
    : 'All suppliers';
  const head = exportHeader({
    title: 'Purchase Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Supplier', supplierName],
      ['Order status', filters.status ? WORDS(filters.status) : 'Any (except drafts)'],
      ['Payment status', filters.paymentStatus ? WORDS(filters.paymentStatus) : 'Any'],
      ['Search', filters.search || '—'],
    ],
    rows: items.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...items.map((r) => COLUMNS.map(([, read]) => read(r, tz)))]),
    fileName: `usha-purchases-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
