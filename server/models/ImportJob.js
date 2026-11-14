import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const IMPORT_STATUSES = ['previewed', 'importing', 'completed', 'completed_with_errors', 'failed', 'cancelled'];
export const ROW_STATUSES = ['valid', 'invalid', 'skipped', 'imported', 'failed'];

/**
 * One CSV inventory import, from upload to finished. It is the import HISTORY record and also the working copy:
 *
 *   previewed  – the file was parsed and validated on the server; nothing has been written to the inventory yet
 *   importing  – the user confirmed; rows are being written (a job can be confirmed only once)
 *   completed / completed_with_errors / failed – done. `rows` says what happened to EVERY row of the file.
 *
 * `parsedRows` (the cleaned file contents) is only kept until the import finishes; the server re-validates it at
 * confirm time against the data as it is then, so nothing the browser sends is trusted.
 */
const importJobSchema = new Schema(
  {
    organizationId: orgField,
    type: { type: String, enum: ['inventory'], default: 'inventory' },
    fileName: { type: String, trim: true, maxlength: 255 },
    fileSize: Number,
    checksum: { type: String, index: false }, // sha256 of the file: spots re-uploads of the same file
    status: { type: String, enum: IMPORT_STATUSES, default: 'previewed' },
    // Counts. total = valid + invalid + skipped at preview; after the import: imported + skipped + failed + invalid = total.
    summary: {
      total: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      imported: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    medicinesCreated: { type: Number, default: 0 },
    batchesCreated: { type: Number, default: 0 },
    warnings: { type: [String], default: [] },
    rows: { type: [Schema.Types.Mixed], default: [] }, // one result per row: { row, status, action, errors[], message … }
    parsedRows: { type: [Schema.Types.Mixed], select: false },
    error: String, // set when the import stopped unexpectedly
    createdBy: { type: Types.ObjectId, ref: 'User' },
    confirmedBy: { type: Types.ObjectId, ref: 'User' },
    confirmedAt: Date,
    completedAt: Date,
  },
  timestamps,
);

importJobSchema.plugin(tenantScope);

importJobSchema.index({ organizationId: 1, createdAt: -1 }); // history
importJobSchema.index({ organizationId: 1, checksum: 1, status: 1 }); // "this file was imported before"

export const ImportJob = mongoose.model('ImportJob', importJobSchema);
