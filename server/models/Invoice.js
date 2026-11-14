import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const INVOICE_STATUSES = ['draft', 'completed', 'cancelled', 'reversed'];

const invoiceItem = new Schema(
  {
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true },
    name: String,
    batchNo: String,
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true }, // the GST-INCLUSIVE selling price at the time of the sale
    discountPercent: { type: Number, default: 0 },
    amount: { type: Number, required: true }, // what this line came to, inclusive of tax, after its own discount
    // snapshots, so the invoice stays true even when the catalogue changes later
    genericName: String,
    sku: String,
    mrp: Number,
    expiryDate: Date,
    // the tax that was charged, split out of the inclusive price (amount = taxableAmount + taxAmount − its share of any bill discount)
    gstPercent: { type: Number, default: 0 },
    billDiscountShare: { type: Number, default: 0 }, // this line's share of the bill-level discount
    taxableAmount: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    // Units of this line the customer has brought back (only ever increased, by a recorded sales return, never past `quantity`).
    returnedQuantity: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    organizationId: orgField,
    invoiceNo: { type: String, required: true },
    // The store the sale came out of — the stock was deducted from its batches. Reporting groups sales by this.
    branchId: { type: Types.ObjectId, ref: 'Branch' },
    branchName: String,
    customer: { name: { type: String, default: 'Walk-in Customer' }, phone: { type: String, default: '' }, gstin: { type: String, default: '', uppercase: true, trim: true } },
    items: { type: [invoiceItem], validate: (v) => v.length > 0 },
    subTotal: { type: Number, required: true }, // Σ line gross, inclusive of tax, before any discount
    itemDiscount: { type: Number, default: 0 }, // Σ the discounts given on individual lines
    discount: { type: Number, default: 0 }, // the bill-level discount
    // the tax inside the total — never added on top of it
    taxableAmount: { type: Number, default: 0 },
    cgstTotal: { type: Number, default: 0 },
    sgstTotal: { type: Number, default: 0 },
    igstTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    interState: { type: Boolean, default: false }, // IGST instead of CGST + SGST
    gstSummary: { type: [new Schema({ gstPercent: Number, taxable: Number, cgst: Number, sgst: Number, igst: Number, tax: Number }, { _id: false })], default: [] },
    roundOff: { type: Number, default: 0 }, // nearest rupee, when the organization asks for it (total = taxable + tax + roundOff)
    total: { type: Number, required: true },
    paymentType: { type: String, enum: ['Cash', 'UPI', 'Card', 'Credit'], default: 'Cash' },
    paid: { type: Number, default: 0 },
    due: { type: Number, default: 0 },
    // Only present on a credit sale that still has something due, and only when the organization set a default credit
    // period (Common Settings). Absent otherwise — which is how every invoice looked before the setting existed.
    dueDate: Date,
    // Set only by recorded sales returns (the original total above never changes): the value of units customers brought back, and the
    // refund money promised for them. Together with `paid` they keep refunds from ever exceeding what the customer actually paid.
    returnedAmount: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },

    /**
     * Lifecycle. Only `completed` invoices are sales and count toward revenue:
     *   draft     – not issued yet
     *   completed – issued sale
     *   cancelled – voided before/without delivery
     *   reversed  – a completed sale that was undone (e.g. fully returned)
     */
    status: { type: String, enum: INVOICE_STATUSES, default: 'completed' },
    // When the sale happened (UTC). Reports use this, not createdAt, so back-dated/imported invoices land on the right day.
    invoiceDate: { type: Date, default: Date.now },
    cancelledAt: Date,
    cancelReason: { type: String, trim: true },
    reversedAt: Date,
    reversalReason: { type: String, trim: true },

    // Client-generated key that makes "save" safe to retry or double-click: the same key never creates a second invoice.
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
    createdBy: { type: Types.ObjectId, ref: 'User' },
  },
  timestamps,
);
invoiceSchema.plugin(tenantScope);

invoiceSchema.index({ organizationId: 1, invoiceNo: 1 }, { unique: true }); // invoice numbers are unique per tenant
invoiceSchema.index({ organizationId: 1, createdAt: -1 });
// Revenue / invoice-count reports: status + date range. Covers today, period and monthly queries.
invoiceSchema.index({ organizationId: 1, status: 1, invoiceDate: -1 });
invoiceSchema.index({ organizationId: 1, invoiceDate: -1 });
invoiceSchema.index({ organizationId: 1, branchId: 1, invoiceDate: -1 }); // sales per store, per period
// A retried request with the same key must never create a second invoice (only enforced when a key is sent).
invoiceSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
invoiceSchema.index({ organizationId: 1, 'items.medicineId': 1 }); // "has this medicine been sold?"
invoiceSchema.index({ organizationId: 1, 'customer.phone': 1 });

export const Invoice = mongoose.model('Invoice', invoiceSchema);
