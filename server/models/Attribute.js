import mongoose from 'mongoose';
import { Schema, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const ATTRIBUTE_TYPES = ['category', 'dosage_form', 'strength', 'unit', 'custom'];

/**
 * Configurable lists used by the catalogue.
 *   category     – one record PER category (attributeName = "Tablets"); medicines point to it with categoryId.
 *   dosage_form  – a list of allowed dosage forms in `values`   (e.g. Tablet, Capsule, Syrup)
 *   strength     – a list of common strengths in `values`
 *   unit         – a list of units in `values`                  (e.g. Strip, Bottle)
 *   custom       – any other named list
 */
const attributeSchema = new Schema(
  {
    organizationId: orgField,
    attributeName: { type: String, required: true, trim: true, maxlength: 100 },
    attributeType: { type: String, enum: ATTRIBUTE_TYPES, required: true },
    values: {
      type: [{ type: String, trim: true, maxlength: 100 }],
      default: [],
      validate: [(v) => v.length <= 200 && new Set(v.map((x) => x.toLowerCase())).size === v.length, 'Values must be unique and at most 200 items'],
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  timestamps,
);

attributeSchema.plugin(tenantScope);

attributeSchema.index({ organizationId: 1, attributeType: 1, attributeName: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
attributeSchema.index({ organizationId: 1, attributeType: 1, status: 1 });

export const Attribute = mongoose.model('Attribute', attributeSchema);
