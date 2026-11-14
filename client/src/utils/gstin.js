/**
 * The GSTIN check digit, so the form can say "that is mistyped" while somebody is still looking at the field.
 *
 * THE SERVER IS THE AUTHORITY. It runs exactly this check again on save (server/utils/indianTax.js) and refuses
 * what it does not like; this copy exists only so the person finds out in the field instead of after pressing
 * Save. If the two ever disagree, the server is right.
 */
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The character a GSTIN's first fourteen say the fifteenth must be, or null if those fourteen are not valid. */
export function gstinCheckDigit(first14) {
  const s = String(first14 || '').toUpperCase();
  if (s.length < 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARS.indexOf(s[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function isValidGstin(gstin) {
  const s = String(gstin || '').toUpperCase().trim();
  return GSTIN_PATTERN.test(s) && gstinCheckDigit(s.slice(0, 14)) === s[14];
}

/** The PAN inside a GSTIN — characters 3 to 12. Shown read-only, never typed, so the two cannot disagree. */
export function panFromGstin(gstin) {
  const s = String(gstin || '').toUpperCase().trim();
  if (s.length < 12) return '';
  const pan = s.slice(2, 12);
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : '';
}

/** The state code a GSTIN was issued under: its first two digits. */
export const stateCodeOfGstin = (gstin) => {
  const s = String(gstin || '').trim();
  return /^\d{2}/.test(s) ? s.slice(0, 2) : null;
};
