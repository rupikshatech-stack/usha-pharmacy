import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * The permanent record that a goods receipt was reversed: when, by whom, why, and exactly which units were taken back out of which batches (each as an
 * opposite entry in the stock ledger). The receipt itself is never edited or deleted; one receipt can be reversed once.
 */
const reversalSchema = new Schema(
  {
    organizationId: orgField,
    receiptId: { type: Types.ObjectId, ref: 'GoodsReceipt', required: true },
    receiptNo: { type: String, required: true },
    orderId: { type: Types.ObjectId, ref: 'Order', required: true },
    orderNo: String,
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    lines: {
      type: [new Schema({ medicineId: Types.ObjectId, name: String, batchId: Types.ObjectId, batchNumber: String, quantity: Number, balanceAfter: Number, paid: Number, free: Number, rejected: Number, damaged: Number }, { _id: false })],
      default: [],
    },
    totalRemoved: { type: Number, required: true, min: 0 },
    idempotencyKey: { type: String, maxlength: 100 },
    reversedBy: { type: Types.ObjectId, ref: 'User', required: true },
    reversedByName: String,
    reversedAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
reversalSchema.plugin(tenantScope);
const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
const refuse = () => {
  throw Object.assign(new Error('Reversal records are permanent.'), { status: 500, code: 'REVERSAL_IMMUTABLE' });
};
reversalSchema.pre(BLOCKED, refuse);
reversalSchema.pre('save', function () {
  if (!this.isNew) refuse();
});
reversalSchema.index({ organizationId: 1, receiptId: 1 }, { unique: true }); // a receipt is reversed at most once
reversalSchema.index({ organizationId: 1, orderId: 1 });
reversalSchema.index({ organizationId: 1, reversedAt: -1 }); // purchase returns in a reporting period

export const GoodsReceiptReversal = mongoose.model('GoodsReceiptReversal', reversalSchema);
