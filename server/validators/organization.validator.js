import { z } from 'zod';
import { GSTIN_PATTERN, REPORTING_PERIODS } from '../models/Organization.js';
import { isValidTimezone } from '../utils/tz.js';

const text = (max) => z.string().trim().max(max).optional();

/**
 * What an organization admin may edit. `slug` and `status` are deliberately absent: the slug is the
 * tenant's stable identifier and the status is controlled by the platform, not the tenant.
 */
export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required').max(150).optional(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address')]).optional(),
  phone: z.union([z.literal(''), z.string().trim().regex(/^[0-9+()\-\s]{7,20}$/, 'Enter a valid phone number')]).optional(),
  gstin: z
    .union([z.literal(''), z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN')])
    .optional(),
  logo: z.union([z.literal(''), z.string().trim().max(500).regex(/^(https?:\/\/|\/)/, 'Logo must be an http(s) URL or a path')]).optional(),
  timezone: z.string().trim().refine(isValidTimezone, 'Unknown timezone (use an IANA name such as Asia/Kolkata)').optional(),
  settings: z
    .object({
      reportingPeriod: z.enum(REPORTING_PERIODS).optional(),
      fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
    })
    .optional(),
  address: z
    .object({
      line1: text(150),
      line2: text(150),
      city: text(80),
      state: text(80),
      pincode: z.union([z.literal(''), z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits')]).optional(),
      country: text(60),
    })
    .optional(),
});
