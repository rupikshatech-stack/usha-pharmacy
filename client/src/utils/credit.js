/**
 * Helpers for the credit request form and history. The server checks everything again (the amount, and the screenshot by its real contents); these only
 * give the person an answer before they send, and word things the same way everywhere.
 */
export const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
export const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT = /\.(jpe?g|png|webp)$/i;

/** "₹5", "₹4.50": a rate or amount as rupees, without needless decimals. */
export const rupees = (n) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** The note under the submit button; the rate comes from the server's setting, never from here. */
export const conversionNote = (rate) =>
  `Note: The current conversion rate is 1 Credit = ${rupees(rate)}. The final approved credits will be calculated by the administrator based on your payment amount.`;

/** Why a typed amount cannot be sent, or '' when it can. */
export function amountProblem(text, { max = 1000000 } = {}) {
  const s = String(text ?? '').trim();
  if (!s) return 'Enter the payment amount';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return /^-/.test(s) ? 'The amount cannot be negative' : 'Enter a valid amount (for example 500 or 499.50)';
  const n = Number(s);
  if (n <= 0) return 'The amount must be greater than zero';
  if (n > max) return `The amount cannot be more than ${rupees(max)}`;
  return '';
}

export const fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Why a chosen file cannot be sent, or '' when it can (type by the browser's report or the extension, and size). */
export function fileProblem(file, { maxMB = 5 } = {}) {
  if (!file) return 'Choose the payment screenshot';
  if (!TYPES.includes(file.type) && !EXT.test(file.name || '')) return 'Use a JPG, JPEG, PNG or WEBP image';
  if (file.type && !TYPES.includes(file.type)) return 'Use a JPG, JPEG, PNG or WEBP image';
  if (!file.size) return 'That file is empty';
  if (file.size > maxMB * 1048576) return `Use a file up to ${maxMB} MB (this one is ${fileSize(file.size)})`;
  return '';
}

/** The request as the server wants it: the amount as typed (trimmed), never as a float that could pick up a rounding error. */
export const toAmountText = (text) => String(text ?? '').trim();

export const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger' };
export const STATUS_TEXT = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

/**
 * The same rule the server applies (it alone decides): whole credits, rounded down, in whole paise — ₹500 = 100 credits, ₹499.50 = 99 credits with ₹4.50 left over.
 * Here it only shows what an amount is worth before it is sent or approved.
 */
export function creditsFor(amount, rate) {
  const a = Math.round(Number(amount) * 100);
  const r = Math.round(Number(rate) * 100);
  if (!(a > 0 && r > 0)) return { credits: 0, remainder: 0 };
  const credits = Math.floor(a / r);
  return { credits, remainder: (a - credits * r) / 100 };
}
/** The credits an amount would give (null when there is nothing to estimate). */
export const estimate = (amount, rate) => (Number(rate) > 0 && Number(amount) > 0 ? creditsFor(amount, rate).credits : null);

/** Maps the server's field errors (path -> message) onto the form's fields. */
export const serverErrors = (details) => Object.fromEntries((details || []).filter((d) => d.path).map((d) => [d.path, d.message]));

export const LOG_TEXT = { SUBMITTED: 'Request submitted', APPROVED: 'Approved', REJECTED: 'Rejected' };

/**
 * The browser is told "credits moved" with this event, so the balance in the header updates the moment an approval goes through instead of waiting for the next
 * poll. The number itself always comes from the server.
 */
export const CREDITS_CHANGED = 'usha:credits-changed';
export const announceCreditsChanged = () => window.dispatchEvent(new CustomEvent(CREDITS_CHANGED));

/** "+100" / "−20": a ledger entry's credits, with the sign spelled out. */
export const signedCredits = (n) => (Number(n) < 0 ? `−${Math.abs(Number(n)).toLocaleString('en-IN')}` : `+${Number(n || 0).toLocaleString('en-IN')}`);

/** "100 credits" / "1 credit". */
export const creditWord = (n) => `${Number(n || 0).toLocaleString('en-IN')} credit${Math.abs(Number(n)) === 1 ? '' : 's'}`;

export const TXN_TEXT = { CREDIT_APPROVAL: 'Request approved', MANUAL_ADJUSTMENT: 'Manual adjustment' };
