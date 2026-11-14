import mongoose from 'mongoose';
import { GoodsReceiptReversal, Order, Supplier } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { PURCHASE_STATUSES, branchMatch, bucketPlan, change, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';
import { purchaseReturnsIn, reversalAmount } from './analyticsPurchases.service.js';

/**
 * Supplier Performance.
 *
 * A supplier is a real record here (unlike a customer), so rows are grouped by `supplier.supplierId`. Orders placed
 * before the Suppliers module existed carry only a name, so those are grouped by the NAME they were placed under and
 * marked `linked: false` — they are still trade and still owed for, and dropping them would understate the figures.
 *
 * THE DEFINITIONS
 *   Purchase value   Σ order.grandTotal of orders PLACED in the period (pending → received). A draft is not a
 *                    purchase and a cancelled order is not one either; neither adds to anything here.
 *   Outstanding      Σ payment.remaining as it stands NOW over all of that supplier's placed orders, except where
 *                    payment is marked paid. A balance, not a period figure — it records what was agreed, not a bank
 *                    statement.
 *   Return value     Reversed goods receipts against that supplier's orders, valued exactly as the Daily Transaction
 *                    Report values them (units removed × the unit cost on the order line).
 *   Return rate      Return value ÷ purchase value in the period. The figure that actually distinguishes a supplier
 *                    who sends the right goods from one who does not.
 *   Lead time        Days from the order date to the first receipt, averaged over the orders in the period that have
 *                    been received. Orders still waiting are excluded rather than counted as fast.
 *
 * HOW IT IS COMPUTED: one aggregation over orders, grouped per supplier once, carrying both all-time and period
 * figures; the summary, the rankings and the paged table are `$facet` branches over those rows. Returns live in a
 * different collection, so they are summed per supplier in a second aggregation and joined to the rows in Node —
 * which is why the table cannot be SORTED by return value, and the sort list says so rather than offering a column
 * that would silently sort by nothing.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const SUPPLIER_SORTABLE = ['value', 'orders', 'owed', 'last', 'name'];
const SORT_FIELD = { value: 'valuePeriod', orders: 'ordersPeriod', owed: 'owed', last: 'lastOrder', name: 'name' };

/** What is still owed on an order: nothing once payment is marked paid. */
const OWED = { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] };
const inPeriod = (period) => ({ $and: [{ $gte: ['$orderDate', period.start] }, { $lt: ['$orderDate', period.end] }] });

/* ------------------------------------------------------------------ the rows */

/** A row per supplier: all-time figures and period figures from the same pass over the orders actually placed. */
function supplierRows(period) {
  const within = inPeriod(period);
  return [
    {
      $group: {
        // Linked suppliers group by id; the rest by the name they were ordered under, which is all those orders have.
        _id: { $ifNull: ['$supplier.supplierId', { $concat: ['name:', { $ifNull: ['$supplier.name', '—'] }] }] },
        // The details as they were on the MOST RECENT order, by order date — not whichever document the group
        // happened to see last, which is not an order and would make the contact on screen arbitrary.
        name: { $top: { output: { $ifNull: ['$supplier.name', '—'] }, sortBy: { orderDate: -1 } } },
        supplierId: { $top: { output: '$supplier.supplierId', sortBy: { orderDate: -1 } } },
        phone: { $top: { output: { $ifNull: ['$supplier.phone', ''] }, sortBy: { orderDate: -1 } } },
        gstin: { $top: { output: { $ifNull: ['$supplier.gstin', ''] }, sortBy: { orderDate: -1 } } },
        ordersAll: { $sum: 1 },
        valueAll: { $sum: { $ifNull: ['$grandTotal', 0] } },
        owed: { $sum: OWED },
        firstOrder: { $min: '$orderDate' },
        lastOrder: { $max: '$orderDate' },
        ordersPeriod: { $sum: { $cond: [within, 1, 0] } },
        valuePeriod: { $sum: { $cond: [within, { $ifNull: ['$grandTotal', 0] }, 0] } },
        taxPeriod: { $sum: { $cond: [within, { $add: [{ $ifNull: ['$gstTotal', 0] }, { $ifNull: ['$charges.gstAmount', 0] }] }, 0] } },
        unitsPeriod: { $sum: { $cond: [within, { $add: [{ $ifNull: ['$totalQuantity', 0] }, { $ifNull: ['$totalFreeQuantity', 0] }] }, 0] } },
        // Lead time: only orders that have actually been received can say how long they took.
        leadDays: {
          $push: {
            $cond: [
              { $and: [within, { $ne: [{ $ifNull: ['$receivedAt', null] }, null] }] },
              { $divide: [{ $subtract: ['$receivedAt', '$orderDate'] }, 86400000] },
              '$$REMOVE',
            ],
          },
        },
      },
    },
    {
      $set: {
        linked: { $ne: [{ $ifNull: ['$supplierId', null] }, null] },
        active: { $gt: ['$ordersPeriod', 0] },
        leadTime: { $cond: [{ $gt: [{ $size: '$leadDays' }, 0] }, { $round: [{ $avg: '$leadDays' }, 1] }, null] },
        receivedOrders: { $size: '$leadDays' },
      },
    },
    { $unset: 'leadDays' },
  ];
}

function filtersFrom(query) {
  return {
    supplierId: query.supplierId || null,
    search: query.search ? String(query.search).trim() : null,
    owing: query.owing === 'true' || query.owing === true,
    activeOnly: query.activeOnly === 'true' || query.activeOnly === true,
  };
}

function tableMatch(f) {
  const match = {};
  if (f.supplierId) match.supplierId = oid(f.supplierId);
  if (f.owing) match.owed = { $gt: 0 };
  if (f.activeOnly) match.active = true;
  if (f.search) {
    const re = new RegExp(escapeRe(f.search), 'i');
    match.$or = [{ name: re }, { phone: re }, { gstin: re }];
  }
  return Object.keys(match).length ? [{ $match: match }] : [];
}

/** Returns per supplier, from the reversal documents, keyed the same way the order rows are keyed. */
async function returnsBySupplier(orgId, period, branches) {
  const rows = await GoodsReceiptReversal.aggregate([
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
    {
      $group: {
        _id: { $ifNull: ['$_ord.supplier.supplierId', { $concat: ['name:', { $ifNull: ['$_ord.supplier.name', '—'] }] }] },
        value: { $sum: reversalAmount() },
        count: { $sum: 1 },
        units: { $sum: { $ifNull: ['$totalRemoved', 0] } },
      },
    },
  ]).allowDiskUse(true);
  return new Map(rows.map((r) => [String(r._id), { value: round2(r.value), count: r.count, units: r.units }]));
}

const readRow = (r, returns) => {
  const back = returns.get(String(r._id)) || { value: 0, count: 0, units: 0 };
  const value = round2(r.valuePeriod);
  return {
    id: r.supplierId ? String(r.supplierId) : null,
    key: String(r._id),
    name: r.name,
    phone: r.phone || null,
    gstin: r.gstin || null,
    linked: Boolean(r.linked),
    orders: r.ordersPeriod || 0,
    value,
    tax: round2(r.taxPeriod),
    units: r.unitsPeriod || 0,
    ordersAll: r.ordersAll || 0,
    valueAll: round2(r.valueAll),
    owed: round2(r.owed),
    returnValue: back.value,
    returnCount: back.count,
    returnRate: value ? Math.round((back.value / value) * 1000) / 10 : 0,
    leadTime: r.leadTime === undefined ? null : r.leadTime,
    receivedOrders: r.receivedOrders || 0,
    firstOrder: r.firstOrder || null,
    lastOrder: r.lastOrder || null,
    active: Boolean(r.active),
  };
};

/* ------------------------------------------------------------------ the report */

/** Supplier Performance: who the stock comes from, what it costs, what comes back and what is still owed. */
export async function getSupplierReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(period, tz);
  const f = filtersFrom(query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = SUPPLIER_SORTABLE.includes(query.sortBy) ? query.sortBy : 'value';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [[facet], returns, totalSuppliers, allReturns, suppliers] = await Promise.all([
    Order.aggregate([
      { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, ...branchMatch(branches) } },
      ...supplierRows(period),
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                suppliers: { $sum: 1 },
                active: { $sum: { $cond: ['$active', 1, 0] } },
                linked: { $sum: { $cond: ['$linked', 1, 0] } },
                value: { $sum: '$valuePeriod' },
                orders: { $sum: '$ordersPeriod' },
                owed: { $sum: '$owed' },
                owing: { $sum: { $cond: [{ $gt: ['$owed', 0] }, 1, 0] } },
              },
            },
          ],
          top: [{ $match: { valuePeriod: { $gt: 0 } } }, { $sort: { valuePeriod: -1 } }, { $limit: 10 }],
          owed: [{ $match: { owed: { $gt: 0 } } }, { $sort: { owed: -1 } }, { $limit: 10 }],
          rows: [...tableMatch(f), { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          total: [...tableMatch(f), { $count: 'n' }],
        },
      },
    ]).allowDiskUse(true),
    returnsBySupplier(orgId, period, branches),
    Supplier.countDocuments({ organizationId: orgId }),
    purchaseReturnsIn(orgId, period, branches, f.supplierId),
    Supplier.find({ organizationId: orgId, isActive: true }).select('name').sort({ name: 1 }).lean(),
  ]);

  // Purchases over time, for the trend beside the rankings.
  const trend = await Order.aggregate([
    {
      $match: {
        organizationId: orgId,
        status: { $in: PURCHASE_STATUSES },
        orderDate: { $gte: period.start, $lt: period.end },
        ...branchMatch(branches),
        ...(f.supplierId ? { 'supplier.supplierId': oid(f.supplierId) } : {}),
      },
    },
    { $group: { _id: plan.truncate('$orderDate'), value: { $sum: { $ifNull: ['$grandTotal', 0] } }, orders: { $sum: 1 } } },
  ]).allowDiskUse(true);
  const byBucket = new Map(trend.map((r) => [plan.keyOf(r._id), r]));

  const s = facet?.summary?.[0] || {};
  const total = facet?.total?.[0]?.n || 0;
  const kpi = (key, label, value, description, format = 'money') => ({ key, label, value, previous: null, change: null, description, format });

  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz },
    filters: { ...f, branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: {
      suppliers: suppliers.map((x) => ({ value: String(x._id), label: x.name })),
      sortBy: SUPPLIER_SORTABLE.map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) })),
    },
    kpis: [
      kpi('totalSuppliers', 'Total suppliers', totalSuppliers, 'Suppliers on the supplier list, whether or not they have been ordered from.', 'number'),
      kpi('activeSuppliers', 'Active suppliers', s.active || 0, 'Suppliers ordered from at least once in this period.', 'number'),
      kpi('purchaseValue', 'Total purchases', round2(s.value), 'What was ordered in the period, including GST. Drafts and cancelled orders are not counted.'),
      kpi('orders', 'Purchase orders', s.orders || 0, 'Orders actually placed in the period.', 'number'),
      kpi('returnValue', 'Purchase return value', allReturns.value, 'Deliveries reversed in the period, valued at the unit cost on the order line the stock came from.'),
      kpi('outstanding', 'Outstanding supplier payments', round2(s.owed), `What is still recorded as unpaid across all placed orders — a balance as it stands now. ${(s.owing || 0).toLocaleString('en-IN')} suppliers are owed something.`),
    ],
    summary: {
      totalSuppliers,
      ordered: s.suppliers || 0,
      active: s.active || 0,
      unlinked: (s.suppliers || 0) - (s.linked || 0),
      value: round2(s.value),
      orders: s.orders || 0,
      owed: round2(s.owed),
      owing: s.owing || 0,
      returns: allReturns,
    },
    charts: {
      topSuppliers: (facet?.top || []).map((r) => readRow(r, returns)),
      mostOwed: (facet?.owed || []).map((r) => readRow(r, returns)),
      trend: {
        bucket: plan.bucket,
        points: plan.keys.map(({ key, at }) => ({ key, at: at.toISOString(), value: round2(byBucket.get(key)?.value), orders: byBucket.get(key)?.orders || 0 })),
      },
    },
    items: (facet?.rows || []).map((r) => readRow(r, returns)),
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    notes: {
      outstanding: 'Outstanding is what the orders themselves record as unpaid, as a balance now. It is not a bank statement and no payment is ever made from this system.',
      returns: 'Return value and return rate are joined on after the page is cut, so the table cannot be sorted by them. Sort by purchase value or outstanding instead.',
      unlinked: (s.suppliers || 0) - (s.linked || 0)
        ? `${(s.suppliers || 0) - (s.linked || 0)} supplier${(s.suppliers || 0) - (s.linked || 0) === 1 ? '' : 's'} on this report exist only as a name on older orders, with no record on the supplier list.`
        : null,
      leadTime: 'Lead time averages only the orders in this period that have been received. An order still on its way is excluded rather than counted as fast.',
    },
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const COLUMNS = [
  ['Supplier', (r) => r.name],
  ['Phone', (r) => r.phone || ''],
  ['GSTIN', (r) => r.gstin || ''],
  ['On supplier list', (r) => (r.linked ? 'Yes' : 'No — name only, from older orders')],
  ['Orders in period', (r) => r.orders],
  ['Purchase value in period (INR)', (r) => r.value.toFixed(2)],
  ['GST in period (INR)', (r) => r.tax.toFixed(2)],
  ['Units in period', (r) => r.units],
  ['Return value in period (INR)', (r) => r.returnValue.toFixed(2)],
  ['Return rate (%)', (r) => r.returnRate.toFixed(1)],
  ['Average lead time (days)', (r) => (r.leadTime === null ? '' : r.leadTime)],
  ['Orders all time', (r) => r.ordersAll],
  ['Purchase value all time (INR)', (r) => r.valueAll.toFixed(2)],
  ['Outstanding now (INR)', (r) => r.owed.toFixed(2)],
  ['First order', (r, tz) => (r.firstOrder ? localDateTime(r.firstOrder, tz) : '')],
  ['Last order', (r, tz) => (r.lastOrder ? localDateTime(r.lastOrder, tz) : '')],
];

/** Every supplier the filters match, as CSV. */
export async function exportSupplierReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const f = filtersFrom(query);
  const sortBy = SUPPLIER_SORTABLE.includes(query.sortBy) ? query.sortBy : 'value';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [rows, returns] = await Promise.all([
    Order.aggregate([
      { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, ...branchMatch(branches) } },
      ...supplierRows(period),
      ...tableMatch(f),
      { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } },
      { $limit: EXPORT_MAX_ROWS + 1 },
    ]).allowDiskUse(true),
    returnsBySupplier(orgId, period, branches),
  ]);

  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} suppliers. Narrow the list and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = rows.map((r) => readRow(r, returns));
  const head = exportHeader({
    title: 'Supplier Performance',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Search', f.search || '—'],
      ['Only suppliers owed money', f.owing ? 'Yes' : 'No'],
      ['Only suppliers ordered from in the period', f.activeOnly ? 'Yes' : 'No'],
      ['Note', 'Purchase values are GST-inclusive. Outstanding is what the orders record as unpaid, as a balance at the time of export.'],
    ],
    rows: items.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...items.map((r) => COLUMNS.map(([, read]) => read(r, tz)))]),
    fileName: `usha-suppliers-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
