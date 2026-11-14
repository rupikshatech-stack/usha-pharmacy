import { z } from 'zod';
import {
  BUSINESS_CATEGORIES,
  DATE_FORMATS,
  GST_REGISTRATION_TYPES,
  INVOICE_TEMPLATES,
  LICENSE_TYPES,
  NOTIFICATION_CHANNELS,
  PAPER_SIZES,
  ROUND_OFF_NEAREST,
  REPORTING_PERIODS,
} from '../models/Organization.js';
import { DOCUMENT_SERIES } from '../utils/documentNumber.js';
import { CIN_PATTERN, FSSAI_PATTERN, GSTIN_PATTERN, IFSC_PATTERN, MOBILE_PATTERN, PIN_PATTERN, STATE_NAMES, UPI_PATTERN, isValidGstin } from '../utils/indianTax.js';
import { isValidTimezone } from '../utils/tz.js';

/**
 * What may be saved on the Settings screens.
 *
 * Two rules run through all of it:
 *
 *   EVERY FIELD IS OPTIONAL, because these are PATCH endpoints: the screen sends what the person changed and
 *   nothing else. A field that is absent is not "set me to empty" — it is "I did not touch this". Clearing a value
 *   is done by sending an empty string, which is a different thing and is allowed where the field is optional.
 *
 *   A VALUE IS REFUSED ONLY WHEN IT CANNOT BE TRUE. A GSTIN whose check digit disagrees with the rest of it is
 *   mistyped and is refused. A GSTIN issued in a different state from the address is unusual but perfectly legal,
 *   so it is saved and the response carries a warning — the API does not invent a rule that the GST law does not
 *   have.
 */

/** An optional text field that may also be cleared. */
const text = (max, label) => z.union([z.literal(''), z.string().trim().max(max, `Keep ${label} under ${max} characters`)]).optional();
const bool = z.boolean().optional();
const blank = (schema) => z.union([z.literal(''), schema]).optional();

/**
 * Optimistic concurrency. Every save carries the `updatedAt` the screen last read; if the stored document has moved
 * on, somebody else saved in between and the server refuses rather than overwriting work it cannot see.
 */
const version = z
  .string({ error: 'Reload the page: this save is missing the version it was based on.' })
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'That version is not a timestamp — reload the page and try again.');

const mobile = blank(
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''))
    .refine((v) => MOBILE_PATTERN.test(v), 'An Indian mobile number is 10 digits starting 6, 7, 8 or 9'),
);

const gstin = blank(
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN_PATTERN, 'A GSTIN is 15 characters: 22AAAAA0000A1Z5')
    .refine(isValidGstin, 'That GSTIN’s check character does not match the rest of it, so at least one character is mistyped'),
);

const addressShape = {
  line1: text(150, 'the street address'),
  line2: text(150, 'the second address line'),
  landmark: text(150, 'the landmark'),
  city: text(80, 'the city'),
  state: blank(z.enum(STATE_NAMES, { error: 'Choose a state or union territory from the list' })),
  pincode: blank(z.string().trim().regex(PIN_PATTERN, 'A PIN code is 6 digits and cannot start with 0')),
  country: text(60, 'the country'),
};

/**
 * A drug licence. The dates are checked against each other: a licence that expires before it starts is a typo, and
 * saving it would put a false expiry warning in front of somebody later.
 */
const license = z
  .object({
    type: z.enum(LICENSE_TYPES, { error: 'Choose a licence type' }),
    number: z.string().trim().min(1, 'Enter the licence number').max(60),
    issuedBy: text(120, 'the issuing authority'),
    validFrom: blank(z.iso.date('Use a date like 2026-04-01')),
    validUntil: blank(z.iso.date('Use a date like 2029-03-31')),
    notes: text(300, 'the note'),
    /**
     * The scanned licence, as the upload endpoint described it. The storage key is checked against this
     * organization's own folder when it is saved — a licence may not point at another tenant's file.
     */
    document: z
      .union([
        z.null(),
        z.object({
          storageKey: z.string().trim().min(1).max(200),
          fileName: z.string().trim().max(150).optional(),
          mimeType: z.string().trim().max(60).optional(),
          size: z.coerce.number().int().min(0).optional(),
        }),
      ])
      .optional(),
  })
  .refine((l) => !l.validFrom || !l.validUntil || l.validFrom <= l.validUntil, {
    message: 'A licence cannot expire before it starts',
    path: ['validUntil'],
  });

/* ------------------------------------------------------------------ tab 1: organization profile */

export const organizationSettingsSchema = z.object({
  version,
  name: z.string().trim().min(1, 'The organization name is required').max(150).optional(),
  legalName: text(150, 'the legal name'),
  businessCategory: z.enum(BUSINESS_CATEGORIES).optional(),
  description: text(1000, 'the description'),
  establishedYear: z
    .union([z.literal(''), z.coerce.number().int().min(1800, 'That year is too far back').max(new Date().getFullYear(), 'A business cannot be established in the future')])
    .optional(),
  email: blank(z.string().trim().toLowerCase().email('Enter a valid email address')),
  phone: blank(z.string().trim().regex(/^[0-9+()\-\s]{7,20}$/, 'Enter a valid phone number')),
  gstin,
  timezone: z.string().trim().refine(isValidTimezone, 'Unknown timezone (use an IANA name such as Asia/Kolkata)').optional(),
  address: z.object(addressShape).optional(),
  billingSameAsRegistered: bool,
  billingAddress: z.object(addressShape).optional(),
  tax: z
    .object({
      registrationType: z.enum(GST_REGISTRATION_TYPES).optional(),
      // `pan` is deliberately absent: it is read out of the GSTIN, never typed, so the two cannot disagree.
      fssai: blank(z.string().trim().regex(FSSAI_PATTERN, 'An FSSAI licence number is 14 digits')),
      cin: blank(z.string().trim().toUpperCase().regex(CIN_PATTERN, 'A CIN is 21 characters, for example U24239MH2010PTC123456')),
    })
    .optional(),
  owner: z
    .object({
      firstName: text(60, 'the first name'),
      lastName: text(60, 'the last name'),
      email: blank(z.string().trim().toLowerCase().email('Enter a valid email address')),
      phone: mobile,
      altPhone: mobile,
    })
    .optional(),
  bank: z
    .object({
      accountHolder: text(120, 'the account holder name'),
      bankName: text(120, 'the bank name'),
      accountNumber: blank(z.string().trim().regex(/^\d{5,20}$/, 'An account number is 5 to 20 digits')),
      ifsc: blank(z.string().trim().toUpperCase().regex(IFSC_PATTERN, 'An IFSC is 11 characters, for example HDFC0001234')),
      branchName: text(120, 'the branch name'),
      upiId: blank(z.string().trim().regex(UPI_PATTERN, 'A UPI ID looks like name@bank')),
    })
    .optional(),
  /** The whole list, when it changes: licences are added and removed, so a partial patch of an array is ambiguous. */
  licenses: z.array(license).max(25, 'That is more licences than any one business holds').optional(),
});

/* ------------------------------------------------------------------ tab 2: invoice customization */

const seriesSchema = z.object({
  series: z.enum(DOCUMENT_SERIES, { error: 'That is not a document this system issues' }),
  branchId: z.union([z.null(), z.string().trim().regex(/^[a-f\d]{24}$/i, 'That is not a valid store')]).optional(),
  prefix: text(12, 'the prefix'),
  suffix: text(12, 'the suffix'),
  separator: z.string().max(3, 'A separator is at most 3 characters').optional(),
  padding: z.coerce.number().int().min(0, 'Padding cannot be negative').max(12, 'Padding of more than 12 digits is not a number anybody reads').optional(),
  start: z.coerce.number().int().min(1, 'Numbering starts at 1 or higher').optional(),
  includeFinancialYear: bool,
  resetEveryFinancialYear: bool,
});

export const invoiceSettingsSchema = z.object({
  version,
  perBranch: bool,
  series: z.array(seriesSchema).max(60, 'That is more series than this can hold').optional(),
  template: z
    .object({
      paperSize: z.enum(PAPER_SIZES).optional(),
      style: z.enum(INVOICE_TEMPLATES).optional(),
      accentColor: blank(z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Choose a colour like #0f766e')),
      show: z
        .object({
          logo: bool,
          gstin: bool,
          drugLicenses: bool,
          hsn: bool,
          batchExpiry: bool,
          mrp: bool,
          discount: bool,
          taxBreakup: bool,
          amountInWords: bool,
          bankDetails: bool,
          upiQr: bool,
          signature: bool,
          computerGenerated: bool,
        })
        .optional(),
    })
    .optional(),
  terms: z
    .object({
      terms: text(2000, 'the terms'),
      footerNote: text(300, 'the footer note'),
      returnPolicy: text(500, 'the return policy'),
      declaration: text(500, 'the declaration'),
      signatoryName: text(120, 'the signatory name'),
    })
    .optional(),
  calculation: z
    .object({
      /**
       * Only inclusive pricing exists in this system: utils/billMath.js splits tax OUT of the price. Accepting
       * `false` would store a setting the billing code ignores, so it is refused with the reason.
       */
      pricesIncludeGst: z
        .literal(true, { error: 'Prices in this system are GST-inclusive: tax is split out of the price, never added on top. Exclusive pricing would need the billing calculation changed first.' })
        .optional(),
      roundOffNearest: z.coerce.number().refine((n) => ROUND_OFF_NEAREST.includes(n), 'Round off to the nearest ₹1 or ₹0.50').optional(),
      /**
       * An item discount comes off the inclusive price BEFORE the tax is split out, so the tax falls with the
       * discount — that is how `utils/billMath.js` works and the only way it works. `false` would be a setting the
       * billing code ignores, so it is refused with the reason rather than stored.
       */
      itemDiscountBeforeTax: z
        .literal(true, { error: 'An item discount is always taken off before the tax is split out, so the tax falls with it. Taking it off after tax would mean changing how every bill is calculated first.' })
        .optional(),
    })
    .optional(),
});

/* ------------------------------------------------------------------ tab 3: common settings */

const notification = z.object({ enabled: bool, channel: z.enum(NOTIFICATION_CHANNELS).optional() }).optional();

export const generalSettingsSchema = z.object({
  version,
  timezone: z.string().trim().refine(isValidTimezone, 'Unknown timezone (use an IANA name such as Asia/Kolkata)').optional(),
  reportingPeriod: z.enum(REPORTING_PERIODS).optional(),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
  posRoundOff: bool,
  transferApprovalRequired: bool,
  transferSelfApproval: bool,
  orderApprovalRequired: bool,
  /** The expiry module's own settings, edited here rather than copied: there is one set of these, not two. */
  expiry: z
    .object({
      thresholds: z
        .array(z.coerce.number().int().min(1, 'A threshold is at least 1 day').max(730, 'Use 730 days or fewer'))
        .length(3, 'Give exactly three thresholds')
        .refine((t) => t[0] < t[1] && t[1] < t[2], 'Each threshold must be larger than the one before')
        .optional(),
      velocityWindowDays: z.coerce.number().int().min(7, 'Use at least 7 days of sales').max(365).optional(),
      supplierReturnWindowDays: z.coerce.number().int().min(0).max(365).optional(),
      clearanceMaxDiscount: z.coerce.number().min(0).max(90, 'A discount above 90% is not clearance, it is a giveaway').optional(),
    })
    .optional(),
  inventory: z
    .object({
      defaultLowStockThreshold: z.coerce.number().int().min(0).max(100000).optional(),
      // FEFO allocation and the block on selling expired stock are NOT settings: the billing code enforces both in
      // the same atomic update that takes the stock, and a switch here could not turn them off.
    })
    .optional(),
  billing: z
    .object({
      requireCustomerPhoneOnCredit: bool,
      defaultCreditDays: z.coerce.number().int().min(0).max(365, 'A credit period longer than a year is not a credit period').optional(),
      // TODO (prescription capture module): requirePrescriptionForSchedule, doctor name and registration number.
      // Deliberately not stored yet — an invoice has nowhere to put a prescription, so the toggle would do nothing.
    })
    .optional(),
  licenseExpiryWarningDays: z.coerce.number().int().min(1).max(365).optional(),
  notifications: z
    .object({ lowStock: notification, nearExpiry: notification, licenseExpiry: notification, dailySummary: notification })
    .optional(),
});

/** Resetting invoice settings to the defaults. Typed confirmation, because it throws away a configuration. */
export const resetInvoiceSchema = z.object({
  version,
  confirm: z.literal('RESET', { error: 'Type RESET to confirm' }),
});

/** The next-number preview. */
export const previewNumberQuery = z.object({
  series: z.enum(DOCUMENT_SERIES, { error: 'That is not a document this system issues' }),
  branchId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'That is not a valid store').optional(),
});
