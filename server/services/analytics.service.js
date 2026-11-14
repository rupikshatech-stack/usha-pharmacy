import mongoose from 'mongoose';
import { Batch, Invoice, Order, SalesReturn } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { dayKey, monthKey, parseLocalDate, startOfDay, startOfMonth } from '../utils/tz.js';
import { orgTimezone } from './organization.service.js';
import { branchScope } from './transferAccess.js';

/**
 * Business analytics. Every figure is aggregated in MongoDB for ONE organization and computed from the records the rest
 * of the system already keeps — there is no reporting copy of anything, so a report can never drift from the ledger.
 *
 * THE DEFINITIONS, once, here, because every screen quotes them:
 *
 *   Gross sales      Σ invoice.total of COMPLETED invoices whose invoiceDate falls in the period. Totals are
 *                    GST-inclusive, which is what the customer paid. Drafts, cancelled and reversed invoices never count.
 *   Sales returns    Σ `returnValue` of returns ACCEPTED in the period (approved, awaiting refund, refunded or
 *                    completed — never pending or rejected). It is the goods' value, not the refund, so a refund that
 *                    has not been paid out yet still reduces what was sold.
 *   Net sales        Gross sales − sales returns.
 *   COGS             Σ (units sold × the purchase price of the BATCH they came out of). The batch is a cost snapshot
 *                    taken when the stock was received, so this is what those exact units cost, not an average. Units
 *                    that came back AND were put back into sellable stock are taken off again at the same batch cost;
 *                    units returned damaged are not, because that stock was consumed and is a real cost of trading.
 *   Gross profit     Net sales − COGS. Note sales are tax-inclusive while batch costs are not, so this is a trading
 *                    margin, not a tax-adjusted one; the GST report is where tax is reconciled.
 *   Purchases        Σ order.grandTotal of orders placed in the period, counting pending → completed. Drafts are not
 *                    purchases (nothing was ordered) and cancelled orders are not either.
 *   Receivables      Σ invoice.due over ALL completed invoices as they stand now. It is a balance, not a period figure,
 *                    so it ignores the date range and says so on screen.
 *
 * Transfers between stores are never sales or purchases: they move stock and are not in any of these figures.
 * Day and month boundaries use the organization's timezone; timestamps are stored in UTC.
 */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
/** Orders that represent a purchase actually placed with a supplier. */
export const PURCHASE_STATUSES = ['pending', 'approved', 'ordered', 'partially_received', 'received'];

/** The change from one period to the next, as a percentage; a rise from nothing is reported as new rather than infinite. */
export const change = (current, previous) => {
  if (!previous) return current ? { percent: null, direction: 'up', isNew: true } : { percent: 0, direction: 'flat', isNew: false };
  const percent = Math.round(((current - previous) / previous) * 1000) / 10;
  return { percent, direction: percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat', isNew: false };
};

/**
 * The period being reported on, and the comparable one immediately before it of exactly the same length, both resolved
 * in the organization's own timezone. `from`/`to` are inclusive calendar days (YYYY-MM-DD).
 */
export function resolvePeriod({ from, to }, tz, now = new Date()) {
  const end = to ? startOfDay(parseLocalDate(to, tz), tz, 1) : startOfDay(now, tz, 1); // exclusive: the day after
  const start = from ? startOfDay(parseLocalDate(from, tz), tz) : startOfMonth(now, tz);
  if (!(start < end)) throw new ApiError(400, 'The start of the period must be before its end.', [{ path: 'from', message: 'Choose a start date before the end date' }], 'BAD_PERIOD');
  const span = end - start;
  return { start, end, previous: { start: new Date(start - span), end: start }, days: Math.round(span / 86400000) };
}

/** The stores a person may report on: all of them for an administrator, otherwise only the ones they are assigned to. */
export function reportableBranches(user, requested) {
  const scope = branchScope(user); // null = unrestricted
  if (requested) {
    if (scope && !scope.includes(String(requested))) throw new ApiError(403, 'You cannot report on that store.', undefined, 'BRANCH_FORBIDDEN');
    return [oid(requested)];
  }
  return scope ? scope.map(oid) : null; // null = every store
}

/** Restricts a pipeline to the stores a person may report on; no restriction at all when they may see every store. */
export const branchMatch = (branches) => (branches ? { branchId: { $in: branches } } : {});

/* ------------------------------------------------------------------ the figures */

/** Gross sales, invoice count and what is still owed, for one period. */
async function salesIn(orgId, { start, end }, branches) {
  const [r] = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: start, $lt: end }, ...branchMatch(branches) } },
    { $group: { _id: null, gross: { $sum: '$total' }, taxable: { $sum: '$taxableAmount' }, tax: { $sum: '$taxTotal' }, discount: { $sum: { $add: ['$discount', { $ifNull: ['$itemDiscount', 0] }] } }, invoices: { $sum: 1 }, due: { $sum: '$due' } } },
  ]);
  return { gross: round2(r?.gross), taxable: round2(r?.taxable), tax: round2(r?.tax), discount: round2(r?.discount), invoices: r?.invoices || 0, due: round2(r?.due) };
}

/**
 * What the units sold in a period cost, from the batch each line came out of. Returns are taken off at the same cost,
 * so goods that came back are not counted as sold.
 */
/** Returns that were accepted: pending ones have not been agreed and rejected ones never happened. */
export const ACCEPTED_RETURNS = ['approved', 'refund_pending', 'refunded', 'completed'];

async function cogsIn(orgId, { start, end }, branches) {
  const [sold] = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: start, $lt: end }, ...branchMatch(branches) } },
    { $unwind: '$items' },
    { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', pipeline: [{ $project: { purchasePrice: 1 } }], as: 'b' } },
    { $group: { _id: null, cost: { $sum: { $multiply: ['$items.quantity', { $ifNull: [{ $first: '$b.purchasePrice' }, 0] }] } }, units: { $sum: '$items.quantity' } } },
  ]);
  const [back] = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: start, $lt: end } } },
    { $unwind: '$items' },
    { $match: { 'items.restock': true } }, // only units that went back on the shelf stop being a cost of sale
    { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', pipeline: [{ $project: { purchasePrice: 1 } }], as: 'b' } },
    { $group: { _id: null, cost: { $sum: { $multiply: [{ $ifNull: ['$items.quantity', 0] }, { $ifNull: [{ $first: '$b.purchasePrice' }, 0] }] } } } },
  ]);
  return { cost: round2((sold?.cost || 0) - (back?.cost || 0)), units: sold?.units || 0 };
}

/** What came back from customers in a period, at what it was sold for. */
async function returnsIn(orgId, { start, end }) {
  const [r] = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: start, $lt: end } } },
    { $group: { _id: null, value: { $sum: { $ifNull: ['$returnValue', 0] } }, count: { $sum: 1 } } },
  ]);
  return { value: round2(r?.value), count: r?.count || 0 };
}

/** What was ordered from suppliers in a period, and what is still owed on it. */
async function purchasesIn(orgId, { start, end }, branches) {
  const [r] = await Order.aggregate([
    { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, orderDate: { $gte: start, $lt: end }, ...branchMatch(branches) } },
    { $group: { _id: null, value: { $sum: '$grandTotal' }, orders: { $sum: 1 }, owed: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] } } } },
  ]);
  return { value: round2(r?.value), orders: r?.orders || 0, owed: round2(r?.owed) };
}

/** Everything still owed by customers, as it stands now — a balance, not a period figure. */
async function receivables(orgId, branches) {
  const [r] = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', due: { $gt: 0 }, ...branchMatch(branches) } },
    { $group: { _id: null, due: { $sum: '$due' }, invoices: { $sum: 1 } } },
  ]);
  return { due: round2(r?.due), invoices: r?.invoices || 0 };
}

/**
 * One period's figures, so the current and the previous one are worked out exactly the same way — and so the
 * Profitability report quotes the same numbers as the overview rather than deriving its own.
 */
export async function figuresFor(orgId, period, branches) {
  const [sales, cogs, returned, purchases] = await Promise.all([
    salesIn(orgId, period, branches),
    cogsIn(orgId, period, branches),
    returnsIn(orgId, period),
    purchasesIn(orgId, period, branches),
  ]);
  const netSales = round2(sales.gross - returned.value);
  return {
    grossSales: sales.gross,
    salesReturns: returned.value,
    returnCount: returned.count,
    netSales,
    cogs: cogs.cost,
    grossProfit: round2(netSales - cogs.cost),
    grossMargin: netSales ? Math.round((((netSales - cogs.cost) / netSales) * 100) * 10) / 10 : 0,
    unitsSold: cogs.units,
    invoices: sales.invoices,
    averageInvoice: sales.invoices ? round2(sales.gross / sales.invoices) : 0,
    taxable: sales.taxable,
    tax: sales.tax,
    discount: sales.discount,
    purchases: purchases.value,
    purchaseOrders: purchases.orders,
    supplierOwed: purchases.owed,
  };
}

/* ------------------------------------------------------------------ the series behind the chart */

const bucketOf = (days) => (days <= 31 ? 'day' : days <= 120 ? 'week' : 'month');

/**
 * How a period is cut up for a chart, and the buckets it contains — shared by every report that draws a trend, so
 * "week" can never mean one thing on the overview and another on the sales report.
 *
 * The length of the period chooses the grain: by day for a month or less, by week up to four months, by month beyond.
 * `keys` is EVERY bucket of the period in order, so a bucket with no trade is returned as a zero rather than left out:
 * a chart then shows a quiet Sunday instead of smoothing over it, and nothing is invented to fill it.
 *
 * A week or a month bucket is identified by the day it STARTS, which may fall before the period does — a period that
 * opens on a Wednesday opens in a part-week whose Monday is outside it. The first bucket is then a partial one, which
 * is the truth; identifying it by the period's own first day instead would leave the database's own bucket key
 * unmatched and quietly drop those days' trade off the chart.
 */
export function bucketPlan(period, tz) {
  const unit = bucketOf(period.days);
  const weekly = unit === 'week';
  /** The same truncation the fill below assumes, for any date field. */
  const truncate = (field) => ({ $dateTrunc: { date: field, unit, timezone: tz, ...(weekly ? { startOfWeek: 'mon' } : {}) } });
  const keyOf = (d) => (unit === 'month' ? monthKey(d, tz) : dayKey(d, tz));

  const keys = [];
  if (unit === 'month') {
    for (let t = startOfMonth(period.start, tz); t < period.end; t = startOfMonth(t, tz, 1)) keys.push({ key: monthKey(t, tz), at: t });
  } else {
    const step = weekly ? 7 : 1;
    // Mondays are counted back from the period's first day so the bucket the database will group into is the bucket
    // the chart has a slot for.
    let first = startOfDay(period.start, tz);
    if (weekly) {
      const dow = (new Date(first).getUTCDay() + 6) % 7; // 0 = Monday, in the organization's own week
      first = startOfDay(first, tz, -dow);
    }
    for (let t = first; t < period.end; t = startOfDay(t, tz, step)) keys.push({ key: keyOf(t), at: t });
  }
  return { bucket: unit, unit, truncate, keyOf, keys };
}

/**
 * Revenue over time for the overview: what was sold and what was bought, bucketed to suit the length of the period.
 * Buckets with no trade come back as zero.
 */
export async function revenueSeries(orgId, period, branches, tz) {
  const plan = bucketPlan(period, tz);

  const [sales, purchases] = await Promise.all([
    Invoice.aggregate([
      { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
      { $group: { _id: plan.truncate('$invoiceDate'), sales: { $sum: '$total' }, invoices: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, orderDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
      { $group: { _id: plan.truncate('$orderDate'), purchases: { $sum: '$grandTotal' } } },
    ]),
  ]);

  const bySales = new Map(sales.map((r) => [plan.keyOf(r._id), r]));
  const byPurchase = new Map(purchases.map((r) => [plan.keyOf(r._id), r]));

  return {
    bucket: plan.bucket,
    points: plan.keys.map(({ key, at }) => ({
      key,
      at: at.toISOString(),
      sales: round2(bySales.get(key)?.sales),
      purchases: round2(byPurchase.get(key)?.purchases),
      invoices: bySales.get(key)?.invoices || 0,
    })),
  };
}

/* ------------------------------------------------------------------ the overview */

/** How the four kinds of transaction compare over the period: how many, how much, and what share of the activity. */
async function transactionMix(orgId, period, branches) {
  const [sales, purchases, returned, purchaseReturns] = await Promise.all([
    salesIn(orgId, period, branches),
    purchasesIn(orgId, period, branches),
    returnsIn(orgId, period),
    mongoose.models.GoodsReceiptReversal
      ? mongoose.models.GoodsReceiptReversal.aggregate([
        { $match: { organizationId: orgId, createdAt: { $gte: period.start, $lt: period.end } } },
        { $group: { _id: null, count: { $sum: 1 } } },
      ])
      : [],
  ]);
  const rows = [
    { key: 'sales', label: 'Sales', count: sales.invoices, amount: sales.gross },
    { key: 'purchases', label: 'Purchases', count: purchases.orders, amount: purchases.value },
    { key: 'salesReturns', label: 'Sales returns', count: returned.count, amount: returned.value },
    { key: 'purchaseReturns', label: 'Purchase returns', count: purchaseReturns[0]?.count || 0, amount: 0 },
  ];
  const total = rows.reduce((n, r) => n + Math.abs(r.amount), 0);
  return rows.map((r) => ({ ...r, share: total ? Math.round((Math.abs(r.amount) / total) * 1000) / 10 : 0 }));
}

/**
 * The analytics overview: the headline figures for the period, the same figures for the period immediately before it,
 * the revenue series behind the chart, and how the transactions break down.
 */
export async function getOverview(org, user, { from, to, branchId } = {}, now = new Date()) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod({ from, to }, tz, now);
  const branches = reportableBranches(user, branchId);

  const [current, previous, series, mix, owed] = await Promise.all([
    figuresFor(orgId, period, branches),
    figuresFor(orgId, period.previous, branches),
    revenueSeries(orgId, period, branches, tz),
    transactionMix(orgId, period, branches),
    receivables(orgId, branches),
  ]);

  const kpi = (key, label, value, prev, description, format = 'money') => ({ key, label, value, previous: prev, change: change(value, prev), description, format });
  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz, previousFrom: period.previous.start.toISOString(), previousTo: period.previous.end.toISOString() },
    kpis: [
      kpi('totalSales', 'Total sales', current.grossSales, previous.grossSales, 'What customers were billed on completed invoices, including GST.'),
      kpi('totalPurchases', 'Total purchases', current.purchases, previous.purchases, 'What was ordered from suppliers. Drafts and cancelled orders are not counted.'),
      kpi('grossProfit', 'Gross profit', current.grossProfit, previous.grossProfit, 'Net sales less what those units cost, taken from the batch each one came out of.'),
      kpi('netSales', 'Net sales', current.netSales, previous.netSales, 'Total sales less everything customers returned in the period.'),
      kpi('transactions', 'Transactions', current.invoices, previous.invoices, 'Completed invoices in the period.', 'number'),
      kpi('averageInvoice', 'Average invoice', current.averageInvoice, previous.averageInvoice, 'Total sales divided by the number of invoices.'),
      kpi('receivables', 'Outstanding receivables', owed.due, null, `What customers still owe across ${owed.invoices} invoice${owed.invoices === 1 ? '' : 's'}. A balance as it stands now, not a figure for the period.`),
      kpi('salesReturns', 'Sales returns', current.salesReturns, previous.salesReturns, 'The value of goods customers brought back in the period.'),
    ],
    totals: { current, previous },
    series,
    transactionMix: mix,
    notes: {
      grossMargin: current.grossMargin,
      netProfit: null,
      netProfitReason: 'Net profit needs operating expenses — rent, salaries, utilities — which this system does not record yet. Gross profit is shown instead.',
    },
  };
}
