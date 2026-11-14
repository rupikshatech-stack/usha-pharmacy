import { z } from 'zod';
import { pageQuery } from './common.js';
import { GSTIN_PATTERN, PAN_PATTERN, SUPPLIER_PAYMENT_TERMS, SUPPLIER_TYPES } from '../models/index.js';

const text = (max) => z.string().trim().max(max, `Use ${max} characters or fewer`).optional();
const phone = z.string().trim().max(20, 'Use 20 characters or fewer').regex(/^[0-9+\-\s()]*$/, 'Use digits, spaces, + and - only').optional();
const email = z.string().trim().max(150).email('Enter a valid email address').or(z.literal('')).optional();

export const SUPPLIER_SORTS = ['name', 'createdAt', 'updatedAt', 'supplierType'];

export const listSuppliersQuery = pageQuery(25).extend({
  search: z.string().trim().max(100).optional().default(''),
  active: z.enum(['active', 'all', 'inactive']).optional().default('active'),
  type: z.enum(SUPPLIER_TYPES).optional(),
  preferred: z.enum(['true', 'false']).optional(),
  sort: z.enum(SUPPLIER_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional().default('asc'),
});

const addressSchema = z
  .object({
    line1: text(150),
    line2: text(150),
    city: text(80),
    state: text(80),
    pincode: z.string().trim().regex(/^(\d{6})?$/, 'Enter a 6-digit PIN code').optional(),
    country: text(80),
    landmark: text(150),
  })
  .optional();

const procurementSchema = z
  .object({
    paymentTerms: z.enum(SUPPLIER_PAYMENT_TERMS).optional(),
    creditPeriodDays: z.coerce.number().int('Whole days only').min(0, 'Cannot be negative').max(365, 'Use 365 days or fewer').optional(),
    minimumOrderValue: z.coerce.number().min(0, 'Cannot be negative').max(100000000, 'That is too large').optional(),
    preferredDeliveryTime: text(100),
    defaultBranchId: z.string().trim().regex(/^([a-f0-9]{24})?$/i, 'Choose a store from the list').optional().transform((v) => v || undefined),
    notes: text(1000),
  })
  .optional();

/**
 * Everything that is optional when a supplier is added or edited. Nothing here carries a default: on a create the model fills the gaps, and on an edit a field
 * nobody sent has to keep the value it already had.
 */
const optionalFields = {
  // Left out, the server allocates the next one (SUP-0001 …).
  code: z.string().trim().toUpperCase().max(20, 'Use 20 characters or fewer').regex(/^[A-Z0-9-]*$/, 'Use letters, numbers and - only').optional(),
  supplierType: z.enum(SUPPLIER_TYPES).optional(),
  website: z.string().trim().max(200, 'Use 200 characters or fewer').regex(/^(https?:\/\/\S+)?$/i, 'Enter a web address starting with http:// or https://').optional(),
  isPreferred: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
  altPhone: phone,
  email,
  altEmail: email,
  address: addressSchema,
  gstin: z.string().trim().toUpperCase().refine((v) => !v || GSTIN_PATTERN.test(v), 'GST number is not in a valid format').optional(),
  pan: z.string().trim().toUpperCase().refine((v) => !v || PAN_PATTERN.test(v), 'PAN is not in a valid format (ABCDE1234F)').optional(),
  procurement: procurementSchema,
};

/**
 * Adding a supplier: the company, who to speak to and their number are required; everything else is optional. The order screens' quick "new supplier" dialog
 * posts the same shape and simply fills in what it knows.
 */
export const createSupplierBody = z.object({
  name: z.string({ error: 'Enter the company name' }).trim().min(1, 'Enter the company name').max(150, 'Use 150 characters or fewer'),
  contactPerson: z.string({ error: 'Enter the contact person' }).trim().min(1, 'Enter the contact person').max(100, 'Use 100 characters or fewer'),
  phone: z.string({ error: 'Enter the phone number' }).trim().min(1, 'Enter the phone number').max(20, 'Use 20 characters or fewer').regex(/^[0-9+\-\s()]+$/, 'Use digits, spaces, + and - only'),
  ...optionalFields,
});

/** Editing: the same rules, and anything left out stays as it was. */
export const updateSupplierBody = createSupplierBody.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const supplierPurchasesQuery = pageQuery(10);
export const preferredBody = z.object({ preferred: z.coerce.boolean() });
export const statusBody = z.object({ status: z.enum(['active', 'inactive']) });
