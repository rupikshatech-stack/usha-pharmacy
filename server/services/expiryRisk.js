/**
 * The maths behind Inventory Expiry Intelligence.
 *
 * Nothing here touches the database, the request or the clock unless it is handed one — every function is pure, so
 * the figures the report quotes can be checked in a unit test rather than argued about. The service layer
 * (analyticsExpiry.service.js) reads the records and calls into here; this file decides what they MEAN.
 *
 * THE QUESTION THIS ANSWERS
 * A list of what is expiring is easy and nearly useless: a pharmacist with four hundred lots on it still does not know
 * what to do on Monday morning. What matters is which lots will not sell in time and how much money that is. So for
 * every lot we work out what it is likely to sell before it expires, and call the rest the projected loss.
 *
 * HOW DEMAND IS SHARED OUT — FEFO, not per-lot history
 * A lot received yesterday has no sales history of its own, so judging it on its own history would say it will sell
 * nothing and write off the whole thing. That is wrong: a lot does not have customers, a MEDICINE has customers.
 * So demand is measured per medicine per store, and then shared out across that medicine's lots in the order they will
 * actually leave the shelf — earliest expiry first (FEFO), which is how the rest of this system allocates stock.
 *
 * Each lot can only sell into the demand that arises BEFORE IT EXPIRES, and only what the lots expiring before it have
 * not already taken. A lot that has already expired gets nothing, and its leftover units are dead — later lots do not
 * inherit them, because those units were never sold.
 */

/** Days in one day, so the arithmetic below reads as arithmetic. */
const DAY_MS = 86400000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The risk bands, worst first. `min` is the lowest score that still counts as that band. */
export const RISK_LEVELS = ['critical', 'high', 'medium', 'low', 'safe'];
export const RISK_LEVEL_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', safe: 'Safe' };
const RISK_BANDS = [
  ['critical', 75],
  ['high', 55],
  ['medium', 35],
  ['low', 15],
  ['safe', 0],
];

/**
 * Whole days from now until a lot expires, negative once it has passed. An expiry is a DATE, not a moment: a lot
 * marked 30 Nov is good for the whole of 30 Nov, so both ends are compared at the start of their day in UTC (which is
 * how expiries are stored) and the answer never drifts by a day because of the time someone opened the page.
 */
export function daysToExpiry(expiryDate, now = new Date()) {
  if (!expiryDate) return null;
  const expiry = Date.UTC(new Date(expiryDate).getUTCFullYear(), new Date(expiryDate).getUTCMonth(), new Date(expiryDate).getUTCDate());
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Math.round((expiry - today) / DAY_MS);
}

/**
 * Shares one medicine's demand in one store across its lots, earliest expiry first.
 *
 * `batches` is every lot of that medicine in that store that still holds stock — the FILTERED view cannot be used here,
 * because a lot hidden by a filter still takes its share of the demand before the ones behind it.
 * `avgDailySales` is units a day, measured over the velocity window. `now` is passed in so that every lot on one page
 * is judged against the same instant.
 *
 * Returns one row per input lot, in the SAME ORDER as it was given, each carrying:
 *   daysToExpiry        whole days left, negative if it has passed
 *   expectedSales       units it is likely to sell before it expires
 *   projectedUnsoldQty  what is left over when it does  (qty − expectedSales, never below zero)
 *
 * The recursion matters and cannot be replaced by a running total: once a lot expires with units left, those units are
 * dead stock. They do not come back to meet later demand, so each step has to know what was really sold, not what the
 * demand curve would have allowed.
 */
export function allocateFefo(batches, avgDailySales = 0, now = new Date()) {
  const velocity = Math.max(0, Number(avgDailySales) || 0);
  // Earliest expiry first, and a stable tiebreak so the same input always gives the same answer.
  const order = batches
    .map((batch, index) => ({ batch, index, days: Math.max(0, daysToExpiry(batch.expiryDate, now) ?? 0) }))
    .sort((a, b) => a.days - b.days || a.index - b.index);

  const out = new Array(batches.length);
  let consumed = 0; // units of demand the lots before this one have already taken
  for (const { batch, index, days } of order) {
    const qty = Math.max(0, Number(batch.quantity) || 0);
    // All the demand that will arise between now and the day this lot expires.
    const demandByExpiry = velocity * days;
    // …less whatever the lots in front of it have already met. An expired lot sees no demand at all.
    const available = Math.max(0, demandByExpiry - consumed);
    const expectedSales = Math.min(qty, available);
    consumed += expectedSales;
    out[index] = {
      daysToExpiry: daysToExpiry(batch.expiryDate, now),
      expectedSales: round2(expectedSales),
      projectedUnsoldQty: round2(Math.max(0, qty - expectedSales)),
    };
  }
  return out;
}

/**
 * How urgent a lot is purely on time: 1 the day it expires or after, nothing once it is more than half a year off.
 * It falls off in a straight line between the two, because a pharmacist's sense of "soon" is linear and a curve here
 * would only make the number harder to argue with.
 */
export function urgencyOf(days, horizonDays = 180) {
  if (days === null || days === undefined) return 0;
  if (days <= 0) return 1;
  return clamp(1 - days / horizonDays, 0, 1);
}

/**
 * How much the money at stake should matter, on a log scale: the difference between ₹500 and ₹5,000 of projected loss
 * deserves attention, the difference between ₹2L and ₹2.1L does not. Saturates at ₹1 lakh.
 */
export function valueWeightOf(projectedLoss, saturationRupees = 100000) {
  const loss = Math.max(0, Number(projectedLoss) || 0);
  if (!loss) return 0;
  return clamp(Math.log10(1 + loss) / Math.log10(1 + saturationRupees), 0, 1);
}

/** The band a score falls in. */
export const riskLevelOf = (score) => RISK_BANDS.find(([, min]) => score >= min)[0];

/**
 * The risk score, 0–100, from the three things that actually decide whether a lot is a problem:
 *
 *   45%  how soon it expires
 *   40%  how much of it is projected to go unsold, SCALED BY how soon — a lot that will clear itself is not a problem
 *        however soon it expires, and one that will not is not a problem yet if the date is two years away
 *   15%  how much money that is — a ₹40 loss and a ₹40,000 loss should not sort next to each other
 *
 * Two cases override the arithmetic, because the arithmetic gets them wrong in a way people would not forgive:
 *   · a lot that has ALREADY EXPIRED while holding stock is Critical, whatever it is worth — it cannot be sold at all
 *   · a lot projected to sell out completely, more than the longest bucket away, is Safe — there is nothing to act on
 */
export function riskScoreOf({ daysToExpiry: days, quantity, projectedUnsoldQty, projectedLoss, safeAfterDays = 90 }) {
  const qty = Math.max(0, Number(quantity) || 0);
  const unsold = clamp(Number(projectedUnsoldQty) || 0, 0, qty);
  const unsoldShare = qty > 0 ? unsold / qty : 0;
  const expired = days !== null && days !== undefined && days <= 0;

  if (expired && qty > 0) return { score: 100, level: 'critical' };
  if (qty > 0 && unsold === 0 && days > safeAfterDays) return { score: 0, level: 'safe' };

  /**
   * The unsold share is GATED BY URGENCY, and that gate is the whole point.
   *
   * A product nobody has bought lately is projected to sell none of itself, so its unsold share is 1.0 whether it
   * expires next week or in two years. Counting that at full weight regardless of the date would score a lot 782 days
   * out as a live problem, and a register full of those is a register nobody reads. Waste only matters as the date
   * comes into view, so the same factor that measures urgency scales it.
   */
  const urgency = urgencyOf(days);
  const raw = 0.45 * urgency + 0.4 * unsoldShare * urgency + 0.15 * valueWeightOf(projectedLoss);
  const score = Math.round(clamp(raw, 0, 1) * 100);
  return { score, level: riskLevelOf(score) };
}

/**
 * The discount worth suggesting to clear a lot before it expires. It rises with the risk and is capped by the
 * organization's own ceiling, and it is only ever a SUGGESTION: nothing in this system changes a selling price by
 * itself. A lot with nothing projected to go unsold is not suggested for clearance at all.
 */
export function suggestedDiscount({ score, projectedUnsoldQty, daysToExpiry: days, maxDiscount = 50 }) {
  if (!projectedUnsoldQty || (days !== null && days <= 0)) return 0;
  const steps = [
    [75, 1],
    [55, 0.7],
    [35, 0.45],
    [15, 0.25],
  ];
  const share = steps.find(([min]) => score >= min)?.[1] ?? 0;
  return Math.round(clamp(maxDiscount * share, 0, maxDiscount) / 5) * 5; // to the nearest 5%, because nobody offers 23% off
}

/**
 * Whether a lot is still worth asking the supplier to take back. Distributors normally accept near-expiry stock inside
 * a window around the expiry date — a few months either side — so the test is the DISTANCE from expiry, before or
 * after, not simply "is it still in date".
 *
 * A lot with no supplier recorded is never recoverable: there is nobody to send it to. That is a real and common case
 * in this data, so it is reported separately rather than quietly folded into the total.
 */
export function supplierReturnable({ supplierId, daysToExpiry: days, disposedAt, supplierReturnStatus, windowDays = 90 }) {
  if (!supplierId) return false;
  if (disposedAt) return false;
  if (supplierReturnStatus === 'returned') return false; // already gone back
  if (days === null || days === undefined) return false;
  return Math.abs(days) <= windowDays;
}

/**
 * Everything the report says about ONE lot, given the lot, its share of the medicine's demand, and the organization's
 * own thresholds. This is the single place a row's figures are decided, so the table, the KPI cards, the charts and
 * the CSV can never disagree with each other.
 */
export function assessBatch(batch, allocation, options = {}) {
  const { supplierReturnWindowDays = 90, clearanceMaxDiscount = 50, thresholds = [15, 30, 90] } = options;
  const qty = Math.max(0, Number(batch.quantity) || 0);
  const purchaseRate = Math.max(0, Number(batch.purchasePrice) || 0);
  const mrp = Math.max(0, Number(batch.mrp) || 0);
  const { daysToExpiry: days } = allocation;

  /**
   * Demand is shared out in fractions — half a unit a day is a real rate — but a lot is counted in whole units and
   * nobody writes off 0.42 of a tablet. So the projection is rounded DOWN to the units a lot can actually be relied on
   * to sell, which rounds the loss UP. A report about money at risk should not flatter itself.
   */
  const expectedSales = Math.min(qty, Math.floor(allocation.expectedSales || 0));
  const projectedUnsoldQty = Math.max(0, qty - expectedSales);
  const projectedLoss = round2(projectedUnsoldQty * purchaseRate);
  const { score, level } = riskScoreOf({ daysToExpiry: days, quantity: qty, projectedUnsoldQty, projectedLoss, safeAfterDays: thresholds[2] });

  return {
    daysToExpiry: days,
    avgDailySales: round2(allocation.avgDailySales ?? 0),
    expectedSales,
    projectedUnsoldQty,
    projectedLoss,
    costValue: round2(qty * purchaseRate),
    mrpValue: round2(qty * mrp),
    riskScore: score,
    riskLevel: level,
    bucket: bucketOf(days, thresholds),
    suggestedDiscount: suggestedDiscount({ score, projectedUnsoldQty, daysToExpiry: days, maxDiscount: clearanceMaxDiscount }),
    recoverable: supplierReturnable({
      supplierId: batch.supplierId,
      daysToExpiry: days,
      disposedAt: batch.disposedAt,
      supplierReturnStatus: batch.supplierReturn?.status,
      windowDays: supplierReturnWindowDays,
    }),
  };
}

/**
 * Which "expiring within" bucket a lot falls in. The buckets are nested on screen (everything under 15 days is also
 * under 30), but a row belongs to exactly one, so the table can be filtered to it without a row appearing twice.
 */
export function bucketOf(days, thresholds = [15, 30, 90]) {
  if (days === null || days === undefined) return 'unknown';
  if (days <= 0) return 'expired';
  const [near, soon, later] = thresholds;
  if (days <= near) return 'under15';
  if (days <= soon) return 'under30';
  if (days <= later) return 'under90';
  return 'safe';
}

/** The buckets in the order the cards are shown, with the nesting each one implies when used as a filter. */
export const BUCKETS = ['expired', 'under15', 'under30', 'under90', 'safe'];
/** Filtering to "under 30 days" means everything at least that urgent, which is how people read the card they clicked. */
export const BUCKETS_AT_LEAST = {
  expired: ['expired'],
  under15: ['expired', 'under15'],
  under30: ['expired', 'under15', 'under30'],
  under90: ['expired', 'under15', 'under30', 'under90'],
  safe: ['safe'],
};
