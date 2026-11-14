import { z } from 'zod';
import { DRUG_SCHEDULES } from '../models/index.js';
import { EXPIRY_GROUP_BY, EXPIRY_SORTABLE, EXPIRY_STATUSES } from '../services/analyticsExpiry.service.js';
import { RISK_LEVELS } from '../services/expiryRisk.js';
import { RETURN_OUTCOMES } from '../services/expiryActions.service.js';

/**
 * Inventory Expiry Intelligence: what the report will accept being asked.
 *
 * Every filter is a value the data can actually hold. An unknown status, risk level or schedule is REFUSED rather
 * than quietly ignored — a filter that appears to work but does not is worse than one that errors, because the person
 * acts on what they think they are looking at.
 */
const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const day = blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-09').refine(realDay, 'That is not a real calendar date'));
const objectId = (what) => blank(z.string().regex(/^[a-f0-9]{24}$/i, `Choose ${what} from the list`));

const orderedDays = (v) => !v.expiryFrom || !v.expiryTo || v.expiryFrom <= v.expiryTo;
const DAY_ORDER = { message: 'The first expiry date must not be after the last', path: ['expiryTo'] };

/** Which store the report is about. Everything on this screen is a position as it stands now, so there is no period. */
const scopeShape = { branchId: objectId('a store') };

/** The filters the register and its exports share. */
const registerShape = {
  ...scopeShape,
  status: blank(z.enum(EXPIRY_STATUSES)),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  categoryId: objectId('a category'),
  manufacturer: blank(z.string().trim().max(120, 'Keep the manufacturer under 120 characters')),
  // "none" is a real answer here: lots with no supplier recorded are a group people need to look at.
  supplierId: blank(z.union([z.literal('none'), z.string().regex(/^[a-f0-9]{24}$/i, 'Choose a supplier from the list')])),
  scheduleCategory: blank(z.enum(DRUG_SCHEDULES.filter(Boolean))),
  riskLevel: blank(z.enum(RISK_LEVELS)),
  minValue: blank(z.coerce.number().min(0, 'A minimum value cannot be negative').max(100000000)),
  expiryFrom: day,
  expiryTo: day,
  sortBy: blank(z.enum(EXPIRY_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
  groupBy: blank(z.enum(EXPIRY_GROUP_BY)),
};

export const expirySummaryQuery = z.object(scopeShape);

export const expiryBatchesQuery = z
  .object({
    ...registerShape,
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .refine(orderedDays, DAY_ORDER);

/* ------------------------------------------------------------------ the actions */

/** The lots an action applies to. One or many — a bulk action is the same request with a longer list. */
const batchIds = z
  .array(z.string().regex(/^[a-f0-9]{24}$/i, 'That is not a valid lot'))
  .min(1, 'Choose at least one lot')
  .max(200, 'Act on at most 200 lots at a time');

const reason = z.string().trim().min(3, 'Say why, in a few words at least').max(300, 'Keep the reason under 300 characters');
const note = blank(z.string().trim().max(300, 'Keep the note under 300 characters'));

/**
 * One request shape per action, chosen by `action`. A discriminated union means a disposal cannot be sent without a
 * reason and a clearance cannot be sent without a discount — the shape of the request proves the intent, rather than
 * the service having to re-check what the caller meant.
 */
export const expiryActionBody = z.discriminatedUnion('action', [
  // Destroying stock always has to be explained. The reason goes into the ledger and the audit trail verbatim.
  z.object({ action: z.literal('dispose'), batchIds, reason }),
  // A suggested discount, never a price change.
  z.object({ action: z.literal('clearance'), batchIds, discountPercent: z.coerce.number().min(0, 'A discount cannot be negative').max(90, 'A discount cannot exceed 90%'), note }),
  z.object({ action: z.literal('clearanceClear'), batchIds }),
  // Quarantines the stock. Reversible — see returnSettle.
  z.object({ action: z.literal('returnRequest'), batchIds, note }),
  z.object({ action: z.literal('returnSettle'), batchIds, outcome: z.enum(RETURN_OUTCOMES), note }),
]);

/** A single lot, for the drawer and the transfer suggestion. */
export const batchIdParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i, 'That is not a valid lot') });

/* ------------------------------------------------------------------ insights, calendar, export, settings */

/** The charts take the same store and the same filters as the register, so they describe the same stock. */
export const expiryInsightsQuery = z.object({ ...registerShape }).refine(orderedDays, DAY_ORDER);

/** The calendar adds the month being looked at. */
export const expiryCalendarQuery = z
  .object({ ...registerShape, month: blank(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-11')) })
  .refine(orderedDays, DAY_ORDER);

/**
 * The export takes the register's own question and has no page of its own, because it carries every matching lot.
 * `format` exists so that asking for a spreadsheet gets a clear answer rather than a silent CSV.
 */
export const expiryExportQuery = z
  .object({ ...registerShape, format: blank(z.string().trim().toLowerCase().max(10)) })
  .refine(orderedDays, DAY_ORDER);

/**
 * The organization's thresholds. Every field is required: a settings form sends the whole card, and accepting a
 * partial update here would let one bad save leave the three buckets in an impossible order.
 */
export const expirySettingsBody = z.object({
  thresholds: z
    .array(z.coerce.number().int().min(1, 'A bucket must be at least a day').max(730, 'Keep a bucket under two years'))
    .length(3, 'Give exactly three buckets')
    .refine((v) => v[0] < v[1] && v[1] < v[2], { message: 'Each bucket must be longer than the one before it' }),
  velocityWindowDays: z.coerce.number().int().min(7, 'Measure demand over at least a week').max(365, 'Measure demand over at most a year'),
  supplierReturnWindowDays: z.coerce.number().int().min(0).max(365, 'A return window longer than a year is not credible'),
  clearanceMaxDiscount: z.coerce.number().int().min(0).max(90, 'A discount ceiling above 90% is not a discount'),
});
