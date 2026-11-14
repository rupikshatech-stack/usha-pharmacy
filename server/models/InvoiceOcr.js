import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * What an OCR provider read from one uploaded invoice: the recognized text, the layout page by page (with where each line sits), the tables, and
 * anything the provider itself detected as named fields. Kept in its OWN collection (one record per upload, replaced when the invoice is processed
 * again) so large results never bloat the upload records the lists read, and so the next phase (structured extraction) can read it as it is.
 *
 * Everything here is what the provider returned: raw and UNVERIFIED. Nothing is interpreted, matched or turned into an order or stock.
 */
const ocrSchema = new Schema(
  {
    organizationId: orgField,
    uploadObjectId: { type: Types.ObjectId, ref: 'InvoiceUpload', required: true },
    uploadId: { type: String, required: true }, // the upload's public id (UP-…)
    provider: { type: String, required: true }, // e.g. google-document-ai
    processor: { type: Schema.Types.Mixed }, // which processor read it (id, location, version): never credentials
    mimeType: String,
    pageCount: { type: Number, required: true, min: 0 },
    text: { type: String, default: '' }, // the whole recognized text, exactly as returned
    pages: { type: [Schema.Types.Mixed], default: [] }, // [{ pageNumber, width, height, unit, rotation, language, qualityScore, defects, confidence, text, lines: [{ text, confidence, box }] }]
    tables: { type: [Schema.Types.Mixed], default: [] }, // [{ pageNumber, index, headerRows: [[cell]], bodyRows: [[cell]], rowCount, columnCount, confidence, box }]
    entities: { type: [Schema.Types.Mixed], default: [] }, // named things the provider detected (an invoice parser): [{ type, text, normalized, confidence, pageNumber, properties }]
    fields: { type: Schema.Types.Mixed, default: {} }, // those entities arranged under invoice field names; a field the provider did not find is null
    lineItems: { type: [Schema.Types.Mixed], default: [] }, // line items the provider detected, as it read them
    warnings: { type: [String], default: [] }, // blurry, rotated, empty or low-confidence pages
    reduced: { type: String }, // set when the result was too large and part of the layout was left out (never the text)
    durationMs: Number,
    processedAt: { type: Date, required: true },
    processedBy: { type: Types.ObjectId, ref: 'User' },
  },
  timestamps,
);
ocrSchema.plugin(tenantScope);

ocrSchema.index({ organizationId: 1, uploadObjectId: 1 }, { unique: true }); // one result per upload
ocrSchema.index({ organizationId: 1, uploadId: 1 });
ocrSchema.index({ organizationId: 1, processedAt: -1 });

export const InvoiceOcr = mongoose.model('InvoiceOcr', ocrSchema);
