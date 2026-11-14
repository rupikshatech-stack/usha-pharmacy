import { z } from 'zod';
import { objectId, pageQuery } from './common.js';

export const createInvoiceSchema = z.object({
  customer: z
    .object({
      name: z.string().trim().max(100).optional().default('Walk-in Customer'),
      phone: z.string().trim().regex(/^(\d{10})?$/, 'Phone must be 10 digits').optional().default(''),
      // a registered customer's GSTIN: it decides whether the sale is taxed CGST + SGST or IGST, and it is printed on the invoice
      gstin: z.string().trim().toUpperCase().regex(/^(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/, 'GST number is not in a valid format').optional().default(''),
    })
    .optional()
    .default({}),
  items: z
    .array(
      z.object({
        medicineId: objectId,
        quantity: z.coerce.number().int().min(1),
        discountPercent: z.coerce.number().min(0).max(100).optional().default(0),
      }),
    )
    .min(1, 'Add at least one item'),
  discount: z.object({ type: z.enum(['percent', 'amount']), value: z.coerce.number().min(0) }).optional(),
  paymentType: z.enum(['Cash', 'UPI', 'Card', 'Credit']).default('Cash'),
  paid: z.coerce.number().min(0).optional(),
  // Make "save" safe to retry: the same key never creates a second invoice.
  idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
});

export const listInvoicesQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
});
