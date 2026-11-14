import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export class ReceiptImmutableError extends Error {
  constructor(message = 'A receipt record is permanent: it cannot be changed or deleted.') {
    super(message);
    this.name = 'ReceiptImmutableError';
    this.status = 500;
    this.code = 'RECEIPT_IMMUTABLE';
  }
}

const lineSchema = new Schema(
  {
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true }, // the SOURCE batch the line came from
    destinationBatchId: { type: Types.ObjectId, ref: 'Batch' }, // the batch that was credited (absent when nothing was credited)
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, required: true },
    batchNumber: { type: String, required: true },
    dispatchedQuantity: { type: Number, required: true, min: 0 },
    previouslyReceived: { type: Number, required: true, min: 0 }, // good units credited by earlier receipts
    previouslyReported: { type: Number, required: true, min: 0 }, // damaged + missing reported by earlier receipts
    receivedQuantity: { type: Number, required: true, min: 0 }, // credited to the destination store by THIS receipt
    damagedQuantity: { type: Number, required: true, min: 0 },
    missingQuantity: { type: Number, required: true, min: 0 }, // missing or short
    remainingQuantity: { type: Number, required: true, min: 0 }, // still expected after this receipt
    remarks: { type: String, trim: true, maxlength: 300 },
    balanceAfter: { type: Number, min: 0 }, // the destination batch's quantity on hand after this receipt
  },
  { _id: false },
);

/**
 * One act of receiving a transfer's stock at the destination branch: who counted what, when, and what was wrong with it. A transfer
 * can be received in several parts, so it can have several of these. Permanent, like the stock ledger: it is written in the same
 * transaction that credits the destination stock, and any attempt to update or delete it is refused. The idempotency key makes a
 * repeated submission (a double click, a retry) return the original receipt instead of crediting stock twice.
 */
const receiptSchema = new Schema(
  {
    organizationId: orgField,
    reference: { type: String, required: true },
    transferId: { type: Types.ObjectId, ref: 'Transfer', required: true },
    transferReference: { type: String, required: true },
    fromBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    toBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    items: { type: [lineSchema], validate: [(v) => v.length > 0, 'A receipt needs at least one line'] },
    totalReceived: { type: Number, required: true, min: 0 },
    totalDamaged: { type: Number, required: true, min: 0 },
    totalMissing: { type: Number, required: true, min: 0 },
    closed: { type: Boolean, default: false }, // the receiver said nothing more is coming: what was still expected was written off as missing
    remarks: { type: String, trim: true, default: '', maxlength: 500 },
    idempotencyKey: { type: String, maxlength: 100 },
    receivedBy: { type: Types.ObjectId, ref: 'User', required: true },
    receivedByName: { type: String },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

receiptSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
receiptSchema.pre(BLOCKED, function () {
  throw new ReceiptImmutableError();
});
receiptSchema.pre('save', function () {
  if (!this.isNew) throw new ReceiptImmutableError();
});
receiptSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new ReceiptImmutableError();
});

receiptSchema.index({ organizationId: 1, reference: 1 }, { unique: true });
receiptSchema.index({ organizationId: 1, transferId: 1, receivedAt: 1 });
receiptSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
receiptSchema.index({ organizationId: 1, receivedAt: -1 });

export const Receipt = mongoose.model('Receipt', receiptSchema);
