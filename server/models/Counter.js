import mongoose from 'mongoose';
import { Schema, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

const counterSchema = new Schema({
  organizationId: orgField,
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.plugin(tenantScope);
counterSchema.index({ organizationId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);

/** Atomic per-organization sequence. Pass the session so the increment rolls back with the document. */
export async function nextSeq(organizationId, key, session) {
  const doc = await Counter.findOneAndUpdate({ organizationId, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
  return doc.seq;
}
