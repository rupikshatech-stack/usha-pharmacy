// The arithmetic and rules of the "Add Order" form. The server computes and checks everything again; this only lets people see the numbers
// and the problems as they type. computeOrder is the same function as the server's (server/utils/orderMath.js) and is tested with the same figures.

const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
const basis = (percent) => Math.round(Number(percent || 0) * 100);
const pct = (amountP, percent) => Math.round((amountP * basis(percent)) / 10000);
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));

/** Lines: { quantity, freeQuantity, rate, discountPercent, gstPercent }. Charges: { shipping, packaging, other, additionalDiscount, gstPercent }. All in rupees. */
export function computeOrder({ items = [], charges = {}, advance = 0 }) {
  const lines = items.map((it) => {
    const gross = Math.round(num(it.quantity)) * paise(it.rate);
    const discount = pct(gross, it.discountPercent);
    const taxable = gross - discount;
    const gst = pct(taxable, it.gstPercent);
    return { gross, discount, gst, total: taxable + gst };
  });
  const sum = (k) => lines.reduce((n, l) => n + l[k], 0);
  const subtotal = sum('gross');
  const discount = sum('discount');
  const gst = sum('gst');
  const itemsTotal = subtotal - discount + gst;
  const shipping = paise(charges.shipping);
  const packaging = paise(charges.packaging);
  const other = paise(charges.other);
  const chargesTotal = shipping + packaging + other;
  const chargesGst = pct(chargesTotal, charges.gstPercent);
  const additionalDiscount = paise(charges.additionalDiscount);
  const before = itemsTotal + chargesTotal + chargesGst;
  const grandTotal = before - additionalDiscount;
  const advanceP = paise(advance);
  const r = (p) => p / 100;
  return {
    lines: lines.map((l) => ({ amount: r(l.gross), discountAmount: r(l.discount), gstAmount: r(l.gst), total: r(l.total) })),
    totalItems: items.length,
    totalQuantity: items.reduce((n, it) => n + Math.round(num(it.quantity)), 0),
    totalFreeQuantity: items.reduce((n, it) => n + Math.round(num(it.freeQuantity)), 0),
    subtotal: r(subtotal),
    discount: r(discount),
    gst: r(gst),
    itemsTotal: r(itemsTotal),
    chargesTotal: r(chargesTotal),
    chargesGst: r(chargesGst),
    additionalDiscount: r(additionalDiscount),
    beforeAdditionalDiscount: r(before),
    grandTotal: r(grandTotal),
    advance: r(advanceP),
    remaining: r(grandTotal - advanceP),
    paymentStatus: advanceP <= 0 ? 'unpaid' : advanceP >= grandTotal ? 'paid' : 'partially_paid',
  };
}

export const PAYMENT_STATUS_LABEL = { unpaid: 'Unpaid', partially_paid: 'Partially Paid', paid: 'Paid' };

/** A new order line from a product the search returned. The rate starts at the last purchase price and the GST at the product's own rate. */
export const lineFromProduct = (p) => ({
  key: p._id,
  product: p,
  quantity: '1',
  freeQuantity: '0',
  rate: p.purchasePrice > 0 ? String(p.purchasePrice) : '',
  discountPercent: '0',
  gstPercent: String(p.gstPercent ?? 12),
});

export const blankCharges = () => ({ shipping: '', packaging: '', other: '', additionalDiscount: '', gstPercent: '0' });
export const blankPayment = () => ({ terms: 'credit', method: '', advance: '' });



/**
 * An order's payment terms as this supplier normally trades. The two vocabularies are not the same: a supplier is kept on advance / cash on delivery /
 * 7–45 days / custom, while an order is paid cod / advance / credit / partial — so any number of days means this order is on credit. Returns null when the
 * supplier says nothing, and the caller only ever uses it as a starting point that the person can change.
 */
export function supplierOrderTerms(supplier) {
  const terms = supplier?.procurement?.paymentTerms;
  if (!terms) return null;
  if (terms === 'advance') return 'advance';
  if (terms === 'cod') return 'cod';
  return 'credit'; // net7 / net15 / net30 / net45 / custom
}

/** "Sun Pharma is normally paid: 30 days (30 days credit)" — what the hint under the terms says. */
export const supplierTermsNote = (supplier) =>
  supplier?.paymentTermsLabel ? `${supplier.name} is normally paid: ${supplier.paymentTermsLabel}${supplier.creditDays ? ` (${supplier.creditDays} days credit)` : ''}.` : '';

/** What the arithmetic needs from the form's text boxes. */
export const toCalcInput = ({ lines, charges, payment }) => ({
  items: lines.map((l) => ({ quantity: num(l.quantity), freeQuantity: num(l.freeQuantity), rate: num(l.rate), discountPercent: num(l.discountPercent), gstPercent: num(l.gstPercent) })),
  charges: { shipping: num(charges.shipping), packaging: num(charges.packaging), other: num(charges.other), additionalDiscount: num(charges.additionalDiscount), gstPercent: num(charges.gstPercent) },
  advance: num(payment.advance),
});

const isMoney = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());
const isPercent = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim()) && Number(v) <= 100;
const isWhole = (v) => /^\d+$/.test(String(v).trim());
const rs = (n) => `₹${n.toFixed(2)}`;

/** { field: message } — empty means the form can be sent. Fields: supplierId, expectedDate, lines, line.<key>.<field>, charges.<field>, payment.<field>. */
export function validateOrder({ supplierId, orderDate, expectedDate, lines, charges, payment, notes = '', referenceNo = '' }) {
  const e = {};
  if (!supplierId) e.supplierId = 'Choose a supplier.';
  if (expectedDate && orderDate && expectedDate < orderDate) e.expectedDate = 'The expected delivery date cannot be before the order date.';
  if (referenceNo.length > 60) e.referenceNo = 'Use 60 characters or fewer.';
  if (notes.length > 500) e.notes = 'Use 500 characters or fewer.';
  if (!lines.length) e.lines = 'Add at least one product.';
  for (const l of lines) {
    const k = `line.${l.key}`;
    if (!isWhole(l.quantity) || Number(l.quantity) < 1) e[`${k}.quantity`] = String(l.quantity).trim() === '' ? 'Enter a quantity.' : /^-/.test(String(l.quantity)) || Number(l.quantity) < 1 ? 'Order at least 1 unit.' : 'Use a whole number.';
    if (!isWhole(l.freeQuantity) || Number(l.freeQuantity) < 0) e[`${k}.freeQuantity`] = /^-/.test(String(l.freeQuantity)) ? 'Cannot be negative.' : 'Use a whole number.';
    if (!isMoney(l.rate)) e[`${k}.rate`] = String(l.rate).trim() === '' ? 'Enter the purchase rate.' : /^-/.test(String(l.rate)) ? 'The rate cannot be negative.' : 'Use at most 2 decimals.';
    if (!isPercent(l.discountPercent)) e[`${k}.discountPercent`] = Number(l.discountPercent) > 100 ? 'Cannot be more than 100.' : /^-/.test(String(l.discountPercent)) ? 'Cannot be negative.' : 'Enter 0 to 100.';
    if (!isPercent(l.gstPercent)) e[`${k}.gstPercent`] = Number(l.gstPercent) > 100 ? 'Cannot be more than 100.' : /^-/.test(String(l.gstPercent)) ? 'Cannot be negative.' : 'Enter 0 to 100.';
  }
  for (const [f, label] of [['shipping', 'shipping charge'], ['packaging', 'packaging charge'], ['other', 'other charge'], ['additionalDiscount', 'additional discount']]) {
    if (String(charges[f]).trim() !== '' && !isMoney(charges[f])) e[`charges.${f}`] = /^-/.test(String(charges[f])) ? `The ${label} cannot be negative.` : 'Use a number with at most 2 decimals.';
  }
  if (!isPercent(charges.gstPercent)) e['charges.gstPercent'] = 'Enter 0 to 100.';

  if (Object.keys(e).length === 0 || !Object.keys(e).some((k) => k.startsWith('line.') || k.startsWith('charges.'))) {
    const c = computeOrder(toCalcInput({ lines, charges, payment }));
    if (c.additionalDiscount > c.beforeAdditionalDiscount) e['charges.additionalDiscount'] = `Cannot be more than the order value before it (${rs(c.beforeAdditionalDiscount)}).`;
    const adv = num(payment.advance);
    if (String(payment.advance).trim() !== '' && !isMoney(payment.advance)) e['payment.advance'] = /^-/.test(String(payment.advance)) ? 'The advance cannot be negative.' : 'Use a number with at most 2 decimals.';
    else if (adv > c.grandTotal) e['payment.advance'] = `Cannot be more than the order total (${rs(c.grandTotal)}).`;
    else if (['cod', 'credit'].includes(payment.terms) && adv > 0) e['payment.advance'] = 'Cash on Delivery and Credit orders have no advance. Choose Advance or Partial Payment terms.';
    else if (payment.terms === 'advance' && adv <= 0) e['payment.advance'] = 'Enter the advance payment amount.';
    else if (payment.terms === 'partial' && !(adv > 0 && adv < c.grandTotal)) e['payment.advance'] = 'A partial payment must be more than 0 and less than the order total.';
    if (adv > 0 && !payment.method) e['payment.method'] = 'Choose how the advance was paid.';
  }
  return e;
}

/** The request body: ids, quantities, rates and choices. Totals, payment status and numbers are the server's to decide. */
export function toOrderPayload({ supplierId, branchId, orderDate, expectedDate, referenceNo, notes, lines, charges, payment }, status, idempotencyKey) {
  return {
    supplierId,
    ...(branchId && { branchId }),
    ...(orderDate && { orderDate }),
    ...(expectedDate && { expectedDate }),
    referenceNo: referenceNo.trim(),
    notes: notes.trim(),
    status,
    items: lines.map((l) => ({ medicineId: l.product._id, quantity: num(l.quantity), freeQuantity: num(l.freeQuantity), rate: num(l.rate), discountPercent: num(l.discountPercent), gstPercent: num(l.gstPercent) })),
    charges: { shipping: num(charges.shipping), packaging: num(charges.packaging), other: num(charges.other), additionalDiscount: num(charges.additionalDiscount), gstPercent: num(charges.gstPercent) },
    payment: { terms: payment.terms, ...(payment.method && { method: payment.method }), advance: num(payment.advance) },
    idempotencyKey,
  };
}

/** Maps a server error (details such as items.1.quantity) back onto the form's fields. */
export function orderErrorsFromServer(err, lines) {
  const fields = {};
  for (const d of err?.details || []) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(d.path || '');
    const key = m ? `line.${lines[Number(m[1])]?.key}.${m[2] === 'medicineId' ? 'quantity' : m[2]}` : d.path === 'items' ? 'lines' : d.path;
    if (key && !fields[key]) fields[key] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const amount = (n) => (n > 0 ? String(n) : '');

/** An order the server sent, as the form's state — so a draft can be edited in the same form it was made in. */
export const orderToForm = (o) => ({
  f: { orderDate: day(o.orderDate), expectedDate: day(o.expectedDate), supplierId: String(o.supplier?.supplierId || ''), branchId: String(o.branchId || ''), referenceNo: o.referenceNo || '', notes: o.notes || '' },
  lines: o.items.map((i) => ({
    key: String(i.medicineId),
    product: { _id: String(i.medicineId), name: i.name, sku: i.sku || '', genericName: i.genericName || '', manufacturer: i.manufacturer || '', category: i.category || '', unit: i.unit || '', gstPercent: i.gstPercent },
    quantity: String(i.quantity), freeQuantity: String(i.freeQuantity || 0), rate: String(i.rate ?? ''), discountPercent: String(i.discountPercent || 0), gstPercent: String(i.gstPercent || 0),
  })),
  charges: { shipping: amount(o.charges?.shipping), packaging: amount(o.charges?.packaging), other: amount(o.charges?.other), additionalDiscount: amount(o.charges?.additionalDiscount), gstPercent: String(o.charges?.gstPercent || 0) },
  payment: { terms: o.payment?.terms || 'credit', method: o.payment?.method || '', advance: amount(o.payment?.advance) },
});

/** The same body as creating, without the status and key: an edit never changes the status. */
export function toOrderUpdatePayload(state) {
  const { status, idempotencyKey, ...body } = toOrderPayload(state);
  return body;
}
