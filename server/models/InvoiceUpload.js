import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 *   uploaded   – the file is stored; nothing has been read yet
 *   processing – the invoice is being read by the connected service
 *   completed  – it was read (OCR text and tables, and the structured draft if one is connected); the result waits for a person to review it
 *   failed     – reading failed (the reason is kept; it can be scanned again)
 *   drafted    – a person reviewed it and saved a draft order from it
 *   discarded  – the file was removed (the record stays, the file and the read data do not)
 */
export const UPLOAD_STATUSES = ['uploaded', 'processing', 'completed', 'failed', 'drafted', 'discarded'];
export const UPLOAD_STATUS_LABEL = { uploaded: 'Uploaded', processing: 'Processing', completed: 'Completed', failed: 'Failed', drafted: 'Draft saved', discarded: 'Removed' };

/**
 * One uploaded supplier invoice: the file's details, where it is stored, what happened when it was scanned and what the user finally made of it.
 * Uploading and scanning never touch stock or orders: only a person's "Save as draft" creates a draft order, and stock only ever changes when goods are
 * received against an order.
 */
const uploadSchema = new Schema(
  {
    organizationId: orgField,
    uploadId: { type: String, required: true }, // the unique, hard-to-guess id the screens and endpoints use
    fileName: { type: String, required: true, maxlength: 150 }, // as the user named it (cleaned); never used as a path
    mimeType: { type: String, required: true, enum: ['application/pdf', 'image/png', 'image/jpeg'] },
    size: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true }, // the file's fingerprint, to notice the same invoice uploaded twice
    storageKey: { type: String }, // where the file is stored (removed when the file is)
    status: { type: String, enum: UPLOAD_STATUSES, default: 'uploaded' },
    provider: String, // which reading service was used for the last scan
    attempts: { type: Number, default: 0 },
    startedAt: Date,
    finishedAt: Date,
    error: { code: String, message: String },
    extraction: { type: Schema.Types.Mixed }, // the structured review draft, when a structured-extraction service is connected (Phase 3's job); only ever what the service returned
    ocrSummary: { type: Schema.Types.Mixed }, // { provider, pageCount, textLength, tableCount, warningCount, durationMs, processedAt }: the OCR text itself lives in InvoiceOcr
    notes: { type: [String], default: undefined }, // things worth knowing about the last run (a blurry page, a part that failed)
    aiStatus: { type: String, enum: ['processing', 'completed', 'failed'] }, // AI structured extraction (Phase 3) of the OCR text; unset until it is asked for
    aiVersion: Number, // the latest InvoiceExtraction version
    aiAttempts: { type: Number, default: 0 },
    aiStartedAt: Date,
    aiFinishedAt: Date,
    aiError: { code: String, message: String },
    reviewed: { type: Schema.Types.Mixed }, // what the user checked and saved, including batch, dates and MRP kept for goods receiving
    orderId: { type: Types.ObjectId, ref: 'Order' },
    draftedAt: Date,
    uploadedBy: { type: Types.ObjectId, ref: 'User' },
    uploadedByName: String,
  },
  timestamps,
);
uploadSchema.plugin(tenantScope);

uploadSchema.index({ organizationId: 1, uploadId: 1 }, { unique: true });
uploadSchema.index({ organizationId: 1, createdAt: -1 });
uploadSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
uploadSchema.index({ organizationId: 1, sha256: 1 });

export const InvoiceUpload = mongoose.model('InvoiceUpload', uploadSchema);
