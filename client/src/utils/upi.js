/**
 * The UPI payment link printed on an invoice as a QR code.
 *
 * A QR code on a bill is an instruction to pay a specific person a specific amount, so the one thing it must never
 * do is appear when any part of that is wrong. This builder returns `null` — meaning "print no QR at all" — rather
 * than a link that is missing a payee or asks for ₹0:
 *
 *   * no UPI ID saved            → nothing to pay into
 *   * the QR toggle is off       → the organization has said not to print it
 *   * the amount is zero or less → a QR for nothing is a confusing thing to hand somebody
 *   * a credit note              → money is going back TO the customer; a "pay us" QR would be exactly backwards
 *
 * Nothing is stored: the link is built from the invoice and the settings at the moment of printing, so a changed
 * UPI ID can never leave an old QR pointing at an account the business no longer uses.
 *
 * Every value is URL-encoded. A payee name with an `&` in it would otherwise end the parameter early and the
 * scanner would read a different amount than the one printed beside it.
 */
export function upiPaymentUri({ upiId, payeeName, amount, note, enabled = true, isCreditNote = false } = {}) {
  const pa = String(upiId || '').trim();
  const value = Number(amount);
  if (!enabled || !pa || isCreditNote) return null;
  if (!Number.isFinite(value) || value <= 0) return null;

  const params = [
    ['pa', pa],
    ['pn', String(payeeName || '').trim()],
    // UPI amounts are rupees with two decimals. 1234.5 and 1234.50 are the same money, but only one of them is
    // what a payment app expects to parse.
    ['am', value.toFixed(2)],
    ['cu', 'INR'],
    ['tn', String(note || '').trim()],
  ].filter(([, v]) => v !== '');

  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
