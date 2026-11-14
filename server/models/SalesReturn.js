import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const RETURN_STATUSES = ['pending', 'approved', 'rejected', 'refund_pending', 'refunded', 'completed'];
export const RETURN_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', refund_pending: 'Refund Pending', refunded: 'Refunded', completed: 'Completed' };
// Statuses where the refund has been paid out, and where it is still owed (not rejected, not yet paid).
export const REFUNDED_STATUSES = ['refunded', 'completed'];
export const AWAITING_REFUND_STATUSES = ['pending', 'approved', 'refund_pending'];

// Why the customer brought the medicines back.
export const RETURN_REASONS = ['expired', 'damaged', 'wrong_product', 'incorrect_quantity', 'changed_mind', 'quality_issue', 'other'];
export const RETURN_REASON_LABEL = {
  expired: 'Expired Medicine',
  damaged: 'Damaged Product',
  wrong_product: 'Wrong Product Delivered',
  incorrect_quantity: 'Incorrect Quantity',
  changed_mind: 'Customer Changed Mind',
  quality_issue: 'Quality Issue',
  other: 'Other',
};
// A return for these reasons can never put units back on the shelf.
export const NO_RESTOCK_REASONS = ['expired', 'damaged'];

// The state of the returned units, as checked by staff. Only "good" units can be restocked (and only when verified).
export const RETURN_CONDITIONS = ['good', 'damaged', 'expired', 'compromised'];
export const RETURN_CONDITION_LABEL = { good: 'Good — sealed and in date', damaged: 'Damaged', expired: 'Expired', compromised: 'Packaging opened or compromised' };

// Money going back to the customer. Recorded only: no payment is ever initiated from here.
export const REFUND_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Store Credit'];
export const REFUND_STATUSES = ['pending', 'processing', 'completed', 'failed'];
export const REFUND_STATUS_LABEL = { pending: 'Pending', processing: 'Processing', completed: 'Completed', failed: 'Failed' };

/** The return's own status that follows from where the refund stands (a failed refund leaves the return approved, to be retried). */
export const returnStatusFor = (refundStatus) => ({ pending: 'refund_pending', processing: 'refund_pending', completed: 'completed', failed: 'approved' })[refundStatus] || 'pending';

const returnItem = new Schema(
  {
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true },
    name: String, // snapshots, like the invoice's
    batchNo: String,
    expiryDate: Date, // the batch's expiry, kept with the return
    originalQuantity: { type: Number, min: 1 }, // units on the invoice line
    previouslyReturned: { type: Number, min: 0, default: 0 }, // units already returned against that line before this return
    quantity: { type: Number, required: true, min: 1 }, // units the customer brought back now
    price: { type: Number, required: true, min: 0 }, // what the customer actually paid per unit (after discounts), rupees
    amount: { type: Number, required: true, min: 0 }, // refund value of these units, rupees, 2 decimals
    condition: { type: String, enum: RETURN_CONDITIONS, default: 'good' },
    restock: { type: Boolean, default: false }, // staff chose to put the units back into sellable stock
    verified: { type: Boolean, default: false }, // and confirmed they inspected them
    restockedQuantity: { type: Number, default: 0, min: 0 }, // units actually put back into inventory
  },
  { _id: false },
);

// One line of the return's permanent history: who did what, when (approval, rejection, refund steps, edits).
const historySchema = new Schema(
  {
    action: { type: String, required: true }, // CREATED | APPROVED | REJECTED | REFUND | EDITED
    at: { type: Date, default: Date.now },
    by: { type: Types.ObjectId, ref: 'User' },
    byName: String,
    note: String,
    previousStatus: String,
    newStatus: String,
  },
  { _id: false },
);

const refundSchema = new Schema(
  {
    method: { type: String, enum: REFUND_METHODS, required: true },
    status: { type: String, enum: REFUND_STATUSES, default: 'pending' },
    reference: { type: String, trim: true, maxlength: 100 }, // transaction / reference id
    remarks: { type: String, trim: true, maxlength: 300 },
    paidAt: Date, // when a Completed refund was recorded
    paidBy: { type: Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

/**
 * A customer returning medicines from an earlier invoice. Reuses what already exists: the invoice (and its lines) it refers to,
 * the batch the stock goes back into, and the stock ledger (SALE_RETURN) when verified units are restocked. Money is in rupees
 * with 2 decimals, like invoices; totals are computed in whole paise so floating-point error never builds up.
 *
 *   pending        – recorded, waiting to be approved
 *   approved       – accepted; the refund has not been arranged yet (also: the refund failed and must be retried)
 *   rejected       – refused (nothing refunded, nothing restocked)
 *   refund_pending – the refund is pending or being processed
 *   refunded       – the money has been paid back
 *   completed      – refunded (the stock side was settled when the return was recorded)
 */
const returnSchema = new Schema(
  {
    organizationId: orgField,
    returnNo: { type: String, required: true }, // SR-0001 … per organization
    invoiceId: { type: Types.ObjectId, ref: 'Invoice', required: true },
    invoiceNo: { type: String, required: true },
    invoiceDate: Date,
    customer: { name: { type: String, default: 'Walk-in Customer' }, phone: { type: String, default: '' } },
    items: { type: [returnItem], validate: (v) => v.length > 0 },
    returnValue: { type: Number, required: true, min: 0 }, // value of the returned products
    refundAmount: { type: Number, required: true, min: 0 }, // what is being refunded (never more than the return value)
    originalPaymentMethod: { type: String },
    refund: { type: refundSchema },
    status: { type: String, enum: RETURN_STATUSES, default: 'pending' },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    notes: { type: String, trim: true, maxlength: 300 }, // additional remarks
    returnDate: { type: Date, default: Date.now },
    processedAt: Date,
    processedBy: { type: Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvedBy: { type: Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectedBy: { type: Types.ObjectId, ref: 'User' },
    rejectReason: { type: String, trim: true, maxlength: 300 },
    history: { type: [historySchema], default: [] },
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  timestamps,
);
returnSchema.plugin(tenantScope);

returnSchema.index({ organizationId: 1, returnNo: 1 }, { unique: true });
returnSchema.index({ organizationId: 1, status: 1, returnDate: -1 });
returnSchema.index({ organizationId: 1, returnDate: -1 });
returnSchema.index({ organizationId: 1, reason: 1, returnDate: -1 });
returnSchema.index({ organizationId: 1, invoiceId: 1 });
returnSchema.index({ organizationId: 1, 'customer.phone': 1 });
returnSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const SalesReturn = mongoose.model('SalesReturn', returnSchema);
