import mongoose from 'mongoose';
import { Batch, Branch, DRUG_SCHEDULES, Invoice } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { orgTimezone } from './organization.service.js';
import { reportableBranches, round2 } from './analytics.service.js';
import { BUCKETS, BUCKETS_AT_LEAST, RISK_LEVELS, allocateFefo, assessBatch } from './expiryRisk.js';

/**
 * Inventory Expiry Intelligence — the service behind the Business Analytics screen of the same name.
 *
 * WHAT MAKES THIS DIFFERENT FROM AN EXPIRY LIST
 * Listing what expires soon is easy. It is also nearly useless on its own: a wholesaler with four hundred lots on the
 * list still does not know which three to deal with this morning. So every lot here carries what it is LIKELY TO SELL
 * before it expires, what will be left when it does, and what that costs — see expiryRisk.js, which holds the maths
 * and is unit-tested on its own.
 *
 * HOW IT IS COMPUTED, AND WHY IT IS SHAPED THIS WAY
 * Two aggregations run in the database, both scoped to one organization and to the stores the person may report on:
 *
 *   1. the lots themselves, joined to their medicine, category, supplier and store;
 *   2. how fast each MEDICINE sells in each STORE, over the organization's velocity window, from completed invoices.
 *
 * The demand is then shared across each medicine's lots in Node, earliest expiry first. That last step is deliberately
 * not a database expression: FEFO allocation is recursive — once a lot expires with units left, those units are dead
 * and the lot behind it does not inherit them — and the closed form that would let `$setWindowFields` do it is wrong
 * in exactly that case. It is still one pass over one result set, not a query per lot.
 *
 * A lot hidden by a filter still takes its share of the demand before the lots behind it, so the whole scoped set is
 * assessed first and the filters are applied to the ASSESSED rows. `MAX_BATCHES` bounds that set; past it the caller
 * is asked to narrow to one store rather than being handed a slow page.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How many lots one question may consider. Comfortably past a large wholesaler's live stock; a guard, not a budget. */
export const MAX_BATCHES = 25000;

/** What the register can be sorted by, and what each one reads on an assessed row. */
export const EXPIRY_SORTABLE = ['risk', 'expiry', 'value', 'loss', 'quantity', 'medicine', 'batch'];
const SORT_READ = {
  risk: (r) => r.riskScore,
  expiry: (r) => (r.daysToExpiry === null ? Number.MAX_SAFE_INTEGER : r.daysToExpiry),
  value: (r) => r.costValue,
  loss: (r) => r.projectedLoss,
  quantity: (r) => r.quantity,
  medicine: (r) => r.medicineName?.toLowerCase() || '',
  batch: (r) => r.batchNumber?.toLowerCase() || '',
};

/** The ways the register can be grouped. `none` is the flat table. */
export const EXPIRY_GROUP_BY = ['none', 'company', 'supplier', 'category'];
const GROUP_READ = {
  company: (r) => [r.manufacturer || '', r.manufacturer || 'Manufacturer not recorded'],
  supplier: (r) => [r.supplierId || '', r.supplierName || 'Supplier not recorded'],
  category: (r) => [r.categoryId || '', r.categoryName || 'Category not set'],
};

/** The statuses a lot can be listed under. These are states of the LOT, not of its expiry date. */
export const EXPIRY_STATUSES = ['all', ...BUCKETS, 'disposed', 'returned', 'clearance', 'quarantined'];

/* ------------------------------------------------------------------ reading the records */

/** The organization's own definitions of "soon" and "selling well", with the defaults the schema promises. */
export function expirySettings(org) {
  const s = org?.settings?.expiry || {};
  const thresholds = Array.isArray(s.thresholds) && s.thresholds.length === 3 ? s.thresholds.map(Number) : [15, 30, 90];
  return {
    thresholds,
    velocityWindowDays: Number(s.velocityWindowDays) || 60,
    supplierReturnWindowDays: s.supplierReturnWindowDays === undefined ? 90 : Number(s.supplierReturnWindowDays),
    clearanceMaxDiscount: Number(s.clearanceMaxDiscount) || 50,
  };
}

/**
 * Every lot this question could possibly be about, with the details the register shows.
 *
 * A lot that holds nothing and nothing has been done to is left out — an empty, in-date lot is not news. A lot this
 * report finished off, by writing it off or sending it back, is kept however empty it is, because the point of that
 * record is precisely that it happened and somebody may need to find it again.
 */
async function loadBatches(orgId, branches) {
  const rows = await Batch.aggregate([
    {
      $match: {
        organizationId: orgId,
        ...(branches ? { branchId: { $in: branches } } : {}),
        $or: [
          // Live stock: anything still on the shelf that has not been archived away.
          { status: { $ne: 'archived' }, availableQuantity: { $gt: 0 } },
          // And anything this report itself finished off. Disposing of a lot and sending it back both archive it and
          // leave it empty, which the first clause excludes — but the whole point of those records is that they
          // happened, so they stay findable under "Disposed" and "Returned to supplier".
          { disposedAt: { $type: 'date' } },
          { 'supplierReturn.status': { $type: 'string' } },
        ],
      },
    },
    { $limit: MAX_BATCHES + 1 },
    {
      $lookup: {
        from: 'medicines',
        localField: 'medicineId',
        foreignField: '_id',
        as: 'medicine',
        pipeline: [{ $project: { medicineName: 1, genericName: 1, manufacturer: 1, company: 1, categoryId: 1, hsnCode: 1, strength: 1, packSize: 1, unit: 1, scheduleCategory: 1, reorderLevel: 1 } }],
      },
    },
    { $unwind: { path: '$medicine', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'attributes', localField: 'medicine.categoryId', foreignField: '_id', as: 'category', pipeline: [{ $project: { attributeName: 1 } }] } },
    { $lookup: { from: 'suppliers', localField: 'supplierId', foreignField: '_id', as: 'supplier', pipeline: [{ $project: { name: 1, code: 1 } }] } },
    { $lookup: { from: 'branches', localField: 'branchId', foreignField: '_id', as: 'branch', pipeline: [{ $project: { name: 1 } }] } },
    {
      $project: {
        _id: 1,
        medicineId: 1,
        branchId: 1,
        batchNumber: 1,
        expiryDate: 1,
        manufacturingDate: 1,
        createdAt: 1,
        purchasePrice: 1,
        sellingPrice: 1,
        mrp: 1,
        availableQuantity: 1,
        reservedQuantity: 1,
        initialQuantity: 1,
        status: 1,
        supplierId: 1,
        disposedAt: 1,
        disposalReason: 1,
        clearance: 1,
        supplierReturn: 1,
        medicineName: { $ifNull: ['$medicine.medicineName', 'Unknown medicine'] },
        genericName: { $ifNull: ['$medicine.genericName', ''] },
        // The lot records the manufacturer that was on the pack it arrived in; the catalogue's is the fallback.
        manufacturer: { $ifNull: [{ $cond: [{ $gt: ['$manufacturer', ''] }, '$manufacturer', null] }, { $ifNull: ['$medicine.manufacturer', ''] }] },
        company: { $ifNull: ['$medicine.company', ''] },
        categoryId: '$medicine.categoryId',
        categoryName: { $ifNull: [{ $first: '$category.attributeName' }, ''] },
        hsnCode: { $ifNull: ['$medicine.hsnCode', ''] },
        strength: { $ifNull: ['$medicine.strength', ''] },
        packSize: { $ifNull: ['$medicine.packSize', ''] },
        unit: { $ifNull: ['$medicine.unit', ''] },
        scheduleCategory: { $ifNull: ['$medicine.scheduleCategory', ''] },
        supplierName: { $ifNull: [{ $first: '$supplier.name' }, ''] },
        branchName: { $ifNull: [{ $first: '$branch.name' }, ''] },
      },
    },
  ]).allowDiskUse(true);

  if (rows.length > MAX_BATCHES) {
    throw new ApiError(
      400,
      `This organization holds more than ${MAX_BATCHES.toLocaleString('en-IN')} live lots. Choose a single store to report on.`,
      undefined,
      'TOO_MANY_BATCHES',
    );
  }
  return rows;
}

/**
 * How fast each medicine sells in each store: units a day over the velocity window, from COMPLETED invoices only.
 * A draft was never issued and a cancelled or reversed one did not happen, so neither says anything about demand.
 *
 * The rate is deliberately measured over the WHOLE window rather than over the days a medicine happened to sell on.
 * A product that sold forty units on one day of sixty sells less than one a day, and saying otherwise would quietly
 * hide a slow mover.
 */
async function loadVelocity(orgId, branches, windowDays, now) {
  const since = new Date(now.getTime() - windowDays * 86400000);
  const rows = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: since, $lte: now }, ...(branches ? { branchId: { $in: branches } } : {}) } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { medicineId: '$items.medicineId', branchId: '$branchId' },
        // Units the customer kept: what was billed, less anything brought back on that line.
        units: { $sum: { $max: [0, { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] }] } },
      },
    },
  ]).allowDiskUse(true);

  const map = new Map();
  for (const r of rows) map.set(`${r._id.medicineId}|${r._id.branchId || ''}`, r.units / windowDays);
  return map;
}

/* ------------------------------------------------------------------ putting it together */

/** The key a lot is allocated under: demand belongs to one medicine in one store, never to a lot. */
const demandKey = (b) => `${b.medicineId}|${b.branchId || ''}`;

/**
 * Assesses every lot: shares each medicine's demand across its lots earliest-expiry-first, then works out what that
 * means for each one. One pass over the whole scoped set, so the figures on a filtered page still describe lots
 * correctly — a lot the filters hide has already taken its share of the demand.
 */
export function assessAll(batches, velocity, settings, now = new Date()) {
  const groups = new Map();
  for (const b of batches) {
    const key = demandKey(b);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const assessed = [];
  for (const [key, lots] of groups) {
    const avgDailySales = velocity.get(key) || 0;
    // A disposed lot holds nothing and competes for no demand; it is reported, not allocated.
    const live = lots.filter((b) => !b.disposedAt);
    const allocations = allocateFefo(live.map((b) => ({ expiryDate: b.expiryDate, quantity: b.availableQuantity })), avgDailySales, now);
    const byId = new Map(live.map((b, i) => [String(b._id), allocations[i]]));

    for (const b of lots) {
      const allocation = byId.get(String(b._id)) || { daysToExpiry: null, expectedSales: 0, projectedUnsoldQty: 0 };
      const quantity = b.disposedAt ? 0 : b.availableQuantity;
      const risk = assessBatch(
        { quantity, purchasePrice: b.purchasePrice, mrp: b.mrp, supplierId: b.supplierId, disposedAt: b.disposedAt, supplierReturn: b.supplierReturn },
        { ...allocation, avgDailySales },
        settings,
      );
      assessed.push(presentRow(b, risk, avgDailySales));
    }
  }
  return assessed;
}

/** One row of the register, exactly as the client receives it. */
function presentRow(b, risk, avgDailySales) {
  const returnStatus = b.supplierReturn?.status || null;
  return {
    id: String(b._id),
    medicineId: String(b.medicineId),
    medicineName: b.medicineName,
    genericName: b.genericName,
    strength: b.strength,
    packSize: b.packSize,
    unit: b.unit || 'units',
    categoryId: b.categoryId ? String(b.categoryId) : null,
    categoryName: b.categoryName,
    manufacturer: b.manufacturer,
    company: b.company,
    hsnCode: b.hsnCode,
    scheduleCategory: b.scheduleCategory,

    batchNumber: b.batchNumber,
    expiryDate: b.expiryDate ? b.expiryDate.toISOString() : null,
    receivedAt: b.createdAt ? b.createdAt.toISOString() : null,
    supplierId: b.supplierId ? String(b.supplierId) : null,
    supplierName: b.supplierName,
    branchId: b.branchId ? String(b.branchId) : null,
    branchName: b.branchName,

    quantity: b.disposedAt ? 0 : b.availableQuantity,
    reservedQuantity: b.reservedQuantity || 0,
    initialQuantity: b.initialQuantity,
    purchasePrice: round2(b.purchasePrice),
    sellingPrice: round2(b.sellingPrice),
    mrp: round2(b.mrp),
    avgDailySales: round2(avgDailySales),

    ...risk,

    batchStatus: b.status,
    disposedAt: b.disposedAt ? b.disposedAt.toISOString() : null,
    disposalReason: b.disposalReason || null,
    clearanceFlagged: Boolean(b.clearance?.flagged),
    clearanceDiscount: b.clearance?.flagged ? (b.clearance.discountPercent ?? null) : null,
    supplierReturnStatus: returnStatus,
    /** What the row IS, for the status filter and the badge: the strongest true thing about it. */
    status: b.disposedAt ? 'disposed' : returnStatus === 'returned' ? 'returned' : b.clearance?.flagged ? 'clearance' : b.status === 'quarantined' ? 'quarantined' : risk.bucket,
  };
}

/* ------------------------------------------------------------------ filtering, sorting, paging */

/** What the person asked for, narrowed to what the data can answer. */
export function filtersFrom(query) {
  return {
    status: query.status && query.status !== 'all' ? query.status : null,
    search: query.search ? String(query.search).trim() : null,
    categoryId: query.categoryId || null,
    manufacturer: query.manufacturer ? String(query.manufacturer).trim() : null,
    supplierId: query.supplierId || null,
    scheduleCategory: query.scheduleCategory || null,
    riskLevel: query.riskLevel || null,
    minValue: query.minValue === undefined || query.minValue === null || query.minValue === '' ? null : Number(query.minValue),
    expiryFrom: query.expiryFrom || null,
    expiryTo: query.expiryTo || null,
  };
}

/**
 * Applies the filters to the assessed rows. A status filter that names a bucket means "at least this urgent", because
 * that is what clicking the card above the table means to the person who clicked it; the lot states (disposed,
 * returned, on clearance, quarantined) are exact.
 */
export function applyFilters(rows, f) {
  let out = rows;
  if (f.status) {
    if (BUCKETS_AT_LEAST[f.status]) {
      const wanted = new Set(BUCKETS_AT_LEAST[f.status]);
      // A lot that has been disposed of or sent back is no longer part of the expiry picture.
      out = out.filter((r) => wanted.has(r.bucket) && r.status !== 'disposed' && r.status !== 'returned');
    } else {
      out = out.filter((r) => r.status === f.status);
    }
  } else {
    // "All stock" means stock: a disposed lot is shown only when it is asked for by name.
    out = out.filter((r) => r.status !== 'disposed');
  }

  if (f.search) {
    const re = new RegExp(escapeRe(f.search), 'i');
    out = out.filter((r) => re.test(r.medicineName) || re.test(r.batchNumber) || re.test(r.categoryName) || re.test(r.manufacturer) || re.test(r.supplierName) || re.test(r.hsnCode) || re.test(r.genericName));
  }
  if (f.categoryId) out = out.filter((r) => r.categoryId === f.categoryId);
  if (f.manufacturer) out = out.filter((r) => r.manufacturer === f.manufacturer);
  if (f.supplierId) out = out.filter((r) => (f.supplierId === 'none' ? !r.supplierId : r.supplierId === f.supplierId));
  if (f.scheduleCategory) out = out.filter((r) => r.scheduleCategory === f.scheduleCategory);
  if (f.riskLevel) out = out.filter((r) => r.riskLevel === f.riskLevel);
  if (f.minValue !== null && !Number.isNaN(f.minValue)) out = out.filter((r) => r.costValue >= f.minValue);
  if (f.expiryFrom) out = out.filter((r) => r.expiryDate && r.expiryDate.slice(0, 10) >= f.expiryFrom);
  if (f.expiryTo) out = out.filter((r) => r.expiryDate && r.expiryDate.slice(0, 10) <= f.expiryTo);
  return out;
}

/** Sorts in place by one of the columns, with a stable tiebreak so paging never shows a row twice. */
export function sortRows(rows, sortBy = 'risk', sortDir = 'desc') {
  const read = SORT_READ[sortBy] || SORT_READ.risk;
  const dir = sortDir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = read(a);
    const y = read(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return a.id < b.id ? -1 : 1;
  });
}

/** The totals of a set of rows — what the cards above the table add up to for the question being asked. */
export function totalsOf(rows, settings) {
  const t = {
    batches: rows.length,
    quantity: 0,
    costValue: 0,
    mrpValue: 0,
    projectedLoss: 0,
    projectedUnsoldQty: 0,
    recoverableValue: 0,
    recoverableBatches: 0,
    noSupplierValue: 0,
    noSupplierBatches: 0,
    byBucket: Object.fromEntries(BUCKETS.map((b) => [b, { batches: 0, quantity: 0, costValue: 0, mrpValue: 0 }])),
    byRisk: Object.fromEntries(RISK_LEVELS.map((l) => [l, 0])),
  };
  for (const r of rows) {
    t.quantity += r.quantity;
    t.costValue += r.costValue;
    t.mrpValue += r.mrpValue;
    t.projectedLoss += r.projectedLoss;
    t.projectedUnsoldQty += r.projectedUnsoldQty;
    if (r.recoverable) {
      t.recoverableValue += r.costValue;
      t.recoverableBatches += 1;
    } else if (!r.supplierId && r.bucket !== 'safe') {
      t.noSupplierValue += r.costValue;
      t.noSupplierBatches += 1;
    }
    const bucket = t.byBucket[r.bucket];
    if (bucket) {
      bucket.batches += 1;
      bucket.quantity += r.quantity;
      bucket.costValue += r.costValue;
      bucket.mrpValue += r.mrpValue;
    }
    t.byRisk[r.riskLevel] = (t.byRisk[r.riskLevel] || 0) + 1;
  }
  for (const key of ['costValue', 'mrpValue', 'projectedLoss', 'projectedUnsoldQty', 'recoverableValue', 'noSupplierValue']) t[key] = round2(t[key]);
  for (const b of Object.values(t.byBucket)) {
    b.costValue = round2(b.costValue);
    b.mrpValue = round2(b.mrpValue);
  }
  t.settings = settings;
  return t;
}

/** Collapses the rows into the groups the register shows, each with its own subtotals. */
export function groupRows(rows, groupBy) {
  const read = GROUP_READ[groupBy];
  if (!read) return null;
  const groups = new Map();
  for (const r of rows) {
    const [id, label] = read(r);
    if (!groups.has(id)) groups.set(id, { id: id || null, label, batches: 0, quantity: 0, costValue: 0, mrpValue: 0, projectedLoss: 0, criticalBatches: 0 });
    const g = groups.get(id);
    g.batches += 1;
    g.quantity += r.quantity;
    g.costValue += r.costValue;
    g.mrpValue += r.mrpValue;
    g.projectedLoss += r.projectedLoss;
    if (r.riskLevel === 'critical') g.criticalBatches += 1;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, costValue: round2(g.costValue), mrpValue: round2(g.mrpValue), projectedLoss: round2(g.projectedLoss) }))
    .sort((a, b) => b.costValue - a.costValue);
}

/* ------------------------------------------------------------------ the shared first half of every request */

/**
 * Everything every endpoint on this report needs: the organization's settings, the stores the person may report on,
 * and every lot in those stores already assessed. Each endpoint then asks its own question of the same set, so the
 * cards, the table, the charts and the CSV can never contradict one another.
 */
export async function assessedFor(org, user, query = {}, now = new Date()) {
  const orgId = org._id;
  const settings = expirySettings(org);
  const branches = reportableBranches(user, query.branchId);
  const [batches, velocity] = await Promise.all([
    loadBatches(orgId, branches),
    loadVelocity(orgId, branches, settings.velocityWindowDays, now),
  ]);
  return { settings, branches, rows: assessAll(batches, velocity, settings, now), tz: orgTimezone(org) };
}

/** The name of the store being reported on, for the header of an export or a printed sheet. */
export async function storeLabel(orgId, requested, branches) {
  if (requested) {
    const b = await Branch.findOne({ _id: oid(requested), organizationId: orgId }).select('name').lean();
    return b?.name || 'Unknown store';
  }
  return branches ? 'Your stores' : 'All stores';
}

/* ------------------------------------------------------------------ the endpoints */

/**
 * The figures above the table: how much is expired or expiring, what it is worth at cost and at MRP, how much of it a
 * supplier might still take back, and how much is projected to be lost outright.
 *
 * The cards describe the whole scoped set, not the filtered page — they are what the filters are applied TO.
 */
export async function getExpirySummary(org, user, query = {}, now = new Date()) {
  const { settings, rows, branches } = await assessedFor(org, user, query, now);
  const live = rows.filter((r) => r.status !== 'disposed' && r.status !== 'returned');
  const totals = totalsOf(live, settings);
  const [near, soon, later] = settings.thresholds;

  /** A card: what it counts, what that is worth, and the filter clicking it applies. */
  const card = (key, label, bucket, description) => {
    const atLeast = BUCKETS_AT_LEAST[bucket].reduce(
      (acc, b) => ({ batches: acc.batches + totals.byBucket[b].batches, quantity: acc.quantity + totals.byBucket[b].quantity, costValue: acc.costValue + totals.byBucket[b].costValue, mrpValue: acc.mrpValue + totals.byBucket[b].mrpValue }),
      { batches: 0, quantity: 0, costValue: 0, mrpValue: 0 },
    );
    return { key, label, filter: bucket, description, ...atLeast, costValue: round2(atLeast.costValue), mrpValue: round2(atLeast.mrpValue) };
  };

  return {
    settings,
    scope: { branchId: query.branchId || null, allStores: !branches },
    generatedAt: now.toISOString(),
    cards: [
      // The labels are SHORT on purpose: three cards reading "Expiring in under N days" truncate to the same
      // "Expiring in un…" at normal widths, which makes three different figures look like one. The full sentence
      // lives in `description`, where the screen reader and the tooltip find it.
      card('expired', 'Already expired', 'expired', 'Lots whose date has passed while they still hold stock. They cannot be sold and need disposing of or sending back.'),
      card('under15', `Under ${near} days`, 'under15', `Everything that expires within ${near} days, including what has already expired.`),
      card('under30', `Under ${soon} days`, 'under30', `Everything that expires within ${soon} days, including the more urgent buckets.`),
      card('under90', `Under ${later} days`, 'under90', `Everything that expires within ${later} days, including the more urgent buckets.`),
    ],
    valueAtRisk: {
      // "At risk" is everything inside the longest bucket, including what has already expired.
      cost: round2(BUCKETS_AT_LEAST.under90.reduce((n, b) => n + totals.byBucket[b].costValue, 0)),
      mrp: round2(BUCKETS_AT_LEAST.under90.reduce((n, b) => n + totals.byBucket[b].mrpValue, 0)),
      batches: BUCKETS_AT_LEAST.under90.reduce((n, b) => n + totals.byBucket[b].batches, 0),
      description: `Every lot expiring within ${later} days, at what it cost and at what it would have retailed for.`,
    },
    recoverable: {
      value: totals.recoverableValue,
      batches: totals.recoverableBatches,
      windowDays: settings.supplierReturnWindowDays,
      description: `Stock with a supplier on record whose expiry falls within ${settings.supplierReturnWindowDays} days either side of today — the window a distributor will normally still take it back in.`,
      noSupplier: {
        value: totals.noSupplierValue,
        batches: totals.noSupplierBatches,
        description: 'At-risk stock with no supplier recorded against the lot. There is nobody to send it back to, so none of it can be recovered that way.',
      },
    },
    projectedLoss: {
      value: totals.projectedLoss,
      quantity: totals.projectedUnsoldQty,
      velocityWindowDays: settings.velocityWindowDays,
      description: `Stock not expected to sell before it expires, at what it cost. Demand is measured per medicine per store over the last ${settings.velocityWindowDays} days and shared across that medicine's lots earliest-expiry-first.`,
    },
    totals,
  };
}

/**
 * One page of the Risk Inventory Register: the lots the filters match, sorted as asked, with the totals for the WHOLE
 * filtered set (not the page) and, when grouping is on, a subtotal per group.
 */
export async function getExpiryBatches(org, user, query = {}, now = new Date()) {
  const { settings, rows } = await assessedFor(org, user, query, now);
  const filters = filtersFrom(query);
  const matched = sortRows(applyFilters(rows, filters), query.sortBy, query.sortDir);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
  const groupBy = EXPIRY_GROUP_BY.includes(query.groupBy) ? query.groupBy : 'none';

  return {
    items: matched.slice((page - 1) * limit, page * limit),
    groups: groupBy === 'none' ? null : groupRows(matched, groupBy),
    groupBy,
    totals: totalsOf(matched, settings),
    filters: { ...filters, branchId: query.branchId || null, sortBy: query.sortBy || 'risk', sortDir: query.sortDir || 'desc', groupBy },
    options: optionsFrom(rows, settings),
    page,
    limit,
    pages: Math.max(1, Math.ceil(matched.length / limit)),
    total: matched.length,
    generatedAt: now.toISOString(),
  };
}

/**
 * The values the dropdowns offer — taken from the lots this person can actually see, so a filter never offers a
 * choice that would return nothing, and never hides one that would.
 */
function optionsFrom(rows, settings) {
  const uniqueBy = (read) => {
    const seen = new Map();
    for (const r of rows) {
      const [value, label] = read(r);
      if (value && !seen.has(value)) seen.set(value, label);
    }
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  };
  const [near, soon, later] = settings.thresholds;
  return {
    statuses: [
      { value: 'all', label: 'All stock' },
      { value: 'expired', label: 'Expired' },
      { value: 'under15', label: `Under ${near} days` },
      { value: 'under30', label: `Under ${soon} days` },
      { value: 'under90', label: `Under ${later} days` },
      { value: 'safe', label: 'Safe' },
      { value: 'clearance', label: 'On clearance' },
      { value: 'quarantined', label: 'Quarantined' },
      { value: 'returned', label: 'Returned to supplier' },
      { value: 'disposed', label: 'Disposed' },
    ],
    riskLevels: RISK_LEVELS.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
    categories: uniqueBy((r) => [r.categoryId, r.categoryName || 'Category not set']),
    manufacturers: uniqueBy((r) => [r.manufacturer, r.manufacturer]),
    suppliers: [...uniqueBy((r) => [r.supplierId, r.supplierName || 'Unknown supplier']), { value: 'none', label: 'No supplier recorded' }],
    schedules: DRUG_SCHEDULES.filter(Boolean).map((value) => ({ value, label: value === 'OTC' ? 'Over the counter' : `Schedule ${value}` })),
    groupBy: [
      { value: 'none', label: 'All medicines' },
      { value: 'company', label: 'Group by company' },
      { value: 'supplier', label: 'Group by supplier' },
      { value: 'category', label: 'Group by category' },
    ],
    sortBy: EXPIRY_SORTABLE.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
  };
}
