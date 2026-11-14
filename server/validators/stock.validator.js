import { z } from 'zod';
import { MOVEMENT_TYPES } from '../models/StockMovement.js';
import { objectId, pageQuery } from './common.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');

/** A manual stock correction: signed quantity (+ adds, − removes) and a mandatory reason. */
export const adjustmentSchema = z
  .object({
    batchId: objectId,
    quantity: z.coerce.number().int('Quantity must be a whole number').refine((v) => v !== 0, 'Quantity cannot be zero'),
    type: z.enum(['ADJUSTMENT', 'WRITE_OFF']).optional().default('ADJUSTMENT'),
    reason: z.string().trim().min(3, 'A reason is required (at least 3 characters)').max(300),
  })
  .refine((a) => a.type !== 'WRITE_OFF' || a.quantity < 0, { path: ['quantity'], message: 'A write-off must remove stock (use a negative quantity)' });

const blank = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional()); // an empty filter means "no filter"

export const movementsQuery = pageQuery(20).extend({
  medicineId: blank(objectId),
  batchId: blank(objectId),
  type: blank(z.enum(MOVEMENT_TYPES)),
  from: blank(dateStr),
  to: blank(dateStr),
});
