/**
 * The arithmetic of a supplier order, in whole paise (integers) so no floating-point error ever builds up. The browser has the same
 * function (client/src/utils/orderMath.js, same test vectors); the server's result is the one that is saved.
 *
 *   per line:   gross    = quantity × rate
 *               discount = gross × discount%
 *               taxable  = gross − discount
 *               gst      = taxable × gst%
 *               total    = taxable + gst            (free units cost nothing)
 *   order:      subtotal = Σ gross, discount = Σ discount, gst = Σ gst
 *               items    = subtotal − discount + gst
 *               charges  = shipping + packaging + other, charges GST = charges × charges-GST%
 *               grand    = items + charges + charges GST − additional discount
 */
const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
const basis = (percent) => Math.round(Number(percent || 0) * 100); // 12.5% -> 1250 basis points
const pct = (amountP, percent) => Math.round((amountP * basis(percent)) / 10000);

export function computeOrder({ items = [], charges = {}, advance = 0 }) {
  const lines = items.map((it) => {
    const gross = Math.round(Number(it.quantity || 0)) * paise(it.rate);
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
  const beforeAdditionalDiscount = itemsTotal + chargesTotal + chargesGst;
  const grandTotal = beforeAdditionalDiscount - additionalDiscount;

  const advanceP = paise(advance);
  const remaining = grandTotal - advanceP;
  const status = advanceP <= 0 ? 'unpaid' : advanceP >= grandTotal ? 'paid' : 'partially_paid';

  const r = (p) => p / 100;
  return {
    lines: lines.map((l) => ({ amount: r(l.gross), discountAmount: r(l.discount), gstAmount: r(l.gst), total: r(l.total) })),
    totalItems: items.length,
    totalQuantity: items.reduce((n, it) => n + Math.round(Number(it.quantity || 0)), 0),
    totalFreeQuantity: items.reduce((n, it) => n + Math.round(Number(it.freeQuantity || 0)), 0),
    subtotal: r(subtotal),
    discount: r(discount),
    gst: r(gst),
    itemsTotal: r(itemsTotal),
    shipping: r(shipping),
    packaging: r(packaging),
    other: r(other),
    chargesTotal: r(chargesTotal),
    chargesGst: r(chargesGst),
    additionalDiscount: r(additionalDiscount),
    beforeAdditionalDiscount: r(beforeAdditionalDiscount),
    grandTotal: r(grandTotal),
    advance: r(advanceP),
    remaining: r(remaining),
    paymentStatus: status,
    // exact paise, for the checks the server makes before saving
    _p: { grandTotal, advance: advanceP, beforeAdditionalDiscount, additionalDiscount },
  };
}
