import mongoose from 'mongoose';
import { Batch, StockMovement } from '../models/index.js';
import { paginated } from '../utils/pagination.js';

/**
 * Appends one entry to the stock ledger (call inside the same transaction that changes the batch).
 * The ledger is append-only: this is the ONLY way entries are created and there is no way to edit or delete them.
 */
export async function recordMovement(req, session, data) {
  const [movement] = await StockMovement.create([{ organizationId: req.orgId, createdBy: req.user._id, ...data }], { session });
  return movement;
}

const createdAtRange = (from, to) => (from || to ? { createdAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } } : {});

/** The ledger, newest first, with the medicine and batch names resolved. */
export async function listMovements(orgId, { medicineId, batchId, type, from, to, page, limit }) {
  const match = {
    organizationId: orgId,
    // aggregate() does not cast ids for us
    ...(medicineId && { medicineId: new mongoose.Types.ObjectId(medicineId) }),
    ...(batchId && { batchId: new mongoose.Types.ObjectId(batchId) }),
    ...(type && { type }),
    ...createdAtRange(from, to),
  };
  const [result] = await StockMovement.aggregate([
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: { from: 'medicines', localField: 'medicineId', foreignField: '_id', as: 'm' } },
          { $lookup: { from: 'batches', localField: 'batchId', foreignField: '_id', as: 'b' } },
          { $lookup: { from: 'users', localField: 'createdBy', foreignField: '_id', pipeline: [{ $project: { name: 1 } }], as: 'u' } },
          // sales point back at their invoice, so the history can say which one
          { $lookup: { from: 'invoices', let: { id: '$refId', t: '$refType', org: '$organizationId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$$t', 'Invoice'] }, { $eq: ['$_id', '$$id'] }, { $eq: ['$organizationId', '$$org'] }] } } }, { $project: { invoiceNo: 1 } }], as: 'inv' } },
          {
            $project: {
              type: 1, quantity: 1, balanceAfter: 1, reason: 1, refType: 1, refId: 1, createdAt: 1, createdBy: 1, branchId: 1, fromBranchId: 1, toBranchId: 1, medicineId: 1, batchId: 1,
              medicineName: { $first: '$m.medicineName' },
              batchNumber: { $first: '$b.batchNumber' },
              createdByName: { $first: '$u.name' },
              invoiceNo: { $first: '$inv.invoiceNo' },
            },
          },
        ],
        count: [{ $count: 'n' }],
      },
    },
  ]);
  return paginated(result.items, { page, limit, total: result.count[0]?.n || 0 });
}

/**
 * Integrity check: for every batch, the ledger must add up to the units on hand.
 * Returns the batches where it doesn't (an empty list means the books are consistent).
 */
export async function reconcileStock(orgId) {
  const [ledger, batches] = await Promise.all([
    StockMovement.aggregate([{ $match: { organizationId: orgId } }, { $group: { _id: '$batchId', balance: { $sum: '$quantity' }, entries: { $sum: 1 } } }]),
    Batch.find({ organizationId: orgId }).select('medicineId batchNumber availableQuantity').lean(),
  ]);
  const byBatch = new Map(ledger.map((l) => [String(l._id), l]));
  const discrepancies = [];
  for (const b of batches) {
    const l = byBatch.get(String(b._id));
    const ledgerBalance = l?.balance ?? 0;
    if (ledgerBalance !== b.availableQuantity) {
      discrepancies.push({ batchId: b._id, medicineId: b.medicineId, batchNumber: b.batchNumber, availableQuantity: b.availableQuantity, ledgerBalance, difference: b.availableQuantity - ledgerBalance, entries: l?.entries ?? 0 });
    }
  }
  return { batchesChecked: batches.length, consistent: discrepancies.length === 0, discrepancies };
}
