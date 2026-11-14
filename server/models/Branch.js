import mongoose from 'mongoose';
import { Schema, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';
import { GSTIN_PATTERN } from './Organization.js';

const CI = { locale: 'en', strength: 2 };

/**
 * A store (branch) of an organization: somewhere stock is held. Every organization always has exactly one DEFAULT
 * store ("Main Store"): batches that were never assigned to a store belong to it, and the Selling Point sells from it.
 */
const branchSchema = new Schema(
  {
    organizationId: orgField,
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    address: { type: String, trim: true, default: '', maxlength: 300 }, // the whole address on one line (kept for older screens; built from the parts below when they are given)
    phone: { type: String, trim: true, default: '', maxlength: 20 },
    // the branch profile (Branches page); a store made the older, quick way simply does not have these
    email: { type: String, trim: true, default: '', maxlength: 120 },
    addressLine1: { type: String, trim: true, default: '', maxlength: 150 },
    addressLine2: { type: String, trim: true, default: '', maxlength: 150 },
    country: { type: String, trim: true, default: '', maxlength: 60 },
    state: { type: String, trim: true, default: '', maxlength: 80 },
    city: { type: String, trim: true, default: '', maxlength: 80 },
    pincode: { type: String, trim: true, default: '', maxlength: 12 },
    landmark: { type: String, trim: true, default: '', maxlength: 150 },
    managerName: { type: String, trim: true, default: '', maxlength: 100 },
    gstin: { type: String, trim: true, uppercase: true, default: '', maxlength: 20, validate: { validator: (v) => !v || GSTIN_PATTERN.test(v), message: 'GSTIN is not in a valid format' } },
    openingDate: Date,
    notes: { type: String, trim: true, default: '', maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByName: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedByName: String,
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  timestamps,
);

branchSchema.plugin(tenantScope);

branchSchema.index({ organizationId: 1, name: 1 }, { unique: true, collation: CI });
branchSchema.index({ organizationId: 1, code: 1 }, { unique: true, collation: CI });
branchSchema.index({ organizationId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } }); // one default store per organization
branchSchema.index({ organizationId: 1, status: 1, name: 1 });

export const Branch = mongoose.model('Branch', branchSchema);
