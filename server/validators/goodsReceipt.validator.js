import { z } from 'zod';
import { objectId, pageQuery } from './common.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08').refine(realDay, 'That is not a real calendar date');
const optDay = z.preprocess((v) => (v === '' ? null : v), day.nullable().optional());
// a count the person typed: a whole number, or null when it has not been entered
const count = (label) => z.preprocess((v) => (v === '' ? null : v), z.coerce.number({ error: `Enter ${label}` }).int('Use a whole number').min(0, `${label[0].toUpperCase()}${label.slice(1)} cannot be negative`).max(10000000).nullable());
const price = (label) => z.preprocess((v) => (v === '' ? null : v), z.coerce.number({ error: `Enter ${label}` }).min(0, `${label[0].toUpperCase()}${label.slice(1)} cannot be negative`).max(10000000).nullable());

export const createDraftBody = z.object({ orderId: blank(objectId), uploadId: blank(z.string().trim().max(40)) });

export const updateDraftBody = z.object({
  items: z
    .array(
      z.object({
        _id: blank(objectId),
        medicineId: blank(objectId),
        receivedQuantity: count('the received quantity').optional(),
        receivedFree: count('the free quantity received').optional(),
        rejectedQuantity: count('the rejected quantity').optional(),
        damagedQuantity: count('the damaged quantity').optional(),
        batchNumber: z.string().trim().max(50, 'Use 50 characters or fewer').optional(),
        manufacturingDate: optDay,
        expiryDate: optDay,
        purchasePrice: price('the purchase price').optional(),
        mrp: price('the MRP').optional(),
        sellingPrice: price('the selling price').optional(),
        remarks: z.string().trim().max(300).optional(),
      }),
    )
    .max(300),
  notes: z.string().trim().max(500).optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

export const confirmReceiptBody = z.object({ confirmed: z.boolean({ error: 'Confirm that the quantities are what actually arrived' }) });
export const reverseReceiptBody = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300), idempotencyKey: z.string().trim().min(8).max(100).optional() });
export const listReceiptsQuery = pageQuery(20).extend({ status: blank(z.enum(['draft', 'confirmed', 'reversed'])), orderId: blank(objectId), search: z.string().trim().max(100).optional().default('') });

// AI Billing -> purchasing
export const finalReviewBody = z.object({ confirmed: z.boolean(), supplierId: blank(objectId), acknowledgeDuplicate: z.boolean().optional().default(false) });
export const createPurchaseOrderBody = z.object({
  branchId: blank(objectId),
  expectedDate: blank(day),
  status: z.enum(['draft', 'ordered']).optional().default('draft'),
  acknowledgeDuplicate: z.boolean().optional().default(false),
});
export const linkPurchaseOrderBody = z.object({ orderId: objectId, acknowledgeDifferences: z.boolean().optional().default(false), acknowledgeDuplicate: z.boolean().optional().default(false) });
export const purchaseOrderOptionsQuery = z.object({ search: z.string().trim().max(100).optional().default('') });
