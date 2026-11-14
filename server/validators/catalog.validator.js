import { z } from 'zod';
import { BUD_UNITS, INGREDIENT_ROLES, INGREDIENT_UNITS } from '../models/index.js';
import { ATTRIBUTE_TYPES } from '../models/Attribute.js';
import { objectId, pageQuery } from './common.js';

const status = z.enum(['active', 'inactive']);

/**
 * One line of a preparation. A `qs` ingredient carries no quantity by definition ("enough to make up the total"); every
 * other unit needs one, so the bench is never left guessing how much to weigh.
 */
const ingredient = z
  .object({
    name: z.string({ error: 'Name the ingredient' }).trim().min(1, 'Name the ingredient').max(150, 'Use 150 characters or fewer'),
    medicineId: z.string().trim().regex(/^([a-f0-9]{24})?$/i, 'Choose an ingredient from your inventory').optional().transform((v) => v || undefined),
    role: z.enum(INGREDIENT_ROLES).optional().default('active'),
    quantity: z.coerce.number({ error: 'Quantity must be a number' }).min(0, 'Quantity cannot be negative').max(1000000, 'That quantity is too large').optional(),
    unit: z.enum(INGREDIENT_UNITS, { error: 'Choose a unit' }),
    notes: z.string().trim().max(200).optional().default(''),
  })
  .refine((i) => i.unit === 'qs' || (i.quantity !== undefined && i.quantity > 0), { message: 'Enter how much of this ingredient goes in', path: ['quantity'] })
  .refine((i) => i.unit !== 'qs' || i.quantity === undefined, { message: 'A "qs" ingredient is whatever makes the total up, so it takes no quantity', path: ['quantity'] })
  .refine((i) => i.unit !== '%' || (i.quantity ?? 0) <= 100, { message: 'A percentage cannot be more than 100', path: ['quantity'] });

/** The preparation half of a compound. Absent on a plain formulation label, which is what most compounds are. */
const preparation = {
  dosageForm: z.string().trim().max(60).optional(),
  totalQuantity: z.coerce.number({ error: 'Batch size must be a number' }).positive('Enter how much this makes').max(1000000, 'That batch is too large').optional(),
  totalUnit: z.string().trim().max(20).optional(),
  ingredients: z.array(ingredient).max(50, 'That is too many ingredients').optional(),
  instructions: z.string().trim().max(4000).optional(),
  requiresHomogenizer: z.coerce.boolean().optional(),
  requiresUnguator: z.coerce.boolean().optional(),
  lightSensitive: z.coerce.boolean().optional(),
  sig: z.string().trim().max(500).optional(),
  budValue: z.coerce.number({ error: 'Beyond-use must be a number' }).int('Use whole days or months').min(1, 'Beyond-use must be at least 1').max(3650, 'That is too far ahead').optional(),
  budUnit: z.enum(BUD_UNITS).optional(),
};

export const createCompoundSchema = z.object({
  compoundName: z.string().trim().min(1, 'Compound name is required').max(150),
  composition: z.string().trim().max(500).optional().default(''),
  description: z.string().trim().max(2000).optional().default(''),
  status: status.optional().default('active'),
  ...preparation,
});

export const compoundBatchQuery = z.object({
  quantity: z.coerce.number({ error: 'Enter a batch size' }).positive('Enter a batch size greater than zero').max(1000000, 'That batch is too large'),
});
// Explicit (no defaults) so an update never overwrites fields the caller didn't send.
export const updateCompoundSchema = z
  .object({
    compoundName: z.string().trim().min(1, 'Compound name is required').max(150).optional(),
    composition: z.string().trim().max(500).optional(),
    description: z.string().trim().max(2000).optional(),
    status: status.optional(),
    ...preparation,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listCompoundsQuery = pageQuery(20).extend({
  search: z.string().trim().max(100).optional().default(''),
  status: z.enum(['', 'active', 'inactive']).optional().default(''),
});

export const linkMedicinesSchema = z.object({
  medicineIds: z.array(objectId).min(1, 'Choose at least one medicine').max(200, 'Link at most 200 medicines at a time'),
});

const values = z
  .array(z.string().trim().min(1).max(100))
  .max(200)
  .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, 'Values must be unique');

export const createAttributeSchema = z.object({
  attributeName: z.string().trim().min(1, 'Attribute name is required').max(100),
  attributeType: z.enum(ATTRIBUTE_TYPES),
  values: values.optional().default([]),
  status: status.optional().default('active'),
});
// The type can't be changed after creation (medicines may point at the attribute).
export const updateAttributeSchema = z
  .object({ attributeName: z.string().trim().min(1).max(100).optional(), values: values.optional(), status: status.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listAttributesQuery = pageQuery(50).extend({
  // The page's "Any type" filter sends type= (empty); that means "no filter", not an invalid type.
  type: z.preprocess((v) => (v === '' ? undefined : v), z.enum(ATTRIBUTE_TYPES).optional()),
  search: z.string().trim().max(100).optional().default(''),
  status: z.enum(['', 'active', 'inactive']).optional().default(''),
});
