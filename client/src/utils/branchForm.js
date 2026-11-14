/**
 * The branch form: its blank state, a branch as editable text, the checks (the same rules the server applies — it checks again), and the request body.
 * The body always carries every profile field, even when empty, which is what makes the server check the profile in full (address line 1 and PIN required).
 */
export const blankBranch = () => ({
  name: '',
  code: '',
  phone: '',
  email: '',
  status: 'active',
  addressLine1: '',
  addressLine2: '',
  country: 'India',
  state: '',
  city: '',
  pincode: '',
  landmark: '',
  managerName: '',
  gstin: '',
  openingDate: '',
  notes: '',
});

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** A saved branch as form text. A branch made the older quick way has no address parts: its one-line address is shown so it can be completed. */
export function fromBranch(b) {
  return {
    ...blankBranch(),
    id: b._id,
    name: b.name || '',
    code: b.code || '',
    phone: b.phone || '',
    email: b.email || '',
    status: b.status || 'active',
    addressLine1: b.addressLine1 || '',
    addressLine2: b.addressLine2 || '',
    country: b.country || 'India',
    state: b.state || '',
    city: b.city || '',
    pincode: b.pincode || '',
    landmark: b.landmark || '',
    managerName: b.managerName || '',
    gstin: b.gstin || '',
    openingDate: b.openingDate ? String(b.openingDate).slice(0, 10) : '',
    notes: b.notes || '',
    legacyAddress: b.addressLine1 ? '' : b.address || '',
  };
}

/** { field: message } for everything that cannot be saved. Empty = fine. */
export function validateBranch(f) {
  const e = {};
  const t = (k) => String(f[k] ?? '').trim();
  if (!t('name')) e.name = 'Branch name is required';
  else if (t('name').length > 100) e.name = 'Branch name must be 100 characters or fewer';
  if (!t('code')) e.code = 'Branch code is required';
  else if (!/^[A-Za-z0-9._-]+$/.test(t('code'))) e.code = 'Use letters, numbers and . _ - only';
  else if (t('code').length > 20) e.code = 'Branch code must be 20 characters or fewer';
  if (!t('addressLine1')) e.addressLine1 = 'Address line 1 is required';
  if (!t('pincode')) e.pincode = 'PIN code is required';
  else if (!t('country') || /^india$/i.test(t('country'))) {
    if (!/^[1-9]\d{5}$/.test(t('pincode'))) e.pincode = 'PIN code must be 6 digits';
  } else if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(t('pincode'))) e.pincode = 'Enter a valid postal code';
  if (t('phone')) {
    const digits = t('phone').replace(/\D/g, '');
    if (!/^\+?[\d\s\-()]{7,20}$/.test(t('phone')) || digits.length < 7 || digits.length > 15) e.phone = 'Enter a valid phone number (7 to 15 digits)';
  }
  if (t('email') && !EMAIL.test(t('email'))) e.email = 'Enter a valid email address';
  if (t('gstin') && !GSTIN.test(t('gstin').toUpperCase())) e.gstin = 'GSTIN is not in a valid format (for example 27ABCDE1234F1Z5)';
  if (t('openingDate') && !realDay(t('openingDate'))) e.openingDate = 'Use a real date';
  for (const [k, max, label] of [
    ['addressLine1', 150, 'Address line 1'],
    ['addressLine2', 150, 'Address line 2'],
    ['landmark', 150, 'Landmark'],
    ['managerName', 100, 'Branch manager'],
    ['notes', 500, 'Notes'],
  ]) {
    if (t(k).length > max) e[k] = `${label} must be ${max} characters or fewer`;
  }
  return e;
}

/** The request body: trimmed, the code and GSTIN in capitals, every profile field present so the server checks the profile in full. */
export function toBody(f) {
  const t = (k) => String(f[k] ?? '').trim();
  return {
    name: t('name'),
    code: t('code').toUpperCase(),
    phone: t('phone'),
    email: t('email'),
    status: f.status === 'inactive' ? 'inactive' : 'active',
    addressLine1: t('addressLine1'),
    addressLine2: t('addressLine2'),
    country: t('country') || 'India',
    state: t('state'),
    city: t('city'),
    pincode: t('pincode'),
    landmark: t('landmark'),
    managerName: t('managerName'),
    gstin: t('gstin').toUpperCase(),
    openingDate: t('openingDate'),
    notes: t('notes'),
  };
}

/** The address in full, one line (what the table shows). Older branches have only the single-line address. */
export const addressText = (b) => [b.addressLine1, b.addressLine2, b.landmark, b.city, b.state, b.pincode, b.country].filter(Boolean).join(', ') || b.address || '';

/** Maps the server's field errors (path -> message) onto the form's fields. */
export const serverErrors = (details) => Object.fromEntries((details || []).filter((d) => d.path).map((d) => [d.path, d.message]));

/** Which actions a branch's row offers. The default branch cannot be deactivated or deleted. */
export function branchActions(b, canManage) {
  return {
    view: true,
    edit: canManage,
    toggle: canManage && !b.isDefault,
    toggleLabel: b.status === 'active' ? 'Deactivate' : 'Activate',
    remove: canManage && !b.isDefault,
  };
}
