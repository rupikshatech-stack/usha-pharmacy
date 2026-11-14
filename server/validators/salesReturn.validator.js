import { z } from 'zod';
import { objectId, pageQuery } from './common.js';
import { REFUND_METHODS, REFUND_STATUSES, RETURN_CONDITIONS, RETURN_REASONS, RETURN_STATUSES } from '../models/index.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional()); // "" means "no filter"
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08');

export const listReturnsQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
  status: blank(z.enum(RETURN_STATUSES)),
  reason: blank(z.enum(RETURN_REASONS)),
  dateFrom: blank(day),
  dateTo: blank(day),
});

export const summaryQuery = z.object({ dateFrom: blank(day), dateTo: blank(day) });

export const searchInvoicesQuery = z.object({
  search: z.string().trim().max(100).optional().default(''),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

const money = z.coerce.number({ error: 'Enter an amount' }).min(0, 'The amount cannot be negative').refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');
const text = (max) => z.string().trim().max(max, `Use ${max} characters or fewer`).optional().default('');

export const createReturnBody = z.object({
  invoiceId: objectId,
  reason: z.enum(RETURN_REASONS, { error: 'Choose why the products are being returned' }),
  notes: text(300),
  items: z
    .array(
      z.object({
        medicineId: objectId,
        batchId: objectId,
        quantity: z.coerce.number({ error: 'Enter a quantity' }).int('Use a whole number').min(1, 'Return at least 1 unit'),
        condition: z.enum(RETURN_CONDITIONS, { error: 'Choose the condition of the returned units' }),
        restock: z.boolean().optional().default(false),
        verified: z.boolean().optional().default(false),
      }),
    )
    .min(1, 'Choose at least one product to return')
    .max(100),
  refund: z.object({
    method: z.enum(REFUND_METHODS, { error: 'Choose a refund method' }),
    amount: money,
    status: z.enum(REFUND_STATUSES, { error: 'Choose a refund status' }),
    reference: text(100),
    remarks: text(300),
  }),
  idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
});

export const approveBody = z.object({ doNotRestock: z.boolean().optional().default(false) });
export const rejectBody = z.object({ reason: z.string({ error: 'Give a reason for rejecting' }).trim().min(3, 'Give a reason for rejecting (at least 3 characters)').max(300, 'Use 300 characters or fewer') });
export const refundBody = z.object({
  status: z.enum(REFUND_STATUSES, { error: 'Choose the refund status' }),
  method: z.enum(REFUND_METHODS).optional(),
  reference: text(100),
  remarks: text(300),
});
export const updateBody = z.object({
  notes: z.string().trim().max(300, 'Use 300 characters or fewer').optional(),
  refund: z.object({ method: z.enum(REFUND_METHODS).optional(), remarks: z.string().trim().max(300, 'Use 300 characters or fewer').optional() }).optional().default({}),
});
