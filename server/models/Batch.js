import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const BATCH_STATUSES = ['active', 'quarantined', 'recalled', 'archived'];

/**
 * Where a request to send a lot back to the supplier has got to.
 *   requested  the lot has been set aside and the supplier asked to take it back (the batch is quarantined, so it cannot be sold)
 *   returned   the supplier took it back — and only this removes the stock, through the usual stock adjustment
 *   rejected   the supplier refused; the stock is ours and comes out of quarantine
 *   cancelled  we changed our minds; the stock comes out of quarantine
 */
export const SUPPLIER_RETURN_STATUSES = ['requested', 'returned', 'rejected', 'cancelled'];
/** Requests that still hold the stock in quarantine. */
export const OPEN_SUPPLIER_RETURNS = ['requested'];

/**
 * One received lot of a medicine. A medicine can have many batches, each with its own expiry date
 * and prices. Batches are HISTORICAL RECORDS: they are never physically deleted — a finished or
 * unwanted batch is archived. The fields that identify the lot are immutable once created.
 *
 * Quantities:
 *   initialQuantity   – units received (never changes)
 *   availableQuantity – units on hand now (changed only through the stock ledger, never below 0)
 *   reservedQuantity  – on-hand units set aside (e.g. pending orders); not sellable
 *   sellable          = availableQuantity − reservedQuantity, and only while the batch is active and not expired
 */
const batchSchema = new Schema(
  {
    organizationId: orgField,
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true, immutable: true },
    batchNumber: { type: String, required: true, trim: true, maxlength: 50, immutable: true },
    manufacturer: { type: String, trim: true, default: '', maxlength: 120 },
    manufacturingDate: { type: Date, immutable: true },
    expiryDate: { type: Date, required: true, immutable: true },
    purchasePrice: { type: Number, min: 0, default: 0 },
    sellingPrice: { type: Number, min: 0, required: true },
    mrp: { type: Number, min: 0, required: true },
    initialQuantity: { type: Number, min: 0, required: true, immutable: true, validate: Number.isInteger },
    availableQuantity: { type: Number, min: [0, 'Stock cannot go below zero'], required: true, validate: Number.isInteger },
    reservedQuantity: { type: Number, min: 0, default: 0, validate: Number.isInteger },
    branchId: { type: Types.ObjectId, ref: 'Branch', immutable: true }, // the store holding these units; it only changes through a transfer (which creates the batch in the other store). Missing = the default store.
    supplierId: { type: Types.ObjectId }, // Supplier module (planned)
    status: { type: String, enum: BATCH_STATUSES, default: 'active' },

    /**
     * Expiry Intelligence (Business Analytics). None of this prices or moves stock on its own: a disposal goes through
     * the ordinary stock adjustment, and a clearance flag is advice to whoever sets prices, never a price change.
     */
    // Written off because it expired or was destroyed. Set by the disposal action, which also removes the stock.
    disposedAt: Date,
    disposedBy: { type: Types.ObjectId, ref: 'User' },
    disposalReason: { type: String, trim: true, maxlength: 300 },
    // Marked for clearance: a SUGGESTED discount, recorded so the people who set prices can act on it. It never changes sellingPrice.
    clearance: {
      flagged: { type: Boolean, default: false },
      discountPercent: { type: Number, min: 0, max: 90 },
      note: { type: String, trim: true, maxlength: 300 },
      flaggedAt: Date,
      flaggedBy: { type: Types.ObjectId, ref: 'User' },
    },
    // A request to send the lot back to the supplier. While it is `requested` the batch is quarantined and cannot be sold.
    supplierReturn: {
      status: { type: String, enum: SUPPLIER_RETURN_STATUSES },
      note: { type: String, trim: true, maxlength: 300 },
      markedAt: Date,
      markedBy: { type: Types.ObjectId, ref: 'User' },
      settledAt: Date, // when it became returned / rejected / cancelled
      settledBy: { type: Types.ObjectId, ref: 'User' },
    },
  },
  timestamps,
);

batchSchema.plugin(tenantScope);

batchSchema.pre('validate', function () {
  if (this.reservedQuantity > this.availableQuantity) this.invalidate('reservedQuantity', 'Reserved quantity cannot exceed the quantity on hand');
  if (this.sellingPrice > this.mrp) this.invalidate('sellingPrice', 'Selling price cannot exceed the MRP');
  if (this.manufacturingDate && this.expiryDate && this.manufacturingDate >= this.expiryDate) {
    this.invalidate('manufacturingDate', 'Manufacturing date must be before the expiry date');
  }
});

batchSchema.virtual('sellableQuantity').get(function () {
  return Math.max(0, this.availableQuantity - this.reservedQuantity);
});

batchSchema.index({ organizationId: 1, medicineId: 1, expiryDate: 1 }); // FEFO allocation, per-medicine batch list
// Batch numbers are unique per tenant + medicine + STORE: the same lot can sit in several stores (that is what a transfer does).
batchSchema.index({ organizationId: 1, medicineId: 1, batchNumber: 1, branchId: 1 }, { unique: true });
batchSchema.index({ organizationId: 1, batchNumber: 1 }); // batch-number search
batchSchema.index({ organizationId: 1, expiryDate: 1, availableQuantity: 1 }); // expiry alerts and sellable stock
batchSchema.index({ organizationId: 1, status: 1, expiryDate: 1 });
batchSchema.index({ organizationId: 1, branchId: 1, medicineId: 1 });
batchSchema.index({ organizationId: 1, supplierId: 1 });
// Expiry Intelligence: the register reads every lot of one organization (optionally one store) in expiry order.
batchSchema.index({ organizationId: 1, branchId: 1, expiryDate: 1, availableQuantity: 1 });
batchSchema.index({ organizationId: 1, expiryDate: 1, availableQuantity: 1, branchId: 1 });
batchSchema.index({ organizationId: 1, 'clearance.flagged': 1, expiryDate: 1 }, { partialFilterExpression: { 'clearance.flagged': true } });
batchSchema.index({ organizationId: 1, 'supplierReturn.status': 1, expiryDate: 1 }, { partialFilterExpression: { 'supplierReturn.status': { $type: 'string' } } });
batchSchema.index({ organizationId: 1, disposedAt: -1 }, { partialFilterExpression: { disposedAt: { $type: 'date' } } });

export const Batch = mongoose.model('Batch', batchSchema);
