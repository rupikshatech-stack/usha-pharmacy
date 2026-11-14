import { panFromGstin } from '../../utils/indianTax.js';

/**
 * The part of the settings migration that fills in fields, as a function — so the migration script and the test that
 * proves "a migrated organization bills exactly like a legacy one" run the SAME code, not two copies that can drift.
 *
 * IDEMPOTENT. Every step is guarded by `$exists: false`, or by the version marker below, so running it twice changes
 * nothing the second time.
 *
 * THE DEFAULTS ARE WHAT THE SYSTEM ALREADY DID. Not what would be sensible, and not what the settings screen suggests:
 * what billing, stock and the screens did on the day before any of this existed. An organization that never opens
 * Common Settings must bill, adjust stock and read its dates exactly as it did before.
 */

/** The settings an organization has when nobody has chosen anything. */
export const DEFAULTS = {
  'settings.invoice.perBranch': false,
  'settings.invoice.series': [],
  'settings.invoice.template.paperSize': 'A4',
  'settings.invoice.template.style': 'classic',
  'settings.invoice.template.accentColor': '#0f766e',
  'settings.invoice.calculation.pricesIncludeGst': true,
  'settings.invoice.calculation.roundOffNearest': 1,
  'settings.invoice.calculation.itemDiscountBeforeTax': true,
  // "06 Nov 2026" — what every screen has always shown.
  'settings.general.dateFormat': 'dd MMM yyyy',
  'settings.general.inventory.defaultLowStockThreshold': 10,
  // A credit sale has never needed a phone number and has never carried a due date.
  'settings.general.billing.requireCustomerPhoneOnCredit': false,
  'settings.general.billing.defaultCreditDays': 0,
  'settings.general.licenseExpiryWarningDays': 60,
  billingSameAsRegistered: true,
  businessCategory: 'retail',
  licenses: [],
};

const SHOW_ON = ['logo', 'gstin', 'drugLicenses', 'hsn', 'batchExpiry', 'mrp', 'discount', 'taxBreakup', 'amountInWords', 'signature', 'computerGenerated'];
// Nothing is configured yet, and an invoice that prints an empty bank block looks like a mistake to the customer.
const SHOW_OFF = ['bankDetails', 'upiQr'];
const NOTIFICATIONS = [['lowStock', true], ['nearExpiry', true], ['licenseExpiry', true], ['dailySummary', false]];

/**
 * The first version of this migration wrote three defaults that did not match what the system actually did (phone
 * required on credit, a 15-day credit period, a slash date format). Nothing read them and no screen could change
 * them, so no human ever chose them — but they would have started changing behaviour the moment they were wired up.
 * This corrects them ONCE, guarded by `settings.general.defaultsVersion`, so it can never overwrite a choice made
 * afterwards.
 */
export const CORRECTED_DEFAULTS_VERSION = 2;

export async function applySettingsDefaults(db) {
  const orgs = db.collection('organizations');
  const report = { filled: 0, toggles: 0, notifications: 0, pans: 0, corrected: 0 };

  for (const [path, value] of Object.entries(DEFAULTS)) {
    report.filled += (await orgs.updateMany({ [path]: { $exists: false } }, { $set: { [path]: value } })).modifiedCount;
  }
  for (const key of SHOW_ON) {
    report.toggles += (await orgs.updateMany({ [`settings.invoice.template.show.${key}`]: { $exists: false } }, { $set: { [`settings.invoice.template.show.${key}`]: true } })).modifiedCount;
  }
  for (const key of SHOW_OFF) {
    report.toggles += (await orgs.updateMany({ [`settings.invoice.template.show.${key}`]: { $exists: false } }, { $set: { [`settings.invoice.template.show.${key}`]: false } })).modifiedCount;
  }
  for (const [key, on] of NOTIFICATIONS) {
    report.notifications += (
      await orgs.updateMany({ [`settings.general.notifications.${key}`]: { $exists: false } }, { $set: { [`settings.general.notifications.${key}`]: { enabled: on, channel: 'in_app' } } })
    ).modifiedCount;
  }

  // The one-off correction. Only organizations that have never been stamped with the corrected version.
  const fix = await orgs.updateMany(
    { 'settings.general.defaultsVersion': { $exists: false } },
    {
      $set: {
        'settings.general.billing.requireCustomerPhoneOnCredit': DEFAULTS['settings.general.billing.requireCustomerPhoneOnCredit'],
        'settings.general.billing.defaultCreditDays': DEFAULTS['settings.general.billing.defaultCreditDays'],
        'settings.general.dateFormat': DEFAULTS['settings.general.dateFormat'],
        'settings.general.defaultsVersion': CORRECTED_DEFAULTS_VERSION,
      },
    },
  );
  report.corrected = fix.modifiedCount;

  // The PAN, read out of the GSTIN where there is one. It is derived, never typed, so this is a safe fill-in.
  for (const org of await orgs.find({}, { projection: { _id: 1, gstin: 1 } }).toArray()) {
    const pan = panFromGstin(org.gstin);
    if (!pan) continue;
    report.pans += (await orgs.updateOne({ _id: org._id, 'tax.pan': { $in: [null, '', undefined] } }, { $set: { 'tax.pan': pan } })).modifiedCount;
  }
  return report;
}
