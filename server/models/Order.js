import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const ORDER_STATUSES = ['draft', 'pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled'];
export const ORDER_STATUS_LABEL = { draft: 'Draft', pending: 'Pending approval', approved: 'Approved', ordered: 'Ordered', partially_received: 'Partially received', received: 'Received', cancelled: 'Cancelled' };
// Orders that can still be received against, and those that can still be cancelled (nothing has arrived yet).
export const RECEIVABLE_ORDER_STATUSES = ['ordered', 'partially_received'];
export const CANCELLABLE_ORDER_STATUSES = ['draft', 'pending', 'approved', 'ordered'];

export const PAYMENT_TERMS = ['cod', 'advance', 'credit', 'partial'];
export const PAYMENT_TERMS_LABEL = { cod: 'Cash on Delivery', advance: 'Advance Payment', credit: 'Credit', partial: 'Partial Payment' };
export const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];
export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'];
export const PAYMENT_STATUS_LABEL = { unpaid: 'Unpaid', partially_paid: 'Partially Paid', paid: 'Paid' };

// The order's permanent history: who did what, when (submitted, approved, ordered, received, cancelled …).
const historySchema = new Schema(
  { action: { type: String, required: true }, at: { type: Date, default: Date.now }, by: { type: Types.ObjectId, ref: 'User' }, byName: String, note: String, previousStatus: String, newStatus: String },
  { _id: false },
);

const orderItem = new Schema(
  {
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    // snapshots: the order keeps what was asked for even if the catalogue changes later
    name: { type: String, required: true },
    sku: String,
    genericName: String,
    manufacturer: String,
    category: String,
    unit: String,
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger }, // units paid for
    freeQuantity: { type: Number, default: 0, min: 0, validate: Number.isInteger }, // extra units the supplier gives at no charge
    rate: { type: Number, default: 0, min: 0 }, // purchase rate per unit, rupees
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    gstPercent: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, default: 0, min: 0 }, // quantity × rate
    discountAmount: { type: Number, default: 0, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 }, // amount − discount + GST
    // Goods received against this line (cumulative). `receivedQuantity` = units that have ARRIVED (paid + free); of those, some were accepted into
    // stock and some rejected or damaged. A line with no `arrivedPaid` / `arrivedFree` predates receiving: its `receivedQuantity` is read as paid first.
    receivedQuantity: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    arrivedPaid: { type: Number, min: 0, validate: Number.isInteger },
    arrivedFree: { type: Number, min: 0, validate: Number.isInteger },
    acceptedQuantity: { type: Number, default: 0, min: 0, validate: Number.isInteger }, // added to sellable stock
    rejectedQuantity: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    damagedQuantity: { type: Number, default: 0, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

/**
 * An order placed with a supplier for stock that is expected to arrive. The supplier's details are copied onto the order at the time it
 * is made (so the order stays readable if the supplier changes later); `supplierId` points to the Supplier record. Money is in rupees with
 * 2 decimals, computed in whole paise (see utils/orderMath.js). Payment fields only RECORD what was agreed or paid: no payment is made.
 *
 *   draft              – being prepared, not submitted
 *   pending            – submitted, waiting for approval (only when the organization requires approval)
 *   approved           – authorized (automatically when approval is not required); not yet sent to the supplier
 *   ordered            – sent to the supplier, nothing received yet
 *   partially_received – some units have arrived
 *   received           – everything expected has arrived
 *   cancelled          – dropped before anything arrived
 */
const orderSchema = new Schema(
  {
    organizationId: orgField,
    orderNo: { type: String, required: true }, // ORD-0001 … per organization
    supplier: {
      supplierId: { type: Types.ObjectId, ref: 'Supplier' },
      name: { type: String, required: true, trim: true, maxlength: 150 },
      contactPerson: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      email: { type: String, trim: true, default: '' },
      address: { type: String, trim: true, default: '' },
      gstin: { type: String, trim: true, default: '' },
    },
    branchId: { type: Types.ObjectId, ref: 'Branch' }, // the store the goods are to be delivered to
    referenceNo: { type: String, trim: true, maxlength: 60 }, // the supplier's own reference (quote / PO number)
    items: { type: [orderItem], validate: (v) => v.length > 0 },
    status: { type: String, enum: ORDER_STATUSES, default: 'draft' },
    orderDate: { type: Date, default: Date.now },
    expectedDate: Date,
    notes: { type: String, trim: true, maxlength: 500 },

    // totals (rupees)
    totalItems: { type: Number, default: 0 },
    totalQuantity: { type: Number, default: 0 },
    totalFreeQuantity: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    gstTotal: { type: Number, default: 0 },
    charges: {
      shipping: { type: Number, default: 0, min: 0 },
      packaging: { type: Number, default: 0, min: 0 },
      other: { type: Number, default: 0, min: 0 },
      gstPercent: { type: Number, default: 0, min: 0, max: 100 },
      gstAmount: { type: Number, default: 0, min: 0 },
      additionalDiscount: { type: Number, default: 0, min: 0 },
    },
    grandTotal: { type: Number, default: 0, min: 0 },

    payment: {
      terms: { type: String, enum: PAYMENT_TERMS },
      method: { type: String, enum: PAYMENT_METHODS },
      advance: { type: Number, default: 0, min: 0 }, // money said to have been paid in advance (recorded only)
      remaining: { type: Number, default: 0, min: 0 },
      status: { type: String, enum: PAYMENT_STATUSES },
    },

    submittedAt: Date,
    submittedBy: { type: Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvedBy: { type: Types.ObjectId, ref: 'User' },
    rejectReason: { type: String, trim: true, maxlength: 300 }, // why an approver sent it back to draft
    orderedAt: Date,
    orderedBy: { type: Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancelledBy: { type: Types.ObjectId, ref: 'User' },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    history: { type: [historySchema], default: [] },
    receivedAt: Date,
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  timestamps,
);
orderSchema.plugin(tenantScope);

orderSchema.index({ organizationId: 1, orderNo: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, orderDate: -1 });
orderSchema.index({ organizationId: 1, status: 1, orderDate: -1 });
orderSchema.index({ organizationId: 1, 'supplier.name': 1 });
orderSchema.index({ organizationId: 1, 'supplier.supplierId': 1 });
orderSchema.index({ organizationId: 1, 'items.medicineId': 1 });
orderSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

export const Order = mongoose.model('Order', orderSchema);
