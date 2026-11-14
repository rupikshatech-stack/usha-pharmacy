import { Attribute, Branch, Invoice, SalesReturn } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, branchMatch, bucketPlan, change, figuresFor, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';

/**
 * The Profitability report. What the business actually MADE on what it sold — not what it took in.
 *
 * THE FORMULAS, in full, because a margin that nobody can reproduce is worse than no margin at all:
 *
 *   Gross sales    Σ invoice.total of COMPLETED invoices dated in the period. GST-inclusive.
 *   Sales returns  Σ returnValue of returns ACCEPTED in the period.
 *   Net sales      Gross sales − sales returns.
 *   COGS           Σ (units sold × the purchasePrice of the BATCH the line came out of) − Σ (units that came back
 *                  AND went back on the shelf × the same batch cost). The batch price is a cost snapshot taken when
 *                  the stock was received, so this is what those exact units cost — not an average, and not today's
 *                  price. Units returned damaged are NOT credited back: that stock was consumed and is a real cost
 *                  of trading.
 *   Gross profit   Net sales − COGS.
 *   Gross margin   Gross profit ÷ net sales, as a percentage. Zero net sales has no margin, and is reported as null
 *                  rather than as 0%.
 *   Net profit     NOT REPORTED. It needs operating expenses — rent, salaries, electricity, transport — and this
 *                  system records none of them. `netProfit` is null and `netProfitReason` says why. Subtracting
 *                  purchases from sales would NOT be net profit: stock bought and not yet sold is an asset, not an
 *                  expense, so that figure would swing wildly with the buying cycle and mean nothing.
 *
 * ONE WARNING ABOUT THE MARGIN, stated on screen too: sales are tax-inclusive while batch costs are not, so this is
 * a TRADING margin, not a tax-adjusted one. The GST report is where tax is reconciled.
 *
 * TWO LEVELS OF FIGURE, deliberately:
 *   • The headline figures come from `figuresFor` in analytics.service.js — the very same function the overview
 *     uses — so the two screens can never disagree.
 *   • The cuts by category and by medicine can only be computed from invoice LINES, because that is the only place a
 *     medicine appears. Line values sum to the invoice totals apart from per-invoice rounding (`roundOff`), which is
 *     at most a rupee an invoice; the response says so in `notes.lineLevel`.
 *
 * A medicine whose batch recorded no purchase price has an unknowable margin. It is still listed, with `costKnown`
 * false, but it is kept out of the best/worst-margin rankings — otherwise free stock would top the table at 100%.
 */

/** A margin as a percentage, or null when there is nothing to take a margin of. */
const marginOf = (profit, revenue) => (revenue ? Math.round((profit / revenue) * 1000) / 10 : null);

/** The cost of one invoice line, from the batch it came out of. */
const LINE_COST = { $multiply: [{ $ifNull: ['$items.quantity', 0] }, { $ifNull: [{ $first: '$_b.purchasePrice' }, 0] }] };
/** The cost of the units a return put BACK on the shelf — the only ones that stop being a cost of sale. */
const RESTOCK_COST = { $multiply: [{ $ifNull: ['$items.restockedQuantity', 0] }, { $ifNull: [{ $first: '$_b.purchasePrice' }, 0] }] };

const batchLookup = { $lookup: { from: 'batches', localField: 'items.batchId', foreignField: '_id', as: '_b', pipeline: [{ $project: { purchasePrice: 1 } }] } };
const medicineLookup = {
  $lookup: { from: 'medicines', localField: 'items.medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { medicineName: 1, categoryId: 1, manufacturer: 1 } }] },
};

/* ------------------------------------------------------------------ the four aggregations */

/** Invoice-level: what was billed, per bucket and per store. */
const invoiceTotals = (orgId, period, branches, plan) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
    {
      $facet: {
        byBucket: [{ $group: { _id: plan.truncate('$invoiceDate'), gross: { $sum: '$total' }, invoices: { $sum: 1 } } }],
        byBranch: [{ $group: { _id: '$branchId', gross: { $sum: '$total' }, invoices: { $sum: 1 } } }],
      },
    },
  ]).allowDiskUse(true);

/** Line-level: what those units cost, and what each category and medicine brought in. */
const invoiceLines = (orgId, period, branches, plan) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
    { $unwind: '$items' },
    batchLookup,
    medicineLookup,
    { $set: { _rev: { $ifNull: ['$items.amount', 0] }, _cost: LINE_COST, _m: { $first: '$_m' } } },
    {
      $facet: {
        byBucket: [{ $group: { _id: plan.truncate('$invoiceDate'), cost: { $sum: '$_cost' } } }],
        byBranch: [{ $group: { _id: '$branchId', cost: { $sum: '$_cost' } } }],
        byCategory: [{ $group: { _id: '$_m.categoryId', revenue: { $sum: '$_rev' }, cost: { $sum: '$_cost' }, units: { $sum: '$items.quantity' } } }],
        byMedicine: [
          {
            $group: {
              _id: '$items.medicineId',
              name: { $first: { $ifNull: ['$_m.medicineName', '$items.name'] } },
              manufacturer: { $first: { $ifNull: ['$_m.manufacturer', ''] } },
              revenue: { $sum: '$_rev' },
              cost: { $sum: '$_cost' },
              units: { $sum: '$items.quantity' },
              invoices: { $addToSet: '$_id' },
            },
          },
          { $set: { invoices: { $size: '$invoices' } } },
        ],
      },
    },
  ]).allowDiskUse(true);

/** The invoice a return belongs to carries its store, which is also how store permissions reach returns. */
const returnScope = (branches) => [
  { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1 } }] } },
  { $set: { _inv: { $first: '$_inv' } } },
  ...(branches ? [{ $match: { '_inv.branchId': { $in: branches } } }] : []),
];

/** Return-level: what came back, per bucket and per store. */
const returnTotals = (orgId, period, branches, plan) =>
  SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    ...returnScope(branches),
    {
      $facet: {
        byBucket: [{ $group: { _id: plan.truncate('$returnDate'), value: { $sum: { $ifNull: ['$returnValue', 0] } }, count: { $sum: 1 } } }],
        byBranch: [{ $group: { _id: '$_inv.branchId', value: { $sum: { $ifNull: ['$returnValue', 0] } }, count: { $sum: 1 } } }],
      },
    },
  ]).allowDiskUse(true);

/** Return lines: the refund value per category and medicine, and the cost of whatever went back on the shelf. */
const returnLines = (orgId, period, branches, plan) =>
  SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    ...returnScope(branches),
    { $unwind: '$items' },
    batchLookup,
    medicineLookup,
    { $set: { _val: { $ifNull: ['$items.amount', 0] }, _cost: RESTOCK_COST, _m: { $first: '$_m' } } },
    {
      $facet: {
        byBucket: [{ $group: { _id: plan.truncate('$returnDate'), cost: { $sum: '$_cost' } } }],
        byBranch: [{ $group: { _id: '$_inv.branchId', cost: { $sum: '$_cost' } } }],
        byCategory: [{ $group: { _id: '$_m.categoryId', value: { $sum: '$_val' }, cost: { $sum: '$_cost' }, units: { $sum: '$items.quantity' } } }],
        byMedicine: [{ $group: { _id: '$items.medicineId', value: { $sum: '$_val' }, cost: { $sum: '$_cost' }, units: { $sum: '$items.quantity' } } }],
      },
    },
  ]).allowDiskUse(true);

/* ------------------------------------------------------------------ putting the two sides together */

const keyed = (rows, read = (r) => String(r._id)) => new Map((rows || []).map((r) => [read(r), r]));

/** One row of a cut: what it sold, what came back, what it cost, and what that leaves. */
function profitRow(label, id, sold = {}, back = {}, extra = {}) {
  const revenue = round2((sold.revenue || sold.gross || 0) - (back.value || 0));
  const cost = round2((sold.cost || 0) - (back.cost || 0));
  const profit = round2(revenue - cost);
  return {
    id: id === undefined ? null : id,
    label,
    revenue,
    cost,
    profit,
    margin: marginOf(profit, revenue),
    costKnown: cost > 0,
    units: Math.max(0, (sold.units || 0) - (back.units || 0)),
    ...extra,
  };
}

/* ------------------------------------------------------------------ the report */

/**
 * The Profitability report: the headline figures (identical to the overview's), the profit trend, and profit split by
 * store, by category and by medicine — with the best and worst margins called out.
 */
export async function getProfitabilityReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(period, tz);

  const [current, previous, [sold], [soldLines], [back], [backLines], stores] = await Promise.all([
    figuresFor(orgId, period, branches),
    figuresFor(orgId, period.previous, branches),
    invoiceTotals(orgId, period, branches, plan),
    invoiceLines(orgId, period, branches, plan),
    returnTotals(orgId, period, branches, plan),
    returnLines(orgId, period, branches, plan),
    Branch.find({ organizationId: orgId, ...(branches ? { _id: { $in: branches } } : {}) }).select('name').lean(),
  ]);

  // The trend: net sales at invoice level (so it adds up to the headline figure) against cost at line level.
  const soldBucket = keyed(sold?.byBucket, (r) => plan.keyOf(r._id));
  const costBucket = keyed(soldLines?.byBucket, (r) => plan.keyOf(r._id));
  const backBucket = keyed(back?.byBucket, (r) => plan.keyOf(r._id));
  const backCostBucket = keyed(backLines?.byBucket, (r) => plan.keyOf(r._id));
  const trend = plan.keys.map(({ key, at }) => {
    const netSales = round2((soldBucket.get(key)?.gross || 0) - (backBucket.get(key)?.value || 0));
    const cogs = round2((costBucket.get(key)?.cost || 0) - (backCostBucket.get(key)?.cost || 0));
    const profit = round2(netSales - cogs);
    return { key, at: at.toISOString(), netSales, cogs, grossProfit: profit, margin: marginOf(profit, netSales) };
  });

  // By store: both sides are known per store, so this cut is as exact as the headline.
  const storeNames = new Map(stores.map((b) => [String(b._id), b.name]));
  const costBranch = keyed(soldLines?.byBranch);
  const backBranch = keyed(back?.byBranch);
  const backCostBranch = keyed(backLines?.byBranch);
  const byBranch = (sold?.byBranch || [])
    .map((r) => {
      const id = r._id ? String(r._id) : null;
      return profitRow(
        id ? storeNames.get(id) || 'Unknown store' : 'No store recorded',
        id,
        { gross: r.gross, cost: costBranch.get(String(r._id))?.cost || 0 },
        { value: backBranch.get(String(r._id))?.value || 0, cost: backCostBranch.get(String(r._id))?.cost || 0 },
        { invoices: r.invoices },
      );
    })
    .sort((a, b) => b.profit - a.profit);

  // By category and by medicine: line level, the only level at which a medicine exists.
  const categoryIds = (soldLines?.byCategory || []).map((c) => c._id).filter(Boolean);
  const categoryNames = categoryIds.length
    ? new Map((await Attribute.find({ organizationId: orgId, _id: { $in: categoryIds } }).select('attributeName').lean()).map((a) => [String(a._id), a.attributeName]))
    : new Map();
  const backCategory = keyed(backLines?.byCategory);
  const byCategory = (soldLines?.byCategory || [])
    .map((c) => profitRow(c._id ? categoryNames.get(String(c._id)) || 'Unknown category' : 'Uncategorised', c._id ? String(c._id) : null, c, backCategory.get(String(c._id))))
    .sort((a, b) => b.profit - a.profit);

  const backMedicine = keyed(backLines?.byMedicine);
  const medicines = (soldLines?.byMedicine || [])
    .map((m) => profitRow(m.name, String(m._id), m, backMedicine.get(String(m._id)), { manufacturer: m.manufacturer, invoices: m.invoices }))
    .sort((a, b) => b.profit - a.profit);

  // A margin is only a ranking if the cost is known. Free or un-priced stock would otherwise top the table at 100%.
  const rankable = medicines.filter((m) => m.costKnown && m.revenue > 0);
  const byMargin = [...rankable].sort((a, b) => b.margin - a.margin);

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
    filters: { branchId: query.branchId || null },
    kpis: [
      kpi('grossSales', 'Gross sales', current.grossSales, previous.grossSales, 'What customers were billed on completed invoices, including GST.'),
      kpi('salesReturns', 'Sales returns', current.salesReturns, previous.salesReturns, 'The value of goods customers brought back in the period.'),
      kpi('netSales', 'Net sales', current.netSales, previous.netSales, 'Gross sales less sales returns.'),
      kpi('cogs', 'Cost of goods sold', current.cogs, previous.cogs, 'What the units sold cost, taken from the batch each line came out of. Units returned and put back on the shelf are credited back at the same cost; damaged ones are not.'),
      kpi('grossProfit', 'Gross profit', current.grossProfit, previous.grossProfit, 'Net sales less cost of goods sold.'),
      kpi('grossMargin', 'Gross margin', current.grossMargin, previous.grossMargin, 'Gross profit as a percentage of net sales. Sales include GST and costs do not, so this is a trading margin, not a tax-adjusted one.', 'percent'),
      kpi('discounts', 'Discounts given', current.discount, previous.discount, 'Bill-level and line-level discounts on those invoices. They are already inside the sales figures — this says how much was given away.'),
      kpi('unitsSold', 'Units sold', current.unitsSold, previous.unitsSold, 'Units on completed invoices in the period.', 'number'),
    ],
    statement: [
      { key: 'grossSales', label: 'Gross sales', value: current.grossSales, kind: 'add' },
      { key: 'salesReturns', label: 'Less sales returns', value: -current.salesReturns, kind: 'subtract' },
      { key: 'netSales', label: 'Net sales', value: current.netSales, kind: 'total' },
      { key: 'cogs', label: 'Less cost of goods sold', value: -current.cogs, kind: 'subtract' },
      { key: 'grossProfit', label: 'Gross profit', value: current.grossProfit, kind: 'total', margin: current.grossMargin },
      { key: 'expenses', label: 'Less operating expenses', value: null, kind: 'missing', note: 'Not recorded by this system' },
      { key: 'netProfit', label: 'Net profit', value: null, kind: 'unavailable', note: 'Needs operating expenses' },
    ],
    totals: { current, previous },
    charts: {
      trend: { bucket: plan.bucket, points: trend },
      byBranch,
      byCategory,
      topMargin: byMargin.slice(0, 10),
      lowMargin: [...byMargin].reverse().slice(0, 10),
      topProfit: medicines.slice(0, 10),
    },
    medicineCount: medicines.length,
    notes: {
      netProfit: null,
      netProfitReason:
        'Net profit needs operating expenses — rent, salaries, utilities, transport — which this system does not record yet. Gross profit is shown instead. Net profit is deliberately NOT worked out by subtracting purchases from sales: stock bought and not yet sold is an asset, not an expense.',
      costMethod: 'Cost of goods sold uses the purchase price recorded on the batch each unit came out of — a snapshot taken when the stock was received.',
      taxBasis: 'Sales are GST-inclusive and batch costs are not, so the margin is a trading margin. Reconcile tax in the GST report.',
      lineLevel: 'The cuts by category and medicine are computed from invoice lines, which add up to the invoice totals apart from per-invoice rounding.',
      unknownCost: medicines.length - rankable.length
        ? `${medicines.length - rankable.length} medicine${medicines.length - rankable.length === 1 ? '' : 's'} sold had no purchase price on the batch, so they are listed but kept out of the margin rankings.`
        : null,
    },
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const COLUMNS = [
  ['Medicine', (r) => r.label],
  ['Manufacturer', (r) => r.manufacturer || ''],
  ['Units sold (net of returns)', (r) => r.units],
  ['Invoices', (r) => r.invoices ?? ''],
  ['Net revenue (INR)', (r) => r.revenue.toFixed(2)],
  ['Cost of goods sold (INR)', (r) => r.cost.toFixed(2)],
  ['Gross profit (INR)', (r) => r.profit.toFixed(2)],
  ['Gross margin (%)', (r) => (r.margin === null ? '' : r.margin.toFixed(1))],
  ['Cost known', (r) => (r.costKnown ? 'Yes' : 'No')],
];

/** Every medicine sold in the period with its own margin — the whole list, not the ten on screen. */
export async function exportProfitabilityReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const [current, all] = await Promise.all([figuresFor(orgId, period, branches), medicineRows(orgId, period, branches, tz)]);

  // The screen shows the ten best and worst; the file carries EVERY medicine sold, ordered by what it made.
  if (all.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} medicines. Choose a shorter period or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }

  const head = exportHeader({
    title: 'Profitability Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Gross sales (INR)', current.grossSales.toFixed(2)],
      ['Sales returns (INR)', current.salesReturns.toFixed(2)],
      ['Net sales (INR)', current.netSales.toFixed(2)],
      ['Cost of goods sold (INR)', current.cogs.toFixed(2)],
      ['Gross profit (INR)', current.grossProfit.toFixed(2)],
      ['Gross margin (%)', String(current.grossMargin)],
      ['Net profit', 'Not available — operating expenses are not recorded'],
      ['Cost method', 'Purchase price of the batch each unit came out of'],
    ],
    rows: all.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...all.map((r) => COLUMNS.map(([, read]) => read(r)))]),
    fileName: `usha-profitability-${fileStamp(tz)}.csv`,
    rows: all.length,
  };
}

/** Every medicine sold in the period, with its margin, ordered by what it made. */
async function medicineRows(orgId, period, branches, tz) {
  const [[soldLines], [backLines]] = await Promise.all([
    invoiceLines(orgId, period, branches, bucketPlan(period, tz)),
    returnLines(orgId, period, branches, bucketPlan(period, tz)),
  ]);
  const back = keyed(backLines?.byMedicine);
  return (soldLines?.byMedicine || [])
    .map((m) => profitRow(m.name, String(m._id), m, back.get(String(m._id)), { manufacturer: m.manufacturer, invoices: m.invoices }))
    .sort((a, b) => b.profit - a.profit);
}
