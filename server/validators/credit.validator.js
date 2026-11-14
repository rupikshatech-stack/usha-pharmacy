import { z } from 'zod';
import { pageQuery } from './common.js';
import { CREDIT_STATUSES, CREDIT_TXN_TYPES } from '../models/index.js';

const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const day = blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-08').refine(realDay, 'That is not a real calendar date'));

export const listCreditRequestsQuery = pageQuery(10)
  .extend({
    status: blank(z.enum(CREDIT_STATUSES)),
    scope: blank(z.enum(['mine', 'all'])),
    search: z.string().trim().max(40).optional().default(''),
    from: day,
    to: day,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The start date must not be after the end date', path: ['to'] });
export const summaryQuery = z.object({ scope: blank(z.enum(['mine', 'all'])) });

// The credit ledger: a person's own entries, or everyone's for an administrator; searchable by transaction or request id (and by name when looking at everyone's).
export const listCreditTransactionsQuery = pageQuery(10)
  .extend({
    scope: blank(z.enum(['mine', 'all'])),
    userId: blank(z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid user')),
    type: blank(z.enum(CREDIT_TXN_TYPES)),
    search: z.string().trim().max(40).optional().default(''),
    from: day,
    to: day,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The start date must not be after the end date', path: ['to'] });
export const balanceQuery = z.object({ userId: blank(z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid user')) });

// What an administrator sends to approve or reject. Credits are never accepted from the browser (any `approvedCredits` is dropped here): the server works them out.
export const approveBody = z.object({ approvedAmount: z.union([z.string(), z.number()]), remarks: z.string().trim().max(300).optional() });
export const rejectBody = z.object({ remarks: z.string().trim().max(300) });

// The conversion rate: rupees per credit, a positive amount with at most two decimals.
export const creditSettingsBody = z.object({
  rupeesPerCredit: z.coerce.number({ error: 'Enter the rupees per credit' }).min(0.01, 'The rate must be at least ₹0.01').max(100000, 'That is too large').refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most two decimals'),
});
