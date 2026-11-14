/**
 * Indian tax and bank identifiers: the rules that decide whether a number somebody typed can possibly be real.
 *
 * None of this talks to a government service. Every check here is ARITHMETIC or a lookup table, which means it can
 * only ever prove a number is WRONG — it can never prove the number belongs to the person typing it. A GSTIN that
 * passes every check here may still be somebody else's, or cancelled. The screens say so rather than showing a green
 * tick that implies a verification nobody performed.
 */

/** The GST state codes, which are the first two digits of every GSTIN. Source: the GST state code list. */
export const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  10: 'Bihar',
  11: 'Sikkim',
  12: 'Arunachal Pradesh',
  13: 'Nagaland',
  14: 'Manipur',
  15: 'Mizoram',
  16: 'Tripura',
  17: 'Meghalaya',
  18: 'Assam',
  19: 'West Bengal',
  20: 'Jharkhand',
  21: 'Odisha',
  22: 'Chhattisgarh',
  23: 'Madhya Pradesh',
  24: 'Gujarat',
  25: 'Daman and Diu',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra',
  28: 'Andhra Pradesh (before division)',
  29: 'Karnataka',
  30: 'Goa',
  31: 'Lakshadweep',
  32: 'Kerala',
  33: 'Tamil Nadu',
  34: 'Puducherry',
  35: 'Andaman and Nicobar Islands',
  36: 'Telangana',
  37: 'Andhra Pradesh',
  38: 'Ladakh',
  97: 'Other Territory',
  99: 'Centre Jurisdiction',
};

/** The states and union territories a pharmacy can be registered in, with the GST code each one uses. */
export const INDIAN_STATES = [
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '18', name: 'Assam' },
  { code: '10', name: 'Bihar' },
  { code: '04', name: 'Chandigarh' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '07', name: 'Delhi' },
  { code: '30', name: 'Goa' },
  { code: '24', name: 'Gujarat' },
  { code: '06', name: 'Haryana' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '20', name: 'Jharkhand' },
  { code: '29', name: 'Karnataka' },
  { code: '32', name: 'Kerala' },
  { code: '38', name: 'Ladakh' },
  { code: '31', name: 'Lakshadweep' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '27', name: 'Maharashtra' },
  { code: '14', name: 'Manipur' },
  { code: '17', name: 'Meghalaya' },
  { code: '15', name: 'Mizoram' },
  { code: '13', name: 'Nagaland' },
  { code: '21', name: 'Odisha' },
  { code: '34', name: 'Puducherry' },
  { code: '03', name: 'Punjab' },
  { code: '08', name: 'Rajasthan' },
  { code: '11', name: 'Sikkim' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '36', name: 'Telangana' },
  { code: '16', name: 'Tripura' },
  { code: '05', name: 'Uttarakhand' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '19', name: 'West Bengal' },
];

export const STATE_NAMES = INDIAN_STATES.map((s) => s.name);
const CODE_BY_STATE = new Map(INDIAN_STATES.map((s) => [s.name.toLowerCase(), s.code]));

/** The GST code for a state name, or null when the name is not one we know. */
export const gstCodeForState = (state) => CODE_BY_STATE.get(String(state || '').trim().toLowerCase()) || null;

export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PIN_PATTERN = /^[1-9]\d{5}$/;
/** An Indian mobile number: ten digits starting 6-9, however the person spaced or prefixed it. */
export const MOBILE_PATTERN = /^[6-9]\d{9}$/;
export const FSSAI_PATTERN = /^\d{14}$/;
export const CIN_PATTERN = /^[LUu]\d{5}[A-Za-z]{2}\d{4}[A-Za-z]{3}\d{6}$/;
export const UPI_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The fifteenth character of a GSTIN is a check digit over the first fourteen. Each character is worth its position
 * in 0-9A-Z, multiplied by 1 or 2 alternately; the quotient and remainder of that product over 36 are both added in,
 * and the check digit is whatever brings the total to a multiple of 36.
 *
 * This catches a mistyped or invented GSTIN. It cannot tell you the GSTIN is REGISTERED, or that it belongs to this
 * business — only the GST portal can say that.
 */
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

/** Whether a GSTIN is well formed AND its check digit agrees with the other fourteen characters. */
export function isValidGstin(gstin) {
  const s = String(gstin || '').toUpperCase().trim();
  if (!GSTIN_PATTERN.test(s)) return false;
  return gstinCheckDigit(s.slice(0, 14)) === s[14];
}

/** The state code a GSTIN was issued under — its first two digits — or null if there is no GSTIN. */
export const stateCodeOfGstin = (gstin) => {
  const s = String(gstin || '').trim();
  return s.length >= 2 && /^\d{2}$/.test(s.slice(0, 2)) ? s.slice(0, 2) : null;
};

/**
 * The PAN inside a GSTIN: characters 3 to 12. It is not a separate thing somebody types — it is already in the
 * GSTIN, so the form shows it rather than asking for it again and letting the two disagree.
 */
export function panFromGstin(gstin) {
  const s = String(gstin || '').toUpperCase().trim();
  if (s.length < 12) return null;
  const pan = s.slice(2, 12);
  return PAN_PATTERN.test(pan) ? pan : null;
}

/**
 * What is wrong with a GSTIN, told apart by severity:
 *   error   — it cannot be a GSTIN at all (wrong shape, or the check digit disagrees)
 *   warning — it is a valid GSTIN, but issued in a different state from the address on this profile. That happens
 *             legitimately (a business registered in one state operating from another), so it is said out loud and
 *             not blocked.
 */
export function inspectGstin(gstin, state) {
  const s = String(gstin || '').toUpperCase().trim();
  if (!s) return { ok: true, pan: null, stateCode: null, warning: null };
  if (!GSTIN_PATTERN.test(s)) return { ok: false, error: 'A GSTIN is 15 characters: two digits, five letters, four digits, a letter, a digit or letter, "Z", and a check character.' };
  if (gstinCheckDigit(s.slice(0, 14)) !== s[14]) {
    return { ok: false, error: 'That GSTIN’s check character does not match the rest of it, so at least one character is mistyped.' };
  }
  const stateCode = stateCodeOfGstin(s);
  const expected = gstCodeForState(state);
  const knownState = GST_STATE_CODES[stateCode] || GST_STATE_CODES[String(Number(stateCode))];
  const warning =
    expected && stateCode !== expected
      ? `This GSTIN was issued in ${knownState || `state code ${stateCode}`}, but the address says ${state}. That is allowed, but check it is the registration you mean to invoice under.`
      : !knownState
        ? `State code ${stateCode} is not a GST state code we recognise.`
        : null;
  return { ok: true, pan: panFromGstin(s), stateCode, stateName: knownState || null, warning };
}

/** The bank branch code inside an IFSC — the last six characters. The first four are the bank. */
export const bankFromIfsc = (ifsc) => (IFSC_PATTERN.test(String(ifsc || '').toUpperCase()) ? String(ifsc).toUpperCase().slice(0, 4) : null);

/** Ten digits starting 6-9, taken out of whatever the person typed (+91, spaces, dashes, brackets). */
export function normaliseMobile(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const ten = digits.length > 10 && digits.startsWith('91') ? digits.slice(-10) : digits.length > 10 ? digits.slice(-10) : digits;
  return MOBILE_PATTERN.test(ten) ? ten : null;
}

/** An account number is kept whole but shown as the last four digits, which is all anyone needs to recognise it. */
export const maskAccountNumber = (acc) => {
  const s = String(acc || '').trim();
  if (!s) return '';
  return s.length <= 4 ? '•'.repeat(s.length) : `${'•'.repeat(Math.min(s.length - 4, 12))}${s.slice(-4)}`;
};
