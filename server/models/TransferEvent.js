import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const TRANSFER_EVENT_ACTIONS = ['CREATED', 'UPDATED', 'DELETED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'DISPATCHED', 'RECEIVED', 'CANCELLED'];

export class TransferEventImmutableError extends Error {
  constructor(message = 'The transfer history is permanent: events cannot be changed or deleted.') {
    super(message);
    this.name = 'TransferEventImmutableError';
    this.status = 500;
    this.code = 'TRANSFER_EVENT_IMMUTABLE';
  }
}

/**
 * The complete, append-only history of a stock transfer: one event for every change of its state (and every edit), saying who did
 * it, at which branch, what the status was before and after, why, and the details (quantities, references, discrepancies).
 *
 * Events are written in the SAME database transaction as the change they describe, so the history can never miss a change or show one
 * that did not happen. They are never edited or deleted — not even when the draft they belong to is deleted.
 */
const eventSchema = new Schema(
  {
    organizationId: orgField,
    transferId: { type: Types.ObjectId, ref: 'Transfer', required: true },
    transferReference: { type: String, required: true }, // kept so the history still reads after a draft is deleted
    action: { type: String, enum: TRANSFER_EVENT_ACTIONS, required: true },
    previousStatus: { type: String }, // absent for CREATED
    newStatus: { type: String },
    performedBy: { type: Types.ObjectId, ref: 'User', required: true },
    performedByName: { type: String }, // snapshot
    branchId: { type: Types.ObjectId, ref: 'Branch' }, // the branch the action happened at: source for dispatch, destination for receipt
    remarks: { type: String, trim: true, maxlength: 500 },
    timestamp: { type: Date, required: true, default: Date.now },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: false },
);

eventSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
eventSchema.pre(BLOCKED, function () {
  throw new TransferEventImmutableError();
});
eventSchema.pre('save', function () {
  if (!this.isNew) throw new TransferEventImmutableError();
});
eventSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new TransferEventImmutableError();
});

eventSchema.index({ organizationId: 1, transferId: 1, timestamp: 1 });
eventSchema.index({ organizationId: 1, timestamp: -1 });
eventSchema.index({ organizationId: 1, action: 1, timestamp: -1 });

export const TransferEvent = mongoose.model('TransferEvent', eventSchema);
