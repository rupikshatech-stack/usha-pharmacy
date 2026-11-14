import { z } from 'zod';
import { pageQuery } from './common.js';
import { UPLOAD_STATUSES } from '../models/index.js';
import { createOrderBody } from './order.validator.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional()); // "" means "no filter"

export const listUploadsQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
  status: blank(z.enum(UPLOAD_STATUSES)),
});

// Saving a draft takes the same content as creating a draft order (the status and key are the server's), plus what the user reviewed, kept with the upload.
export const draftBody = createOrderBody.omit({ status: true, idempotencyKey: true }).extend({ reviewed: z.record(z.string(), z.unknown()).optional(), acknowledgeDuplicate: z.boolean().optional() });

// Lines to be matched against the products (read from an invoice, or typed in by hand). Lenient on purpose: it is a draft to be reviewed.
const loose = z.union([z.string(), z.number()]).nullish();
export const matchBody = z.object({
  invoiceNo: z.string().trim().max(60).optional().default(''),
  invoiceDate: z.string().trim().max(10).optional().default(''),
  supplier: z.object({ name: z.string().trim().max(150).optional().default(''), gstin: z.string().trim().max(20).optional().default(''), phone: z.string().trim().max(20).optional().default(''), address: z.string().trim().max(300).optional().default('') }).optional().default({}),
  items: z
    .array(z.object({ name: z.string().trim().max(200).optional().default(''), sku: z.string().trim().max(60).optional().default(''), manufacturer: z.string().trim().max(120).optional().default(''), batchNumber: z.string().trim().max(50).optional().default(''), manufacturingDate: loose, expiryDate: loose, quantity: loose, freeQuantity: loose, rate: loose, mrp: loose, discountPercent: loose, gstPercent: loose, amount: loose, confidence: loose }))
    .max(200)
    .default([]),
  totals: z.object({ subtotal: loose, taxableAmount: loose, cgst: loose, sgst: loose, igst: loose, additionalCharges: loose, grandTotal: loose }).optional().default({}),
});

// Product matching (Phase 4)
const objectIdText = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
export const matchProductsBody = z.object({ rematch: z.enum(['open', 'all']).optional().default('open'), force: z.boolean().optional().default(false) });
export const matchesQuery = z.object({ status: blank(z.enum(['matched', 'needs_review', 'unmatched'])), search: z.string().trim().max(100).optional().default('') });
export const suggestionsQuery = z.object({ search: z.string().trim().max(100).optional().default('') });
export const selectProductBody = z.object({ productId: objectIdText, acknowledgeConflicts: z.boolean().optional().default(false) });
export const confirmMatchBody = z.object({ acknowledgeConflicts: z.boolean().optional().default(false) });
export const unmatchedBody = z.object({ note: z.string().trim().max(300).optional() });

// A person's corrections to an AI-extracted invoice. The shape is only outlined here: services/aiExtraction/invoiceExtractionSchema.js checks every value strictly.
const section = z.record(z.string(), z.unknown());
export const extractedBody = z.object({
  data: z.object({ supplier: section.default({}), invoice: section.default({}), items: z.array(section).max(500).default([]), totals: section.default({}) }),
  reviewed: z.boolean().optional().default(false),
  confirmed: z.boolean().optional().default(false),
  acknowledgeIssues: z.boolean().optional().default(false),
  expectedEditCount: z.number().int().min(0).optional(),
});
export const extractedQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
