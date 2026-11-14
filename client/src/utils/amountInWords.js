/**
 * An amount in words, the Indian way: lakh and crore, not million and billion.
 *
 * An invoice prints the amount twice — in figures and in words — because the words are the version that cannot be
 * altered by adding a digit. So this has to be exact: "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees
 * and Seventy Eight Paise Only", never a rounded approximation of it.
 *
 * Paise are carried through to the word, because a bill for ₹99.50 that says "Ninety Nine Rupees Only" is wrong by
 * fifty paise and unsignable.
 */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0-99 in words. */
const twoDigits = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);

/** 0-999 in words. */
const threeDigits = (n) => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
};

/** A whole number in words, grouped the Indian way: crore, lakh, thousand, then the last three digits. */
export function numberToWords(value) {
  const n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${numberToWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/**
 * The full line an invoice prints, paise included.
 * @param {number} amount rupees, with paise after the decimal point
 */
export function amountInWords(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  const negative = value < 0;
  // Rounded to the paisa first: 99.999 is a hundred rupees to anybody paying it.
  const paise = Math.round(Math.abs(value) * 100);
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;

  const words = [
    negative ? 'Minus' : '',
    numberToWords(rupees),
    rupees === 1 ? 'Rupee' : 'Rupees',
    fraction ? `and ${twoDigits(fraction)} ${fraction === 1 ? 'Paisa' : 'Paise'}` : '',
    'Only',
  ]
    .filter(Boolean)
    .join(' ');
  return words;
}
