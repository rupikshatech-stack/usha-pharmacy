import mongoose from 'mongoose';
import { Batch, Medicine } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { paginated } from '../utils/pagination.js';
import { escapeRegex } from '../utils/regex.js';
import { presentBatch } from './batch.service.js';
import { defaultBranchId, inBranch } from './branch.service.js';

/**
 * The Inventory Batch page: every batch of every medicine in one searchable, filterable list.
 *
 * Expiry alerts count batches that still HAVE stock (units on hand, not archived):
 *   expired – expiry date has passed         within30/60/90 – expires in the next 30/60/90 days (cumulative:
 *   "within 90" includes the batches that are also "within 30").
 * An expired batch is never sellable — see stock.service.sellableBatchFilter, which POS/invoices use.
 */
const DAY = 24 * 60 * 60 * 1000;
export const EXPIRY_FILTERS = ['expired', '30', '60', '90', 'valid'];
export const BATCH_STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'expired', 'quarantined', 'recalled', 'archived'];

/** $match fragment for an expiry filter (null = no filter). */
export function expiryMatch(expiry, now) {
  if (!expiry) return null;
  const hasStock = { availableQuantity: { $gt: 0 }, status: { $ne: 'archived' } };
  if (expiry === 'valid') return { expiryDate: { $gt: now } };
  if (expiry === 'expired') return { ...hasStock, expiryDate: { $lte: now } };
  return { ...hasStock, expiryDate: { $gt: now, $lte: new Date(now.getTime() + Number(expiry) * DAY) } };
}

/** The single "Status" shown for a batch, calculated (never stored) so it can't go stale. */
const stockStatusExpr = (now) => ({
  $switch: {
    branches: [
      { case: { $eq: ['$status', 'archived'] }, then: 'archived' },
      { case: { $eq: ['$status', 'quarantined'] }, then: 'quarantined' },
      { case: { $eq: ['$status', 'recalled'] }, then: 'recalled' },
      { case: { $lte: ['$availableQuantity', 0] }, then: 'out_of_stock' },
      { case: { $lte: ['$expiryDate', now] }, then: 'expired' },
      { case: { $lte: [{ $subtract: ['$availableQuantity', '$reservedQuantity'] }, 0] }, then: 'out_of_stock' },
      { case: { $lt: [{ $subtract: ['$availableQuantity', '$reservedQuantity'] }, { $ifNull: ['$reorderLevel', 0] }] }, then: 'low_stock' },
    ],
    default: 'in_stock',
  },
});

const STATUS_RANK = { expired: 0, recalled: 1, quarantined: 2, out_of_stock: 3, low_stock: 4, in_stock: 5, archived: 6 };

export const BATCH_SORTABLE = ['expiryDate', 'medicineName', 'batchNumber', 'manufacturer', 'manufacturingDate', 'purchasePrice', 'sellingPrice', 'mrp', 'availableQuantity', 'stockStatus', 'createdAt'];

export async function listAllBatches(orgId, q, now = new Date()) {
  const mainStore = await defaultBranchId(orgId);
  const base = {
    ...(q.branchId && inBranch(new mongoose.Types.ObjectId(q.branchId), mainStore)),
    organizationId: orgId,
    ...(q.medicineId && { medicineId: new mongoose.Types.ObjectId(q.medicineId) }),
    ...(q.manufacturer && { manufacturer: new RegExp(`^${escapeRegex(q.manufacturer)}$`, 'i') }),
    ...(q.archived === 'exclude' && { status: { $ne: 'archived' } }),
    ...(q.archived === 'only' && { status: 'archived' }),
    ...expiryMatch(q.expiry, now),
  };
  // an expiry alert already narrows `status`/`availableQuantity`; keep both conditions when "only archived" is combined
  if (q.archived === 'only' && base.status !== 'archived') base.status = 'archived';

  const search = q.search ? new RegExp(escapeRegex(q.search), 'i') : null;
  const afterLookup = {
    ...(search && { $or: [{ medicineName: search }, { batchNumber: search }, { sku: search }, { barcode: search }] }),
    ...(q.stock && { stockStatus: q.stock }),
  };

  const sortField = q.sortBy === 'stockStatus' ? 'statusRank' : q.sortBy;
  const dir = q.sortDir === 'desc' ? -1 : 1;

  const [result] = await Batch.aggregate([
    { $match: base }, // `base` always carries organizationId
    {
      $lookup: {
        from: 'medicines',
        let: { id: '$medicineId', org: '$organizationId' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$_id', '$$id'] }, { $eq: ['$organizationId', '$$org'] }] } } },
          { $project: { medicineName: 1, genericName: 1, sku: 1, barcode: 1, reorderLevel: 1, isActive: 1, dosageForm: 1, strength: 1 } },
        ],
        as: '_m',
      },
    },
    {
      $addFields: {
        medicineName: { $ifNull: [{ $first: '$_m.medicineName' }, ''] },
        genericName: { $first: '$_m.genericName' },
        sku: { $first: '$_m.sku' },
        barcode: { $first: '$_m.barcode' },
        dosageForm: { $first: '$_m.dosageForm' },
        strength: { $first: '$_m.strength' },
        reorderLevel: { $first: '$_m.reorderLevel' },
        branchId: { $ifNull: ['$branchId', mainStore] },
        medicineActive: { $first: '$_m.isActive' },
        isExpired: { $lte: ['$expiryDate', now] },
        daysToExpiry: { $ceil: { $divide: [{ $subtract: ['$expiryDate', now] }, DAY] } },
      },
    },
    { $addFields: { stockStatus: stockStatusExpr(now) } },
    {
      $addFields: {
        sellableQuantity: { $cond: [{ $in: ['$stockStatus', ['in_stock', 'low_stock']] }, { $subtract: ['$availableQuantity', '$reservedQuantity'] }, 0] },
        statusRank: { $switch: { branches: Object.entries(STATUS_RANK).map(([k, v]) => ({ case: { $eq: ['$stockStatus', k] }, then: v })), default: 9 } },
      },
    },
    { $lookup: { from: 'branches', let: { b: '$branchId', org: '$organizationId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$b'] }, { $eq: ['$organizationId', '$$org'] }] } } }, { $project: { name: 1 } }], as: '_b' } },
    { $addFields: { branchName: { $first: '$_b.name' } } },
    { $project: { _m: 0, _b: 0 } },
    ...(Object.keys(afterLookup).length ? [{ $match: afterLookup }] : []),
    { $sort: { [sortField]: dir, _id: 1 } },
    {
      $facet: {
        items: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit }, { $project: { statusRank: 0 } }],
        count: [{ $count: 'n' }],
      },
    },
  ]).collation({ locale: 'en', strength: 2 });

  return paginated(result.items, { page: q.page, limit: q.limit, total: result.count[0]?.n || 0 });
}

/** Expiry alert counters for the cards at the top of the page. Cumulative windows; only batches with stock. */
export async function expirySummary(orgId, now = new Date()) {
  const inDays = (n) => new Date(now.getTime() + n * DAY);
  const live = { $and: [{ $gt: ['$availableQuantity', 0] }, { $ne: ['$status', 'archived'] }] };
  const bucket = (cond) => ({ batches: { $sum: { $cond: [{ $and: [live, cond] }, 1, 0] } }, units: { $sum: { $cond: [{ $and: [live, cond] }, '$availableQuantity', 0] } } });
  const within = (n) => ({ $and: [{ $gt: ['$expiryDate', now] }, { $lte: ['$expiryDate', inDays(n)] }] });
  const [r] = await Batch.aggregate([
    { $match: { organizationId: orgId } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        expiredBatches: bucket({ $lte: ['$expiryDate', now] }).batches,
        expiredUnits: bucket({ $lte: ['$expiryDate', now] }).units,
        d30Batches: bucket(within(30)).batches,
        d30Units: bucket(within(30)).units,
        d60Batches: bucket(within(60)).batches,
        d60Units: bucket(within(60)).units,
        d90Batches: bucket(within(90)).batches,
        d90Units: bucket(within(90)).units,
      },
    },
  ]);
  const x = r || {};
  return {
    totalBatches: x.total || 0,
    expired: { batches: x.expiredBatches || 0, units: x.expiredUnits || 0 },
    within30: { batches: x.d30Batches || 0, units: x.d30Units || 0 },
    within60: { batches: x.d60Batches || 0, units: x.d60Units || 0 },
    within90: { batches: x.d90Batches || 0, units: x.d90Units || 0 },
  };
}

export async function batchManufacturers(orgId) {
  const names = await Batch.distinct('manufacturer', { organizationId: orgId });
  return names.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export async function getBatch(orgId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Batch not found');
  const batch = await Batch.findOne({ _id: id, organizationId: orgId }).lean();
  if (!batch) throw new ApiError(404, 'Batch not found');
  const medicine = await Medicine.findOne({ _id: batch.medicineId, organizationId: orgId }).select('medicineName genericName sku reorderLevel isActive unit').lean();
  return { ...presentBatch(batch), medicine };
}
