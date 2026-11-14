import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const MOVEMENT_TYPES = ['OPENING', 'PURCHASE', 'SALE', 'SALE_RETURN', 'ADJUSTMENT', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT'];

export class LedgerImmutableError extends Error {
  constructor(message = 'The stock ledger is append-only: entries cannot be changed or deleted. Post a correcting entry instead.') {
    super(message);
    this.name = 'LedgerImmutableError';
    this.status = 500;
    this.code = 'LEDGER_IMMUTABLE';
  }
}

/**
 * The stock movement LEDGER: an append-only history of every change to a batch's quantity.
 * Entries are never edited or deleted — a mistake is fixed by posting a new, opposite entry.
 * For every batch:  sum(ledger quantities) === batch.availableQuantity  (see ledger.service reconcile()).
 */
const movementSchema = new Schema(
  {
    organizationId: orgField,
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    // Signed: positive adds stock, negative removes it. Zero is meaningless and rejected.
    quantity: { type: Number, required: true, validate: [(v) => Number.isInteger(v) && v !== 0, 'Quantity must be a non-zero whole number'] },
    balanceAfter: { type: Number, min: 0 }, // the batch's availableQuantity right after this entry
    reason: { type: String, trim: true, maxlength: 300 },
    refType: String, // e.g. "Invoice", "Batch"
    refId: Types.ObjectId,
    branchId: { type: Types.ObjectId },
    fromBranchId: { type: Types.ObjectId }, // transfers
    toBranchId: { type: Types.ObjectId },
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }, // there is no "updated": entries never change
);

movementSchema.plugin(tenantScope);

// ---- immutability: every way of changing or removing an existing entry is refused
const BLOCKED_QUERIES = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
movementSchema.pre(BLOCKED_QUERIES, function () {
  throw new LedgerImmutableError();
});
movementSchema.pre('save', function () {
  if (!this.isNew) throw new LedgerImmutableError();
});
movementSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new LedgerImmutableError();
});

movementSchema.index({ organizationId: 1, createdAt: -1 });
movementSchema.index({ organizationId: 1, batchId: 1, createdAt: 1 }); // a batch's history + balance reconciliation
movementSchema.index({ organizationId: 1, medicineId: 1, createdAt: -1 });
movementSchema.index({ organizationId: 1, type: 1, createdAt: -1 });
movementSchema.index({ organizationId: 1, refType: 1, refId: 1 });

export const StockMovement = mongoose.model('StockMovement', movementSchema);
