import { z } from 'zod';
import { TAXABILITY } from '../models/index.js';
import { BATCH_STATUSES } from '../models/Batch.js';
import { STOCK_STATUSES, STOCK_STATUS_ALIASES } from '../services/stock.service.js';
import { money, objectId, pageQuery } from './common.js';

const optText = (max, label) => z.string().trim().max(max, `${label} must be ${max} characters or fewer`).optional().default('');
const emptyToUndefined = (v) => (v === '' || v === null ? undefined : v);
const optionalId = z.preprocess(emptyToUndefined, objectId.optional());

/** SKU and barcode: optional, 2–60 characters, letters / numbers / . _ - / only, no spaces. */
const code = (label) =>
  z
    .string()
    .trim()
    .max(60, `${label} must be 60 characters or fewer`)
    .regex(/^[A-Za-z0-9._\-/]*$/, `${label} can use letters, numbers and . _ - / only (no spaces)`)
    .refine((v) => v === '' || v.length >= 2, `${label} must be at least 2 characters`)
    .optional()
    .default('');

/** A reorder level, without a default: what a medicine starts with is decided where it is created, not here. */
const reorderLevelField = z.coerce
  .number({ error: 'Reorder level must be a number' })
  .int('Reorder level must be a whole number')
  .min(0, 'Reorder level cannot be negative')
  .max(1000000, 'Reorder level is too large')
  .optional();

const medicineFields = {
  medicineName: z.string().trim().min(1, 'Medicine name is required').max(150, 'Medicine name must be 150 characters or fewer'),
  genericName: optText(200, 'Generic name'),
  salt: optText(200, 'Salt / compound'),
  manufacturer: optText(120, 'Manufacturer'),
  // Name an existing category/compound by id, or give a name and it is found (or created) for you. '' clears it.
  categoryId: optionalId,
  categoryName: z.string().trim().max(100, 'Category must be 100 characters or fewer').optional(),
  compoundId: optionalId,
  compoundName: z.string().trim().max(150, 'Compound must be 150 characters or fewer').optional(),
  dosageForm: optText(60, 'Dosage form'),
  strength: optText(60, 'Strength'),
  packSize: optText(60, 'Pack size'),
  unit: optText(30, 'Unit'),
  company: optText(120, 'Company'),
  // How it is packed, outer to inner. Quantities are whole numbers of at least one; the inner quantity is what a pack actually holds.
  packing: z
    .object({
      outerUnit: optText(30, 'Outer pack'),
      outerQty: z.coerce.number({ error: 'Outer quantity must be a number' }).int('Outer quantity must be a whole number').min(1, 'Outer quantity must be at least 1').max(100000, 'Outer quantity is too large').optional(),
      innerUnit: optText(30, 'Inner pack'),
      innerQty: z.coerce.number({ error: 'Pack quantity must be a number' }).int('Pack quantity must be a whole number').min(1, 'Pack quantity must be at least 1').max(100000, 'Pack quantity is too large').optional(),
    })
    .optional(),
  hsnCode: z.string().trim().regex(/^(\d{4,8})?$/, 'HSN code must be 4 to 8 digits').optional().default(''),
  // Exempt and nil-rated products carry no GST; the service forces the rate to 0 so a bill can never charge tax on them.
  taxability: z.enum(TAXABILITY, { error: 'Choose whether GST applies' }).optional(),
  defaultMrp: z.coerce.number({ error: 'MRP must be a number' }).min(0, 'MRP cannot be negative').max(10000000, 'MRP is too large').optional(),
  defaultPurchasePrice: z.coerce.number({ error: 'Purchase rate must be a number' }).min(0, 'Purchase rate cannot be negative').max(10000000, 'Purchase rate is too large').optional(),
  gstPercentage: z.coerce
    .number({ error: 'GST must be a number' })
    .min(0, 'GST must be between 0 and 100')
    .max(100, 'GST must be between 0 and 100')
    .refine((v) => Math.round(v * 100) / 100 === v, 'GST can have at most 2 decimal places')
    .optional()
    .default(12),
  barcode: code('Barcode'),
  sku: code('SKU'),
  reorderLevel: reorderLevelField.default(10),
  description: optText(2000, 'Description'),
  image: z.union([z.literal(''), z.string().trim().max(500, 'Image link must be 500 characters or fewer').regex(/^(https?:\/\/|\/)/, 'Image must be an http(s) link or a path starting with /')]).optional().default(''),
  attributes: z
    .array(
      z.object({
        key: z.string().trim().min(1, 'Every custom attribute needs a name').max(60, 'Attribute name must be 60 characters or fewer'),
        value: z.string().trim().max(120, 'Attribute value must be 120 characters or fewer').default(''),
      }),
    )
    .max(20, 'At most 20 custom attributes')
    .refine((a) => new Set(a.map((x) => x.key.toLowerCase())).size === a.length, 'Custom attribute names must be unique')
    .optional()
    .default([]),
  isActive: z.boolean().optional().default(true),
};

/** Duplicate pre-check used by the form while typing (GET /api/inventory/duplicates). */
export const duplicatesQuery = z.object({
  sku: z.string().trim().max(60).optional().default(''),
  barcode: z.string().trim().max(60).optional().default(''),
  excludeId: z.preprocess(emptyToUndefined, objectId.optional()), // the medicine being edited
});

const dateOrUndefined = z.preprocess(emptyToUndefined, z.coerce.date().optional());

const batchFields = z.object({
  batchNumber: z.string().trim().min(1, 'Batch number is required').max(50),
  manufacturer: z.string().trim().max(120).optional(),
  manufacturingDate: dateOrUndefined,
  expiryDate: z.coerce.date({ errorMap: () => ({ message: 'A valid expiry date is required' }) }),
  purchasePrice: money.optional().default(0),
  sellingPrice: money,
  mrp: money,
  initialQuantity: z.coerce.number().int('Quantity must be a whole number').min(1, 'Quantity must be at least 1'),
  branchId: optionalId,
  supplierId: optionalId,
});

/** Receiving a batch: it must not already be expired, the price can't exceed MRP, and dates must make sense. */
export const batchSchema = batchFields
  .refine((b) => b.expiryDate > new Date(), { path: ['expiryDate'], message: 'Expiry date must be in the future' })
  .refine((b) => b.sellingPrice <= b.mrp, { path: ['sellingPrice'], message: 'Selling price cannot exceed the MRP' })
  .refine((b) => !b.manufacturingDate || b.manufacturingDate < b.expiryDate, { path: ['manufacturingDate'], message: 'Manufacturing date must be before the expiry date' })
  .refine((b) => !b.manufacturingDate || b.manufacturingDate <= new Date(), { path: ['manufacturingDate'], message: 'Manufacturing date cannot be in the future' });

/** The only parts of a batch that can change after it is received (identity and quantity are fixed). */
export const updateBatchSchema = z
  .object({
    purchasePrice: money.optional(),
    sellingPrice: money.optional(),
    mrp: money.optional(),
    manufacturer: z.string().trim().max(120).optional(),
    status: z.enum(BATCH_STATUSES).optional(),
    reservedQuantity: z.coerce.number().int().min(0).optional(),
    supplierId: optionalId,
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update' });

// A NEW medicine takes its starting reorder level from the organization's setting when the form does not give one
// (default 10 — what it has always been). Updating a medicine is unchanged: it still falls back to 10 as before.
export const createMedicineSchema = z.object({ ...medicineFields, reorderLevel: reorderLevelField, batch: batchSchema.optional() });
export const updateMedicineSchema = z.object(medicineFields);

export const SORTABLE = ['medicineName', 'genericName', 'manufacturer', 'categoryName', 'totalStock', 'availableStock', 'reorderLevel', 'stockStatus', 'isActive'];

export const listMedicinesQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
  categoryId: z.preprocess(emptyToUndefined, objectId.optional()),
  manufacturer: z.string().trim().max(120).optional().default(''),
  // in_stock | low_stock | out_of_stock | expired (the older short names in/low/out are still accepted)
  stock: z
    .enum(['', 'in', 'low', 'out', ...STOCK_STATUSES])
    .optional()
    .default('')
    .transform((v) => STOCK_STATUS_ALIASES[v] ?? v),
  // archived medicines are hidden unless asked for
  archived: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['exclude', 'include', 'only']).optional().default('exclude')), // empty = default
  sortBy: z.enum(SORTABLE).optional().default('medicineName'),
  sortDir: z.enum(['asc', 'desc']).optional().default('asc'),
});

export const posQuery = z.object({ q: z.string().trim().max(100).optional().default('') });
