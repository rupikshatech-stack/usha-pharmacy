import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';
import { BUCKETS } from '../services/expiryRisk.js';

/**
 * The most urgent tier a batch has already been emailed about.
 *
 * It is a collection of its own rather than a field on `Batch` for two reasons. Batch is a core record that stock,
 * invoices and the ledger all lean on, and alert bookkeeping has no business living in it; and this can be cleared
 * wholesale — to re-send a digest, or after a test — without rewriting a single stock row.
 *
 * One row per batch per organization. The tier is a bucket name from expiryRisk.js, so "has this become more
 * urgent?" is a comparison of two positions in BUCKETS and nothing more.
 */
const expiryAlertSchema = new Schema(
  {
    organizationId: orgField,
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true },
    // The bucket this batch was last emailed about: 'expired' | 'under15' | 'under30' | 'under90'.
    tier: { type: String, enum: BUCKETS, required: true },
    alertedAt: { type: Date, required: true },
  },
  timestamps,
);

expiryAlertSchema.plugin(tenantScope);
// One row per batch. The uniqueness is the whole point: two runs cannot each believe they are the first.
expiryAlertSchema.index({ organizationId: 1, batchId: 1 }, { unique: true });

export const ExpiryAlert = mongoose.model('ExpiryAlert', expiryAlertSchema);
