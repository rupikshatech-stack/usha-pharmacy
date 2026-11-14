import { Batch, Branch, Invoice, Order, SalesReturn } from '../models/index.js';
import { exportHeader, fileStamp, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, PURCHASE_STATUSES, bucketPlan, change, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';

/**
 * Branch performance comparison.
 *
 * One row per store, with the same figures worked out the same way, so the comparison is a comparison and not a
 * collection of coincidences. Every figure uses the definitions stated once in `analytics.service.js`; nothing here
 * invents a second meaning for "net sales" or "gross profit".
 *
 *   Total sales        Σ invoice.total of completed invoices dated in the period, by the store that made the sale.
 *   Sales returns      Σ returnValue of returns accepted in the period. A return carries no store of its own, so it
 *                      belongs to the store on the invoice it is returned against.
 *   Net sales          Total sales − sales returns.
 *   Return rate        Sales returns ÷ total sales. The figure that says whether a store is selling the right things.
 *   COGS               Units sold × the purchase price of the batch each line came out of, less the cost of units
 *                      that came back and went on the shelf again.
 *   Gross profit       Net sales − COGS, with the margin as a percentage of net sales.
 *   Purchase value     Σ order.grandTotal of orders placed in the period for that store.
 *   Inventory value    Stock on hand NOW at each batch's purchase price. A position, not a period figure — a store
 *                      cannot have had a different amount of stock "during" a date range.
 *
 * Stock moved between stores is never a sale or a purchase, so a transfer appears in none of these figures. A person
 * sees only the stores they are assigned to; an administrator sees them all, including stores with no trade at all,
 * because "this branch sold nothing this month" is exactly the answer somebody is looking for.
 *
 * Each figure is one indexed aggregation per period, and the current and previous periods run the same code — so a
 * store's arrow means the same thing as the headline arrow on the overview.
 */
export const BRANCH_SORTABLE = ['sales', 'netSales', 'profit', 'margin', 'invoices', 'average', 'returnRate', 'purchases', 'stock'];

const branchIn = (branches) => (branches ? { branchId: { $in: branches } } : {});
const keyOf = (id) => (id ? String(id) : 'none');

/* ------------------------------------------------------------------ one period, per store */

/** Sales and invoice counts per store. */
const salesByBranch = (orgId, period, branches) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchIn(branches) } },
    {
      $group: {
        _id: '$branchId',
        sales: { $sum: { $ifNull: ['$total', 0] } },
        invoices: { $sum: 1 },
        units: { $sum: { $sum: '$items.quantity' } },
        discount: { $sum: { $add: [{ $ifNull: ['$discount', 0] }, { $ifNull: ['$itemDiscount', 0] }] } },
        tax: { $sum: { $ifNull: ['$taxTotal', 0] } },
        due: { $sum: { $ifNull: ['$due', 0] } },
      },
    },
  ]);

/** What those units cost, per store, from the batch each line came out of. */
const cogsByBranch = (orgId, period, branches) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchIn(branches) } },
    { $unwind: '$items' },
    { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', as: '_b', pipeline: [{ $project: { purchasePrice: 1 } }] } },
    { $group: { _id: '$branchId', cost: { $sum: { $multiply: [{ $ifNull: ['$items.quantity', 0] }, { $ifNull: [{ $first: '$_b.purchasePrice' }, 0] }] } } } },
  ]).allowDiskUse(true);

/** Returns per store, read through the invoice they belong to — which is also how store permissions reach them. */
const returnsByBranch = (orgId, period, branches) =>
  SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1 } }] } },
    { $set: { _inv: { $first: '$_inv' } } },
    ...(branches ? [{ $match: { '_inv.branchId': { $in: branches } } }] : []),
    { $group: { _id: '$_inv.branchId', value: { $sum: { $ifNull: ['$returnValue', 0] } }, count: { $sum: 1 } } },
  ]).allowDiskUse(true);

/** The cost of returned units that went back on the shelf, per store: they stop being a cost of sale. */
const restockByBranch = (orgId, period, branches) =>
  SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1 } }] } },
    { $set: { _inv: { $first: '$_inv' } } },
    ...(branches ? [{ $match: { '_inv.branchId': { $in: branches } } }] : []),
    { $unwind: '$items' },
    { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', as: '_b', pipeline: [{ $project: { purchasePrice: 1 } }] } },
    { $group: { _id: '$_inv.branchId', cost: { $sum: { $multiply: [{ $ifNull: ['$items.restockedQuantity', 0] }, { $ifNull: [{ $first: '$_b.purchasePrice' }, 0] }] } } } },
  ]).allowDiskUse(true);

/** Purchases per store. */
const purchasesByBranch = (orgId, period, branches) =>
  Order.aggregate([
    { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, orderDate: { $gte: period.start, $lt: period.end }, ...branchIn(branches) } },
    {
      $group: {
        _id: '$branchId',
        purchases: { $sum: { $ifNull: ['$grandTotal', 0] } },
        orders: { $sum: 1 },
        owed: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] } },
      },
    },
  ]);

/** Stock on hand now, per store, at what it cost. Expired stock is reported on its own. */
const stockByBranch = (orgId, branches) =>
  Batch.aggregate([
    { $match: { organizationId: orgId, status: { $ne: 'archived' }, availableQuantity: { $gt: 0 }, ...branchIn(branches) } },
    {
      $group: {
        _id: '$branchId',
        stockValue: { $sum: { $cond: [{ $lte: ['$expiryDate', '$$NOW'] }, 0, { $multiply: ['$availableQuantity', { $ifNull: ['$purchasePrice', 0] }] }] } },
        expiredValue: { $sum: { $cond: [{ $lte: ['$expiryDate', '$$NOW'] }, { $multiply: ['$availableQuantity', { $ifNull: ['$purchasePrice', 0] }] }, 0] } },
        stockUnits: { $sum: '$availableQuantity' },
        batches: { $sum: 1 },
      },
    },
  ]).allowDiskUse(true);

const asMap = (rows) => new Map(rows.map((r) => [keyOf(r._id), r]));

/** Every figure for one period, per store, so the current and previous periods are worked out identically. */
async function periodByBranch(orgId, period, branches) {
  const [sales, cogs, returns, restock, purchases] = await Promise.all([
    salesByBranch(orgId, period, branches),
    cogsByBranch(orgId, period, branches),
    returnsByBranch(orgId, period, branches),
    restockByBranch(orgId, period, branches),
    purchasesByBranch(orgId, period, branches),
  ]);
  return { sales: asMap(sales), cogs: asMap(cogs), returns: asMap(returns), restock: asMap(restock), purchases: asMap(purchases) };
}

/** One store's figures, assembled from the per-period maps. */
function figuresOf(maps, key) {
  const sales = round2(maps.sales.get(key)?.sales);
  const invoices = maps.sales.get(key)?.invoices || 0;
  const returned = round2(maps.returns.get(key)?.value);
  const netSales = round2(sales - returned);
  const cogs = round2((maps.cogs.get(key)?.cost || 0) - (maps.restock.get(key)?.cost || 0));
  const profit = round2(netSales - cogs);
  return {
    sales,
    invoices,
    units: maps.sales.get(key)?.units || 0,
    discount: round2(maps.sales.get(key)?.discount),
    tax: round2(maps.sales.get(key)?.tax),
    receivables: round2(maps.sales.get(key)?.due),
    returns: returned,
    returnCount: maps.returns.get(key)?.count || 0,
    returnRate: sales ? Math.round((returned / sales) * 1000) / 10 : 0,
    netSales,
    cogs,
    profit,
    margin: netSales ? Math.round((profit / netSales) * 1000) / 10 : null,
    average: invoices ? round2(sales / invoices) : 0,
    purchases: round2(maps.purchases.get(key)?.purchases),
    purchaseOrders: maps.purchases.get(key)?.orders || 0,
    supplierOwed: round2(maps.purchases.get(key)?.owed),
  };
}

/* ------------------------------------------------------------------ the report */

const SORT_READ = {
  sales: (r) => r.sales,
  netSales: (r) => r.netSales,
  profit: (r) => r.profit,
  margin: (r) => (r.margin === null ? -Infinity : r.margin),
  invoices: (r) => r.invoices,
  average: (r) => r.average,
  returnRate: (r) => r.returnRate,
  purchases: (r) => r.purchases,
  stock: (r) => r.stockValue,
};

/**
 * Branch analytics: every store the person may report on, side by side, with the same figures and a comparison with
 * the period before.
 *
 * The rows are sorted in Node, deliberately: there are as many rows as the organization has stores — tens, not
 * thousands — and they are assembled from six aggregations, so there is nothing to page and nothing to push down.
 */
export async function getBranchReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(period, tz);
  const sortBy = BRANCH_SORTABLE.includes(query.sortBy) ? query.sortBy : 'sales';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [stores, current, previous, stock, trend] = await Promise.all([
    Branch.find({ organizationId: orgId, ...(branches ? { _id: { $in: branches } } : {}) }).select('name code status isDefault').sort({ name: 1 }).lean(),
    periodByBranch(orgId, period, branches),
    periodByBranch(orgId, period.previous, branches),
    stockByBranch(orgId, branches).then(asMap),
    Invoice.aggregate([
      { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchIn(branches) } },
      { $group: { _id: { bucket: plan.truncate('$invoiceDate'), branchId: '$branchId' }, sales: { $sum: { $ifNull: ['$total', 0] } } } },
    ]).allowDiskUse(true),
  ]);

  // Stores that exist, plus any key that turned up in the data (a sale recorded against no store at all, or against a
  // store that has since been removed — it still happened, and hiding it would make the totals not add up).
  const keys = new Set(stores.map((b) => keyOf(b._id)));
  for (const m of [current.sales, current.returns, current.purchases, stock]) for (const k of m.keys()) keys.add(k);
  const names = new Map(stores.map((b) => [keyOf(b._id), b]));

  let rows = [...keys].map((key) => {
    const store = names.get(key);
    const now = figuresOf(current, key);
    const before = figuresOf(previous, key);
    const s = stock.get(key) || {};
    return {
      id: key === 'none' ? null : key,
      name: store ? store.name : key === 'none' ? 'No store recorded' : 'Store no longer on the list',
      code: store?.code || null,
      isDefault: Boolean(store?.isDefault),
      status: store?.status || null,
      known: Boolean(store),
      ...now,
      stockValue: round2(s.stockValue),
      expiredValue: round2(s.expiredValue),
      stockUnits: s.stockUnits || 0,
      batches: s.batches || 0,
      previous: { sales: before.sales, netSales: before.netSales, profit: before.profit, invoices: before.invoices, average: before.average, purchases: before.purchases },
      change: {
        sales: change(now.sales, before.sales),
        netSales: change(now.netSales, before.netSales),
        profit: change(now.profit, before.profit),
        invoices: change(now.invoices, before.invoices),
      },
    };
  });

  const read = SORT_READ[sortBy];
  rows = rows.sort((a, b) => (read(a) - read(b)) * dir || a.name.localeCompare(b.name));

  // The totals are the sum of the rows, so the table and the headline can never disagree.
  const sum = (k) => round2(rows.reduce((n, r) => n + (r[k] || 0), 0));
  const totals = {
    stores: rows.length,
    sales: sum('sales'),
    returns: sum('returns'),
    netSales: sum('netSales'),
    cogs: sum('cogs'),
    profit: sum('profit'),
    invoices: rows.reduce((n, r) => n + r.invoices, 0),
    purchases: sum('purchases'),
    stockValue: sum('stockValue'),
    receivables: sum('receivables'),
  };
  totals.margin = totals.netSales ? Math.round((totals.profit / totals.netSales) * 1000) / 10 : null;
  totals.average = totals.invoices ? round2(totals.sales / totals.invoices) : 0;
  totals.returnRate = totals.sales ? Math.round((totals.returns / totals.sales) * 1000) / 10 : 0;

  // The trend: one series per store, every bucket filled, so a quiet week in one store is visible beside a busy one.
  const trendBy = new Map();
  for (const r of trend) trendBy.set(`${plan.keyOf(r._id.bucket)}|${keyOf(r._id.branchId)}`, r.sales);
  const series = {
    bucket: plan.bucket,
    stores: rows.map((r) => ({ id: r.id, name: r.name })),
    points: plan.keys.map(({ key, at }) => {
      const point = { key, at: at.toISOString() };
      for (const r of rows) point[r.id || 'none'] = round2(trendBy.get(`${key}|${r.id || 'none'}`));
      return point;
    }),
  };

  const best = (k) => (rows.length ? [...rows].sort((a, b) => (SORT_READ[k](b) || 0) - (SORT_READ[k](a) || 0))[0] : null);
  return {
    period: {
      from: period.start.toISOString(),
      to: period.end.toISOString(),
      days: period.days,
      timezone: tz,
      previousFrom: period.previous.start.toISOString(),
      previousTo: period.previous.end.toISOString(),
    },
    filters: { branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: { sortBy: BRANCH_SORTABLE.map((value) => ({ value, label: value.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()) })) },
    rows,
    totals,
    series,
    leaders: {
      sales: best('sales'),
      profit: best('profit'),
      margin: rows.some((r) => r.margin !== null) ? best('margin') : null,
      average: best('average'),
    },
    notes: {
      scope: branches ? 'You are seeing only the stores you are assigned to.' : 'You are seeing every store in the organization, including any with no trade in this period.',
      transfers: 'Stock moved between your own stores is never a sale or a purchase, so transfers appear in none of these figures.',
      stockHasNoPeriod: 'Inventory value is stock on hand now, at what it cost. It does not follow the date range — a store cannot have held different stock "during" a range.',
      definitions: 'Net sales, gross profit and cost of goods sold use the definitions stated once in the analytics service, which is what the overview and the other reports use.',
    },
  };
}

/* ------------------------------------------------------------------ the export */

const COLUMNS = [
  ['Store', (r) => r.name],
  ['Code', (r) => r.code || ''],
  ['Invoices', (r) => r.invoices],
  ['Total sales (INR)', (r) => r.sales.toFixed(2)],
  ['Sales returns (INR)', (r) => r.returns.toFixed(2)],
  ['Return rate (%)', (r) => r.returnRate.toFixed(1)],
  ['Net sales (INR)', (r) => r.netSales.toFixed(2)],
  ['Cost of goods sold (INR)', (r) => r.cogs.toFixed(2)],
  ['Gross profit (INR)', (r) => r.profit.toFixed(2)],
  ['Gross margin (%)', (r) => (r.margin === null ? '' : r.margin.toFixed(1))],
  ['Average invoice (INR)', (r) => r.average.toFixed(2)],
  ['Units sold', (r) => r.units],
  ['Discounts (INR)', (r) => r.discount.toFixed(2)],
  ['GST on sales (INR)', (r) => r.tax.toFixed(2)],
  ['Purchase value (INR)', (r) => r.purchases.toFixed(2)],
  ['Purchase orders', (r) => r.purchaseOrders],
  ['Outstanding from customers (INR)', (r) => r.receivables.toFixed(2)],
  ['Owed to suppliers (INR)', (r) => r.supplierOwed.toFixed(2)],
  ['Inventory value at cost (INR)', (r) => r.stockValue.toFixed(2)],
  ['Expired stock value (INR)', (r) => r.expiredValue.toFixed(2)],
  ['Sales in previous period (INR)', (r) => r.previous.sales.toFixed(2)],
  ['Change in sales (%)', (r) => (r.change.sales.percent === null ? '' : r.change.sales.percent.toFixed(1))],
];

/** Every store side by side, as CSV, with the organization total as the last line. */
export async function exportBranchReport(org, user, query = {}) {
  const report = await getBranchReport(org, user, query);
  const tz = report.period.timezone;
  const t = report.totals;
  const head = exportHeader({
    title: 'Branch Performance',
    org,
    store: query.branchId ? report.rows[0]?.name || '—' : 'All stores you may report on',
    period: { start: new Date(report.period.from), end: new Date(report.period.to) },
    tz,
    filters: [
      ['Stores compared', String(t.stores)],
      ['Total sales (INR)', t.sales.toFixed(2)],
      ['Net sales (INR)', t.netSales.toFixed(2)],
      ['Gross profit (INR)', t.profit.toFixed(2)],
      ['Gross margin (%)', t.margin === null ? '' : String(t.margin)],
      ['Inventory value at cost (INR)', t.stockValue.toFixed(2)],
      ['Note', 'Inventory value is a position at the time of export; every other figure is for the period above. Transfers between stores are not sales or purchases.'],
    ],
    rows: report.rows.length,
  });
  const body = report.rows.map((r) => COLUMNS.map(([, read]) => read(r)));
  const totalRow = [
    'All stores',
    '',
    t.invoices,
    t.sales.toFixed(2),
    t.returns.toFixed(2),
    t.returnRate.toFixed(1),
    t.netSales.toFixed(2),
    t.cogs.toFixed(2),
    t.profit.toFixed(2),
    t.margin === null ? '' : t.margin.toFixed(1),
    t.average.toFixed(2),
    '',
    '',
    '',
    t.purchases.toFixed(2),
    '',
    t.receivables.toFixed(2),
    '',
    t.stockValue.toFixed(2),
    '',
    '',
    '',
  ];
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...body, totalRow]),
    fileName: `usha-branches-${fileStamp(tz)}.csv`,
    rows: report.rows.length,
  };
}
