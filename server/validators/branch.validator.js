import { z } from 'zod';
import { GSTIN_PATTERN } from '../models/Organization.js';
import { pageQuery } from './common.js';

/**
 * Branches (stores). The OLD small shape (name, code, address, phone) keeps working so everything that already creates a store — transfers, orders — is
 * unaffected. As soon as a request carries any of the branch PROFILE fields (address line 1, PIN, email, manager, GSTIN…) — the Branches page always does —
 * the profile is checked in full: address line 1 and PIN code are required, and every value that is given must be in a valid format.
 */
const storeName = z.string().trim().min(1, 'Store name is required').max(100, 'Store name must be 100 characters or fewer');
const storeCode = z
  .string()
  .trim()
  .min(1, 'Store code is required')
  .max(20, 'Store code must be 20 characters or fewer')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers and . _ - only');

const text = (max, label) => z.string().trim().max(max, `${label} must be ${max} characters or fewer`).optional();

const PROFILE = {
  addressLine1: text(150, 'Address line 1'),
  addressLine2: text(150, 'Address line 2'),
  country: text(60, 'Country'),
  state: text(80, 'State'),
  city: text(80, 'City'),
  pincode: text(12, 'PIN code'),
  landmark: text(150, 'Landmark'),
  email: text(120, 'Email'),
  managerName: text(100, 'Branch manager'),
  gstin: text(20, 'GSTIN'),
  openingDate: text(10, 'Opening date'),
  notes: text(500, 'Notes'),
};
const PROFILE_KEYS = Object.keys(PROFILE);

const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s\-()]{7,20}$/;
const PIN_IN = /^[1-9]\d{5}$/;
const PIN_OTHER = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;

/** The formats of whatever was given, and (when asked) the fields a complete profile must have. */
function check(v, ctx, { complete }) {
  const bad = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (complete) {
    if (!v.addressLine1) bad('addressLine1', 'Address line 1 is required');
    if (!v.pincode) bad('pincode', 'PIN code is required');
  } else {
    if (v.addressLine1 !== undefined && !v.addressLine1) bad('addressLine1', 'Address line 1 is required');
    if (v.pincode !== undefined && !v.pincode) bad('pincode', 'PIN code is required');
  }
  if (v.phone && !(PHONE.test(v.phone) && v.phone.replace(/\D/g, '').length >= 7 && v.phone.replace(/\D/g, '').length <= 15)) bad('phone', 'Enter a valid phone number (7 to 15 digits)');
  if (v.email && !EMAIL.test(v.email)) bad('email', 'Enter a valid email address');
  if (v.pincode) {
    const india = !v.country || /^india$/i.test(v.country.trim());
    if (india ? !PIN_IN.test(v.pincode) : !PIN_OTHER.test(v.pincode)) bad('pincode', india ? 'PIN code must be 6 digits' : 'Enter a valid postal code');
  }
  if (v.gstin && !GSTIN_PATTERN.test(v.gstin.toUpperCase())) bad('gstin', 'GSTIN is not in a valid format (for example 27ABCDE1234F1Z5)');
  if (v.openingDate && !realDay(v.openingDate)) bad('openingDate', 'Use a real date like 2026-04-01');
}

export const createBranchSchema = z
  .object({
    name: storeName,
    code: storeCode,
    address: z.string().trim().max(300).optional(), // the older single-line address
    phone: z.string().trim().max(20).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    ...PROFILE,
  })
  .superRefine((v, ctx) => check(v, ctx, { complete: PROFILE_KEYS.some((k) => v[k] !== undefined) }));

export const updateBranchSchema = z
  .object({
    name: storeName.optional(),
    code: storeCode.optional(),
    address: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(20).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    ...PROFILE,
  })
  .superRefine((v, ctx) => {
    if (Object.keys(v).length === 0) ctx.addIssue({ code: 'custom', path: [], message: 'Nothing to update' });
    check(v, ctx, { complete: false });
  });

/** Without any of these the list is the plain array older screens expect; with any, it is a page. */
export const PAGING_KEYS = ['page', 'limit', 'search', 'status'];
export const listBranchesQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''),
  status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['active', 'inactive']).optional()),
});
