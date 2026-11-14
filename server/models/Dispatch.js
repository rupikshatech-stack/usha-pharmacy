import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export class DispatchImmutableError extends Error {
  constructor(message = 'A dispatch record is permanent: it cannot be changed or deleted. Cancel the transfer instead.') {
    super(message);
    this.name = 'DispatchImmutableError';
    this.status = 500;
    this.code = 'DISPATCH_IMMUTABLE';
  }
}

const lineSchema = new Schema(
  {
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true },
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, required: true }, // snapshots: the record stays readable if the catalogue changes later
    batchNumber: { type: String, required: true },
    approvedQuantity: { type: Number, required: true, min: 1 }, // what the transfer was approved for on this line
    previouslyDispatched: { type: Number, required: true, min: 0 }, // already sent by earlier dispatches
    dispatchedQuantity: { type: Number, required: true, min: 1, validate: Number.isInteger }, // sent by THIS dispatch
    remainingQuantity: { type: Number, required: true, min: 0 }, // still to send after this dispatch
    balanceAfter: { type: Number, required: true, min: 0 }, // the source batch's quantity on hand after this dispatch
  },
  { _id: false },
);

/**
 * One act of dispatching stock for a transfer: who sent what, when, and from which batches. A transfer can be dispatched in
 * several parts, so it can have several of these; each has its own unique reference (DSP-0001 …).
 *
 * The record is PERMANENT, like the stock ledger: it is written in the same transaction that removes the stock, and any attempt
 * to update or delete it is refused. The idempotency key (when given) makes a repeated submission of the same dispatch — a
 * double click, a retry after a timeout — return the original record instead of dispatching twice.
 */
const dispatchSchema = new Schema(
  {
    organizationId: orgField,
    reference: { type: String, required: true },
    transferId: { type: Types.ObjectId, ref: 'Transfer', required: true },
    transferReference: { type: String, required: true },
    fromBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    toBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    items: { type: [lineSchema], validate: [(v) => v.length > 0, 'A dispatch needs at least one line'] },
    totalUnits: { type: Number, required: true, min: 1 },
    closedShort: { type: Boolean, default: false }, // the remaining quantities were dropped: nothing more will be sent
    notes: { type: String, trim: true, default: '', maxlength: 300 },
    idempotencyKey: { type: String, maxlength: 100 },
    dispatchedBy: { type: Types.ObjectId, ref: 'User', required: true },
    dispatchedAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

dispatchSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
dispatchSchema.pre(BLOCKED, function () {
  throw new DispatchImmutableError();
});
dispatchSchema.pre('save', function () {
  if (!this.isNew) throw new DispatchImmutableError();
});
dispatchSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new DispatchImmutableError();
});

dispatchSchema.index({ organizationId: 1, reference: 1 }, { unique: true });
dispatchSchema.index({ organizationId: 1, transferId: 1, dispatchedAt: 1 });
dispatchSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
dispatchSchema.index({ organizationId: 1, dispatchedAt: -1 });

export const Dispatch = mongoose.model('Dispatch', dispatchSchema);
