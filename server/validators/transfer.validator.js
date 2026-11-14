import { z } from 'zod';
import { TRANSFER_STATUSES } from '../models/Transfer.js';
import { objectId, pageQuery } from './common.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional()); // "" means "no filter / not given"

const dateOnly = z
  .string({ error: 'Choose the transfer date' })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .transform((s, ctx) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      ctx.addIssue({ code: 'custom', message: 'Not a real calendar date' });
      return z.NEVER;
    }
    return d;
  });

const line = z.object({
  batchId: objectId,
  quantity: z.coerce.number({ error: 'Enter a quantity' }).int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(10_000_000, 'Quantity is too large'),
});

/** Draft content: stores, date, note and the lines (batches of the SOURCE store with quantities). */
export const transferBody = z
  .object({
    fromBranchId: objectId,
    toBranchId: objectId,
    transferDate: dateOnly,
    notes: z.string().trim().max(500, 'Notes must be 500 characters or fewer').optional().default(''),
    expectedArrivalDate: z.preprocess((v) => (v === '' || v === null ? undefined : v), dateOnly.optional()),
    internalRemarks: z.string().trim().max(500, 'Internal remarks must be 500 characters or fewer').optional().default(''),
    items: z.array(line).min(1, 'Add at least one batch to transfer').max(100, 'A transfer can have at most 100 lines'),
  })
  .refine((t) => t.fromBranchId !== t.toBranchId, { path: ['toBranchId'], message: 'Choose a different destination store' })
  .refine((t) => !t.expectedArrivalDate || t.expectedArrivalDate >= t.transferDate, { path: ['expectedArrivalDate'], message: 'The expected arrival cannot be before the transfer date' });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');

export const listTransfersQuery = pageQuery(10)
  .extend({
  search: z.string().trim().max(100).optional().default(''),
  // 'pending' groups everything waiting to be dispatched (submitted + approved)
  status: blank(z.enum([...TRANSFER_STATUSES, 'pending', 'transit'])), // 'pending' = submitted + approved; 'transit' = partially dispatched + in transit
  dateFrom: blank(day),
  dateTo: blank(day),
  fromBranchId: blank(objectId),
  toBranchId: blank(objectId),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { path: ['dateTo'], message: 'The end date must not be before the start date' });

export const cancelBody = z.object({ reason: z.string().trim().max(300, 'Reason must be 300 characters or fewer').optional().default('') });

/** What to dispatch now. Everything is optional: with no lines, everything still to be sent goes. */
export const dispatchBody = z.preprocess(
  (v) => v ?? {},
  z.object({
    items: z
      .array(
        z.object({
          batchId: objectId,
          quantity: z.coerce.number({ error: 'Enter a quantity' }).int('Quantity must be a whole number').min(1, 'Quantity must be at least 1').max(10_000_000, 'Quantity is too large'),
        }),
      )
      .min(1, 'Add at least one line to dispatch')
      .max(100)
      .optional(),
    closeShort: z.boolean().optional().default(false),
    notes: z.string().trim().max(300, 'Notes must be 300 characters or fewer').optional().default(''),
    idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
  }),
);

const count = (label) => z.coerce.number({ error: `Enter ${label}` }).int('Quantity must be a whole number').min(0, 'Quantity cannot be negative').max(10_000_000, 'Quantity is too large');

/** What was counted at the destination. Everything is optional: with no lines, everything still expected arrived in good condition. */
export const receiveBody = z.preprocess(
  (v) => v ?? {},
  z.object({
    items: z
      .array(
        z.object({
          batchId: objectId,
          receivedQuantity: count('the received quantity').optional().default(0),
          damagedQuantity: count('the damaged quantity').optional().default(0),
          missingQuantity: count('the missing quantity').optional().default(0),
          remarks: z.string().trim().max(300, 'Remarks must be 300 characters or fewer').optional().default(''),
        }),
      )
      .min(1, 'Add at least one line to receive')
      .max(100)
      .optional(),
    closeReceipt: z.boolean().optional().default(false),
    remarks: z.string().trim().max(500, 'Remarks must be 500 characters or fewer').optional().default(''),
    idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
  }),
);

export const eventsQuery = pageQuery(50);

export const rejectBody = z.object({ reason: z.string().trim().min(3, 'Give a reason for rejecting (at least 3 characters)').max(300, 'Reason must be 300 characters or fewer') });
export const settingsBody = z.object({ approvalRequired: z.boolean({ error: 'approvalRequired must be true or false' }), allowSelfApproval: z.boolean({ error: 'allowSelfApproval must be true or false' }).optional() });

/* ---- stores: see branch.validator.js */
