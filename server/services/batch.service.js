import { Batch, Medicine } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from './audit.service.js';
import { defaultBranchId, requireActiveBranch } from './branch.service.js';
import { recordMovement } from './ledger.service.js';
import { withTransaction } from './transaction.service.js';

/** A batch as the API shows it, with derived fields (never stored, so they can't go stale). */
export const presentBatch = (b, now = new Date()) => {
  const expired = b.expiryDate <= now;
  const sellable = Math.max(0, b.availableQuantity - b.reservedQuantity);
  return { ...b, isExpired: expired, sellableQuantity: b.status === 'active' && !expired ? sellable : 0 };
};

export async function listBatches(orgId, medicineId) {
  const rows = await Batch.find({ organizationId: orgId, medicineId }).sort({ expiryDate: 1 }).lean();
  const now = new Date();
  return rows.map((b) => presentBatch(b, now));
}

const duplicateBatch = () => new ApiError(409, 'This medicine already has a batch with that batch number.', undefined, 'DUPLICATE_BATCH');

/**
 * Receives a new batch: the batch row AND its opening ledger entry are written together (call inside
 * a transaction). The medicine's stock then follows from its batches — nothing is stored on the medicine.
 */
export async function createBatchInTx(req, medicine, data, session) {
  const qty = data.initialQuantity;
  /**
   * Stock that has already expired is never received, however it arrives. Every way of putting a batch on a shelf —
   * adding one by hand, receiving a delivery, importing a spreadsheet — ends here, so this is where the rule is
   * enforced: not only when a form is validated, but at the write. A spreadsheet previewed on Monday and confirmed
   * on Friday has had four days to expire; its preview said it was fine, and this is what notices that it no longer is.
   * (Selling enforces the same thing again, in the atomic update that takes the stock.)
   */
  if (!data.expiryDate || new Date(data.expiryDate).getTime() <= Date.now()) {
    throw new ApiError(400, `Batch ${data.batchNumber || ''} has already expired, so it cannot be received into stock.`.replace('  ', ' '), [{ path: 'expiryDate', message: 'Expiry date must be in the future' }], 'BATCH_EXPIRED');
  }
  // A new batch is held in the store named, or in the default store. A client-supplied store must belong to this organization.
  const branchId = data.branchId ? (await requireActiveBranch(req.orgId, data.branchId, session))._id : await defaultBranchId(req.orgId, session);
  const [batch] = await Batch.create(
    [
      {
        organizationId: req.orgId,
        medicineId: medicine._id,
        batchNumber: data.batchNumber,
        manufacturer: data.manufacturer || medicine.manufacturer || '',
        manufacturingDate: data.manufacturingDate,
        expiryDate: data.expiryDate,
        purchasePrice: data.purchasePrice ?? 0,
        sellingPrice: data.sellingPrice,
        mrp: data.mrp,
        initialQuantity: qty,
        availableQuantity: qty,
        reservedQuantity: 0,
        branchId,
        supplierId: data.supplierId,
        status: 'active',
      },
    ],
    { session },
  );
  await recordMovement(req, session, {
    medicineId: medicine._id,
    batchId: batch._id,
    type: 'PURCHASE',
    quantity: qty,
    balanceAfter: qty,
    reason: data.ledger?.reason || 'Batch received',
    refType: data.ledger?.refType || 'Batch',
    refId: data.ledger?.refId || batch._id,
    branchId,
  });
  return batch;
}

export async function addBatch(req, medicineId, data) {
  const medicine = await Medicine.findOne({ _id: medicineId, organizationId: req.orgId }).lean();
  if (!medicine) throw new ApiError(404, 'Medicine not found');
  if (!medicine.isActive) throw new ApiError(409, 'This medicine is discontinued. Reactivate it before receiving stock.', undefined, 'MEDICINE_INACTIVE');
  try {
    return await withTransaction(async (session) => {
      const batch = await createBatchInTx(req, medicine, data, session);
      await audit(
        req,
        {
          action: 'STOCK_ADD',
          entity: 'Batch',
          entityId: batch._id,
          message: `Stock updated — ${medicine.medicineName} (+${data.initialQuantity}, batch ${data.batchNumber})`,
          meta: { batchNumber: data.batchNumber, quantity: data.initialQuantity, expiryDate: data.expiryDate },
        },
        session,
      );
      return batch;
    });
  } catch (e) {
    if (e.code === 11000) throw duplicateBatch();
    throw e;
  }
}

// A batch's store is NOT editable: stock changes store only through a transfer.
const CHANGEABLE = ['purchasePrice', 'sellingPrice', 'mrp', 'manufacturer', 'status', 'reservedQuantity', 'supplierId'];

/**
 * Edits the changeable parts of a batch. Identity (batch number, expiry, initial quantity, medicine) and
 * stock quantity are NOT editable: quantity changes go through the ledger (adjustStock), history stays intact.
 * Every change is audited with the old and new values.
 */
export async function updateBatch(req, medicineId, batchId, patch) {
  const batch = await Batch.findOne({ _id: batchId, medicineId, organizationId: req.orgId });
  if (!batch) throw new ApiError(404, 'Batch not found');

  const before = {};
  const after = {};
  for (const k of CHANGEABLE) {
    if (patch[k] !== undefined && String(patch[k]) !== String(batch[k])) {
      before[k] = batch[k];
      after[k] = patch[k];
      batch[k] = patch[k];
    }
  }
  if (!Object.keys(after).length) return batch.toObject();

  if (after.status === 'archived' && batch.availableQuantity !== 0) {
    throw new ApiError(409, `A batch with ${batch.availableQuantity} unit(s) on hand can't be archived. Write the stock off or sell it first.`, undefined, 'BATCH_NOT_EMPTY');
  }
  try {
    await batch.save(); // runs model validation (reserved ≤ on hand, price ≤ MRP)
  } catch (e) {
    if (e.name === 'ValidationError') throw new ApiError(400, Object.values(e.errors)[0].message, undefined, 'VALIDATION');
    throw e;
  }
  const medicine = await Medicine.findOne({ _id: medicineId, organizationId: req.orgId }).select('medicineName').lean();
  await audit(req, {
    action: 'BATCH_UPDATE',
    entity: 'Batch',
    entityId: batch._id,
    message: `Batch updated — ${medicine?.medicineName} batch ${batch.batchNumber} (${Object.keys(after).join(', ')})`,
    meta: { before, after },
  });
  return batch.toObject();
}

/**
 * Manual stock adjustment (stock take, damage, expiry write-off). Atomic: the batch balance and the
 * ledger entry change together or not at all. Stock can never go below zero or below the reserved amount.
 */
export async function adjustStock(req, { batchId, quantity, type, reason }) {
  return withTransaction(async (session) => {
    const batch = await Batch.findOne({ _id: batchId, organizationId: req.orgId }, null, { session }).lean();
    if (!batch) throw new ApiError(404, 'Batch not found');
    if (batch.status === 'archived') throw new ApiError(409, 'This batch is archived and cannot be adjusted.', undefined, 'BATCH_ARCHIVED');

    // The guard is part of the update itself, so two simultaneous removals can't both succeed and overdraw the batch.
    const updated = await Batch.findOneAndUpdate(
      { _id: batchId, organizationId: req.orgId, $expr: { $gte: [{ $add: ['$availableQuantity', quantity] }, '$reservedQuantity'] } },
      { $inc: { availableQuantity: quantity } },
      { returnDocument: 'after', session },
    );
    if (!updated) {
      throw new ApiError(
        409,
        `Not enough unreserved stock: ${batch.availableQuantity} on hand, ${batch.reservedQuantity} reserved, cannot remove ${-quantity}.`,
        undefined,
        'INSUFFICIENT_STOCK',
      );
    }

    await recordMovement(req, session, {
      medicineId: updated.medicineId,
      batchId: updated._id,
      type,
      quantity,
      balanceAfter: updated.availableQuantity,
      reason,
      refType: 'Adjustment',
    });
    const medicine = await Medicine.findOne({ _id: updated.medicineId, organizationId: req.orgId }, null, { session }).select('medicineName').lean();
    await audit(
      req,
      {
        action: type === 'WRITE_OFF' ? 'STOCK_WRITE_OFF' : 'STOCK_ADJUST',
        entity: 'Batch',
        entityId: updated._id,
        message: `Stock ${type === 'WRITE_OFF' ? 'written off' : 'adjusted'} — ${medicine?.medicineName} batch ${updated.batchNumber}: ${quantity > 0 ? '+' : ''}${quantity} (${reason})`,
        meta: { quantity, reason, before: batch.availableQuantity, after: updated.availableQuantity },
      },
      session,
    );
    return { batch: updated.toObject(), balanceAfter: updated.availableQuantity };
  });
}
