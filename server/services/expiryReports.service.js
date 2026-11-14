import { Organization, StockMovement } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { round2 } from './analytics.service.js';
import { audit } from './audit.service.js';
import { applyFilters, assessedFor, expirySettings, filtersFrom, sortRows, storeLabel, totalsOf } from './analyticsExpiry.service.js';

/**
 * The reporting half of Inventory Expiry Intelligence: the charts beside the register, the calendar view of it, the
 * CSV export of it, and the organization's own thresholds.
 *
 * All of it is built from the SAME assessed rows the register is built from (see analyticsExpiry.service.js), so a
 * bar on a chart can never disagree with the list underneath it — the commonest way a dashboard quietly loses the
 * trust of the people who use it.
 *
 * There is one deliberate exception, and it is labelled as one wherever it appears: the loss trend reads what was
 * ACTUALLY written off in each of the last six months out of the stock ledger. Everything else on this screen is a
 * projection about the future; that one is a fact about the past, and it is here so the two can be compared.
 */

/* ------------------------------------------------------------------ the insights */

/** Whole months from now, as YYYY-MM keys. A quiet month comes back as a zero, never as a gap in the chart. */
function monthKeys(count, from = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
    out.push({ key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, at: d.toISOString() });
  }
  return out;
}

/** The biggest `n` entries of a map, by value at cost. */
const topBy = (map, n) => [...map.values()].sort((a, b) => b.costValue - a.costValue).slice(0, n);

const roundRows = (list) =>
  list.map((r) => ({
    ...r,
    costValue: round2(r.costValue),
    projectedLoss: round2(r.projectedLoss),
    ...(r.expiredValue === undefined ? {} : { expiredValue: round2(r.expiredValue) }),
  }));

/**
 * The four charts.
 *
 *   expiryByMonth    what expires each month for the next year — the wave, so a clearance push can be planned
 *   topManufacturers who the at-risk money sits with, which is what to stop over-ordering
 *   topSuppliers     the same by supplier, which is the figure to take into a conversation about returns
 *   lossTrend        what was really written off over the last six months
 */
export async function getExpiryInsights(org, user, query = {}, now = new Date()) {
  const { settings, rows, branches } = await assessedFor(org, user, query, now);
  const live = rows.filter((r) => r.status !== 'disposed' && r.status !== 'returned');
  const atRisk = live.filter((r) => r.bucket !== 'safe');

  // 1. The wave: stock on hand now, grouped by the month it expires in.
  const months = new Map(monthKeys(12, now).map(({ key, at }) => [key, { key, at, costValue: 0, mrpValue: 0, projectedLoss: 0, batches: 0, quantity: 0 }]));
  for (const r of live) {
    if (!r.expiryDate) continue;
    const m = months.get(r.expiryDate.slice(0, 7));
    if (!m) continue; // already expired, or more than a year out
    m.costValue += r.costValue;
    m.mrpValue += r.mrpValue;
    m.projectedLoss += r.projectedLoss;
    m.quantity += r.quantity;
    m.batches += 1;
  }

  // 2 and 3. Who the at-risk value sits with. "Not recorded" is a row in both, not a gap: a wholesaler with ₹46,000
  //          of at-risk stock and no supplier against it has a real problem, and hiding it would be the wrong kindness.
  const byMaker = new Map();
  const bySupplier = new Map();
  for (const r of atRisk) {
    const maker = r.manufacturer || 'Not recorded';
    if (!byMaker.has(maker)) byMaker.set(maker, { id: maker, label: maker, costValue: 0, projectedLoss: 0, batches: 0 });
    const a = byMaker.get(maker);
    a.costValue += r.costValue;
    a.projectedLoss += r.projectedLoss;
    a.batches += 1;

    const sid = r.supplierId || 'none';
    if (!bySupplier.has(sid)) bySupplier.set(sid, { id: sid, label: r.supplierName || 'Supplier not recorded', costValue: 0, projectedLoss: 0, expiredValue: 0, batches: 0 });
    const s = bySupplier.get(sid);
    s.costValue += r.costValue;
    s.projectedLoss += r.projectedLoss;
    s.batches += 1;
    if (r.bucket === 'expired') s.expiredValue += r.costValue;
  }

  // 4. What was actually written off, month by month. History, from the ledger, valued at what the stock cost.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const writeOffs = await StockMovement.aggregate([
    { $match: { organizationId: org._id, type: 'WRITE_OFF', createdAt: { $gte: since }, ...(branches ? { branchId: { $in: branches } } : {}) } },
    { $lookup: { from: 'batches', localField: 'batchId', foreignField: '_id', as: 'b', pipeline: [{ $project: { purchasePrice: 1 } }] } },
    {
      $group: {
        _id: { $dateToString: { date: '$createdAt', format: '%Y-%m' } },
        units: { $sum: { $abs: '$quantity' } },
        value: { $sum: { $multiply: [{ $abs: '$quantity' }, { $ifNull: [{ $first: '$b.purchasePrice' }, 0] }] } },
        events: { $sum: 1 },
      },
    },
  ]).allowDiskUse(true);

  const lossByMonth = new Map(writeOffs.map((w) => [w._id, w]));
  const lossTrend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const hit = lossByMonth.get(key);
    lossTrend.push({ key, at: d.toISOString(), value: round2(hit?.value), units: hit?.units || 0, events: hit?.events || 0 });
  }

  return {
    settings,
    generatedAt: now.toISOString(),
    expiryByMonth: [...months.values()].map((m) => ({ ...m, costValue: round2(m.costValue), mrpValue: round2(m.mrpValue), projectedLoss: round2(m.projectedLoss) })),
    topManufacturers: roundRows(topBy(byMaker, 10)),
    topSuppliers: roundRows(topBy(bySupplier, 10)),
    lossTrend,
    // Each chart carries its own caveat, so nobody has to guess what a bar means.
    notes: {
      expiryByMonth: 'Stock on hand now, grouped by the month it expires in. A position, not a forecast of what will be bought.',
      topManufacturers: 'At-risk stock by the company that made it — what to think twice about before re-ordering.',
      topSuppliers: 'At-risk stock by the supplier it was received from — the figure to take into a conversation about returns.',
      lossTrend: 'What was actually written off each month, valued at what it cost. Unlike everything else here this is history, not a projection.',
    },
  };
}

/* ------------------------------------------------------------------ the calendar */

const RISK_RANK = { critical: 4, high: 3, medium: 2, low: 1, safe: 0 };

/**
 * One month of expiries, day by day, for the heatmap.
 *
 * The table answers "what do I deal with first". This answers a different question — "when does the wave hit" —
 * which is the one that matters when planning a clearance push or a collection run with a distributor. Four hundred
 * dates in a list is noise; a month you can point at is a plan.
 */
export async function getExpiryCalendar(org, user, query = {}, now = new Date()) {
  const { settings, rows } = await assessedFor(org, user, query, now);
  // The filters apply here too, so the calendar always shows the same stock the table would.
  const live = applyFilters(rows, filtersFrom(query)).filter((r) => r.status !== 'disposed' && r.status !== 'returned');

  const m = /^(\d{4})-(\d{2})$/.exec(query.month || '');
  const year = m ? Number(m[1]) : now.getUTCFullYear();
  const month = m ? Number(m[2]) - 1 : now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));

  const days = new Map();
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), costValue: 0, mrpValue: 0, projectedLoss: 0, batches: 0, quantity: 0, worstRisk: null });
  }

  for (const r of live) {
    if (!r.expiryDate) continue;
    const day = days.get(r.expiryDate.slice(0, 10));
    if (!day) continue;
    day.costValue += r.costValue;
    day.mrpValue += r.mrpValue;
    day.projectedLoss += r.projectedLoss;
    day.quantity += r.quantity;
    day.batches += 1;
    if (!day.worstRisk || RISK_RANK[r.riskLevel] > RISK_RANK[day.worstRisk]) day.worstRisk = r.riskLevel;
  }

  const list = [...days.values()].map((d) => ({ ...d, costValue: round2(d.costValue), mrpValue: round2(d.mrpValue), projectedLoss: round2(d.projectedLoss) }));
  // Which months hold anything at all, so the arrows can skip the empty ones rather than walking through years of nothing.
  const monthsWithStock = [...new Set(live.map((r) => r.expiryDate?.slice(0, 7)).filter(Boolean))].sort();

  return {
    settings,
    month: `${year}-${String(month + 1).padStart(2, '0')}`,
    // The weekday the month opens on (0 = Sunday), so the grid lays itself out without the browser recomputing it.
    startWeekday: start.getUTCDay(),
    days: list,
    busiest: list.reduce((best, d) => (d.batches && (!best || d.costValue > best.costValue) ? d : best), null),
    monthsWithStock,
    totals: {
      costValue: round2(list.reduce((n, d) => n + d.costValue, 0)),
      projectedLoss: round2(list.reduce((n, d) => n + d.projectedLoss, 0)),
      batches: list.reduce((n, d) => n + d.batches, 0),
    },
    generatedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

/** The columns of the exported register, in the order someone reading the file would want them. */
const EXPORT_COLUMNS = [
  ['Medicine', (r) => r.medicineName],
  ['Generic', (r) => r.genericName],
  ['Strength', (r) => r.strength],
  ['Pack', (r) => r.packSize],
  ['Category', (r) => r.categoryName],
  ['Company', (r) => r.manufacturer],
  ['Schedule', (r) => r.scheduleCategory],
  ['HSN', (r) => r.hsnCode],
  ['Batch', (r) => r.batchNumber],
  ['Supplier', (r) => r.supplierName || 'Not recorded'],
  ['Store', (r) => r.branchName],
  ['Expiry', (r) => (r.expiryDate ? r.expiryDate.slice(0, 10) : '')],
  ['Days to expiry', (r) => r.daysToExpiry],
  ['Quantity', (r) => r.quantity],
  ['Unit', (r) => r.unit],
  ['Avg sales a day', (r) => r.avgDailySales],
  ['Likely to sell', (r) => r.expectedSales],
  ['Likely unsold', (r) => r.projectedUnsoldQty],
  ['Cost each (INR)', (r) => r.purchasePrice.toFixed(2)],
  ['MRP (INR)', (r) => r.mrp.toFixed(2)],
  ['Value at cost (INR)', (r) => r.costValue.toFixed(2)],
  ['Value at MRP (INR)', (r) => r.mrpValue.toFixed(2)],
  ['Projected loss (INR)', (r) => r.projectedLoss.toFixed(2)],
  ['Risk score', (r) => r.riskScore],
  ['Risk level', (r) => r.riskLevel],
  ['Suggested discount %', (r) => r.suggestedDiscount],
  ['Recoverable from supplier', (r) => (r.recoverable ? 'Yes' : 'No')],
  ['Status', (r) => r.status],
  ['On clearance', (r) => (r.clearanceFlagged ? `Yes (${r.clearanceDiscount ?? '-'}%)` : 'No')],
  ['Supplier return', (r) => r.supplierReturnStatus || ''],
];

/**
 * The register as a CSV file: EVERY lot the filters match, not the page on screen, carrying the same figures the
 * screen carries.
 *
 * The file opens with a block saying what it is a report OF — which organization, which store, which filters, and
 * the velocity window the projections were worked out over. A copy forwarded to a supplier or an accountant has to
 * still explain itself a month later, when nobody remembers what was on screen when it was made.
 *
 * Only CSV. A spreadsheet writer would mean a new dependency and a second code path for the same numbers to drift
 * down; a CSV opens in Excel and cannot disagree with itself.
 */
export async function exportExpiryRegister(org, user, query = {}, now = new Date()) {
  if (query.format && query.format !== 'csv') {
    throw new ApiError(
      400,
      `This report exports as CSV. ${String(query.format).toUpperCase()} is not available — a CSV file opens in Excel and carries exactly what the screen shows.`,
      [{ path: 'format', message: 'Use format=csv' }],
      'FORMAT_UNAVAILABLE',
    );
  }

  const { settings, rows, branches, tz } = await assessedFor(org, user, query, now);
  const filters = filtersFrom(query);
  const matched = sortRows(applyFilters(rows, filters), query.sortBy, query.sortDir);

  if (matched.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} lots. Narrow the filters or choose a single store, then export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }

  const totals = totalsOf(matched, settings);
  const head = [
    ['Usha Pharmacy — Inventory Expiry Intelligence'],
    ['Organization', org?.name || ''],
    ['GSTIN', org?.gstin || '—'],
    ['Store', await storeLabel(org._id, query.branchId, branches)],
    ['Generated', localDateTime(now, tz)],
    ['Timezone', tz],
    ['Status filter', filters.status || 'All stock (disposed lots excluded)'],
    ['Search', filters.search || '—'],
    ['Company', filters.manufacturer || 'Any'],
    ['Supplier', filters.supplierId === 'none' ? 'No supplier recorded' : filters.supplierId ? matched[0]?.supplierName || filters.supplierId : 'Any'],
    ['Schedule', filters.scheduleCategory || 'Any'],
    ['Risk level', filters.riskLevel || 'Any'],
    ['Minimum value (INR)', filters.minValue === null ? 'Any' : String(filters.minValue)],
    ['Expiring between', `${filters.expiryFrom || 'any date'} and ${filters.expiryTo || 'any date'}`],
    ['Velocity window (days)', String(settings.velocityWindowDays)],
    ['Lots', String(matched.length)],
    ['Total value at cost (INR)', totals.costValue.toFixed(2)],
    ['Total value at MRP (INR)', totals.mrpValue.toFixed(2)],
    ['Total projected loss (INR)', totals.projectedLoss.toFixed(2)],
    [],
  ];

  return {
    csv: toCsv([...head, EXPORT_COLUMNS.map(([h]) => h), ...matched.map((r) => EXPORT_COLUMNS.map(([, read]) => read(r)))]),
    fileName: `usha-expiry-${fileStamp(tz, now)}.csv`,
    rows: matched.length,
  };
}

/* ------------------------------------------------------------------ the settings */

/**
 * The organization's own definitions of "soon" and "selling well".
 *
 * These are per-organization on purpose. A retail chemist turning stock over in a fortnight and a wholesaler holding
 * a quarter's supply do not mean the same thing by "expiring soon", and one hard-coded set of thresholds would make
 * the report quietly wrong for one of them. Changing them changes every figure on the screen, so it is audited.
 */
export async function updateExpirySettings(req, body) {
  const expiry = {
    thresholds: body.thresholds,
    velocityWindowDays: body.velocityWindowDays,
    supplierReturnWindowDays: body.supplierReturnWindowDays,
    clearanceMaxDiscount: body.clearanceMaxDiscount,
  };

  const org = await Organization.findOneAndUpdate(
    { _id: req.tenant.organizationId },
    { $set: { 'settings.expiry': expiry } },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!org) throw new ApiError(404, 'Organization not found');

  await audit(req, {
    action: 'EXPIRY_SETTINGS_UPDATE',
    entity: 'Organization',
    entityId: org._id,
    message:
      `Expiry settings changed — buckets ${expiry.thresholds.join(' / ')} days, ` +
      `velocity window ${expiry.velocityWindowDays} days, supplier return window ${expiry.supplierReturnWindowDays} days, ` +
      `clearance capped at ${expiry.clearanceMaxDiscount}%`,
    meta: expiry,
  });
  return expirySettings(org);
}
