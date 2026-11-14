import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * One AI reading of one uploaded invoice's OCR output into a structured invoice (supplier, invoice, medicine rows, totals). Every run creates a NEW
 * version, so reprocessing keeps the history; the OCR record it was read from is never touched.
 *
 *   data     – what the AI returned after strict checking. Never edited afterwards: it is the record of what the model said.
 *   current  – the working copy people correct (it starts as a copy of `data`). The original stays beside it so every change can be seen.
 *   meta     – for every value: where in the OCR it was found, the OCR's own confidence and a level (high / medium / low / missing / edited)
 *   validation, duplicates – the backend's re-calculation and checks, and any invoice that looks like the same one
 *
 * An extraction is NEVER "verified" because the AI produced it: only a person marking it reviewed does that. Nothing here makes an order, receives
 * stock, matches products or touches a payment.
 */
const extractionSchema = new Schema(
  {
    organizationId: orgField,
    uploadObjectId: { type: Types.ObjectId, ref: 'InvoiceUpload', required: true },
    uploadId: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },
    provider: { type: String, required: true }, // gemini | openai
    model: String,
    usage: { type: Schema.Types.Mixed }, // token counts, when the provider reports them
    durationMs: Number,
    ocrId: { type: Types.ObjectId, ref: 'InvoiceOcr' }, // the OCR record this was read from
    ocrProcessedAt: Date, // …and when that OCR was made (a later OCR makes this extraction stale)
    data: { type: Schema.Types.Mixed, required: true },
    problems: { type: [Schema.Types.Mixed], default: [] }, // values that had to be dropped or interpreted when checking the AI's answer
    aiWarnings: { type: [String], default: [] }, // what the model itself flagged, plus notes such as "the OCR text was cut"
    current: { type: Schema.Types.Mixed, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },
    validation: { type: Schema.Types.Mixed },
    validatedAt: Date,
    duplicates: { type: [Schema.Types.Mixed], default: [] },
    matching: { type: Schema.Types.Mixed }, // product matching of the rows (Phase 4): per row the chosen / suggested product ids, status, reasons, confirmation — never a copy of a product
    finalReview: { type: Schema.Types.Mixed }, // the person's final verification of the invoice (who, when, and which state of the invoice they verified)
    purchase: { type: Schema.Types.Mixed }, // the purchase order this invoice was turned into, or linked to: { mode, orderId, orderNo, supplierInvoiceId, by, at }
    matchingRevision: { type: Number, default: 0 }, // guards concurrent changes to `matching`
    reviewStatus: { type: String, enum: ['needs_review', 'ready_for_review', 'reviewed'], default: 'needs_review' },
    reviewedBy: { type: Types.ObjectId, ref: 'User' },
    reviewedByName: String,
    reviewedAt: Date,
    editCount: { type: Number, default: 0 },
    editedBy: { type: Types.ObjectId, ref: 'User' },
    editedByName: String,
    editedAt: Date,
    initiatedBy: { type: Types.ObjectId, ref: 'User' },
    initiatedByName: String,
    extractedAt: { type: Date, required: true },
  },
  timestamps,
);
extractionSchema.plugin(tenantScope);

extractionSchema.index({ organizationId: 1, uploadObjectId: 1, version: -1 }, { unique: true });
extractionSchema.index({ organizationId: 1, 'current.invoice.invoiceNumber': 1 });

export const InvoiceExtraction = mongoose.model('InvoiceExtraction', extractionSchema);
