import { z } from 'zod';
import { objectId, pageQuery } from './common.js';
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, PAYMENT_TERMS } from '../models/index.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional()); // "" means "no filter"

export const listOrdersQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
  status: blank(z.enum(ORDER_STATUSES)),
  supplierId: blank(objectId),
  branchId: blank(objectId),
  paymentStatus: blank(z.enum(PAYMENT_STATUSES)),
  dateFrom: blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08')),
  dateTo: blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08')),
  overdue: z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' || v === '' ? undefined : v), z.boolean().optional()),
});

export const productsQuery = z.object({
  search: z.string().trim().max(100).optional().default(''),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
});

const realDay = (v) => {
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08').refine(realDay, 'That is not a real calendar date');
const optDay = z.preprocess((v) => (v === '' || v === null ? undefined : v), day.optional());
const money = (label) => z.coerce.number({ error: `Enter ${label}` }).min(0, `${label[0].toUpperCase()}${label.slice(1)} cannot be negative`).max(10000000, 'That is too large').refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');
const percent = (label) => z.coerce.number({ error: `Enter ${label}` }).min(0, `${label[0].toUpperCase()}${label.slice(1)} cannot be negative`).max(100, `${label[0].toUpperCase()}${label.slice(1)} cannot be more than 100`).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');
const text = (max) => z.string().trim().max(max, `Use ${max} characters or fewer`).optional().default('');

export const createOrderBody = z.object({
  supplierId: objectId,
  branchId: z.preprocess((v) => (v === '' || v === null ? undefined : v), objectId.optional()),
  orderDate: optDay,
  expectedDate: optDay,
  referenceNo: text(60),
  notes: text(500),
  status: z.enum(['draft', 'submitted'], { error: 'Choose draft or submitted' }).default('submitted'), // submitting sends it for approval, or approves it when approval is not required
  items: z
    .array(
      z.object({
        medicineId: objectId,
        quantity: z.coerce.number({ error: 'Enter a quantity' }).int('Use a whole number').min(1, 'Order at least 1 unit').max(1000000, 'That is too large'),
        freeQuantity: z.coerce.number().int('Use a whole number').min(0, 'Free quantity cannot be negative').max(1000000).optional().default(0),
        rate: money('the purchase rate'),
        discountPercent: percent('the discount').optional().default(0),
        gstPercent: percent('the GST percentage').optional().default(0),
      }),
    )
    .min(1, 'Add at least one product')
    .max(200),
  charges: z
    .object({
      shipping: money('the shipping charge').optional().default(0),
      packaging: money('the packaging charge').optional().default(0),
      other: money('the other charge').optional().default(0),
      additionalDiscount: money('the additional discount').optional().default(0),
      gstPercent: percent('the GST percentage').optional().default(0),
    })
    .optional()
    .default({}),
  payment: z.object({
    terms: z.enum(PAYMENT_TERMS, { error: 'Choose the payment terms' }),
    method: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(PAYMENT_METHODS).optional()),
    advance: money('the advance payment').optional().default(0),
  }),
  idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
});

const qty = (label) => z.coerce.number({ error: `Enter ${label}` }).int('Use a whole number').min(0, `${label[0].toUpperCase()}${label.slice(1)} cannot be negative`).max(1000000, 'That is too large');
export const receiveBody = z.object({
  items: z
    .array(
      z.object({
        medicineId: objectId,
        quantity: qty('the receiving quantity').optional().default(0),
        freeQuantity: qty('the free quantity').optional().default(0),
        rejectedQuantity: qty('the rejected quantity').optional().default(0),
        damagedQuantity: qty('the damaged quantity').optional().default(0),
        batchNumber: z.string().trim().max(50, 'Use 50 characters or fewer').optional().default(''),
        manufacturingDate: optDay,
        expiryDate: optDay,
        purchasePrice: money('the purchase price').optional(),
        mrp: money('the MRP').optional(),
        sellingPrice: money('the selling price').optional(),
        remarks: text(300),
      }),
    )
    .min(1, 'Enter the quantities that arrived')
    .max(200),
  remarks: text(500),
  idempotencyKey: z.string().trim().min(8, 'idempotencyKey must be at least 8 characters').max(100).optional(),
});
export const orderRejectBody = z.object({ reason: z.string({ error: 'Give a reason' }).trim().min(3, 'Give a reason (at least 3 characters)').max(300, 'Use 300 characters or fewer') });
export const orderCancelBody = z.object({ reason: z.string().trim().max(300, 'Use 300 characters or fewer').optional().default('') });
export const orderSettingsBody = z.object({ approvalRequired: z.boolean({ error: 'approvalRequired must be true or false' }) });
export const receiptsQuery = z.object({ orderId: z.preprocess((v) => (v === '' ? undefined : v), objectId.optional()), page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(100).optional().default(20) });

// Editing a draft takes the same content as creating one (the status is not part of it: an edit never changes the status).
export const updateOrderBody = createOrderBody.omit({ status: true, idempotencyKey: true });

// Update the status of an order: the steps of the workflow by name. "received" and "partially_received" are never set by hand: goods are received through /receive.
export const statusBody = z.object({
  status: z.enum(['draft', 'pending', 'approved', 'ordered', 'cancelled'], { error: 'Choose a status the workflow allows' }),
  reason: z.string().trim().max(300, 'Use 300 characters or fewer').optional().default(''),
});
