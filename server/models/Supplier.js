import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';
import { GSTIN_PATTERN } from './Organization.js';

const CI = { locale: 'en', strength: 2 };

/** A permanent account number: five letters, four digits, one letter (ABCDE1234F). */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'wholesaler', 'stockist', 'other'];
export const SUPPLIER_TYPE_LABEL = { manufacturer: 'Manufacturer', distributor: 'Distributor', wholesaler: 'Wholesaler', stockist: 'Stockist', other: 'Other' };

/**
 * How this supplier is normally paid. This is their standing arrangement, which is not the same thing as an individual order's `payment.terms`
 * (cod / advance / credit / partial): a supplier on 30-day terms places orders on credit with a 30-day credit period.
 */
export const SUPPLIER_PAYMENT_TERMS = ['advance', 'cod', 'net7', 'net15', 'net30', 'net45', 'custom'];
export const SUPPLIER_PAYMENT_TERMS_LABEL = { advance: 'Advance payment', cod: 'Cash on delivery', net7: '7 days', net15: '15 days', net30: '30 days', net45: '45 days', custom: 'Custom' };
/** The credit period each term implies, in days; `custom` takes whatever `creditPeriodDays` says. */
export const TERM_DAYS = { advance: 0, cod: 0, net7: 7, net15: 15, net30: 30, net45: 45 };

/**
 * A company the pharmacy buys stock from. Orders point to it and keep a snapshot of its details at the time of the order, so editing a supplier here never
 * rewrites history. Everything beyond the name is optional in the database — records the Orders module created before the Suppliers screens existed are still
 * valid — while the API asks for the contact person and phone number when a supplier is added or edited through the Suppliers form.
 */
const supplierSchema = new Schema(
  {
    organizationId: orgField,
    // The code people quote (SUP-0001 …). The server fills it in when a supplier is added without one; it is unique per organization, whatever the case.
    code: { type: String, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    supplierType: { type: String, enum: SUPPLIER_TYPES, default: 'distributor' },
    website: { type: String, trim: true, default: '', maxlength: 200 },
    isPreferred: { type: Boolean, default: false }, // listed first and marked in the table

    contactPerson: { type: String, trim: true, default: '', maxlength: 100 },
    phone: { type: String, trim: true, default: '', maxlength: 20 },
    altPhone: { type: String, trim: true, default: '', maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, default: '', maxlength: 150 },
    altEmail: { type: String, trim: true, lowercase: true, default: '', maxlength: 150 },

    address: {
      line1: { type: String, trim: true, default: '', maxlength: 150 },
      line2: { type: String, trim: true, default: '', maxlength: 150 },
      city: { type: String, trim: true, default: '', maxlength: 80 },
      state: { type: String, trim: true, default: '', maxlength: 80 },
      pincode: { type: String, trim: true, default: '', maxlength: 10 },
      country: { type: String, trim: true, default: 'India', maxlength: 80 },
      landmark: { type: String, trim: true, default: '', maxlength: 150 },
    },

    gstin: { type: String, trim: true, uppercase: true, default: '', validate: { validator: (v) => !v || GSTIN_PATTERN.test(v), message: 'GST number is not in a valid format' } },
    pan: { type: String, trim: true, uppercase: true, default: '', validate: { validator: (v) => !v || PAN_PATTERN.test(v), message: 'PAN is not in a valid format' } },

    // How buying from them usually works. None of it moves money; it is what the order screens start from.
    procurement: {
      // no default: a supplier is only said to trade on particular terms once someone has chosen them (the order form prefills from this, so a guess would mislead)
      paymentTerms: { type: String, enum: SUPPLIER_PAYMENT_TERMS },
      creditPeriodDays: { type: Number, min: 0, max: 365, default: 0 },
      minimumOrderValue: { type: Number, min: 0, default: 0 }, // rupees
      preferredDeliveryTime: { type: String, trim: true, default: '', maxlength: 100 }, // e.g. "2–3 days" or "Mornings"
      defaultBranchId: { type: Types.ObjectId, ref: 'Branch' }, // the store their deliveries usually go to
      notes: { type: String, trim: true, default: '', maxlength: 1000 },
    },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Types.ObjectId, ref: 'User' },
    createdByName: String,
    updatedBy: { type: Types.ObjectId, ref: 'User' },
    updatedByName: String,
  },
  timestamps,
);
supplierSchema.plugin(tenantScope);

supplierSchema.index({ organizationId: 1, name: 1 }, { unique: true, collation: CI }); // one supplier per name in an organization, any case
supplierSchema.index({ organizationId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } }); // and one supplier per code
supplierSchema.index({ organizationId: 1, isActive: 1, name: 1 });
supplierSchema.index({ organizationId: 1, isPreferred: -1, name: 1 });
supplierSchema.index({ organizationId: 1, gstin: 1 });

export const Supplier = mongoose.model('Supplier', supplierSchema);
