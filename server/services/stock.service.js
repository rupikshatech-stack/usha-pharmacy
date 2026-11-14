/**
 * Shared stock rules, so every screen agrees on what "available stock" and "low stock" mean.
 *
 * A batch is SELLABLE only while: status is "active", it has NOT expired (expiryDate > now), and it has
 * units that are not reserved. Expired, quarantined, recalled and archived stock is never sellable.
 *
 *  - Available (sellable) stock of a medicine = Σ (availableQuantity − reservedQuantity) over its sellable batches.
 *    It is always CALCULATED from batch balances; no total is stored on the medicine.
 *  - Low stock = available stock strictly BELOW the medicine's reorder level.
 *  - Out of stock = available stock is 0.
 */

/** Net units of a batch that can be sold. */
export const sellableUnitsExpr = { $subtract: ['$availableQuantity', '$reservedQuantity'] };

/** Plain filter selecting sellable batches (use with find/countDocuments/$match). */
export const sellableBatchFilter = (now = new Date()) => ({
  status: 'active',
  expiryDate: { $gt: now },
  $expr: { $gt: [sellableUnitsExpr, 0] },
});

/** Pipeline stages adding `availableStock` (sellable units) to each Medicine; tenant-scoped inside the lookup too. */
export const sellableStockStages = (now = new Date()) => [
  {
    $lookup: {
      from: 'batches',
      let: { id: '$_id', org: '$organizationId' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$medicineId', '$$id'] },
                { $eq: ['$organizationId', '$$org'] },
                { $eq: ['$status', 'active'] },
                { $gt: ['$expiryDate', now] },
                { $gt: [sellableUnitsExpr, 0] },
              ],
            },
          },
        },
        { $group: { _id: null, qty: { $sum: sellableUnitsExpr } } },
      ],
      as: 'stockAgg',
    },
  },
  { $addFields: { availableStock: { $ifNull: [{ $first: '$stockAgg.qty' }, 0] } } },
  { $project: { stockAgg: 0 } },
];

export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'expired'];

/**
 * Adds the full inventory picture to each Medicine, calculated from its batches in one lookup:
 *   batchCount     – batches ever received (> 0 means the medicine has stock history)
 *   totalStock     – units physically on hand (all non-archived batches, expired ones included)
 *   availableStock – SELLABLE units (active, unexpired, unreserved)
 *   expiredStock   – on-hand units whose batch has expired
 *   stockStatus    – in_stock | low_stock | out_of_stock | expired, by these rules:
 *       sellable units > 0  -> low_stock if below the reorder level, else in_stock
 *       none sellable, but expired units on hand -> expired
 *       otherwise -> out_of_stock
 */
export const inventoryStatsStages = (now = new Date()) => [
  {
    $lookup: {
      from: 'batches',
      let: { id: '$_id', org: '$organizationId' },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$medicineId', '$$id'] }, { $eq: ['$organizationId', '$$org'] }] } } },
        {
          $group: {
            _id: null,
            batchCount: { $sum: 1 },
            totalStock: { $sum: { $cond: [{ $ne: ['$status', 'archived'] }, '$availableQuantity', 0] } },
            availableStock: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiryDate', now] }] }, sellableUnitsExpr, 0] } },
            expiredStock: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'archived'] }, { $lte: ['$expiryDate', now] }] }, '$availableQuantity', 0] } },
          },
        },
      ],
      as: '_stats',
    },
  },
  {
    $addFields: {
      batchCount: { $ifNull: [{ $first: '$_stats.batchCount' }, 0] },
      totalStock: { $ifNull: [{ $first: '$_stats.totalStock' }, 0] },
      availableStock: { $ifNull: [{ $first: '$_stats.availableStock' }, 0] },
      expiredStock: { $ifNull: [{ $first: '$_stats.expiredStock' }, 0] },
    },
  },
  {
    $addFields: {
      stockStatus: {
        $switch: {
          branches: [
            { case: { $gt: ['$availableStock', 0] }, then: { $cond: [{ $lt: ['$availableStock', '$reorderLevel'] }, 'low_stock', 'in_stock'] } },
            { case: { $gt: ['$expiredStock', 0] }, then: 'expired' },
          ],
          default: 'out_of_stock',
        },
      },
    },
  },
  { $project: { _stats: 0 } },
];

/** The same rules in plain JS, for a single medicine whose batches are already loaded. */
export function deriveStock(batches, reorderLevel, now = new Date()) {
  let totalStock = 0;
  let availableStock = 0;
  let expiredStock = 0;
  for (const b of batches) {
    if (b.status === 'archived') continue;
    totalStock += b.availableQuantity;
    const expired = new Date(b.expiryDate) <= now;
    if (expired) expiredStock += b.availableQuantity;
    else if (b.status === 'active') availableStock += Math.max(0, b.availableQuantity - b.reservedQuantity);
  }
  const stockStatus = availableStock > 0 ? (availableStock < reorderLevel ? 'low_stock' : 'in_stock') : expiredStock > 0 ? 'expired' : 'out_of_stock';
  return { batchCount: batches.length, totalStock, availableStock, expiredStock, stockStatus };
}

/** $match for medicines whose available stock is below their reorder level. */
export const lowStockMatch = { $expr: { $lt: ['$availableStock', '$reorderLevel'] } };

/** Older short names still accepted by the API. */
export const STOCK_STATUS_ALIASES = { in: 'in_stock', low: 'low_stock', out: 'out_of_stock' };

/** Sort order for "stock status": most urgent first. */
export const STOCK_RANK = { out_of_stock: 0, expired: 1, low_stock: 2, in_stock: 3 };
