import { Batch, Invoice, Medicine } from '../models/index.js';
import { dayKey, monthKey, monthLabel, startOfMonth } from '../utils/tz.js';
import { businessDay, orgTimezone, reportingPeriod } from './organization.service.js';
import { invoiceStatusCounts, monthlyTotals, round2, salesTotals } from './sales.service.js';
import { lowStockMatch, sellableBatchFilter, sellableStockStages, sellableUnitsExpr } from './stock.service.js';
import { recentActivity } from './activity.service.js';
import { refundTotals } from './salesReturn.service.js';

/*
 * Dashboard analytics. Everything is computed live from MongoDB for ONE organization.
 * `org` is the verified tenant organization document (req.tenant.organization); `orgId` its id.
 * `now` is injectable so the date logic can be tested at any instant.
 * Timestamps are stored in UTC; day/month boundaries come from the organization's timezone.
 */
const EXPIRY_WINDOW_DAYS = 90;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const pct = (cur, prev) => (prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 1000) / 10);

/* ---------------- stock-based building blocks ---------------- */

/** Active medicines whose sellable stock is below their reorder level. */
async function lowStockCount(orgId, now) {
  const [r] = await Medicine.aggregate([
    { $match: { organizationId: orgId, isActive: true } },
    ...sellableStockStages(now),
    { $match: lowStockMatch },
    { $count: 'n' },
  ]);
  return r?.n || 0;
}

/** Batches with units on hand that expire within the window (and, separately, those already expired). */
async function expiryCounts(orgId, now, days = EXPIRY_WINDOW_DAYS) {
  const soon = addDays(now, days);
  const onHand = { organizationId: orgId, availableQuantity: { $gt: 0 }, status: { $ne: 'archived' } };
  const [expiringSoon, expired] = await Promise.all([
    Batch.countDocuments({ ...onHand, expiryDate: { $gt: now, $lte: soon } }),
    Batch.countDocuments({ ...onHand, expiryDate: { $lte: now } }),
  ]);
  return { expiringSoon, expired };
}

/* ---------------- GET /dashboard/overview ---------------- */

/**
 * Headline KPIs.
 *  todayRevenue   – completed sales on the current business day (org timezone)
 *  totalRevenue   – completed sales in the reporting period (or the from/to override)
 *  totalInvoices  – completed invoices in that same period (drafts/cancelled/reversed excluded)
 *  lowStockAlerts – active medicines with sellable stock below reorder level
 */
export async function getOverview(org, { from, to } = {}, now = new Date()) {
  const orgId = org._id;
  const tz = orgTimezone(org);

  const today = businessDay(org, now, 0);
  const yesterday = businessDay(org, now, -1);
  const period = from || to ? { type: 'custom', label: 'Custom range', start: from || null, end: to || null } : reportingPeriod(org, now);
  const thisMonth = { start: startOfMonth(now, tz, 0), end: startOfMonth(now, tz, 1) };
  const lastMonth = { start: startOfMonth(now, tz, -1), end: thisMonth.start };

  const [todaySales, yesterdaySales, periodSales, statusCounts, thisMonthSales, lastMonthSales, lowStock, expiry, medicineCount, periodRefunds] = await Promise.all([
    salesTotals(orgId, today.start, today.end),
    salesTotals(orgId, yesterday.start, yesterday.end),
    salesTotals(orgId, period.start, period.end),
    invoiceStatusCounts(orgId, period.start, period.end),
    salesTotals(orgId, thisMonth.start, thisMonth.end),
    salesTotals(orgId, lastMonth.start, lastMonth.end),
    lowStockCount(orgId, now),
    expiryCounts(orgId, now),
    Medicine.countDocuments({ organizationId: orgId }),
    refundTotals(orgId, period.start, period.end),
  ]);

  return {
    timezone: tz,
    generatedAt: now.toISOString(),
    businessDate: dayKey(now, tz),
    period: { type: period.type, label: period.label, start: period.start?.toISOString() ?? null, end: period.end?.toISOString() ?? null },

    todayRevenue: todaySales.revenue,
    todayInvoices: todaySales.invoices,
    yesterdayRevenue: yesterdaySales.revenue,
    todayVsYesterday: pct(todaySales.revenue, yesterdaySales.revenue),
    invoicesVsYesterday: pct(todaySales.invoices, yesterdaySales.invoices),

    totalRevenue: periodSales.revenue,
    totalInvoices: periodSales.invoices,
    totalRefunds: periodRefunds.refunded, // money refunded for returns dated in the same period (revenue above stays the original invoice totals)
    netRevenue: round2(periodSales.revenue - periodRefunds.refunded),
    returnsAwaitingApproval: periodRefunds.awaitingApproval,
    collected: periodSales.collected,
    outstanding: periodSales.outstanding,
    invoiceStatusCounts: statusCounts,

    thisMonthRevenue: thisMonthSales.revenue,
    lastMonthRevenue: lastMonthSales.revenue,
    monthVsLastMonth: pct(thisMonthSales.revenue, lastMonthSales.revenue),

    lowStockAlerts: lowStock,
    expiringBatches: expiry.expiringSoon,
    expiredBatches: expiry.expired,
    medicineCount,
  };
}

/* ---------------- GET /dashboard/monthly-sales ---------------- */

/** Revenue per local month for the last `months` months including the current one, zero-filled. */
export async function getMonthlySales(org, { months = 6 } = {}, now = new Date()) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const from = startOfMonth(now, tz, -(months - 1));
  const to = startOfMonth(now, tz, 1);

  const totals = await monthlyTotals(orgId, from, to, tz);
  const items = Array.from({ length: months }, (_, i) => {
    const key = monthKey(startOfMonth(now, tz, -(months - 1 - i)), tz);
    const t = totals.get(key);
    return { month: key, label: monthLabel(key), revenue: t?.revenue ?? 0, invoices: t?.invoices ?? 0 };
  });

  return {
    timezone: tz,
    months,
    from: from.toISOString(),
    to: to.toISOString(),
    totalRevenue: round2(items.reduce((s, m) => s + m.revenue, 0)),
    items,
  };
}

/* ---------------- GET /dashboard/stock-levels ---------------- */

/** Active medicines with the most sellable stock (batches grouped first, so it scales with batches, not medicines). */
export async function getStockLevels(orgId, { limit = 8 } = {}, now = new Date()) {
  const rows = await Batch.aggregate([
    { $match: { organizationId: orgId, ...sellableBatchFilter(now) } },
    { $group: { _id: '$medicineId', qty: { $sum: sellableUnitsExpr } } },
    { $lookup: { from: 'medicines', localField: '_id', foreignField: '_id', as: 'm' } },
    { $unwind: '$m' },
    { $match: { 'm.isActive': true, 'm.organizationId': orgId } },
    { $sort: { qty: -1, 'm.medicineName': 1 } },
    { $limit: limit },
    { $project: { _id: 0, medicineId: '$_id', name: '$m.medicineName', qty: 1, reorderLevel: '$m.reorderLevel' } },
  ]);
  return { limit, totalUnits: rows.reduce((s, r) => s + r.qty, 0), items: rows };
}

/* ---------------- GET /dashboard/recent-activity ---------------- */

export async function getRecentActivity(orgId, opts) {
  return { items: await recentActivity(orgId, opts) };
}

/* ---------------- GET /dashboard/alerts ---------------- */

/**
 * Which alerts the bell shows. In-app only for now: every one of these has a `channel`, and `in_app` is the only value
 * that does anything. TODO (email / WhatsApp): when those channels exist, a notification with another channel is sent
 * from a scheduled job that reads these same flags - nothing here needs to change shape for that.
 */
function notificationFlags(settings) {
  const n = settings.general?.notifications || {};
  const on = (key, fallback) => (n[key]?.enabled === undefined ? fallback : Boolean(n[key].enabled));
  // Low stock and expiry are on, and the daily summary off - which is exactly what the bell showed before this was configurable.
  return { lowStock: on('lowStock', true), nearExpiry: on('nearExpiry', true), licenseExpiry: on('licenseExpiry', true), dailySummary: on('dailySummary', false) };
}

/** Drug licences that have lapsed or will within the warning window, soonest first. Computed from the profile itself. */
function licenceAlerts(org, now) {
  const warnDays = org?.settings?.general?.licenseExpiryWarningDays ?? 60;
  return (org?.licenses || [])
    .filter((l) => l.validUntil)
    .map((l) => ({ type: l.type, number: l.number, validUntil: l.validUntil, daysToExpiry: Math.ceil((new Date(l.validUntil).getTime() - now.getTime()) / 86400000) }))
    .filter((l) => l.daysToExpiry <= warnDays)
    .map((l) => ({ ...l, expired: l.daysToExpiry < 0 }))
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

/** What yesterday's trade came to, in the organization's own day. Only computed when the organization asked for it. */
async function yesterdaySummary(orgId, org, now) {
  const { start, end } = businessDay(org, now, -1);
  const [row] = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: start, $lt: end } } },
    { $group: { _id: null, invoices: { $sum: 1 }, sales: { $sum: { $ifNull: ['$total', 0] } } } },
  ]);
  return { date: start.toISOString(), invoices: row?.invoices || 0, sales: Math.round((row?.sales || 0) * 100) / 100 };
}


/**
 * Inventory alerts: medicines below reorder level (lowest stock first) and batches that are
 * expired or expire within `expiryDays` (soonest first).
 */
export async function getAlerts(orgId, { limit = 5, expiryDays } = {}, now = new Date(), org = null) {
  const settings = org?.settings || {};
  // The window is the organization's own largest expiry threshold (Common Settings -> settings.expiry, the same
  // numbers the Expiry Intelligence report uses - there is one set of these, not two). 90 days unless it changed them.
  expiryDays = expiryDays ?? settings.expiry?.thresholds?.[2] ?? EXPIRY_WINDOW_DAYS;
  const soon = addDays(now, expiryDays);
  const notifications = notificationFlags(settings);

  const [lowStock, expiring, lowCount, expiry] = await Promise.all([
    Medicine.aggregate([
      { $match: { organizationId: orgId, isActive: true } },
      ...sellableStockStages(now),
      { $match: lowStockMatch },
      { $sort: { availableStock: 1, medicineName: 1 } },
      { $limit: limit },
      { $project: { medicineName: 1, availableStock: 1, reorderLevel: 1 } },
    ]),
    Batch.aggregate([
      { $match: { organizationId: orgId, availableQuantity: { $gt: 0 }, status: { $ne: 'archived' }, expiryDate: { $lte: soon } } },
      { $sort: { expiryDate: 1 } },
      { $limit: limit },
      { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: 'm' } },
      { $project: { batchNumber: 1, expiryDate: 1, quantity: '$availableQuantity', name: { $first: '$m.medicineName' } } },
    ]),
    lowStockCount(orgId, now),
    expiryCounts(orgId, now, expiryDays),
  ]);

  return {
    // Which alerts this organization wants in the bell. The counts and lists below are always returned - the
    // dashboard cards read them too - so turning an alert off hides it from the bell, never from the figures.
    notifications,
    licenses: notifications.licenseExpiry ? licenceAlerts(org, now) : [],
    dailySummary: notifications.dailySummary ? await yesterdaySummary(orgId, org, now) : null,
    counts: { lowStock: lowCount, expiringSoon: expiry.expiringSoon, expired: expiry.expired },
    expiryWindowDays: expiryDays,
    lowStockItems: lowStock.map((m) => ({ id: m._id, name: m.medicineName, qty: m.availableStock, reorderLevel: m.reorderLevel })),
    expiringBatches: expiring.map((b) => ({
      id: b._id,
      name: b.name || 'Unknown',
      batchNumber: b.batchNumber,
      quantity: b.quantity,
      expiryDate: b.expiryDate,
      expired: b.expiryDate <= now,
    })),
  };
}
