import mongoose from 'mongoose';
import { Attribute, Medicine } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { reportableBranches, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';
import { LOW_ON_STOCK, OUT_OF_STOCK, sellablePerMedicine } from './analyticsInventory.service.js';

/**
 * The Low Stock Report: what to order, before somebody is turned away at the counter.
 *
 * THIS REPORT HAS NO DATE RANGE, and that is not an omission. Everything on it is a POSITION — what is on the
 * shelves at this moment. "What was low last Tuesday" is a question about history that this screen deliberately
 * cannot be asked, because a buyer acts on what is low NOW. Every other analytics screen takes a period; this one
 * takes a store, and says so rather than offering a date picker that would quietly change nothing.
 *
 * WHAT COUNTS AS LOW is not decided here. `LOW_ON_STOCK` and `OUT_OF_STOCK` are defined once in the inventory
 * service and imported, so this report and Inventory Analytics can never drift into two different answers to
 * "how many medicines are low". Both are per MEDICINE across the stores in scope, never per batch: a buyer orders
 * a medicine, not a lot.
 *
 *   Out of stock   Zero sellable units — including a medicine with no batch at all, which is exactly what being
 *                  out of stock means to the person ordering.
 *   Low            Some stock left, at or below the medicine's own reorder level.
 *   Critical       Low, and down to less than HALF the reorder level: the ones to order first. An item already at
 *                  zero is not called critical — it is out, which is worse, and is counted as such.
 *
 * SELLABLE, not "on hand": units set aside for somebody else, in an inactive lot, or already expired cannot be
 * sold to the next customer, so they are not counted as stock a buyer can rely on. This is the same `SELLABLE`
 * the rest of the analytics module uses.
 *
 * TWO FIGURES ARE SUGGESTIONS, and the report labels them as such rather than letting them pass as facts:
 *
 *   Suggested order   reorder level − sellable units. It is arithmetic, NOT a forecast: it brings the shelf back
 *                     to its own stated minimum and takes no view of how fast the medicine sells. A medicine with
 *                     no reorder level set gets no suggestion at all, because there is no minimum to return to —
 *                     inventing one would be guessing with somebody else's money.
 *   Estimated cost    The suggested order valued at the LAST PURCHASE PRICE recorded for that medicine, from any
 *                     batch ever received. Where nothing was ever purchased the cost is left blank and the report
 *                     says so, rather than printing ₹0, which would read as "free".
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const LOW_STOCK_STATUSES = ['out', 'critical', 'low'];
export const LOW_STOCK_SORTABLE = ['urgency', 'medicine', 'available', 'threshold', 'shortfall', 'cost'];
const SORT_FIELD = {
  urgency: 'urgency',
  medicine: 'medicineName',
  available: 'sellable',
  threshold: 'reorderLevel',
  shortfall: 'shortfall',
  cost: 'estimatedCost',
};
const STATUS_LABEL = { out: 'OUT_OF_STOCK', critical: 'CRITICAL', low: 'LOW' };

/** Half the reorder level, which is where "low" becomes "order this one first". */
const HALF = { $divide: [{ $ifNull: ['$reorderLevel', 0] }, 2] };

/**
 * Every medicine that needs ordering, with the figures a buyer acts on: the catalogue, each medicine's sellable
 * units, the last price anyone paid for it, and the status and suggestion derived from those.
 */
function register(orgId, branches, { search, status, categoryId } = {}) {
  const match = { organizationId: orgId, isActive: true };
  if (categoryId) match.categoryId = oid(categoryId);
  if (search) {
    const re = new RegExp(escapeRe(search), 'i');
    match.$or = [{ medicineName: re }, { salt: re }, { manufacturer: re }];
  }
  return [
    { $match: match },
    ...sellablePerMedicine(branches),
    // Only what needs ordering. Everything else belongs on a different screen.
    { $match: { $expr: { $or: [OUT_OF_STOCK, LOW_ON_STOCK] } } },
    {
      $set: {
        // Urgency orders the list the way a buyer works: nothing left, then nearly nothing, then merely low.
        urgency: { $cond: [OUT_OF_STOCK, 3, { $cond: [{ $lt: ['$sellable', HALF] }, 2, 1] }] },
        status: { $cond: [OUT_OF_STOCK, 'out', { $cond: [{ $lt: ['$sellable', HALF] }, 'critical', 'low'] }] },
        // No reorder level means no stated minimum to return to, so there is nothing to suggest.
        shortfall: {
          $cond: [{ $gt: [{ $ifNull: ['$reorderLevel', 0] }, 0] }, { $max: [0, { $subtract: ['$reorderLevel', '$sellable'] }] }, null],
        },
      },
    },
    ...(status ? [{ $match: { status } }] : []),
    {
      // The last price anyone actually paid for this medicine, from any batch ever received — archived and empty
      // lots included, because a price that was paid is a price that was paid.
      $lookup: {
        from: 'batches',
        localField: '_id',
        foreignField: 'medicineId',
        as: '_price',
        pipeline: [
          { $match: { purchasePrice: { $gt: 0 }, ...(branches ? { branchId: { $in: branches } } : {}) } },
          { $sort: { createdAt: -1 } },
          { $limit: 1 },
          { $project: { purchasePrice: 1, createdAt: 1 } },
        ],
      },
    },
    { $set: { lastCost: { $first: '$_price.purchasePrice' }, lastCostAt: { $first: '$_price.createdAt' } } },
    {
      $set: {
        estimatedCost: {
          $cond: [{ $and: [{ $ne: ['$shortfall', null] }, { $gt: [{ $ifNull: ['$lastCost', 0] }, 0] }] }, { $multiply: ['$shortfall', '$lastCost'] }, null],
        },
      },
    },
    { $unset: ['_b', '_price'] },
  ];
}

const readRow = (r, categories) => ({
  id: String(r._id),
  medicineName: r.medicineName,
  salt: r.salt || null,
  strength: r.strength || null,
  packSize: r.packSize || null,
  manufacturer: r.manufacturer || null,
  unit: r.unit || null,
  category: r.categoryId ? categories.get(String(r.categoryId)) || 'Unknown category' : null,
  threshold: r.reorderLevel ?? null,
  thresholdSet: Boolean(r.reorderLevel),
  available: r.sellable || 0,
  shortfall: r.shortfall ?? null,
  lastCost: r.lastCost ? round2(r.lastCost) : null,
  lastCostAt: r.lastCostAt || null,
  estimatedCost: r.estimatedCost === null || r.estimatedCost === undefined ? null : round2(r.estimatedCost),
  status: r.status,
  statusLabel: STATUS_LABEL[r.status] || r.status,
});

/** The catalogue's categories, so a row can name its own rather than showing an id. */
async function categoryNames(orgId) {
  // A category is an Attribute, and its display name is `attributeName` — not `value`, which is the list of
  // allowed values on other attribute types.
  const rows = await Attribute.find({ organizationId: orgId, attributeType: 'category' }).select('attributeName').lean();
  return new Map(rows.filter((c) => c.attributeName).map((c) => [String(c._id), c.attributeName]));
}

/* ------------------------------------------------------------------ the report */

/**
 * The Low Stock Report: the three counts a buyer needs, the register itself, and what it would cost to put right.
 * No period — see the note at the top of this file.
 */
export async function getLowStockReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const branches = reportableBranches(user, query.branchId);
  const status = LOW_STOCK_STATUSES.includes(query.status) ? query.status : null;
  const search = query.search ? String(query.search).trim() : null;
  const categoryId = query.categoryId || null;
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const sortBy = LOW_STOCK_SORTABLE.includes(query.sortBy) ? query.sortBy : 'urgency';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [[facet], categories] = await Promise.all([
    Medicine.aggregate([
      // The counts describe everything that needs ordering, so they are taken BEFORE the status filter narrows the
      // table — otherwise filtering to "out of stock" would make the other two cards read zero.
      ...register(orgId, branches, { search, categoryId }),
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                out: { $sum: { $cond: [{ $eq: ['$status', 'out'] }, 1, 0] } },
                critical: { $sum: { $cond: [{ $eq: ['$status', 'critical'] }, 1, 0] } },
                low: { $sum: { $cond: [{ $eq: ['$status', 'low'] }, 1, 0] } },
                units: { $sum: { $ifNull: ['$shortfall', 0] } },
                cost: { $sum: { $ifNull: ['$estimatedCost', 0] } },
                noThreshold: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$reorderLevel', 0] }, 0] }, 0, 1] } },
                noCost: { $sum: { $cond: [{ $and: [{ $ne: ['$shortfall', null] }, { $eq: [{ $ifNull: ['$lastCost', 0] }, 0] }] }, 1, 0] } },
              },
            },
          ],
          rows: [
            ...(status ? [{ $match: { status } }] : []),
            { $sort: { [SORT_FIELD[sortBy]]: dir, medicineName: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
          total: [...(status ? [{ $match: { status } }] : []), { $count: 'n' }],
        },
      },
    ]).allowDiskUse(true),
    categoryNames(orgId),
  ]);

  const s = facet?.summary?.[0] || {};
  const total = facet?.total?.[0]?.n || 0;

  return {
    asOf: new Date().toISOString(),
    timezone: tz,
    organization: { name: org.name, gstin: org.gstin || null },
    filters: { branchId: query.branchId || null, status, search, categoryId, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: {
      statuses: [
        { value: '', label: 'All items' },
        { value: 'out', label: 'Out of stock' },
        { value: 'critical', label: 'Critical' },
        { value: 'low', label: 'Low' },
      ],
      categories: [...categories].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    },
    cards: [
      {
        key: 'total',
        label: 'Total low stock items',
        value: s.total || 0,
        hint: 'Medicines at or below their own reorder level, including those with none left. Requires procurement review.',
        tone: 'warning',
      },
      {
        key: 'out',
        label: 'Out of stock',
        value: s.out || 0,
        hint: 'Nothing sellable in these stores at all, including any medicine with no batch. Immediate reorder needed.',
        tone: 'danger',
      },
      {
        key: 'critical',
        label: 'Critical reorder levels',
        value: s.critical || 0,
        hint: 'Still has stock, but below half its reorder level. An item already at zero is counted as out of stock, not critical.',
        tone: 'accent',
      },
    ],
    summary: {
      total: s.total || 0,
      out: s.out || 0,
      critical: s.critical || 0,
      low: s.low || 0,
      suggestedUnits: s.units || 0,
      estimatedCost: round2(s.cost),
      /**
       * Whether that total means anything at all. When nothing on the list has a price on record the sum is zero,
       * and a zero in a money column reads as "free" — which is the opposite of the truth, that the cost is
       * unknown. The screen, the printed sheet and the CSV all read this one flag so they cannot disagree.
       */
      costKnown: round2(s.cost) > 0 || !(s.noCost || 0),
      costIsPartial: Boolean(s.noCost),
      noThreshold: s.noThreshold || 0,
      noCost: s.noCost || 0,
    },
    items: (facet?.rows || []).map((r) => readRow(r, categories)),
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    notes: {
      noPeriod: 'This report has no date range: it is the position on the shelves right now. What was low last week is a question about history, not a buying decision.',
      sellable: 'Stock counts only units that could be sold to the next customer — not units reserved for somebody else, in an inactive lot, or already expired.',
      definition: 'Low and out of stock use the same definitions as Inventory Analytics, counted per medicine across the stores in scope rather than per batch.',
      suggestion: 'The suggested order brings a medicine back to its own reorder level. It is arithmetic, not a forecast, and takes no view of how fast the medicine sells.',
      cost: 'Estimated cost values the suggested order at the last price actually paid for that medicine. Where nothing was ever purchased it is left blank rather than shown as zero.',
      noThreshold: s.noThreshold
        ? `${s.noThreshold} medicine${s.noThreshold === 1 ? ' has' : 's have'} no reorder level set, so no order can be suggested for ${s.noThreshold === 1 ? 'it' : 'them'}. ${s.noThreshold === 1 ? 'It appears' : 'They appear'} here only because nothing is left.`
        : null,
      noCost: s.noCost
        ? `${s.noCost} medicine${s.noCost === 1 ? '' : 's'} on this list ${s.noCost === 1 ? 'has' : 'have'} no purchase price on record, so the estimated cost excludes ${s.noCost === 1 ? 'it' : 'them'}.`
        : null,
    },
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const COLUMNS = [
  ['Medicine', (r) => r.medicineName],
  ['Salt', (r) => r.salt || ''],
  ['Strength', (r) => r.strength || ''],
  ['Pack', (r) => r.packSize || ''],
  ['Manufacturer', (r) => r.manufacturer || ''],
  ['Category', (r) => r.category || ''],
  ['Unit', (r) => r.unit || ''],
  ['Reorder level', (r) => (r.thresholdSet ? r.threshold : 'Not set')],
  ['Sellable stock', (r) => r.available],
  ['Suggested order', (r) => (r.shortfall === null ? 'No reorder level set' : r.shortfall)],
  ['Last purchase price (INR)', (r) => (r.lastCost === null ? 'Never purchased' : r.lastCost.toFixed(2))],
  ['Estimated cost (INR)', (r) => (r.estimatedCost === null ? '' : r.estimatedCost.toFixed(2))],
  ['Status', (r) => r.statusLabel],
];

/** Every medicine the filters match, as CSV — the whole list, not the page on screen. */
export async function exportLowStockReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const branches = reportableBranches(user, query.branchId);
  const status = LOW_STOCK_STATUSES.includes(query.status) ? query.status : null;
  const search = query.search ? String(query.search).trim() : null;
  const categoryId = query.categoryId || null;
  const sortBy = LOW_STOCK_SORTABLE.includes(query.sortBy) ? query.sortBy : 'urgency';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [rows, categories] = await Promise.all([
    Medicine.aggregate([
      ...register(orgId, branches, { search, status, categoryId }),
      { $sort: { [SORT_FIELD[sortBy]]: dir, medicineName: 1 } },
      { $limit: EXPORT_MAX_ROWS + 1 },
    ]).allowDiskUse(true),
    categoryNames(orgId),
  ]);

  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} medicines. Narrow the list with a search, a status or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }

  const items = rows.map((r) => readRow(r, categories));
  const suggested = items.reduce((n, r) => n + (r.shortfall || 0), 0);
  const cost = round2(items.reduce((n, r) => n + (r.estimatedCost || 0), 0));
  const head = exportHeader({
    title: 'Low Stock Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    tz,
    filters: [
      ['Status', status ? STATUS_LABEL[status] : 'All items needing reorder'],
      ['Search', search || '—'],
      ['Medicines listed', String(items.length)],
      ['Suggested units to order', suggested.toLocaleString('en-IN')],
      // Never print a bare 0 for money that is simply unknown.
      [
        'Estimated cost (INR)',
        items.some((r) => r.estimatedCost !== null)
          ? `${cost.toFixed(2)}${items.some((r) => r.shortfall !== null && r.lastCost === null) ? ' (partial: excludes medicines with no purchase price on record)' : ''}`
          : 'Not known — no purchase price on record for any medicine on this list',
      ],
      [
        'Note',
        'A position as at the time of export, not a figure for any period. The suggested order brings each medicine back to its own reorder level and is not a forecast; estimated cost uses the last price paid for that medicine.',
      ],
    ],
    rows: items.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...items.map((r) => COLUMNS.map(([, read]) => read(r)))]),
    fileName: `usha-low-stock-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
