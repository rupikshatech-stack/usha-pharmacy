import mongoose from 'mongoose';
import { Schema, Types, timestamps } from './shared.js';
import { SLUG_PATTERN } from '../utils/slug.js';
import { DEFAULT_TIMEZONE, isValidTimezone } from '../utils/tz.js';

export const REPORTING_PERIODS = ['fiscal_year', 'calendar_year', 'all_time'];
export const BUSINESS_CATEGORIES = ['retail', 'wholesale', 'both', 'hospital'];
/** A pharmacy is either trading or shut out of its own workspace; there is no third state and no soft delete. */
export const ORGANIZATION_STATUSES = ['active', 'suspended'];
export const BUSINESS_CATEGORY_LABEL = { retail: 'Retail pharmacy', wholesale: 'Wholesale / distribution', both: 'Retail and wholesale', hospital: 'Hospital pharmacy' };
export const GST_REGISTRATION_TYPES = ['regular', 'composition', 'unregistered'];
/** The drug licences a pharmacy or wholesaler actually holds under the Drugs and Cosmetics Rules. */
export const LICENSE_TYPES = ['20', '21', '20B', '21B', '20C', '21C', '21F', 'other'];
export const LICENSE_TYPE_LABEL = {
  20: 'Form 20 — retail, non-schedule C',
  21: 'Form 21 — retail, schedule C & C1',
  '20B': 'Form 20B — wholesale, non-schedule C',
  '21B': 'Form 21B — wholesale, schedule C & C1',
  '20C': 'Form 20C — retail, schedule X',
  '21C': 'Form 21C — wholesale, schedule X',
  '21F': 'Form 21F — restricted licence',
  other: 'Other licence',
};
export const PAPER_SIZES = ['A4', 'A5', 'thermal80', 'thermal58'];
export const INVOICE_TEMPLATES = ['classic', 'compact', 'detailed'];
export const DATE_FORMATS = ['dd MMM yyyy', 'dd/MM/yyyy', 'dd-MM-yyyy', 'yyyy-MM-dd'];
/**
 * What the system showed before this was configurable — "06 Nov 2026". It is the DEFAULT, deliberately, so that an
 * organization that never opens Common Settings sees exactly what it always saw.
 */
export const DEFAULT_DATE_FORMAT = 'dd MMM yyyy';
export const ROUND_OFF_NEAREST = [1, 0.5];
// 'email' sends the daily digest from scripts/run-expiry-alerts.js; 'in_app' is the notification bell. A channel
// of 'email' still shows the in-app alert — the email is in addition to it, not instead of it.
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'none'];

export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The tenant root. Every other business collection points at it through organizationId. */
const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
      match: [SLUG_PATTERN, 'slug may contain only lowercase letters, numbers and single hyphens'],
    },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    address: {
      line1: { type: String, trim: true, default: '' },
      line2: { type: String, trim: true, default: '' },
      landmark: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
      state: { type: String, trim: true, default: '' },
      pincode: { type: String, trim: true, default: '' },
      country: { type: String, trim: true, default: 'India' },
    },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      validate: { validator: (v) => !v || GSTIN_PATTERN.test(v), message: 'GSTIN is not in a valid format' },
    },
    logo: { type: String, trim: true, default: '' }, // URL or storage path of the logo image
    // The name on the GST registration, when it differs from the name over the door.
    legalName: { type: String, trim: true, default: '', maxlength: 150 },
    businessCategory: { type: String, enum: BUSINESS_CATEGORIES, default: 'retail' },
    description: { type: String, trim: true, default: '', maxlength: 1000 },
    establishedYear: { type: Number, min: 1800, max: 2200 },

    /**
     * Who the business belongs to. This is BUSINESS data — it is printed on documents and asked for by inspectors —
     * and it is deliberately NOT the login. The person's sign-in identity lives on their User record, because that
     * is what resolves the tenant at sign-in; changing it is a security action with its own endpoint, not a field
     * on a settings form.
     */
    owner: {
      firstName: { type: String, trim: true, default: '', maxlength: 60 },
      lastName: { type: String, trim: true, default: '', maxlength: 60 },
      email: { type: String, trim: true, lowercase: true, default: '', maxlength: 150 },
      phone: { type: String, trim: true, default: '', maxlength: 20 },
      altPhone: { type: String, trim: true, default: '', maxlength: 20 },
    },

    /** Tax identity beyond the GSTIN. `pan` is derived from the GSTIN, never typed, so the two cannot disagree. */
    tax: {
      registrationType: { type: String, enum: GST_REGISTRATION_TYPES, default: 'regular' },
      pan: { type: String, trim: true, uppercase: true, default: '', maxlength: 10 },
      fssai: { type: String, trim: true, default: '', maxlength: 14 },
      cin: { type: String, trim: true, uppercase: true, default: '', maxlength: 21 },
    },

    /**
     * Drug licences, as a LIST. A pharmacy holds several at once — Form 20 and 21 for retail, 20B and 21B for
     * wholesale, 20C/21C for Schedule X — each with its own number and its own expiry date. One text field could
     * only ever hold one of them, which is why the reference product's single "licence number" is not enough to
     * answer the question an inspector actually asks.
     */
    licenses: [
      {
        type: { type: String, enum: LICENSE_TYPES, required: true },
        number: { type: String, trim: true, required: true, maxlength: 60 },
        issuedBy: { type: String, trim: true, default: '', maxlength: 120 },
        validFrom: Date,
        validUntil: Date,
        // The scanned licence, in the upload store. Never served directly — only through an authenticated route.
        document: {
          storageKey: { type: String, trim: true },
          fileName: { type: String, trim: true, maxlength: 150 },
          mimeType: { type: String, trim: true, maxlength: 60 },
          size: { type: Number, min: 0 },
        },
        notes: { type: String, trim: true, default: '', maxlength: 300 },
      },
    ],

    /**
     * Where customers pay. Printed on invoices, so it is business data rather than a secret — but an account number
     * is still not something every member of staff needs, and the read API masks it for anyone who cannot edit it.
     */
    bank: {
      accountHolder: { type: String, trim: true, default: '', maxlength: 120 },
      bankName: { type: String, trim: true, default: '', maxlength: 120 },
      accountNumber: { type: String, trim: true, default: '', maxlength: 30 },
      ifsc: { type: String, trim: true, uppercase: true, default: '', maxlength: 11 },
      branchName: { type: String, trim: true, default: '', maxlength: 120 },
      upiId: { type: String, trim: true, default: '', maxlength: 120 },
    },

    /** Where the business invoices from, when that is not where it is registered. */
    billingSameAsRegistered: { type: Boolean, default: true },
    billingAddress: {
      line1: { type: String, trim: true, default: '' },
      line2: { type: String, trim: true, default: '' },
      landmark: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
      state: { type: String, trim: true, default: '' },
      pincode: { type: String, trim: true, default: '' },
      country: { type: String, trim: true, default: 'India' },
    },
    status: { type: String, enum: ORGANIZATION_STATUSES, default: 'active' },

    // Timestamps are always stored in UTC; this IANA zone decides what a "day" or "month" means in
    // reports and how times are displayed.
    timezone: {
      type: String,
      trim: true,
      default: DEFAULT_TIMEZONE,
      validate: { validator: isValidTimezone, message: 'Unknown timezone (use an IANA name such as Asia/Kolkata)' },
    },
    settings: {
      // Which sales count toward "Total Revenue" / "Total Invoices" on the dashboard.
      reportingPeriod: { type: String, enum: REPORTING_PERIODS, default: 'fiscal_year' },
      // First month of the financial year (4 = April, the Indian fiscal year).
      fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 4 },
      // When true, a submitted stock transfer must be approved before it can be dispatched.
      transferApprovalRequired: { type: Boolean, default: false },
      // When false (the default) nobody but an org admin can approve a transfer they created or submitted themselves.
      transferSelfApproval: { type: Boolean, default: false },
      // When true, a submitted supplier order waits for approval before it can be marked as ordered.
      orderApprovalRequired: { type: Boolean, default: false },
      // Rupees one credit costs (credit requests show the amount paid and an estimate of the credits). Not set = the CREDIT_RUPEES_PER_CREDIT default (5).
      creditRupeesPerCredit: { type: Number, min: 0.01, max: 100000 },
      // When true, a bill at the Selling Point is rounded to the nearest rupee and the difference is printed as "Round off". Off by default: totals stay exact.
      posRoundOff: { type: Boolean, default: false },
      /**
       * Inventory Expiry Intelligence. These are the organization's own definitions of "soon" and "selling well", so two
       * stores of the same chain can disagree about them without the report meaning two different things.
       */
      expiry: {
        // The three "expiring within" buckets the report counts, in days, ascending. Defaults to 15 / 30 / 90.
        thresholds: { type: [Number], default: () => [15, 30, 90], validate: [(v) => v.length === 3 && v.every((n) => Number.isInteger(n) && n > 0 && n <= 730) && v[0] < v[1] && v[1] < v[2], 'Give three whole numbers of days, each larger than the last'] },
        // How far back sales are read to work out how fast a medicine sells.
        velocityWindowDays: { type: Number, min: 7, max: 365, default: 60 },
        // How close to its expiry a lot can be and still be worth asking the supplier to take back.
        supplierReturnWindowDays: { type: Number, min: 0, max: 365, default: 90 },
        // The largest discount the report will ever suggest for clearance.
        clearanceMaxDiscount: { type: Number, min: 0, max: 90, default: 50 },
      },

      /**
       * How documents are numbered and how invoices are printed.
       *
       * Numbering is the part that has to be right. A number, once issued, is on paper in somebody's files, so
       * nothing here can reach an invoice that already exists: changing a prefix changes what the NEXT document is
       * called and nothing else. Sequences come from the atomic counter in models/Counter.js, keyed by whatever
       * makes a series distinct — see utils/documentNumber.js.
       */
      invoice: {
        // When true, each store numbers its own documents. Off by default: one shop, one sequence.
        perBranch: { type: Boolean, default: false },
        series: [
          {
            series: { type: String, enum: ['sales', 'salesReturn', 'purchase'], required: true },
            // null = the organization's own setting, which every store follows until it is given its own.
            branchId: { type: Types.ObjectId, ref: 'Branch', default: null },
            prefix: { type: String, trim: true, default: '', maxlength: 12 },
            suffix: { type: String, trim: true, default: '', maxlength: 12 },
            separator: { type: String, default: '-', maxlength: 3 },
            padding: { type: Number, min: 0, max: 12, default: 4 },
            // Where a brand-new sequence starts. It can never be lowered below a number already issued.
            start: { type: Number, min: 1, default: 1 },
            includeFinancialYear: { type: Boolean, default: false },
            resetEveryFinancialYear: { type: Boolean, default: false },
          },
        ],
        template: {
          paperSize: { type: String, enum: PAPER_SIZES, default: 'A4' },
          style: { type: String, enum: INVOICE_TEMPLATES, default: 'classic' },
          accentColor: { type: String, trim: true, default: '#0f766e', maxlength: 9 },
          // What appears on the printed invoice. Every one of these is a real element of the layout.
          show: {
            logo: { type: Boolean, default: true },
            gstin: { type: Boolean, default: true },
            drugLicenses: { type: Boolean, default: true },
            hsn: { type: Boolean, default: true },
            batchExpiry: { type: Boolean, default: true },
            mrp: { type: Boolean, default: true },
            discount: { type: Boolean, default: true },
            taxBreakup: { type: Boolean, default: true },
            amountInWords: { type: Boolean, default: true },
            bankDetails: { type: Boolean, default: false },
            upiQr: { type: Boolean, default: false },
            signature: { type: Boolean, default: true },
            computerGenerated: { type: Boolean, default: true },
          },
        },
        terms: {
          terms: { type: String, trim: true, default: '', maxlength: 2000 },
          footerNote: { type: String, trim: true, default: '', maxlength: 300 },
          returnPolicy: { type: String, trim: true, default: '', maxlength: 500 },
          declaration: { type: String, trim: true, default: '', maxlength: 500 },
          signatoryName: { type: String, trim: true, default: '', maxlength: 120 },
          signature: {
            storageKey: { type: String, trim: true },
            fileName: { type: String, trim: true, maxlength: 150 },
            mimeType: { type: String, trim: true, maxlength: 60 },
            size: { type: Number, min: 0 },
          },
        },
        calculation: {
          /**
           * Retail prices in this system are GST-INCLUSIVE: tax is split out of the price, never added on top (see
           * utils/billMath.js). The field is here so the invoice can say which it is, but only `true` is supported —
           * the validator refuses `false` rather than storing a setting that the billing code would ignore.
           */
          pricesIncludeGst: { type: Boolean, default: true },
          // Which multiple a bill is rounded to when settings.posRoundOff is on. `posRoundOff` stays the on/off
          // switch so there is one answer to "does this organization round", not two.
          roundOffNearest: { type: Number, enum: ROUND_OFF_NEAREST, default: 1 },
          itemDiscountBeforeTax: { type: Boolean, default: true },
        },
      },

      /** Everything else: how dates read, what the stock rules are, and what the bell is allowed to tell people. */
      general: {
        // Display only. Every date is stored as a UTC instant and stays one; this decides how it is written on screen.
        dateFormat: { type: String, enum: DATE_FORMATS, default: DEFAULT_DATE_FORMAT },
        // Bumped by migrate-settings.js when it corrects a default that was wrong, so a correction runs once and
        // can never overwrite a choice somebody makes afterwards.
        defaultsVersion: { type: Number, default: 2 },
        inventory: {
          // The reorder level a NEW medicine starts with. Each medicine keeps its own after that.
          defaultLowStockThreshold: { type: Number, min: 0, max: 100000, default: 10 },
        },
        billing: {
          // OFF by default: today a credit sale has never needed a phone number, and turning this on for everybody
          // would change billing for an organization that never asked for it.
          requireCustomerPhoneOnCredit: { type: Boolean, default: false },
          // 0 = no due date, which is exactly what a credit invoice has today. Anything above 0 stamps a due date.
          defaultCreditDays: { type: Number, min: 0, max: 365, default: 0 },
        },
        // How long before a drug licence expires the warning starts.
        licenseExpiryWarningDays: { type: Number, min: 1, max: 365, default: 60 },
        notifications: {
          lowStock: { enabled: { type: Boolean, default: true }, channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'in_app' } },
          nearExpiry: { enabled: { type: Boolean, default: true }, channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'in_app' } },
          licenseExpiry: { enabled: { type: Boolean, default: true }, channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'in_app' } },
          dailySummary: { enabled: { type: Boolean, default: false }, channel: { type: String, enum: NOTIFICATION_CHANNELS, default: 'in_app' } },
        },
      },

      /** Who last changed the settings, and when. Also the token that detects two people saving at once. */
      updatedAt: Date,
      updatedBy: { type: Types.ObjectId, ref: 'User' },
      updatedByName: { type: String, trim: true, maxlength: 120 },
    },
  },
  timestamps,
);

// Slugs are the public, human-friendly tenant identifier, so they must be unique.
organizationSchema.index({ slug: 1 }, { unique: true });
// A GSTIN identifies one legal entity; unique when present (empty means "not provided").
organizationSchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $type: 'string', $gt: '' } } });
organizationSchema.index({ status: 1 });

export const Organization = mongoose.model('Organization', organizationSchema);
