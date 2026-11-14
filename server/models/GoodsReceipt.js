import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export class GoodsReceiptImmutableError extends Error {
  constructor(message = 'Goods received records are permanent: they cannot be changed or deleted.') {
    super(message);
    this.name = 'GoodsReceiptImmutableError';
    this.status = 500;
    this.code = 'GOODS_RECEIPT_IMMUTABLE';
  }
}

const lineSchema = new Schema(
  {
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    name: { type: String, required: true },
    unit: String,
    orderedQuantity: { type: Number, required: true, min: 0 }, // paid + free units the order expects
    previouslyReceived: { type: Number, required: true, min: 0 }, // units that arrived in earlier receipts
    remainingBefore: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 0 }, // paid units arriving now
    freeQuantity: { type: Number, required: true, min: 0 }, // free units arriving now
    rejectedQuantity: { type: Number, required: true, min: 0 }, // arrived but refused (wrong item, short expiry, …)
    damagedQuantity: { type: Number, required: true, min: 0 }, // arrived damaged
    acceptedQuantity: { type: Number, required: true, min: 0 }, // verified and added to sellable stock = quantity + free − rejected − damaged
    remainingAfter: { type: Number, required: true, min: 0 },
    batchNumber: String,
    manufacturingDate: Date,
    expiryDate: Date,
    purchasePrice: { type: Number, min: 0 },
    mrp: { type: Number, min: 0 },
    sellingPrice: { type: Number, min: 0 },
    batchId: { type: Types.ObjectId, ref: 'Batch' }, // the batch the accepted units went into (new or existing)
    newBatch: Boolean, // true when this receipt created the batch
    balanceAfter: { type: Number, min: 0 }, // that batch's quantity on hand after this receipt
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false },
);

/**
 * One act of receiving goods against an order: who received what, in which batch, what was refused or damaged. An order can be
 * delivered in several parts, so it can have several of these. Permanent, like the stock ledger: it is written in the same transaction
 * that adds the stock, and any attempt to update or delete it is refused. The idempotency key makes a repeated submission (a double
 * click, a retry) return the original record instead of adding the stock twice.
 */
const goodsReceiptSchema = new Schema(
  {
    organizationId: orgField,
    receiptNo: { type: String, required: true }, // GRN-0001 … per organization
    orderId: { type: Types.ObjectId, ref: 'Order', required: true },
    orderNo: { type: String, required: true },
    supplier: { supplierId: Types.ObjectId, name: String },
    branchId: { type: Types.ObjectId, ref: 'Branch' },
    items: { type: [lineSchema], validate: [(v) => v.length > 0, 'A goods received record needs at least one line'] },
    totalArrived: { type: Number, required: true, min: 0 },
    totalAccepted: { type: Number, required: true, min: 0 },
    totalRejected: { type: Number, required: true, min: 0 },
    totalDamaged: { type: Number, required: true, min: 0 },
    remarks: { type: String, trim: true, default: '', maxlength: 500 },
    supplierInvoice: { invoiceId: Types.ObjectId, number: String, date: Date }, // the supplier's invoice this delivery belongs to (AI Billing / purchase history)
    draftId: Types.ObjectId, // the draft goods receipt that was confirmed into this record
    uploadId: String, // the AI Billing upload the invoice came from
    idempotencyKey: { type: String, maxlength: 100 },
    receivedBy: { type: Types.ObjectId, ref: 'User', required: true },
    receivedByName: String,
    receivedAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
goodsReceiptSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
goodsReceiptSchema.pre(BLOCKED, function () {
  throw new GoodsReceiptImmutableError();
});
goodsReceiptSchema.pre('save', function () {
  if (!this.isNew) throw new GoodsReceiptImmutableError();
});
goodsReceiptSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new GoodsReceiptImmutableError();
});

goodsReceiptSchema.index({ organizationId: 1, receiptNo: 1 }, { unique: true });
goodsReceiptSchema.index({ organizationId: 1, orderId: 1, receivedAt: 1 });
goodsReceiptSchema.index({ organizationId: 1, receivedAt: -1 });
goodsReceiptSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const GoodsReceipt = mongoose.model('GoodsReceipt', goodsReceiptSchema);
