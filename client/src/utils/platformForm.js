/**
 * The platform onboarding form: its blank state, the checks (the same rules the server applies — it checks
 * again), the request body, and the handover note an operator sends the pharmacy.
 *
 * Only three things are genuinely required — the pharmacy's name and the owner's first name and email — because
 * everything else can be filled in later by the pharmacy itself on its own Settings screens. The operator is
 * usually on the telephone when they fill this in; demanding a GSTIN before the account exists would stall that
 * call for a number nobody has to hand.
 */

export const BUSINESS_CATEGORIES = [
  ['retail', 'Retail pharmacy'],
  ['wholesale', 'Wholesale'],
  ['both', 'Retail and wholesale'],
  ['hospital', 'Hospital pharmacy'],
];

export const blankOrganization = () => ({
  name: '',
  businessCategory: 'retail',
  phone: '',
  address: { line1: '', city: '', state: '', pincode: '' },
  owner: { firstName: '', lastName: '', email: '', phone: '' },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Reads a dotted path out of the form ("owner.email"), exactly as typed. The server's field errors use the same
 * paths, so one spelling addresses the field, its error and its value.
 *
 * It does NOT trim: this is what a text box is given back every keystroke, and trimming here would eat the space
 * between a first and second word as it was typed. The checks and the request body trim for themselves.
 */
export const at = (f, path) => String(path.split('.').reduce((o, k) => (o == null ? o : o[k]), f) ?? '');

/** Writes a dotted path without mutating the form. */
export function put(f, path, value) {
  const [head, leaf] = path.split('.');
  return leaf ? { ...f, [head]: { ...f[head], [leaf]: value } } : { ...f, [head]: value };
}

const phoneProblem = (v) => {
  const digits = v.replace(/\D/g, '');
  return /^\+?[\d\s\-()]{7,20}$/.test(v) && digits.length >= 7 && digits.length <= 15 ? '' : 'Enter a valid phone number (7 to 15 digits)';
};

/** { 'dotted.path': message } for everything that cannot be sent. Empty = fine. */
export function validateOrganization(f) {
  const e = {};
  const t = (p) => at(f, p).trim();

  if (!t('name')) e.name = 'The pharmacy needs a name';
  else if (t('name').length < 2) e.name = 'Give the pharmacy a name of at least 2 characters';
  else if (t('name').length > 150) e.name = 'The name must be 150 characters or fewer';

  if (!t('owner.firstName')) e['owner.firstName'] = "The owner's first name is required";
  else if (t('owner.firstName').length > 60) e['owner.firstName'] = 'First name must be 60 characters or fewer';
  if (t('owner.lastName').length > 60) e['owner.lastName'] = 'Last name must be 60 characters or fewer';

  if (!t('owner.email')) e['owner.email'] = 'The owner needs an email address — it is how they sign in';
  else if (!EMAIL.test(t('owner.email'))) e['owner.email'] = 'Enter a valid email address for the owner';
  else if (t('owner.email').length > 150) e['owner.email'] = 'That email address is too long';

  for (const p of ['phone', 'owner.phone']) {
    const problem = t(p) ? phoneProblem(t(p)) : '';
    if (problem) e[p] = problem;
  }

  // Same rule the pharmacy's own Settings screen applies, so an address typed here passes there too.
  if (t('address.pincode') && !/^[1-9]\d{5}$/.test(t('address.pincode'))) {
    e['address.pincode'] = 'A PIN code is 6 digits and cannot start with 0';
  }
  for (const [p, max, label] of [
    ['address.line1', 200, 'The address'],
    ['address.city', 80, 'The city'],
    ['address.state', 80, 'The state'],
  ]) {
    if (t(p).length > max) e[p] = `${label} must be ${max} characters or fewer`;
  }

  return e;
}

/**
 * The request body: trimmed, and with the empty optional parts left out rather than sent as "".
 *
 * An omitted field and an empty one mean different things to the pharmacy afterwards — one was never asked, the
 * other was answered with nothing — and sending "" would write blanks over the defaults the organization model
 * sets for itself.
 */
export function toBody(f) {
  const t = (p) => at(f, p).trim();
  const body = {
    name: t('name'),
    businessCategory: f.businessCategory || 'retail',
    owner: { firstName: t('owner.firstName'), email: t('owner.email').toLowerCase() },
  };
  if (t('phone')) body.phone = t('phone');
  if (t('owner.lastName')) body.owner.lastName = t('owner.lastName');
  if (t('owner.phone')) body.owner.phone = t('owner.phone');

  const address = {};
  for (const k of ['line1', 'city', 'state', 'pincode']) {
    if (t(`address.${k}`)) address[k] = t(`address.${k}`);
  }
  if (Object.keys(address).length) body.address = address;
  return body;
}

/** Maps the server's field errors (path -> message) onto the form's fields. */
export const serverErrors = (details) => Object.fromEntries((details || []).filter((d) => d?.path).map((d) => [d.path, d.message]));

/**
 * The note the operator passes to the pharmacy. Built here, and tested, because it carries the one copy of a
 * password that exists anywhere: if this string is wrong, the credential is lost and somebody has to reset it.
 */
export const handoverText = ({ organization, administrator, temporaryPassword, signInUrl }) =>
  [
    `Pharmacy: ${organization.name}`,
    `Sign in at: ${signInUrl}`,
    `Email: ${administrator.email}`,
    `Temporary password: ${temporaryPassword}`,
    '',
    'You will be asked to choose your own password the first time you sign in.',
  ].join('\n');
