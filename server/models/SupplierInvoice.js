import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * A supplier's invoice, verified by a person and recorded in the purchase history: which supplier, which invoice number and date, which order it belongs to,
 * the products and batch details it listed, what was then actually accepted and rejected (filled in as goods receipts are confirmed), the amounts, and who
 * created and verified it. One supplier cannot have the same (normalized) invoice number twice: the unique index is the duplicate protection; an authorized
 * person can record a legitimate repeat, which then carries a "#2" suffix in its key and a link to the first.
 * It records what was agreed and received. It never records a payment: the payment status shown is whatever the order records.
 */
const lineSchema = new Schema(
  {
    itemId: String,
    medicineId: { type: Types.ObjectId, ref: 'Medicine' },
    name: String,
    batchNumber: String,
    manufacturingDate: Date,
    expiryDate: Date,
    invoiceQuantity: Number,
    freeQuantity: Number,
    purchaseRate: Number,
    mrp: Number,
    discountPercentage: Number,
    gstPercentage: Number,
    lineTotal: Number,
    receivedQuantity: { type: Number, default: 0 }, // arrived so far (paid + free), over all confirmed receipts
    acceptedQuantity: { type: Number, default: 0 },
    rejectedQuantity: { type: Number, default: 0 },
    damagedQuantity: { type: Number, default: 0 },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    organizationId: orgField,
    supplier: { supplierId: { type: Types.ObjectId, ref: 'Supplier', required: true }, name: String, gstin: String },
    invoiceNumber: { type: String, required: true, trim: true, maxlength: 60 },
    invoiceKey: { type: String, required: true }, // normalized: lower-case letters and digits only (+ "#2" for a recorded repeat)
    duplicateOf: { type: Types.ObjectId, ref: 'SupplierInvoice' },
    invoiceDate: Date,
    invoiceType: String,
    orderId: { type: Types.ObjectId, ref: 'Order', required: true },
    orderNo: String,
    uploadObjectId: { type: Types.ObjectId, ref: 'InvoiceUpload' },
    uploadId: String,
    extractionVersion: Number,
    items: { type: [lineSchema], default: [] },
    totals: { type: Schema.Types.Mixed, default: {} }, // as verified: subtotal, discount, taxableAmount, cgst, sgst, igst, otherCharges, roundOff, grandTotal
    calculatedTotal: Number, // what the order module worked out from the same lines (a difference from grandTotal is shown, never hidden)
    receiptIds: { type: [Types.ObjectId], default: [] },
    receiptNos: { type: [String], default: [] },
    status: { type: String, enum: ['verified', 'partially_received', 'received'], default: 'verified' },
    paymentStatus: { type: String, enum: ['unpaid', 'partially_paid', 'paid'], default: 'unpaid' }, // copied from the order; nothing here marks anything paid
    createdBy: { type: Types.ObjectId, ref: 'User' },
    createdByName: String,
    verifiedBy: { type: Types.ObjectId, ref: 'User' },
    verifiedByName: String,
    verifiedAt: Date,
  },
  timestamps,
);
invoiceSchema.plugin(tenantScope);
invoiceSchema.index({ organizationId: 1, 'supplier.supplierId': 1, invoiceKey: 1 }, { unique: true });
invoiceSchema.index({ organizationId: 1, orderId: 1 });
invoiceSchema.index({ organizationId: 1, uploadObjectId: 1 });
invoiceSchema.index({ organizationId: 1, invoiceDate: -1 });

export const SupplierInvoice = mongoose.model('SupplierInvoice', invoiceSchema);
