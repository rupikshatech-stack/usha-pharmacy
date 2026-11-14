import mongoose from 'mongoose';
import { Attribute, Batch, Branch, Invoice, MOVEMENT_TYPES, Medicine, StockMovement } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { bucketPlan, branchMatch, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';

/**
 * Inventory analytics: what is on the shelves right now, what it is worth, and what is moving.
 *
 * TWO KINDS OF FIGURE LIVE ON THIS SCREEN, and keeping them apart is the whole point:
 *
 *   A STOCK POSITION is as it stands NOW — units on hand, what they are worth, what is low, what is out, what is
 *   about to expire. A date range cannot change it: stock has no period. The screen says so rather than quietly
 *   filtering a balance by a date and showing a number nobody can reproduce.
 *
 *   A MOVEMENT is a period figure — what came in and what went out between two dates, read from the append-only
 *   stock ledger, and what sold fastest and slowest over that window. These do follow the date range.
 *
 * VALUATION, stated once: stock is valued at the PURCHASE PRICE recorded on each batch — what those exact units
 * cost when they were received. Never at MRP and never at the selling price: valuing stock at what you hope to sell
 * it for books the profit before the sale. A batch with no purchase price recorded contributes nothing to the
 * valuation and is counted and named separately, so the gap is visible instead of silently understating the total.
 *
 *   Inventory valuation = Σ (availableQuantity × batch.purchasePrice) over live, unexpired, unarchived batches
 *   Expired stock value = the same sum over batches whose expiry date has passed but which still hold units
 *
 * A medicine is LOW on stock when its sellable units across all the stores in scope are at or below its own
 * `reorderLevel` and above zero; OUT when they are zero. Both are per medicine, not per batch — a buyer orders a
 * medicine, not a lot.
 *
 * Everything is aggregated in MongoDB for one organization, restricted to the stores the person may report on.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const INVENTORY_STOCK_STATUSES = ['in_stock', 'low', 'out', 'expired', 'near_expiry', 'quarantined'];
export const INVENTORY_EXPIRY_WINDOWS = ['expired', '30', '60', '90', 'beyond90'];
export const INVENTORY_SORTABLE = ['value', 'quantity', 'medicine', 'expiry', 'cost'];
const SORT_FIELD = { value: 'stockValue', quantity: 'availableQuantity', medicine: 'medicineName', expiry: 'expiryDate', cost: 'purchasePrice' };

/** Units a batch can actually sell: on hand, less what is set aside, and only while it is active and in date. */
export const SELLABLE = {
  $cond: [
    { $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiryDate', '$$NOW'] }] },
    { $max: [0, { $subtract: ['$availableQuantity', { $ifNull: ['$reservedQuantity', 0] }] }] },
    0,
  ],
};
/** What a batch's units cost. Zero when nobody recorded a purchase price — never guessed from MRP. */
const STOCK_VALUE = { $multiply: ['$availableQuantity', { $ifNull: ['$purchasePrice', 0] }] };
const IS_EXPIRED = { $lte: ['$expiryDate', '$$NOW'] };

/** Live stock: anything not archived that still holds units. An empty lot is history, not inventory. */
const liveStock = (orgId, branches) => ({
  organizationId: orgId,
  status: { $ne: 'archived' },
  availableQuantity: { $gt: 0 },
  ...(branches ? { branchId: { $in: branches } } : {}),
});

/* ------------------------------------------------------------------ the stock position */

/**
 * The position as it stands now: units, valuation, how much of it is expired or close to it, and how many batches
 * carry no cost at all.
 */
export async function position(orgId, branches, nearDays) {
  const near = new Date(Date.now() + nearDays * 86400000);
  const [r] = await Batch.aggregate([
    { $match: liveStock(orgId, branches) },
    {
      $group: {
        _id: null,
        units: { $sum: '$availableQuantity' },
        sellableUnits: { $sum: SELLABLE },
        batches: { $sum: 1 },
        valuation: { $sum: { $cond: [IS_EXPIRED, 0, STOCK_VALUE] } },
        expiredValue: { $sum: { $cond: [IS_EXPIRED, STOCK_VALUE, 0] } },
        expiredUnits: { $sum: { $cond: [IS_EXPIRED, '$availableQuantity', 0] } },
        expiredBatches: { $sum: { $cond: [IS_EXPIRED, 1, 0] } },
        nearExpiryBatches: { $sum: { $cond: [{ $and: [{ $not: IS_EXPIRED }, { $lte: ['$expiryDate', near] }] }, 1, 0] } },
        nearExpiryValue: { $sum: { $cond: [{ $and: [{ $not: IS_EXPIRED }, { $lte: ['$expiryDate', near] }] }, STOCK_VALUE, 0] } },
        noCostBatches: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$purchasePrice', 0] }, 0] }, 0, 1] } },
        quarantined: { $sum: { $cond: [{ $eq: ['$status', 'quarantined'] }, 1, 0] } },
      },
    },
  ]);
  return {
    units: r?.units || 0,
    sellableUnits: r?.sellableUnits || 0,
    batches: r?.batches || 0,
    valuation: round2(r?.valuation),
    expiredValue: round2(r?.expiredValue),
    expiredUnits: r?.expiredUnits || 0,
    expiredBatches: r?.expiredBatches || 0,
    nearExpiryBatches: r?.nearExpiryBatches || 0,
    nearExpiryValue: round2(r?.nearExpiryValue),
    noCostBatches: r?.noCostBatches || 0,
    quarantined: r?.quarantined || 0,
  };
}

/**
 * How many medicines are low or out, per medicine rather than per batch. A medicine with no batch at all in the
 * stores in scope counts as out of stock: a buyer needs to see it, and "no lot" is exactly what out of stock means.
 */
export const sellablePerMedicine = (branches) => [
  {
    $lookup: {
      from: 'batches',
      localField: '_id',
      foreignField: 'medicineId',
      as: '_b',
      pipeline: [
        { $match: { status: { $ne: 'archived' }, availableQuantity: { $gt: 0 }, ...(branches ? { branchId: { $in: branches } } : {}) } },
        { $project: { sellable: SELLABLE } },
      ],
    },
  },
  { $set: { sellable: { $sum: '$_b.sellable' } } },
];

/**
 * LOW and OUT, written once and used everywhere.
 *
 * OUT is zero sellable units — including a medicine with no batch at all in these stores, because "no lot" is
 * exactly what out of stock means to the person who has to order it. LOW is some stock left, but at or below the
 * medicine's own reorder level. They are mutually exclusive by construction, so a medicine is never counted twice,
 * and both are per MEDICINE rather than per batch: a buyer orders a medicine, not a lot.
 */
export const OUT_OF_STOCK = { $lte: ['$sellable', 0] };
export const LOW_ON_STOCK = { $and: [{ $gt: ['$sellable', 0] }, { $lte: ['$sellable', { $ifNull: ['$reorderLevel', 0] }] }] };

export async function stockLevels(orgId, branches) {
  const [r] = await Medicine.aggregate([
    { $match: { organizationId: orgId, isActive: true } },
    ...sellablePerMedicine(branches),
    {
      $group: {
        _id: null,
        medicines: { $sum: 1 },
        out: { $sum: { $cond: [OUT_OF_STOCK, 1, 0] } },
        low: { $sum: { $cond: [LOW_ON_STOCK, 1, 0] } },
      },
    },
  ]).allowDiskUse(true);
  return { medicines: r?.medicines || 0, low: r?.low || 0, out: r?.out || 0 };
}

/** Stock and valuation by category — the catalogue's own categories, with anything unfiled named as such. */
async function byCategory(orgId, branches) {
  const rows = await Batch.aggregate([
    { $match: liveStock(orgId, branches) },
    { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { categoryId: 1 } }] } },
    { $set: { _m: { $first: '$_m' } } },
    {
      $group: {
        _id: '$_m.categoryId',
        units: { $sum: '$availableQuantity' },
        amount: { $sum: { $cond: [IS_EXPIRED, 0, STOCK_VALUE] } },
        batches: { $sum: 1 },
        medicines: { $addToSet: '$medicineId' },
      },
    },
    { $set: { medicines: { $size: '$medicines' } } },
    { $sort: { amount: -1 } },
  ]).allowDiskUse(true);

  const ids = rows.map((r) => r._id).filter(Boolean);
  const names = ids.length
    ? new Map((await Attribute.find({ organizationId: orgId, _id: { $in: ids } }).select('attributeName').lean()).map((a) => [String(a._id), a.attributeName]))
    : new Map();
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return rows.map((r) => ({
    id: r._id ? String(r._id) : null,
    label: r._id ? names.get(String(r._id)) || 'Unknown category' : 'Uncategorised',
    units: r.units,
    amount: round2(r.amount),
    batches: r.batches,
    medicines: r.medicines,
    share: total ? Math.round((r.amount / total) * 1000) / 10 : 0,
  }));
}

/* ------------------------------------------------------------------ movement, over the period */

/**
 * What came in and what went out over the period, from the append-only stock ledger. Entries are signed, so stock in
 * is the positives and stock out the negatives; a transfer appears on both sides of the organization at once and is
 * reported separately, because moving stock between our own stores is neither a purchase nor a sale.
 */
async function movement(orgId, period, branches, plan) {
  const IN = ['OPENING', 'PURCHASE', 'SALE_RETURN', 'TRANSFER_IN'];
  const rows = await StockMovement.aggregate([
    {
      $match: {
        organizationId: orgId,
        createdAt: { $gte: period.start, $lt: period.end },
        ...(branches ? { $or: [{ branchId: { $in: branches } }, { toBranchId: { $in: branches } }, { fromBranchId: { $in: branches } }] } : {}),
      },
    },
    {
      $facet: {
        byBucket: [
          {
            $group: {
              _id: plan.truncate('$createdAt'),
              inUnits: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } },
              outUnits: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0] } },
            },
          },
        ],
        byType: [{ $group: { _id: '$type', units: { $sum: { $abs: '$quantity' } }, entries: { $sum: 1 } } }, { $sort: { units: -1 } }],
      },
    },
  ]).allowDiskUse(true);

  const facet = rows[0] || {};
  const byBucket = new Map((facet.byBucket || []).map((r) => [plan.keyOf(r._id), r]));
  const byType = new Map((facet.byType || []).map((r) => [r._id, r]));
  return {
    series: {
      bucket: plan.bucket,
      points: plan.keys.map(({ key, at }) => ({
        key,
        at: at.toISOString(),
        inUnits: byBucket.get(key)?.inUnits || 0,
        outUnits: byBucket.get(key)?.outUnits || 0,
      })),
    },
    byType: MOVEMENT_TYPES.map((type) => ({
      type,
      label: type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
      units: byType.get(type)?.units || 0,
      entries: byType.get(type)?.entries || 0,
      isTransfer: type.startsWith('TRANSFER'),
    })),
    inUnits: (facet.byBucket || []).reduce((n, r) => n + r.inUnits, 0),
    outUnits: (facet.byBucket || []).reduce((n, r) => n + r.outUnits, 0),
  };
}

/**
 * What sold fastest and slowest over the period: units sold per medicine from completed invoices, against what is
 * still on hand. A medicine holding stock that sold NOTHING in the window is the one worth seeing, so the slow list
 * is built from stock on hand rather than from sales — a list of slow sellers that only contains things that sold is
 * no use to anybody.
 */
export async function velocity(orgId, period, branches, limit = 10) {
  const [sold, onHand] = await Promise.all([
    Invoice.aggregate([
      { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.medicineId',
          name: { $first: '$items.name' },
          units: { $sum: { $ifNull: ['$items.quantity', 0] } },
          revenue: { $sum: { $ifNull: ['$items.amount', 0] } },
          invoices: { $addToSet: '$_id' },
        },
      },
      { $set: { invoices: { $size: '$invoices' } } },
    ]).allowDiskUse(true),
    Batch.aggregate([
      { $match: liveStock(orgId, branches) },
      { $group: { _id: '$medicineId', units: { $sum: '$availableQuantity' }, value: { $sum: { $cond: [IS_EXPIRED, 0, STOCK_VALUE] } } } },
    ]).allowDiskUse(true),
  ]);

  const soldBy = new Map(sold.map((r) => [String(r._id), r]));
  const stockBy = new Map(onHand.map((r) => [String(r._id), r]));
  const ids = [...new Set([...soldBy.keys(), ...stockBy.keys()])];
  const names = new Map(
    (await Medicine.find({ organizationId: orgId, _id: { $in: ids.map(oid) } }).select('medicineName').lean()).map((m) => [String(m._id), m.medicineName]),
  );
  const days = Math.max(1, period.days);

  const rows = ids.map((id) => {
    const s = soldBy.get(id);
    const k = stockBy.get(id);
    const units = s?.units || 0;
    const stock = k?.units || 0;
    const perDay = Math.round((units / days) * 100) / 100;
    return {
      id,
      label: names.get(id) || s?.name || 'Unknown medicine',
      units,
      revenue: round2(s?.revenue),
      perDay,
      stock,
      stockValue: round2(k?.value),
      // How long the stock on hand would last at the period's own rate. Null when nothing sold: "forever" is not a number.
      daysOfCover: perDay > 0 ? Math.round(stock / perDay) : null,
    };
  });

  const fast = rows.filter((r) => r.units > 0).sort((a, b) => b.units - a.units).slice(0, limit);
  // Slow means: holding stock, and selling little or nothing of it. Ordered by what is tied up, because that is the cost.
  const slow = rows
    .filter((r) => r.stock > 0)
    .sort((a, b) => a.perDay - b.perDay || b.stockValue - a.stockValue)
    .slice(0, limit);
  return { fast, slow, neverSold: rows.filter((r) => r.stock > 0 && r.units === 0).length };
}

/* ------------------------------------------------------------------ the batch register */

/** The filters the register understands, each one a value the data can actually hold. */
function filtersFrom(query) {
  return {
    categoryId: query.categoryId || null,
    manufacturer: query.manufacturer ? String(query.manufacturer).trim() : null,
    stockStatus: query.stockStatus || null,
    expiryWindow: query.expiryWindow || null,
    search: query.search ? String(query.search).trim() : null,
  };
}

/** The window a batch's expiry date must fall in, as a date range on the batch itself. */
function expiryRange(window) {
  const now = new Date();
  const at = (days) => new Date(now.getTime() + days * 86400000);
  switch (window) {
    case 'expired':
      return { expiryDate: { $lte: now } };
    case '30':
      return { expiryDate: { $gt: now, $lte: at(30) } };
    case '60':
      return { expiryDate: { $gt: at(30), $lte: at(60) } };
    case '90':
      return { expiryDate: { $gt: at(60), $lte: at(90) } };
    case 'beyond90':
      return { expiryDate: { $gt: at(90) } };
    default:
      return {};
  }
}

/**
 * One page of the stock register: a row per batch, with the medicine, store, cost, price, expiry and what the units
 * on hand are worth. Filtering, sorting and paging all happen in the database.
 */
async function register(orgId, branches, f, { sortBy, dir, page, limit, nearDays, rowsOnly = false, maxRows = 0 }) {
  const near = new Date(Date.now() + nearDays * 86400000);
  const pipeline = [
    { $match: { ...liveStock(orgId, branches), ...expiryRange(f.expiryWindow) } },
    { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { medicineName: 1, categoryId: 1, manufacturer: 1, sku: 1, unit: 1, reorderLevel: 1 } }] } },
    { $set: { _m: { $first: '$_m' } } },
    ...(f.categoryId ? [{ $match: { '_m.categoryId': oid(f.categoryId) } }] : []),
    ...(f.manufacturer
      ? [{ $match: { $or: [{ manufacturer: new RegExp(escapeRe(f.manufacturer), 'i') }, { '_m.manufacturer': new RegExp(escapeRe(f.manufacturer), 'i') }] } }]
      : []),
    ...(f.search
      ? [{ $match: { $or: [{ '_m.medicineName': new RegExp(escapeRe(f.search), 'i') }, { batchNumber: new RegExp(escapeRe(f.search), 'i') }, { '_m.sku': new RegExp(escapeRe(f.search), 'i') }] } }]
      : []),
    {
      $project: {
        _id: 0,
        id: '$_id',
        medicineId: 1,
        medicineName: { $ifNull: ['$_m.medicineName', 'Unknown medicine'] },
        categoryId: '$_m.categoryId',
        manufacturer: { $ifNull: [{ $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$manufacturer', ''] } }, 0] }, '$manufacturer', '$_m.manufacturer'] }, ''] },
        unit: { $ifNull: ['$_m.unit', ''] },
        branchId: 1,
        batchNumber: 1,
        expiryDate: 1,
        availableQuantity: 1,
        reservedQuantity: { $ifNull: ['$reservedQuantity', 0] },
        sellable: SELLABLE,
        purchasePrice: { $ifNull: ['$purchasePrice', 0] },
        sellingPrice: { $ifNull: ['$sellingPrice', 0] },
        mrp: { $ifNull: ['$mrp', 0] },
        stockValue: { $round: [STOCK_VALUE, 2] },
        costKnown: { $gt: [{ $ifNull: ['$purchasePrice', 0] }, 0] },
        batchStatus: '$status',
        reorderLevel: { $ifNull: ['$_m.reorderLevel', 0] },
        stockStatus: {
          $switch: {
            branches: [
              { case: IS_EXPIRED, then: 'expired' },
              { case: { $eq: ['$status', 'quarantined'] }, then: 'quarantined' },
              { case: { $lte: ['$expiryDate', near] }, then: 'near_expiry' },
              { case: { $lte: [SELLABLE, 0] }, then: 'out' },
              { case: { $lte: [SELLABLE, { $ifNull: ['$_m.reorderLevel', 0] }] }, then: 'low' },
            ],
            default: 'in_stock',
          },
        },
      },
    },
    ...(f.stockStatus ? [{ $match: { stockStatus: f.stockStatus } }] : []),
  ];

  if (rowsOnly) {
    const rows = await Batch.aggregate([...pipeline, { $sort: { [SORT_FIELD[sortBy]]: dir, id: dir } }, ...(maxRows ? [{ $limit: maxRows }] : [])]).allowDiskUse(true);
    return { rows, total: rows.length, filtered: null };
  }

  const [facet] = await Batch.aggregate([
    ...pipeline,
    {
      $facet: {
        rows: [{ $sort: { [SORT_FIELD[sortBy]]: dir, id: dir } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'n' }],
        filtered: [{ $group: { _id: null, units: { $sum: '$availableQuantity' }, value: { $sum: '$stockValue' } } }],
      },
    },
  ]).allowDiskUse(true);

  return {
    rows: facet?.rows || [],
    total: facet?.total?.[0]?.n || 0,
    filtered: { units: facet?.filtered?.[0]?.units || 0, value: round2(facet?.filtered?.[0]?.value) },
  };
}

/** Store names for the rows on one page. */
async function decorate(orgId, rows) {
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter(Boolean).map(String))];
  const stores = branchIds.length ? await Branch.find({ organizationId: orgId, _id: { $in: branchIds.map(oid) } }).select('name').lean() : [];
  const names = new Map(stores.map((b) => [String(b._id), b.name]));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    branchName: r.branchId ? names.get(String(r.branchId)) || null : 'Default store',
    daysToExpiry: r.expiryDate ? Math.ceil((new Date(r.expiryDate).getTime() - now) / 86400000) : null,
  }));
}

/** The categories and manufacturers actually present in the stock in scope, so the filters offer only real values. */
async function registerOptions(orgId, branches) {
  const [cats, makers] = await Promise.all([
    Batch.aggregate([
      { $match: liveStock(orgId, branches) },
      { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { categoryId: 1 } }] } },
      { $group: { _id: { $first: '$_m.categoryId' } } },
    ]),
    Batch.aggregate([
      { $match: liveStock(orgId, branches) },
      { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { manufacturer: 1 } }] } },
      { $group: { _id: { $ifNull: [{ $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$manufacturer', ''] } }, 0] }, '$manufacturer', { $first: '$_m.manufacturer' }] }, ''] } } },
    ]),
  ]);
  const ids = cats.map((c) => c._id).filter(Boolean);
  const names = ids.length ? await Attribute.find({ organizationId: orgId, _id: { $in: ids } }).select('attributeName').lean() : [];
  return {
    categories: names.map((a) => ({ value: String(a._id), label: a.attributeName })).sort((a, b) => a.label.localeCompare(b.label)),
    manufacturers: makers.map((m) => m._id).filter(Boolean).sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value })),
    stockStatuses: [
      { value: 'in_stock', label: 'In stock' },
      { value: 'low', label: 'Low stock' },
      { value: 'out', label: 'Nothing sellable' },
      { value: 'near_expiry', label: 'Near expiry' },
      { value: 'expired', label: 'Expired' },
      { value: 'quarantined', label: 'Quarantined' },
    ],
    expiryWindows: [
      { value: 'expired', label: 'Already expired' },
      { value: '30', label: 'Within 30 days' },
      { value: '60', label: '31 to 60 days' },
      { value: '90', label: '61 to 90 days' },
      { value: 'beyond90', label: 'After 90 days' },
    ],
    sortBy: INVENTORY_SORTABLE.map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) })),
  };
}

/** How near "near expiry" is: the organization's own first threshold, so this screen agrees with Expiry Intelligence. */
export const nearExpiryDays = (org) => {
  const t = org?.settings?.expiry?.thresholds;
  return Array.isArray(t) && t.length === 3 ? Number(t[2]) || 90 : 90;
};

/* ------------------------------------------------------------------ the report */

/** Inventory analytics: the stock position now, the movement over the period, and one page of the stock register. */
export async function getInventoryReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(period, tz);
  const nearDays = nearExpiryDays(org);
  const filters = filtersFrom(query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = INVENTORY_SORTABLE.includes(query.sortBy) ? query.sortBy : 'value';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [pos, levels, categories, moved, pace, table, options] = await Promise.all([
    position(orgId, branches, nearDays),
    stockLevels(orgId, branches),
    byCategory(orgId, branches),
    movement(orgId, period, branches, plan),
    velocity(orgId, period, branches),
    register(orgId, branches, filters, { sortBy, dir, page, limit, nearDays }),
    registerOptions(orgId, branches),
  ]);

  /** A stock figure has no period, so it carries no comparison: `previous` is null and the card says why. */
  const kpi = (key, label, value, description, format = 'money') => ({ key, label, value, previous: null, change: null, description, format });
  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz },
    filters: { ...filters, branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options,
    kpis: [
      kpi('units', 'Total stock units', pos.units, `Units on hand across ${pos.batches.toLocaleString('en-IN')} live batches, as they stand now. A stock figure has no date range.`, 'number'),
      kpi('valuation', 'Inventory valuation', pos.valuation, 'Units on hand valued at the purchase price recorded on each batch — what they cost, never MRP or the selling price. Expired stock is excluded and reported separately.'),
      kpi('lowStock', 'Low stock medicines', levels.low, 'Medicines whose sellable units are at or below their own reorder level, but not yet zero.', 'number'),
      kpi('outOfStock', 'Out of stock medicines', levels.out, `Active medicines with nothing sellable in these stores, of ${levels.medicines.toLocaleString('en-IN')} on the catalogue.`, 'number'),
      kpi('nearExpiry', 'Near-expiry batches', pos.nearExpiryBatches, `Batches expiring within ${nearDays} days and still holding units — ${inrish(pos.nearExpiryValue)} at cost.`, 'number'),
      kpi('expiredValue', 'Expired stock value', pos.expiredValue, `${pos.expiredBatches.toLocaleString('en-IN')} batches have passed their expiry date but still hold ${pos.expiredUnits.toLocaleString('en-IN')} units. Valued at what they cost.`),
      kpi('stockIn', 'Units in', moved.inUnits, 'Units added in the period, from the stock ledger: opening stock, purchases, returns put back and transfers in.', 'number'),
      kpi('stockOut', 'Units out', moved.outUnits, 'Units removed in the period: sales, write-offs, adjustments and transfers out.', 'number'),
    ],
    position: { ...pos, ...levels, nearExpiryDays: nearDays },
    charts: {
      byCategory: categories,
      movement: moved.series,
      movementByType: moved.byType,
      fastMoving: pace.fast,
      slowMoving: pace.slow,
    },
    items: await decorate(orgId, table.rows),
    filteredTotals: table.filtered,
    page,
    limit,
    pages: Math.max(1, Math.ceil(table.total / limit)),
    total: table.total,
    notes: {
      valuation: 'Stock is valued at the purchase price recorded on each batch. Valuing it at MRP or the selling price would book the profit before the sale.',
      noCost: pos.noCostBatches
        ? `${pos.noCostBatches.toLocaleString('en-IN')} batch${pos.noCostBatches === 1 ? '' : 'es'} on hand have no purchase price recorded, so they add nothing to the valuation.`
        : null,
      stockHasNoPeriod: 'Stock units, valuation, low stock, out of stock and expiry are positions as they stand now; the date range applies only to movement and to what sold fast or slowly.',
      neverSold: pace.neverSold ? `${pace.neverSold.toLocaleString('en-IN')} medicines are holding stock that sold nothing at all in this period.` : null,
    },
  };
}

/** Money inside a sentence, where the full formatter would be noise. */
function inrish(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 25000;

const STATUS_WORD = {
  in_stock: 'In stock',
  low: 'Low stock',
  out: 'Nothing sellable',
  near_expiry: 'Near expiry',
  expired: 'Expired',
  quarantined: 'Quarantined',
};

const COLUMNS = [
  ['Medicine', (r) => r.medicineName],
  ['Category', (r) => r.categoryName || ''],
  ['Manufacturer', (r) => r.manufacturer],
  ['Store', (r) => r.branchName],
  ['Batch', (r) => r.batchNumber],
  ['Expiry', (r) => (r.expiryDate ? new Date(r.expiryDate).toISOString().slice(0, 10) : '')],
  ['Days to expiry', (r) => (r.daysToExpiry === null ? '' : r.daysToExpiry)],
  ['Available quantity', (r) => r.availableQuantity],
  ['Reserved', (r) => r.reservedQuantity],
  ['Sellable', (r) => r.sellable],
  ['Purchase cost (INR)', (r) => Number(r.purchasePrice).toFixed(2)],
  ['Selling price (INR)', (r) => Number(r.sellingPrice).toFixed(2)],
  ['MRP (INR)', (r) => Number(r.mrp).toFixed(2)],
  ['Stock value at cost (INR)', (r) => Number(r.stockValue).toFixed(2)],
  ['Cost recorded', (r) => (r.costKnown ? 'Yes' : 'No')],
  ['Stock status', (r) => STATUS_WORD[r.stockStatus] || r.stockStatus],
  ['Batch status', (r) => r.batchStatus],
];

/** The whole stock register the filters match, as CSV — not the page on screen. */
export async function exportInventoryReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const filters = filtersFrom(query);
  const sortBy = INVENTORY_SORTABLE.includes(query.sortBy) ? query.sortBy : 'value';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const { rows } = await register(orgId, branches, filters, {
    sortBy,
    dir,
    page: 1,
    limit: 0,
    nearDays: nearExpiryDays(org),
    rowsOnly: true,
    maxRows: EXPORT_MAX_ROWS + 1,
  });
  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} batches. Choose one store, one category or a narrower expiry window and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = await decorate(orgId, rows);
  const categoryIds = [...new Set(items.map((r) => r.categoryId).filter(Boolean).map(String))];
  const categoryNames = categoryIds.length
    ? new Map((await Attribute.find({ organizationId: orgId, _id: { $in: categoryIds.map(oid) } }).select('attributeName').lean()).map((a) => [String(a._id), a.attributeName]))
    : new Map();
  const withCategory = items.map((r) => ({ ...r, categoryName: r.categoryId ? categoryNames.get(String(r.categoryId)) || '' : 'Uncategorised' }));

  const head = exportHeader({
    title: 'Inventory Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Note', 'Stock figures are a position as at the time of export; the period above applies only to movement figures on screen.'],
      ['Valuation method', 'Purchase price recorded on each batch'],
      ['Category', filters.categoryId ? categoryNames.get(String(filters.categoryId)) || '—' : 'All categories'],
      ['Manufacturer', filters.manufacturer || 'All manufacturers'],
      ['Stock status', filters.stockStatus ? STATUS_WORD[filters.stockStatus] : 'Any'],
      ['Expiry window', filters.expiryWindow || 'Any'],
      ['Search', filters.search || '—'],
      ['Total stock value in this file (INR)', withCategory.reduce((n, r) => n + Number(r.stockValue || 0), 0).toFixed(2)],
    ],
    rows: withCategory.length,
  });
  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...withCategory.map((r) => COLUMNS.map(([, read]) => read(r)))]),
    fileName: `usha-inventory-${fileStamp(tz)}.csv`,
    rows: withCategory.length,
  };
}
