import { Batch, Invoice, Medicine, Order, SalesReturn } from '../models/index.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, PURCHASE_STATUSES, branchMatch, bucketPlan, figuresFor, reportableBranches, resolvePeriod, revenueSeries, round2 } from './analytics.service.js';
import { nearExpiryDays, position, stockLevels, velocity } from './analyticsInventory.service.js';

/**
 * Business Insights: the handful of things in this period's data that somebody running the business would actually
 * want told to them, each with the number behind it and a link to the report that proves it.
 *
 * WHAT THIS IS NOT. It is not a model, and there is no external service behind it. Every insight is a DETERMINISTIC
 * RULE over figures the reports already compute — the same `figuresFor()` the overview quotes, the same inventory
 * position, the same definitions — so an insight can always be reproduced by opening the report it links to. If the
 * two ever disagree, the insight is wrong, and that is a bug rather than a difference of opinion.
 *
 * THREE RULES THE RULES THEMSELVES FOLLOW:
 *
 *   1. Say what happened, never why. "Sales fell 14% against the previous 30 days" is a fact. "Sales fell because
 *      footfall dropped" is a guess, and this system has no footfall data. Nothing here claims a cause.
 *   2. Carry the evidence. Every insight states the period it is about and the figure it is built from, so it can be
 *      checked rather than believed.
 *   3. Stay quiet when the data cannot support a statement. A threshold is not met, or there is not enough trade to
 *      compare — then there is no insight, not a hedged one. An organization with nothing to say gets an honest
 *      empty state, which is itself information.
 *
 * Thresholds are stated once, here, as named constants: a rule with a magic number buried in it cannot be argued
 * with by the person it is advising.
 */

/** The thresholds that decide whether something is worth saying at all. */
export const THRESHOLDS = {
  /** A change in sales or profit below this is noise, not news. */
  changePercent: 5,
  /** …and it is only reported when there was enough trade for a percentage to mean anything. */
  minimumBase: 1000,
  /** A medicine needs this many units sold before "best seller" is a statement rather than an accident. */
  minimumUnits: 3,
  /** Returns at or above this share of the units sold are worth a look. */
  returnRatePercent: 10,
  minimumReturnedUnits: 3,
  /** Stock that has not sold at all is only worth mentioning once this much money is tied up in it. */
  deadStockValue: 1000,
  /** A bucket this many times the period's own average is unusual enough to point out. */
  spikeMultiple: 2,
  /** Receivables worth chasing. */
  receivables: 1000,
  /** How many insights to return at most. */
  limit: 12,
};

/** Severity decides the order and the colour: something that costs money outranks something that earns praise. */
const RANK = { critical: 0, warning: 1, opportunity: 2, positive: 3, info: 4 };

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/**
 * One insight. `metric` is the single figure the statement rests on, `evidence` the figures behind it, and `link` the
 * report where the reader can see it for themselves — never a dead end.
 */
const insight = ({ key, severity = 'info', title, detail, metric, evidence, link, linkLabel }) => ({
  key,
  severity,
  title,
  detail,
  metric: metric || null,
  evidence: evidence || null,
  link: link || null,
  linkLabel: linkLabel || null,
});

const money = (value, label) => ({ label, value: round2(value), format: 'money' });
const count = (value, label) => ({ label, value, format: 'number' });
const percent = (value, label) => ({ label, value, format: 'percent' });

/* ------------------------------------------------------------------ the data the rules read */

/** Units sold and returned per medicine, so a return rate can be worked out per product. */
async function returnsByMedicine(orgId, period, branches) {
  const [sold, back] = await Promise.all([
    Invoice.aggregate([
      { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
      { $unwind: '$items' },
      { $group: { _id: '$items.medicineId', name: { $first: '$items.name' }, units: { $sum: { $ifNull: ['$items.quantity', 0] } }, amount: { $sum: { $ifNull: ['$items.amount', 0] } } } },
    ]).allowDiskUse(true),
    SalesReturn.aggregate([
      { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
      ...(branches
        ? [
          { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: '_inv', pipeline: [{ $project: { branchId: 1 } }] } },
          { $match: { '_inv.branchId': { $in: branches } } },
        ]
        : []),
      { $unwind: '$items' },
      { $group: { _id: '$items.medicineId', name: { $first: '$items.name' }, units: { $sum: { $ifNull: ['$items.quantity', 0] } }, amount: { $sum: { $ifNull: ['$items.amount', 0] } } } },
    ]).allowDiskUse(true),
  ]);
  const soldBy = new Map(sold.map((r) => [String(r._id), r]));
  return back
    .map((r) => {
      const s = soldBy.get(String(r._id));
      return {
        id: String(r._id),
        name: r.name || s?.name || 'a medicine',
        returnedUnits: r.units,
        returnedValue: round2(r.amount),
        soldUnits: s?.units || 0,
        rate: pct(r.units, s?.units || 0),
      };
    })
    .filter((r) => r.soldUnits > 0);
}

/** Medicines that sold in the period but are at or below their own reorder level now: a buying list, not a warning. */
async function reorderOpportunities(orgId, period, branches, limit = 5) {
  return Medicine.aggregate([
    { $match: { organizationId: orgId, isActive: true } },
    {
      $lookup: {
        from: 'invoices',
        let: { med: '$_id' },
        as: '_sold',
        pipeline: [
          { $match: { status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
          { $unwind: '$items' },
          { $match: { $expr: { $eq: ['$items.medicineId', '$$med'] } } },
          { $group: { _id: null, units: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
        ],
      },
    },
    { $set: { soldUnits: { $ifNull: [{ $first: '$_sold.units' }, 0] } } },
    { $match: { soldUnits: { $gt: 0 } } },
    {
      $lookup: {
        from: 'batches',
        localField: '_id',
        foreignField: 'medicineId',
        as: '_b',
        pipeline: [
          { $match: { status: 'active', availableQuantity: { $gt: 0 }, ...(branches ? { branchId: { $in: branches } } : {}) } },
          { $match: { $expr: { $gt: ['$expiryDate', '$$NOW'] } } },
          { $project: { sellable: { $max: [0, { $subtract: ['$availableQuantity', { $ifNull: ['$reservedQuantity', 0] }] }] } } },
        ],
      },
    },
    { $set: { sellable: { $sum: '$_b.sellable' } } },
    { $match: { $expr: { $lte: ['$sellable', { $ifNull: ['$reorderLevel', 0] }] } } },
    { $sort: { soldUnits: -1 } },
    { $limit: limit },
    { $project: { _id: 1, medicineName: 1, reorderLevel: 1, sellable: 1, soldUnits: 1 } },
  ]).allowDiskUse(true);
}

/** Sales per store, for this period and the one before, so one store's change can be pointed out. */
const salesPerBranch = (orgId, period, branches) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
    { $group: { _id: '$branchId', sales: { $sum: { $ifNull: ['$total', 0] } }, invoices: { $sum: 1 } } },
    { $lookup: { from: 'branches', localField: '_id', foreignField: '_id', as: '_b', pipeline: [{ $project: { name: 1 } }] } },
    { $set: { name: { $ifNull: [{ $first: '$_b.name' }, 'No store recorded'] } } },
    { $sort: { sales: -1 } },
  ]).allowDiskUse(true);

/** Who owes the most, as a balance now. */
const topDebtor = (orgId, branches) =>
  Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', due: { $gt: 0 }, ...branchMatch(branches) } },
    { $group: { _id: { $trim: { input: { $ifNull: ['$customer.phone', ''] } } }, name: { $top: { output: '$customer.name', sortBy: { invoiceDate: -1 } } }, due: { $sum: '$due' }, invoices: { $sum: 1 } } },
    { $match: { _id: { $ne: '' } } },
    { $sort: { due: -1 } },
    { $limit: 1 },
  ]).allowDiskUse(true);

/** What is owed to suppliers, as a balance now. */
const supplierDebt = (orgId, branches) =>
  Order.aggregate([
    { $match: { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, ...branchMatch(branches) } },
    {
      $group: {
        _id: null,
        owed: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $ifNull: ['$payment.remaining', 0] }] } },
        suppliers: { $addToSet: { $cond: [{ $eq: ['$payment.status', 'paid'] }, '$$REMOVE', { $ifNull: ['$supplier.supplierId', '$supplier.name'] }] } },
      },
    },
  ]);

/** The batches closest to expiring that still hold stock, for the link in the expiry insight. */
const soonestExpiry = (orgId, branches, days) =>
  Batch.aggregate([
    {
      $match: {
        organizationId: orgId,
        status: { $ne: 'archived' },
        availableQuantity: { $gt: 0 },
        ...(branches ? { branchId: { $in: branches } } : {}),
        expiryDate: { $gt: new Date(), $lte: new Date(Date.now() + days * 86400000) },
      },
    },
    { $sort: { expiryDate: 1 } },
    { $limit: 1 },
    { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { medicineName: 1 } }] } },
    { $project: { batchNumber: 1, expiryDate: 1, availableQuantity: 1, name: { $first: '$_m.medicineName' } } },
  ]);

/* ------------------------------------------------------------------ the rules */

/**
 * Business Insights for a period. Returns the insights worth showing, most serious first, plus what was examined so
 * an empty result can say so rather than looking broken.
 */
export async function getInsights(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const periodArg = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(periodArg, tz);
  const nearDays = nearExpiryDays(org);
  const limit = Math.min(Number(query.limit) || THRESHOLDS.limit, 30);
  const scope = query.branchId ? `&branchId=${query.branchId}` : '';
  const dates = `?from=${plan.keys.length ? periodArg.start.toISOString().slice(0, 10) : ''}&to=${new Date(periodArg.end.getTime() - 1).toISOString().slice(0, 10)}`;
  const link = (path) => `${path}${dates}${scope}`;

  const [current, previous, series, pace, pos, levels, returnRates, reorder, branchSales, branchSalesBefore, debtor, owed, soonest] = await Promise.all([
    figuresFor(orgId, periodArg, branches),
    figuresFor(orgId, periodArg.previous, branches),
    revenueSeries(orgId, periodArg, branches, tz),
    velocity(orgId, periodArg, branches, 5),
    position(orgId, branches, nearDays),
    stockLevels(orgId, branches),
    returnsByMedicine(orgId, periodArg, branches),
    reorderOpportunities(orgId, periodArg, branches),
    salesPerBranch(orgId, periodArg, branches),
    salesPerBranch(orgId, periodArg.previous, branches),
    topDebtor(orgId, branches),
    supplierDebt(orgId, branches),
    soonestExpiry(orgId, branches, nearDays),
  ]);

  const out = [];
  const periodWords = `the ${periodArg.days === 1 ? 'day' : `${periodArg.days} days`} to ${new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium' }).format(new Date(periodArg.end.getTime() - 1))}`;
  const comparable = `the previous ${periodArg.days === 1 ? 'day' : `${periodArg.days} days`}`;

  /* --- how trade is moving. Only when there is enough of it on both sides for a percentage to mean anything. --- */
  const salesChange = pct(current.grossSales - previous.grossSales, previous.grossSales);
  if (salesChange !== null && Math.max(current.grossSales, previous.grossSales) >= THRESHOLDS.minimumBase && Math.abs(salesChange) >= THRESHOLDS.changePercent) {
    const up = salesChange > 0;
    out.push(
      insight({
        key: 'salesChange',
        severity: up ? 'positive' : 'warning',
        title: `Sales ${up ? 'rose' : 'fell'} ${Math.abs(salesChange)}% against ${comparable}`,
        detail: `You billed ₹${current.grossSales.toLocaleString('en-IN')} in ${periodWords}, against ₹${previous.grossSales.toLocaleString('en-IN')} before it. This states the change only — nothing here identifies a cause.`,
        metric: percent(salesChange, 'Change in sales'),
        evidence: { current: money(current.grossSales, 'This period'), previous: money(previous.grossSales, comparable) },
        link: link('/analytics/sales'),
        linkLabel: 'Open the Sales Report',
      }),
    );
  }

  const profitChange = pct(current.grossProfit - previous.grossProfit, previous.grossProfit);
  if (profitChange !== null && Math.max(current.grossProfit, previous.grossProfit) >= THRESHOLDS.minimumBase && Math.abs(profitChange) >= THRESHOLDS.changePercent) {
    const up = profitChange > 0;
    out.push(
      insight({
        key: 'profitChange',
        severity: up ? 'positive' : 'warning',
        title: `Gross profit ${up ? 'rose' : 'fell'} ${Math.abs(profitChange)}% against ${comparable}`,
        detail: `₹${current.grossProfit.toLocaleString('en-IN')} this period against ₹${previous.grossProfit.toLocaleString('en-IN')} before it, at a margin of ${current.grossMargin}%. Profit uses the purchase price of the batch each unit came out of.`,
        metric: percent(profitChange, 'Change in gross profit'),
        evidence: { margin: percent(current.grossMargin, 'Gross margin'), cogs: money(current.cogs, 'Cost of goods sold') },
        link: link('/analytics/profitability'),
        linkLabel: 'Open Profitability',
      }),
    );
  }

  /* --- an unusual bucket inside the period. A fact about the series, not a diagnosis. --- */
  const traded = series.points.filter((p) => p.sales > 0);
  if (traded.length >= 4) {
    const average = traded.reduce((n, p) => n + p.sales, 0) / traded.length;
    const peak = [...traded].sort((a, b) => b.sales - a.sales)[0];
    if (average > 0 && peak.sales >= average * THRESHOLDS.spikeMultiple) {
      out.push(
        insight({
          key: 'salesSpike',
          severity: 'info',
          title: `One ${series.bucket} stands out: ₹${peak.sales.toLocaleString('en-IN')}`,
          detail: `That is ${Math.round((peak.sales / average) * 10) / 10}× the ${series.bucket}ly average of ₹${Math.round(average).toLocaleString('en-IN')} across this period. Worth checking the invoices behind it before reading anything into it.`,
          metric: money(peak.sales, `Busiest ${series.bucket}`),
          evidence: { bucket: { label: 'Bucket', value: peak.key, format: 'text' }, average: money(round2(average), `Average ${series.bucket}`) },
          link: `/analytics/transactions?type=sale&from=${peak.key.length === 7 ? `${peak.key}-01` : peak.key}&to=${peak.key.length === 7 ? `${peak.key}-01` : peak.key}${scope}`,
          linkLabel: 'See that day\'s transactions',
        }),
      );
    }
  }

  /* --- what sold. --- */
  const best = pace.fast[0];
  if (best && best.units >= THRESHOLDS.minimumUnits) {
    out.push(
      insight({
        key: 'bestSeller',
        severity: 'positive',
        title: `${best.label} sold the most units this period`,
        detail: `${plural(best.units, 'unit')} sold, worth ₹${best.revenue.toLocaleString('en-IN')}, at about ${best.perDay} a day. ${
          best.daysOfCover === null ? 'There is no stock of it on hand.' : `Stock on hand would last about ${plural(best.daysOfCover, 'day')} at that rate.`
        }`,
        metric: count(best.units, 'Units sold'),
        evidence: { revenue: money(best.revenue, 'Revenue'), cover: best.daysOfCover === null ? null : count(best.daysOfCover, 'Days of cover') },
        link: link('/analytics/sales'),
        linkLabel: 'See top sellers',
      }),
    );
  }

  /* --- money tied up in stock that is not moving. --- */
  const dead = pace.slow.filter((r) => r.units === 0 && r.stockValue >= THRESHOLDS.deadStockValue);
  if (dead.length) {
    const worth = round2(dead.reduce((n, r) => n + r.stockValue, 0));
    out.push(
      insight({
        key: 'deadStock',
        severity: 'opportunity',
        title: `₹${worth.toLocaleString('en-IN')} of stock sold nothing at all this period`,
        detail: `${plural(dead.length, 'medicine')} are holding stock with no sales in ${periodWords} — the largest is ${dead[0].label} at ₹${dead[0].stockValue.toLocaleString('en-IN')} of cost.`,
        metric: money(worth, 'Tied up at cost'),
        evidence: { medicines: count(dead.length, 'Medicines') },
        link: link('/analytics/inventory'),
        linkLabel: 'Open Inventory Analytics',
      }),
    );
  }

  /* --- expiry. Two separate statements: what is about to go, and what already has. --- */
  if (pos.nearExpiryBatches > 0) {
    const first = soonest[0];
    out.push(
      insight({
        key: 'nearExpiry',
        severity: pos.nearExpiryValue >= THRESHOLDS.deadStockValue ? 'warning' : 'info',
        title: `${plural(pos.nearExpiryBatches, 'batch', 'batches')} expire within ${nearDays} days`,
        detail: `₹${pos.nearExpiryValue.toLocaleString('en-IN')} of stock at cost.${
          first ? ` The nearest is ${first.name || 'a medicine'}, batch ${first.batchNumber}, with ${plural(first.availableQuantity, 'unit')} left.` : ''
        } Expiry Intelligence ranks these by what is unlikely to sell in time.`,
        metric: money(pos.nearExpiryValue, 'At risk, at cost'),
        evidence: { batches: count(pos.nearExpiryBatches, 'Batches') },
        link: '/analytics/expiry',
        linkLabel: 'Open Expiry Intelligence',
      }),
    );
  }
  if (pos.expiredBatches > 0) {
    out.push(
      insight({
        key: 'expiredStock',
        severity: 'critical',
        title: `${plural(pos.expiredBatches, 'batch', 'batches')} are past their expiry date and still hold stock`,
        detail: `${plural(pos.expiredUnits, 'unit')} worth ₹${pos.expiredValue.toLocaleString('en-IN')} at cost. Expired stock can never be sold, and it is excluded from the inventory valuation.`,
        metric: money(pos.expiredValue, 'Expired, at cost'),
        evidence: { batches: count(pos.expiredBatches, 'Batches'), units: count(pos.expiredUnits, 'Units') },
        link: '/analytics/expiry?status=expired',
        linkLabel: 'Deal with expired stock',
      }),
    );
  }

  /* --- products coming back. --- */
  const returnable = returnRates
    .filter((r) => r.returnedUnits >= THRESHOLDS.minimumReturnedUnits && r.rate !== null && r.rate >= THRESHOLDS.returnRatePercent)
    .sort((a, b) => b.rate - a.rate);
  if (returnable.length) {
    const worst = returnable[0];
    out.push(
      insight({
        key: 'highReturns',
        severity: 'warning',
        title: `${worst.name} came back on ${worst.rate}% of the units sold`,
        detail: `${plural(worst.returnedUnits, 'unit')} returned against ${plural(worst.soldUnits, 'unit')} sold, worth ₹${worst.returnedValue.toLocaleString('en-IN')}.${
          returnable.length > 1 ? ` ${plural(returnable.length - 1, 'other medicine', 'other medicines')} also passed ${THRESHOLDS.returnRatePercent}%.` : ''
        } The reason on each return says more than this figure can.`,
        metric: percent(worst.rate, 'Returned share of units'),
        evidence: { returned: count(worst.returnedUnits, 'Units returned'), sold: count(worst.soldUnits, 'Units sold') },
        link: link('/analytics/transactions?type=salesReturn'),
        linkLabel: 'See the returns',
      }),
    );
  }

  /* --- buying. Low stock only matters for something that is actually selling. --- */
  if (reorder.length) {
    out.push(
      insight({
        key: 'reorder',
        severity: 'opportunity',
        title: `${plural(reorder.length, 'medicine')} sold this period and are now at or below their reorder level`,
        detail: `${reorder
          .slice(0, 3)
          .map((m) => `${m.medicineName} (${m.sellable} left, sold ${m.soldUnits})`)
          .join('; ')}${reorder.length > 3 ? ', and others' : ''}.`,
        metric: count(reorder.length, 'Medicines to reorder'),
        evidence: { lowStock: count(levels.low, 'Low on stock'), outOfStock: count(levels.out, 'Out of stock') },
        link: link('/analytics/inventory?stockStatus=low'),
        linkLabel: 'See low stock',
      }),
    );
  }
  if (levels.out > 0) {
    out.push(
      insight({
        key: 'outOfStock',
        severity: 'warning',
        title: `${plural(levels.out, 'medicine')} have nothing sellable in these stores`,
        detail: `Of ${plural(levels.medicines, 'active medicine')} on the catalogue. A medicine with no sellable batch cannot be billed at the counter.`,
        metric: count(levels.out, 'Out of stock'),
        evidence: { catalogue: count(levels.medicines, 'Active medicines') },
        link: link('/analytics/inventory?stockStatus=out'),
        linkLabel: 'See what is out',
      }),
    );
  }

  /* --- which store. Only ever a comparison, and only when there is more than one to compare. --- */
  if (branchSales.length > 1) {
    const top = branchSales[0];
    out.push(
      insight({
        key: 'bestBranch',
        severity: 'positive',
        title: `${top.name} billed the most this period`,
        detail: `₹${round2(top.sales).toLocaleString('en-IN')} across ${plural(top.invoices, 'invoice')}, ${pct(top.sales, branchSales.reduce((n, b) => n + b.sales, 0))}% of all sales in ${periodWords}.`,
        metric: money(top.sales, 'Sales'),
        evidence: { invoices: count(top.invoices, 'Invoices') },
        link: link('/analytics/branches'),
        linkLabel: 'Compare stores',
      }),
    );

    const before = new Map(branchSalesBefore.map((b) => [String(b._id), b.sales]));
    const falls = branchSales
      .map((b) => ({ ...b, change: pct(b.sales - (before.get(String(b._id)) || 0), before.get(String(b._id)) || 0) }))
      .filter((b) => b.change !== null && b.change <= -THRESHOLDS.changePercent && (before.get(String(b._id)) || 0) >= THRESHOLDS.minimumBase)
      .sort((a, b) => a.change - b.change);
    if (falls.length) {
      out.push(
        insight({
          key: 'branchDecline',
          severity: 'warning',
          title: `${falls[0].name} billed ${Math.abs(falls[0].change)}% less than in ${comparable}`,
          detail: `₹${round2(falls[0].sales).toLocaleString('en-IN')} this period against ₹${round2(before.get(String(falls[0]._id)) || 0).toLocaleString('en-IN')} before it. The comparison is the same length of time; it does not explain itself.`,
          metric: percent(falls[0].change, 'Change in sales'),
          evidence: { previous: money(before.get(String(falls[0]._id)) || 0, comparable) },
          link: link('/analytics/branches'),
          linkLabel: 'Compare stores',
        }),
      );
    }
  }

  /* --- money owed, both ways. These are balances, so they carry no period. --- */
  const debt = debtor[0];
  if (debt && debt.due >= THRESHOLDS.receivables) {
    out.push(
      insight({
        key: 'receivables',
        severity: 'warning',
        title: `${debt.name || 'A customer'} owes ₹${round2(debt.due).toLocaleString('en-IN')}`,
        detail: `Across ${plural(debt.invoices, 'invoice')}. This is a balance as it stands now, not a figure for ${periodWords}.`,
        metric: money(debt.due, 'Outstanding'),
        evidence: { invoices: count(debt.invoices, 'Invoices') },
        link: '/analytics/customers?owing=true',
        linkLabel: 'See who owes',
      }),
    );
  }
  const supplierOwed = owed[0];
  if (supplierOwed && supplierOwed.owed >= THRESHOLDS.receivables) {
    out.push(
      insight({
        key: 'supplierDebt',
        severity: 'info',
        title: `₹${round2(supplierOwed.owed).toLocaleString('en-IN')} is recorded as unpaid to suppliers`,
        detail: `Across ${plural((supplierOwed.suppliers || []).length, 'supplier')}. It records what the orders agreed, not a bank statement — a balance now, not a figure for the period.`,
        metric: money(supplierOwed.owed, 'Owed to suppliers'),
        evidence: { suppliers: count((supplierOwed.suppliers || []).length, 'Suppliers') },
        link: '/analytics/suppliers?owing=true',
        linkLabel: 'See supplier balances',
      }),
    );
  }

  const ranked = out.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, limit);
  return {
    period: { from: periodArg.start.toISOString(), to: periodArg.end.toISOString(), days: periodArg.days, timezone: tz, previousFrom: periodArg.previous.start.toISOString(), previousTo: periodArg.previous.end.toISOString() },
    filters: { branchId: query.branchId || null },
    generatedAt: new Date().toISOString(),
    insights: ranked,
    counts: {
      total: ranked.length,
      bySeverity: Object.keys(RANK).reduce((acc, k) => ({ ...acc, [k]: ranked.filter((i) => i.severity === k).length }), {}),
    },
    /** What was looked at, so an empty answer reads as "nothing to report" rather than "nothing worked". */
    examined: {
      invoices: current.invoices,
      sales: current.grossSales,
      medicinesSold: pace.fast.length,
      batchesOnHand: pos.batches,
      stores: branchSales.length,
    },
    thresholds: THRESHOLDS,
    notes: {
      method: 'Every insight is a rule over the same figures the reports show, with the threshold that triggered it published alongside. There is no model and no outside service.',
      causation: 'Insights state what changed, never why: this system records trade, not the reasons for it.',
      silence: 'Nothing is shown unless the data supports it. An empty list means nothing crossed a threshold in this period, which is itself an answer.',
      balances: 'Outstanding figures are balances as they stand now and do not follow the date range.',
    },
  };
}
