import mongoose from 'mongoose';
import { Schema, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const ALERT_KINDS = ['expiry'];

/**
 * One row per organization per kind per day: the record that a digest has already gone out.
 *
 * The unique index IS the idempotency guard. The job inserts this row BEFORE composing anything, and a second run
 * on the same day collides with it and stops. Checking "has it run today?" with a read and then writing would leave
 * a window in which two runs both read "no" — a scheduler that fires twice, or an operator running it by hand while
 * the scheduled one is going, would then send the same pharmacy two digests.
 *
 * `runDate` is a plain YYYY-MM-DD string in the organization's own timezone, not a Date. "The same day" is a
 * calendar question, and a timestamp invites comparisons that are right in one timezone and wrong in another.
 */
const alertRunSchema = new Schema(
  {
    organizationId: orgField,
    kind: { type: String, enum: ALERT_KINDS, required: true },
    runDate: { type: String, required: true, match: [/^\d{4}-\d{2}-\d{2}$/, 'runDate must be YYYY-MM-DD'] },
    sentAt: Date,
    recipients: { type: [String], default: [] },
    counts: { type: Object, default: {} },
    // A send that failed: the row still exists (so the day is not retried in a loop), carrying why.
    error: { type: String, default: '' },
  },
  timestamps,
);

alertRunSchema.plugin(tenantScope);
alertRunSchema.index({ organizationId: 1, kind: 1, runDate: 1 }, { unique: true });

export const AlertRun = mongoose.model('AlertRun', alertRunSchema);
