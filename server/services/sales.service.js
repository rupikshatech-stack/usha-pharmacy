import { Invoice } from '../models/index.js';

/**
 * SALES = completed invoices. This is the ONLY place revenue and invoice counts are computed.
 *
 * Rules:
 *  - Only invoices with status "completed" are sales. draft / cancelled / reversed never count.
 *  - Revenue is the invoice `total` (net of discounts, issued value). Payments are not summed, so
 *    retried or duplicate payment attempts cannot inflate it; one invoice is counted exactly once.
 *  - Reports use `invoiceDate` (UTC) so a back-dated or imported invoice lands on the right day.
 *  - Ranges are half-open [from, to) in UTC. A null bound means unbounded.
 */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const dateRange = (from, to) => {
  if (!from && !to) return {};
  return { invoiceDate: { ...(from && { $gte: from }), ...(to && { $lt: to }) } };
};

export const completedSalesMatch = (orgId, from, to) => ({ organizationId: orgId, status: 'completed', ...dateRange(from, to) });

/** { revenue, invoices, collected, outstanding } for completed sales in [from, to). */
export async function salesTotals(orgId, from, to) {
  const [r] = await Invoice.aggregate([
    { $match: completedSalesMatch(orgId, from, to) },
    { $group: { _id: null, revenue: { $sum: '$total' }, collected: { $sum: '$paid' }, outstanding: { $sum: '$due' }, invoices: { $sum: 1 } } },
  ]);
  return {
    revenue: round2(r?.revenue || 0),
    collected: round2(r?.collected || 0),
    outstanding: round2(r?.outstanding || 0),
    invoices: r?.invoices || 0,
  };
}

/** Number of invoices in each lifecycle status in [from, to) — for transparency next to the headline count. */
export async function invoiceStatusCounts(orgId, from, to) {
  const rows = await Invoice.aggregate([
    { $match: { organizationId: orgId, ...dateRange(from, to) } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const counts = { draft: 0, completed: 0, cancelled: 0, reversed: 0 };
  for (const r of rows) if (r._id in counts) counts[r._id] = r.n;
  return counts;
}

/** Completed-sales revenue and invoice count per local calendar month ("YYYY-MM" in `timezone`) in [from, to). */
export async function monthlyTotals(orgId, from, to, timezone) {
  const rows = await Invoice.aggregate([
    { $match: completedSalesMatch(orgId, from, to) },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$invoiceDate', timezone } }, revenue: { $sum: '$total' }, invoices: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, { revenue: round2(r.revenue), invoices: r.invoices }]));
}

export { round2 };
