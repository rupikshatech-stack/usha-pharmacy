import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const INGREDIENT_ROLES = ['active', 'base', 'excipient'];
export const INGREDIENT_ROLE_LABEL = { active: 'Active', base: 'Base', excipient: 'Excipient' };
/** `%` is per cent weight-in-weight of the finished preparation; `qs` means "enough to make up the total" and carries no number. */
export const INGREDIENT_UNITS = ['%', 'g', 'mg', 'mL', 'drops', 'qs'];
export const BUD_UNITS = ['days', 'months'];

/** One line of a preparation: what goes in, how much, and whether it is an active, the base, or something else. */
const ingredientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    // When the ingredient is something the pharmacy stocks, this points at it — so preparing a batch can later take it out of stock.
    medicineId: { type: Types.ObjectId, ref: 'Medicine' },
    role: { type: String, enum: INGREDIENT_ROLES, default: 'active' },
    quantity: { type: Number, min: 0 }, // absent for a `qs` base: it is whatever makes the total up
    unit: { type: String, enum: INGREDIENT_UNITS, required: true },
    notes: { type: String, trim: true, default: '', maxlength: 200 },
  },
  { _id: false },
);

/**
 * A compound serves two purposes in a pharmacy, and this record covers both:
 *
 *   1. A FORMULATION LABEL — "Paracetamol 650 mg" — that several bought-in medicines share. This is all most compounds
 *      are, and it is what `Medicine.compoundId` points at.
 *   2. A PREPARATION the pharmacy makes itself — a cream, a suspension, a capsule — written out as a recipe: what goes
 *      in, how it is made, how long it keeps and how it is normally taken.
 *
 * Everything from `totalQuantity` down is the second purpose and is simply absent on the first, so a plain formulation
 * label behaves exactly as it always did.
 */
const compoundSchema = new Schema(
  {
    organizationId: orgField,
    compoundName: { type: String, required: true, trim: true, maxlength: 150 },
    composition: { type: String, trim: true, default: '', maxlength: 500 },
    description: { type: String, trim: true, default: '', maxlength: 2000 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    /* ---- a preparation the pharmacy makes itself (absent on a plain formulation label) ---- */
    dosageForm: { type: String, trim: true, default: '', maxlength: 60 }, // Cream, Ointment, Suspension, Capsule …
    totalQuantity: { type: Number, min: 0.001 }, // what one batch makes: 100 g of cream, 60 capsules
    totalUnit: { type: String, trim: true, default: '', maxlength: 20 },
    ingredients: { type: [ingredientSchema], default: [] },
    instructions: { type: String, trim: true, default: '', maxlength: 4000 }, // how it is made, step by step
    // Equipment and handling it needs; these end up on the worksheet and the label.
    requiresHomogenizer: { type: Boolean, default: false },
    requiresUnguator: { type: Boolean, default: false },
    lightSensitive: { type: Boolean, default: false }, // dispense in an amber container
    sig: { type: String, trim: true, default: '', maxlength: 500 }, // the directions it normally carries
    budValue: { type: Number, min: 1, max: 3650 }, // beyond-use: how long it keeps once made
    budUnit: { type: String, enum: BUD_UNITS, default: 'days' },
    createdBy: { type: Types.ObjectId, ref: 'User' },
    createdByName: String,
    updatedBy: { type: Types.ObjectId, ref: 'User' },
    updatedByName: String,
  },
  timestamps,
);

compoundSchema.plugin(tenantScope);

compoundSchema.index({ organizationId: 1, compoundName: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }); // case-insensitive, per tenant
compoundSchema.index({ organizationId: 1, status: 1, compoundName: 1 });
compoundSchema.index({ organizationId: 1, 'ingredients.medicineId': 1 }); // "what do we make from this ingredient?"

export const Compound = mongoose.model('Compound', compoundSchema);
