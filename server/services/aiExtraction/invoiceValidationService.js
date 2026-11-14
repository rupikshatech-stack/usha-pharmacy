/**
 * Checking an extracted invoice. Pure and deterministic: no database, no AI. It RE-CALCULATES the money from the extracted figures (in whole paise, like
 * the rest of the system), compares the result with what the invoice itself says, and reports every difference with both numbers. It never changes an
 * extracted value: the invoice's own figures stay exactly as read, and the calculated ones are returned beside them (`computed`).
 *
 * Each issue: { severity: 'error' | 'warning' | 'info', code, path, message, expected?, actual?, difference? }
 *   error   – the invoice cannot be trusted or used until a person fixes or accepts it (missing invoice number, impossible dates, totals that do not add up…)
 *   warning – worth checking (missing batch, rate above MRP, an unusual GST rate…)
 *   info    – context only
 * `path` points at the field (items.2.lineTotal, totals.grandTotal) so the screen can highlight it.
 *
 * Suppliers differ (discount before or after tax, line amounts with or without tax, rounding), so a difference is never "corrected": it is shown, and a
 * person decides. A line amount is accepted if it matches either the taxable value or the tax-inclusive value.
 */
const TOL = 100; // one rupee, in paise: rounding differences smaller than this are not worth a warning
export const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 6, 7.5, 12, 14, 18, 28, 40];
const GSTIN = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const STATE_CODES = new Set([...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, '0')), '97', '99']);

const paise = (v) => (v === null || v === undefined ? null : Math.round(v * 100));
const rupees = (p) => (p === null ? null : p / 100);
const has = (v) => v !== null && v !== undefined;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const inr = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function validateExtraction(data, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const issues = [];
  const add = (severity, code, path, message, extra = {}) => issues.push({ severity, code, path, message, ...extra });
  const mismatch = (code, path, label, expectedP, actualP) =>
    add('error', code, path, `${label}: the invoice says ${inr(actualP)} but the figures add up to ${inr(expectedP)} (difference ${inr(Math.abs(actualP - expectedP))}).`, { expected: rupees(expectedP), actual: rupees(actualP), difference: rupees(actualP - expectedP) });

  const { supplier = {}, invoice = {}, items = [], totals = {} } = data;

  /* supplier */
  if (!supplier.name) add('error', 'SUPPLIER_NAME_MISSING', 'supplier.name', 'The supplier’s name was not found.');
  if (supplier.gstin) {
    const g = supplier.gstin.replace(/\s/g, '').toUpperCase();
    const m = GSTIN.exec(g);
    if (!m) add('error', 'GSTIN_INVALID', 'supplier.gstin', `The supplier’s GSTIN “${supplier.gstin}” is not in the 15-character GSTIN format.`);
    else if (!STATE_CODES.has(m[1])) add('warning', 'GSTIN_STATE_UNKNOWN', 'supplier.gstin', `The GSTIN starts with ${m[1]}, which is not a GST state code.`);
    else if (supplier.stateCode && supplier.stateCode !== m[1]) add('warning', 'STATE_CODE_MISMATCH', 'supplier.stateCode', `The state code ${supplier.stateCode} differs from the one in the GSTIN (${m[1]}).`);
  } else {
    add('warning', 'GSTIN_MISSING', 'supplier.gstin', 'The supplier’s GSTIN was not found.');
  }

  /* invoice */
  if (!invoice.invoiceNumber) add('error', 'INVOICE_NUMBER_MISSING', 'invoice.invoiceNumber', 'The invoice number was not found.');
  if (!invoice.invoiceDate) add('error', 'INVOICE_DATE_MISSING', 'invoice.invoiceDate', 'The invoice date was not found.');
  else if (invoice.invoiceDate > today) add('warning', 'INVOICE_DATE_FUTURE', 'invoice.invoiceDate', `The invoice date ${invoice.invoiceDate} is in the future.`);
  if (invoice.dueDate && invoice.invoiceDate && invoice.dueDate < invoice.invoiceDate) add('warning', 'DUE_BEFORE_INVOICE', 'invoice.dueDate', 'The due date is before the invoice date.');
  if (!items.length) add('error', 'NO_ITEMS', 'items', 'No medicine rows were found.');

  /* lines */
  const lines = items.map((it, i) => {
    const p = (f) => `items.${i}.${f}`;
    const n = i + 1;
    if (!it.medicineName && !it.description) add('error', 'ITEM_NAME_MISSING', p('medicineName'), `Line ${n} has no medicine name.`);
    if (!has(it.quantity) && !has(it.freeQuantity)) add('error', 'QUANTITY_MISSING', p('quantity'), `Line ${n} has no quantity.`);
    else if (has(it.quantity) && it.quantity === 0 && !(it.freeQuantity > 0)) add('warning', 'QUANTITY_ZERO', p('quantity'), `Line ${n} has a quantity of 0.`);
    if (has(it.quantity) && !Number.isInteger(it.quantity)) add('warning', 'QUANTITY_FRACTIONAL', p('quantity'), `Line ${n}: quantity ${it.quantity} is not a whole number.`);
    if (!has(it.purchaseRate)) add('warning', 'RATE_MISSING', p('purchaseRate'), `Line ${n} has no purchase rate.`);
    if (has(it.purchaseRate) && has(it.mrp) && it.purchaseRate > it.mrp) add('warning', 'RATE_ABOVE_MRP', p('purchaseRate'), `Line ${n}: the purchase rate ${it.purchaseRate} is above the MRP ${it.mrp} (the two columns may be swapped).`);
    if (!it.batchNumber) add('warning', 'BATCH_MISSING', p('batchNumber'), `Line ${n} has no batch number. It is not filled in for you.`);
    if (!it.expiryDate) add('warning', 'EXPIRY_MISSING', p('expiryDate'), `Line ${n} has no expiry date. It is not filled in for you.`);
    else if (it.expiryDate < today) add('warning', 'EXPIRED', p('expiryDate'), `Line ${n}: the expiry date ${it.expiryDate} has already passed.`);
    if (it.expiryDate && it.manufacturingDate && it.expiryDate <= it.manufacturingDate) add('error', 'EXPIRY_BEFORE_MFG', p('expiryDate'), `Line ${n}: the expiry date is not after the manufacturing date.`);
    if (it.hsnCode && !/^\d{4}(\d{2}(\d{2})?)?$/.test(it.hsnCode.replace(/\s/g, ''))) add('warning', 'HSN_FORMAT', p('hsnCode'), `Line ${n}: HSN “${it.hsnCode}” is not 4, 6 or 8 digits.`);
    if (has(it.gstPercentage) && !GST_RATES.includes(it.gstPercentage)) add('warning', 'GST_RATE_UNUSUAL', p('gstPercentage'), `Line ${n}: ${it.gstPercentage}% is not a standard GST rate.`);

    const qty = it.quantity;
    const rate = it.purchaseRate;
    const gross = has(qty) && has(rate) ? Math.round(qty * rate * 100) : null;
    let discount = null;
    if (has(it.discountAmount)) discount = paise(it.discountAmount);
    else if (gross !== null && has(it.discountPercentage)) discount = Math.round((gross * it.discountPercentage) / 100);
    if (has(it.discountAmount) && has(it.discountPercentage) && gross !== null) {
      const fromPct = Math.round((gross * it.discountPercentage) / 100);
      if (Math.abs(fromPct - paise(it.discountAmount)) > TOL) add('warning', 'DISCOUNT_MISMATCH', p('discountAmount'), `Line ${n}: ${it.discountPercentage}% of ${inr(gross)} is ${inr(fromPct)} but the discount shown is ${inr(paise(it.discountAmount))}.`, { expected: rupees(fromPct), actual: it.discountAmount });
    }
    if (discount !== null && gross !== null && discount > gross) add('error', 'DISCOUNT_ABOVE_VALUE', p('discountAmount'), `Line ${n}: the discount is more than the value of the goods.`);
    const taxableCalc = gross !== null ? gross - (discount ?? 0) : null;
    const taxableStated = paise(it.taxableAmount);
    if (taxableStated !== null && taxableCalc !== null && Math.abs(taxableStated - taxableCalc) > TOL) mismatch('LINE_TAXABLE_MISMATCH', p('taxableAmount'), `Line ${n} taxable amount`, taxableCalc, taxableStated);
    const base = taxableStated ?? taxableCalc;
    const statedTaxParts = ['cgst', 'sgst', 'igst'].filter((k) => has(it[k]));
    const statedTax = statedTaxParts.length ? sum(statedTaxParts.map((k) => paise(it[k]))) : null;
    const taxCalc = base !== null && has(it.gstPercentage) ? Math.round((base * it.gstPercentage) / 100) : null;
    if (statedTax !== null && taxCalc !== null && Math.abs(statedTax - taxCalc) > TOL) mismatch('LINE_TAX_MISMATCH', p('cgst'), `Line ${n} GST`, taxCalc, statedTax);
    if (has(it.cgst) && has(it.sgst) && Math.abs(paise(it.cgst) - paise(it.sgst)) > TOL / 2) add('warning', 'CGST_SGST_DIFFER', p('sgst'), `Line ${n}: CGST (${it.cgst}) and SGST (${it.sgst}) are normally equal.`);
    const tax = statedTax ?? taxCalc;
    const totalCalc = base !== null ? base + (tax ?? 0) : null;
    const totalStated = paise(it.lineTotal);
    if (totalStated !== null && totalCalc !== null && Math.abs(totalStated - totalCalc) > TOL && Math.abs(totalStated - base) > TOL) mismatch('LINE_TOTAL_MISMATCH', p('lineTotal'), `Line ${n} total`, totalCalc, totalStated);
    return { index: i, gross, discount, taxable: base, tax, total: totalStated ?? totalCalc, taxableCalculated: taxableCalc, taxCalculated: taxCalc, totalCalculated: totalCalc };
  });

  /* totals */
  const known = (k) => lines.map((l) => l[k]).filter((v) => v !== null);
  const sums = {
    gross: known('gross').length ? sum(known('gross')) : null,
    discount: lines.some((l) => l.discount !== null) ? sum(known('discount')) : null,
    taxable: known('taxable').length ? sum(known('taxable')) : null,
    tax: known('tax').length ? sum(known('tax')) : null,
    lineTotal: known('total').length ? sum(known('total')) : null,
    cgst: items.some((i) => has(i.cgst)) ? sum(items.map((i) => paise(i.cgst) ?? 0)) : null,
    sgst: items.some((i) => has(i.sgst)) ? sum(items.map((i) => paise(i.sgst) ?? 0)) : null,
    igst: items.some((i) => has(i.igst)) ? sum(items.map((i) => paise(i.igst) ?? 0)) : null,
  };
  const T = Object.fromEntries(Object.keys(totals).map((k) => [k, paise(totals[k])]));
  if (sums.taxable !== null && T.taxableAmount != null && Math.abs(T.taxableAmount - sums.taxable) > TOL * Math.max(1, Math.ceil(items.length / 10))) mismatch('TAXABLE_TOTAL_MISMATCH', 'totals.taxableAmount', 'Total taxable amount', sums.taxable, T.taxableAmount);
  for (const k of ['cgst', 'sgst', 'igst']) {
    if (sums[k] !== null && T[k] != null && Math.abs(T[k] - sums[k]) > TOL * Math.max(1, Math.ceil(items.length / 10))) mismatch(`${k.toUpperCase()}_TOTAL_MISMATCH`, `totals.${k}`, `Total ${k.toUpperCase()}`, sums[k], T[k]);
  }
  if (T.subtotal != null && sums.gross !== null && ![sums.gross, sums.taxable, sums.lineTotal].some((v) => v !== null && Math.abs(v - T.subtotal) <= TOL * Math.max(1, Math.ceil(items.length / 10)))) {
    mismatch('SUBTOTAL_MISMATCH', 'totals.subtotal', 'Subtotal', sums.gross, T.subtotal);
  }
  if (T.discount != null && sums.discount !== null && Math.abs(T.discount - sums.discount) > TOL) {
    add('info', 'DISCOUNT_TOTAL_DIFFERS', 'totals.discount', `The line discounts add up to ${inr(sums.discount)} but the invoice shows a total discount of ${inr(T.discount)} (it may include an invoice-level discount).`, { expected: rupees(sums.discount), actual: rupees(T.discount), difference: rupees(T.discount - sums.discount) });
  }
  if (has(totals.roundOff) && Math.abs(totals.roundOff) > 1) add('warning', 'ROUND_OFF_LARGE', 'totals.roundOff', `The round off ${totals.roundOff} is larger than ₹1.`);
  if (has(totals.cgst) !== has(totals.sgst) && (has(totals.cgst) || has(totals.sgst))) add('warning', 'CGST_SGST_ONE_SIDED', 'totals.sgst', 'Only one of CGST and SGST was found in the totals.');
  if ((has(totals.igst) && totals.igst > 0) && ((has(totals.cgst) && totals.cgst > 0) || (has(totals.sgst) && totals.sgst > 0))) add('warning', 'IGST_WITH_CGST', 'totals.igst', 'IGST and CGST/SGST are both charged on the same invoice, which is unusual.');

  const taxableBase = T.taxableAmount ?? sums.taxable;
  const taxTotal = ['cgst', 'sgst', 'igst'].some((k) => T[k] != null) ? sum(['cgst', 'sgst', 'igst'].map((k) => T[k] ?? 0)) : sums.tax;
  const extras = sum([T.otherCharges, T.shippingCharges, T.packagingCharges, T.roundOff].map((v) => v ?? 0));
  const calcGrand = taxableBase !== null ? taxableBase + (taxTotal ?? 0) + extras : null;
  const calcGrandFromLines = sums.lineTotal !== null ? sums.lineTotal + extras : null;
  const slack = TOL * Math.max(1, Math.ceil(items.length / 10));
  if (T.grandTotal == null) add('warning', 'GRAND_TOTAL_MISSING', 'totals.grandTotal', 'The invoice grand total was not found.');
  else {
    const candidates = [calcGrand, calcGrandFromLines].filter((v) => v !== null);
    if (candidates.length && !candidates.some((v) => Math.abs(v - T.grandTotal) <= slack)) mismatch('GRAND_TOTAL_MISMATCH', 'totals.grandTotal', 'Grand total', candidates[0], T.grandTotal);
  }
  if (T.balanceDue != null && T.grandTotal != null && T.amountPaid != null && Math.abs(T.grandTotal - T.amountPaid - T.balanceDue) > TOL) {
    add('warning', 'BALANCE_MISMATCH', 'totals.balanceDue', `Grand total ${inr(T.grandTotal)} less paid ${inr(T.amountPaid)} is ${inr(T.grandTotal - T.amountPaid)} but the balance due shown is ${inr(T.balanceDue)}.`, { expected: rupees(T.grandTotal - T.amountPaid), actual: rupees(T.balanceDue) });
  }

  const count = (s) => issues.filter((i) => i.severity === s).length;
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    issues,
    summary: { errors: count('error'), warnings: count('warning'), info: count('info') },
    requiresReview: count('error') + count('warning') > 0,
    computed: {
      lines: lines.map((l) => ({ index: l.index, gross: rupees(l.gross), discount: rupees(l.discount), taxable: rupees(l.taxable), tax: rupees(l.tax), total: rupees(l.total) })),
      sums: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, rupees(v)])),
      grandTotal: rupees(calcGrand ?? calcGrandFromLines),
    },
  };
}

/** Which fields have issues, for highlighting: { 'items.2.lineTotal': 'error', … } (the most severe wins). */
export function issueMap(issues) {
  const rank = { error: 0, warning: 1, info: 2 };
  const out = {};
  for (const i of issues) if (i.path && (out[i.path] === undefined || rank[i.severity] < rank[out[i.path]])) out[i.path] = i.severity;
  return out;
}
