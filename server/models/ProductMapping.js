import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * What a supplier's description of a medicine was confirmed to be: "this supplier's 'PCM 500 TAB' is our product Paracetamol 500mg Tablet". Written ONLY when
 * a person confirms a match, never from similarity alone, and reused only for the SAME description (the normalized key: name, strengths, dosage form, pack)
 * from the same supplier — and even then the product is compared again first (strength, dosage form, ingredient), so a changed product cannot be matched silently.
 * It points at an existing product by id; it never copies or changes the product.
 */
const mappingSchema = new Schema(
  {
    organizationId: orgField,
    supplierKey: { type: String, required: true }, // the supplier's id when known, otherwise gstin:… or name:…
    supplierId: { type: Types.ObjectId, ref: 'Supplier' },
    key: { type: String, required: true }, // the normalized description (see productNormalizationService.describe)
    originalName: { type: String, required: true, maxlength: 300 },
    normalizedName: { type: String, default: '' },
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    manufacturer: { type: String, default: '' },
    strength: { type: String, default: '' },
    dosageForm: { type: String, default: '' },
    packSize: { type: String, default: '' },
    source: { type: String, enum: ['automatic', 'manual'], required: true }, // how it was first confirmed: an automatic suggestion accepted, or a product picked by hand
    confirmedBy: { type: Types.ObjectId, ref: 'User' },
    confirmedByName: String,
    confirmedAt: { type: Date, required: true },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: Date,
    history: { type: [Schema.Types.Mixed], default: [] }, // earlier products this description pointed to, when it was changed
  },
  timestamps,
);
mappingSchema.plugin(tenantScope);

mappingSchema.index({ organizationId: 1, supplierKey: 1, key: 1 }, { unique: true }); // one product per supplier description: no duplicate mappings
mappingSchema.index({ organizationId: 1, medicineId: 1 });

export const ProductMapping = mongoose.model('ProductMapping', mappingSchema);
