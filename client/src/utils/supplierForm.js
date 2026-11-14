/**
 * The Add / Edit Supplier form: what the fields are, what counts as valid, and how the form becomes the request the server expects.
 * The server checks all of it again — these rules only let someone fix a mistake before sending, and word it the same way on both screens.
 */
export const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[0-9+\-\s()]+$/;
const URL = /^https?:\/\/\S+$/i;

export const SUPPLIER_TYPES = [
  { value: 'manufacturer', label: 'Manufacturer' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'wholesaler', label: 'Wholesaler' },
  { value: 'stockist', label: 'Stockist' },
  { value: 'other', label: 'Other' },
];

export const PAYMENT_TERMS = [
  { value: 'advance', label: 'Advance payment' },
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'net7', label: '7 days' },
  { value: 'net15', label: '15 days' },
  { value: 'net30', label: '30 days' },
  { value: 'net45', label: '45 days' },
  { value: 'custom', label: 'Custom' },
];
const TERM_DAYS = { advance: 0, cod: 0, net7: 7, net15: 15, net30: 30, net45: 45 };

/** The days a term implies; only "Custom" takes the number someone typed. */
export const creditDaysFor = (terms, typed) => (terms === 'custom' ? Math.max(0, Math.trunc(Number(typed) || 0)) : TERM_DAYS[terms] ?? 0);

/** An empty form. */
export const emptySupplier = () => ({
  name: '', code: '', gstin: '', pan: '', supplierType: 'distributor', website: '', isPreferred: false, status: 'active',
  contactPerson: '', phone: '', altPhone: '', email: '', altEmail: '',
  line1: '', line2: '', country: 'India', state: '', city: '', pincode: '', landmark: '',
  paymentTerms: 'cod', creditPeriodDays: '', minimumOrderValue: '', preferredDeliveryTime: '', defaultBranchId: '', notes: '',
});

/** A supplier from the server, as the form holds it. */
export const supplierToForm = (s) => ({
  ...emptySupplier(),
  name: s.name || '', code: s.code || '', gstin: s.gstin || '', pan: s.pan || '', supplierType: s.supplierType || 'distributor', website: s.website || '',
  isPreferred: Boolean(s.isPreferred), status: s.isActive === false ? 'inactive' : 'active',
  contactPerson: s.contactPerson || '', phone: s.phone || '', altPhone: s.altPhone || '', email: s.email || '', altEmail: s.altEmail || '',
  line1: s.address?.line1 || '', line2: s.address?.line2 || '', country: s.address?.country || 'India', state: s.address?.state || '', city: s.address?.city || '',
  pincode: s.address?.pincode || '', landmark: s.address?.landmark || '',
  paymentTerms: s.procurement?.paymentTerms || 'cod',
  creditPeriodDays: s.procurement?.creditPeriodDays ? String(s.procurement.creditPeriodDays) : '',
  minimumOrderValue: s.procurement?.minimumOrderValue ? String(s.procurement.minimumOrderValue) : '',
  preferredDeliveryTime: s.procurement?.preferredDeliveryTime || '',
  defaultBranchId: s.procurement?.defaultBranchId ? String(s.procurement.defaultBranchId) : '',
  notes: s.procurement?.notes || '',
});

/** Everything wrong with the form, as field -> message. Empty means it can be sent. */
export function supplierProblems(f) {
  const e = {};
  const has = (k) => String(f[k] ?? '').trim();
  if (!has('name')) e.name = 'Enter the company name';
  else if (has('name').length > 150) e.name = 'Use 150 characters or fewer';
  if (!has('contactPerson')) e.contactPerson = 'Enter the contact person';
  if (!has('phone')) e.phone = 'Enter the phone number';
  else if (!PHONE.test(has('phone'))) e.phone = 'Use digits, spaces, + and - only';
  if (has('altPhone') && !PHONE.test(has('altPhone'))) e.altPhone = 'Use digits, spaces, + and - only';
  if (has('email') && !EMAIL.test(has('email'))) e.email = 'Enter a valid email address';
  if (has('altEmail') && !EMAIL.test(has('altEmail'))) e.altEmail = 'Enter a valid email address';
  if (has('code') && !/^[A-Za-z0-9-]+$/.test(has('code'))) e.code = 'Use letters, numbers and - only';
  if (has('gstin') && !GSTIN.test(has('gstin').toUpperCase())) e.gstin = 'GST number is not in a valid format';
  if (has('pan') && !PAN.test(has('pan').toUpperCase())) e.pan = 'PAN is not in a valid format (ABCDE1234F)';
  if (has('website') && !URL.test(has('website'))) e.website = 'Enter a web address starting with http:// or https://';
  if (!has('line1')) e.line1 = 'Enter the address';
  if (has('pincode') && !/^\d{6}$/.test(has('pincode'))) e.pincode = 'Enter a 6-digit PIN code';
  if (f.paymentTerms === 'custom') {
    const d = has('creditPeriodDays');
    if (!d) e.creditPeriodDays = 'Enter the credit period in days';
    else if (!/^\d+$/.test(d) || Number(d) > 365) e.creditPeriodDays = 'Enter whole days, 365 or fewer';
  } else if (has('creditPeriodDays') && !/^\d+$/.test(has('creditPeriodDays'))) e.creditPeriodDays = 'Enter whole days';
  if (has('minimumOrderValue') && !/^\d+(\.\d{1,2})?$/.test(has('minimumOrderValue'))) e.minimumOrderValue = 'Enter an amount like 5000 or 5000.50';
  return e;
}

/** The form as the API wants it: trimmed, upper-cased where the server stores it that way, and numbers as numbers. */
export function supplierPayload(f) {
  const t = (k) => String(f[k] ?? '').trim();
  return {
    name: t('name'),
    code: t('code').toUpperCase(),
    supplierType: f.supplierType || 'distributor',
    website: t('website'),
    isPreferred: Boolean(f.isPreferred),
    isActive: f.status !== 'inactive',
    contactPerson: t('contactPerson'),
    phone: t('phone'),
    altPhone: t('altPhone'),
    email: t('email'),
    altEmail: t('altEmail'),
    gstin: t('gstin').toUpperCase(),
    pan: t('pan').toUpperCase(),
    address: { line1: t('line1'), line2: t('line2'), country: t('country'), state: t('state'), city: t('city'), pincode: t('pincode'), landmark: t('landmark') },
    procurement: {
      paymentTerms: f.paymentTerms || 'cod',
      creditPeriodDays: creditDaysFor(f.paymentTerms, f.creditPeriodDays),
      minimumOrderValue: Number(t('minimumOrderValue') || 0),
      preferredDeliveryTime: t('preferredDeliveryTime'),
      defaultBranchId: t('defaultBranchId'),
      notes: t('notes'),
    },
  };
}

/** Maps the server's field errors (path -> message) onto the form's own field names. */
export const serverErrors = (details) => {
  const map = { 'address.line1': 'line1', 'address.line2': 'line2', 'address.city': 'city', 'address.state': 'state', 'address.pincode': 'pincode', 'address.country': 'country', 'address.landmark': 'landmark', 'procurement.paymentTerms': 'paymentTerms', 'procurement.creditPeriodDays': 'creditPeriodDays', 'procurement.minimumOrderValue': 'minimumOrderValue', 'procurement.defaultBranchId': 'defaultBranchId', 'procurement.notes': 'notes', 'procurement.preferredDeliveryTime': 'preferredDeliveryTime' };
  const out = {};
  for (const d of details || []) {
    const key = map[d.path] || d.path;
    if (key && !out[key]) out[key] = d.message;
  }
  return out;
};

/** "₹5,000" / "—": an amount for the details screen. */
export const rupees = (n) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n))
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** What the Procurement section says about the terms in one line. */
export const termsSummary = (terms, days) => {
  const label = PAYMENT_TERMS.find((t) => t.value === terms)?.label || '—';
  const d = creditDaysFor(terms, days);
  return d > 0 ? `${label} (${d} day${d === 1 ? '' : 's'} credit)` : label;
};
