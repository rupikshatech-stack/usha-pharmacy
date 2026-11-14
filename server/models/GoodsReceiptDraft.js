import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

const lineSchema = new Schema(
  {
    itemId: String, // the invoice row this line came from (AI Billing), when it came from an invoice
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    name: { type: String, required: true },
    unit: String,
    // what the supplier's invoice says — kept apart from what actually arrived; never edited
    invoice: { type: Schema.Types.Mixed, default: {} }, // { quantity, freeQuantity, batchNumber, manufacturingDate, expiryDate, mrp, purchaseRate, discountPercentage, gstPercentage, lineTotal }
    // what the person enters after counting the delivery (null = not entered yet: it is never assumed to equal the invoice)
    receivedQuantity: { type: Number, min: 0, default: null }, // paid units that arrived
    receivedFree: { type: Number, min: 0, default: null }, // free units that arrived
    rejectedQuantity: { type: Number, min: 0, default: 0 },
    damagedQuantity: { type: Number, min: 0, default: 0 },
    batchNumber: { type: String, trim: true, default: '' },
    manufacturingDate: Date,
    expiryDate: Date,
    purchasePrice: { type: Number, min: 0 },
    mrp: { type: Number, min: 0 },
    sellingPrice: { type: Number, min: 0 },
    remarks: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: true },
);

/**
 * A goods receipt being prepared: the lines of a supplier invoice against an order, with the quantities that ACTUALLY arrived entered separately from
 * what the invoice says. Editable until it is confirmed. Confirming it hands the lines to the order module's receiving service (one transaction that adds
 * only the accepted units to stock and writes the permanent, immutable GRN); the draft then records which GRN it became and can no longer change.
 */
const draftSchema = new Schema(
  {
    organizationId: orgField,
    draftNo: { type: String, required: true }, // GRD-0001 … per organization
    orderId: { type: Types.ObjectId, ref: 'Order', required: true },
    orderNo: { type: String, required: true },
    supplier: { supplierId: Types.ObjectId, name: String },
    branchId: { type: Types.ObjectId, ref: 'Branch' },
    supplierInvoiceId: { type: Types.ObjectId, ref: 'SupplierInvoice' },
    supplierInvoiceNumber: String,
    supplierInvoiceDate: Date,
    uploadObjectId: { type: Types.ObjectId, ref: 'InvoiceUpload' },
    uploadId: String,
    items: { type: [lineSchema], default: [] },
    notes: { type: String, trim: true, default: '', maxlength: 500 },
    status: { type: String, enum: ['draft', 'confirming', 'confirmed', 'discarded'], default: 'draft' },
    revision: { type: Number, default: 0 }, // guards concurrent edits
    receiptId: { type: Types.ObjectId, ref: 'GoodsReceipt' },
    receiptNo: String,
    confirmedBy: { type: Types.ObjectId, ref: 'User' },
    confirmedByName: String,
    confirmedAt: Date,
    createdBy: { type: Types.ObjectId, ref: 'User' },
    createdByName: String,
    updatedByName: String,
  },
  timestamps,
);
draftSchema.plugin(tenantScope);
draftSchema.index({ organizationId: 1, draftNo: 1 }, { unique: true });
draftSchema.index({ organizationId: 1, orderId: 1, status: 1 });
draftSchema.index({ organizationId: 1, uploadObjectId: 1, status: 1 });
// one open draft per invoice: two requests at the same moment cannot make two
draftSchema.index({ organizationId: 1, uploadObjectId: 1 }, { unique: true, partialFilterExpression: { status: 'draft', uploadObjectId: { $exists: true } } });

export const GoodsReceiptDraft = mongoose.model('GoodsReceiptDraft', draftSchema);
