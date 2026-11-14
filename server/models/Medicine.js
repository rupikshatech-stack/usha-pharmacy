import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const TAXABILITY = ['taxable', 'exempt', 'nil'];

/**
 * The Drugs and Cosmetics Rules schedule the product is sold under. '' means nobody has said yet — it is never guessed
 * from the free-text details, because guessing wrong about a Schedule H1 drug is worse than admitting we do not know.
 */
export const DRUG_SCHEDULES = ['', 'H', 'H1', 'X', 'G', 'OTC'];
export const DRUG_SCHEDULE_LABEL = { H: 'Schedule H', H1: 'Schedule H1', X: 'Schedule X', G: 'Schedule G', OTC: 'Over the counter' };
export const TAXABILITY_LABEL = { taxable: 'Taxable', exempt: 'Exempt', nil: 'Nil rated' };

/**
 * A medicine is the PRODUCT (what it is). Real price, expiry and stock live on its BATCHES, never here —
 * stock is always calculated from the valid batches (see services/stock.service.js), and a bill is always
 * priced from the batch it sells. What this record carries about money is only a DEFAULT, to save typing
 * when a new batch is entered.
 */
const medicineSchema = new Schema(
  {
    organizationId: orgField,
    medicineName: { type: String, required: true, trim: true, maxlength: 150 },
    genericName: { type: String, trim: true, default: '', maxlength: 200 },
    salt: { type: String, trim: true, default: '', maxlength: 200 },
    manufacturer: { type: String, trim: true, default: '', maxlength: 120 },
    categoryId: { type: Types.ObjectId, ref: 'Attribute' }, // an Attribute with attributeType "category"
    compoundId: { type: Types.ObjectId, ref: 'Compound' },
    dosageForm: { type: String, trim: true, default: '', maxlength: 60 },
    strength: { type: String, trim: true, default: '', maxlength: 60 },
    packSize: { type: String, trim: true, default: '', maxlength: 60 }, // the printed pack, e.g. "15 tablets"; written from `packing` when that is filled in
    unit: { type: String, trim: true, default: '', maxlength: 30 },
    // The company whose name is on the pack, when that is not the factory that made it (a marketing company sells what a loan licensee manufactures).
    company: { type: String, trim: true, default: '', maxlength: 120 },
    /**
     * How the product is packed, outer to inner: an outer of `outerQty` inners, each inner holding `innerQty` sellable units.
     * e.g. { outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 } — a box of 10 strips of 15 tablets.
     * Stock is always counted in the SELLABLE unit (the tablet here); this only says how it arrives.
     */
    packing: {
      outerUnit: { type: String, trim: true, default: '', maxlength: 30 },
      outerQty: { type: Number, min: 1, max: 100000, default: 1 },
      innerUnit: { type: String, trim: true, default: '', maxlength: 30 },
      innerQty: { type: Number, min: 1, max: 100000 },
    },
    hsnCode: { type: String, trim: true, default: '', maxlength: 20 },
    // Which drug schedule it falls under, when that is known. Reporting filters on it; it does not restrict selling.
    scheduleCategory: { type: String, enum: DRUG_SCHEDULES, default: '' },
    // Whether GST applies at all. `exempt` and `nil` force the rate to 0, so a bill shows no tax for this product.
    taxability: { type: String, enum: TAXABILITY, default: 'taxable' },
    gstPercentage: { type: Number, min: 0, max: 100, default: 12 },
    // Defaults that prefill a NEW batch. They never price a sale: the batch being sold decides that.
    defaultMrp: { type: Number, min: 0 },
    defaultPurchasePrice: { type: Number, min: 0 },
    barcode: { type: String, trim: true, default: '', maxlength: 60 },
    sku: { type: String, trim: true, default: '', maxlength: 60 },
    reorderLevel: { type: Number, min: 0, default: 10 },
    description: { type: String, trim: true, default: '', maxlength: 2000 },
    image: { type: String, trim: true, default: '', maxlength: 500 }, // URL or path
    attributes: { type: [new Schema({ key: String, value: String }, { _id: false })], default: [] }, // free-form extra details
    isActive: { type: Boolean, default: true }, // false = archived: hidden from sale, history kept
    archivedAt: Date, // when it was archived (cleared on restore)
    archivedBy: { type: Types.ObjectId, ref: 'User' },
  },
  timestamps,
);

medicineSchema.plugin(tenantScope);

// Every index starts with organizationId so each query is served per tenant.
medicineSchema.index({ organizationId: 1, medicineName: 1 });
medicineSchema.index({ organizationId: 1, isActive: 1, medicineName: 1 });
medicineSchema.index({ organizationId: 1, categoryId: 1, medicineName: 1 });
medicineSchema.index({ organizationId: 1, compoundId: 1 });
medicineSchema.index({ organizationId: 1, manufacturer: 1, medicineName: 1 });
medicineSchema.index({ organizationId: 1, genericName: 1 });
medicineSchema.index({ organizationId: 1, hsnCode: 1 });
medicineSchema.index({ organizationId: 1, scheduleCategory: 1, medicineName: 1 });
// A barcode / SKU identifies one product within an organization (empty means "not set").
// Case-insensitive: "abc-1" and "ABC-1" are the same SKU.
const CI = { locale: 'en', strength: 2 };
medicineSchema.index({ organizationId: 1, barcode: 1 }, { unique: true, collation: CI, partialFilterExpression: { barcode: { $type: 'string', $gt: '' } } });
medicineSchema.index({ organizationId: 1, sku: 1 }, { unique: true, collation: CI, partialFilterExpression: { sku: { $type: 'string', $gt: '' } } });

export const Medicine = mongoose.model('Medicine', medicineSchema);
