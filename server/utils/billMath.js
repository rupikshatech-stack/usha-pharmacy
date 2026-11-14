/**
 * The arithmetic of a retail bill at the Selling Point, in whole paise (integers) so no floating-point error ever builds up. The browser has the same
 * function (client/src/utils/billMath.js, same test vectors); the server's result is the one that is saved.
 *
 * Prices here are **GST-inclusive**, as pharmacy retail prices are in India: the selling price on a batch already contains the tax, so tax is split OUT of
 * the price rather than added on top. A bill's total is therefore exactly what it was before tax was ever shown — the breakdown explains the same number.
 *
 *   per line:   gross    = quantity × price                 (inclusive)
 *               discount = gross × discount%                (item-level)
 *               net      = gross − discount                 (inclusive)
 *   bill:       a bill-level discount is shared across the lines in proportion to their net, so every line's tax falls with it
 *               final    = net − its share of the bill discount
 *               taxable  = final × 100 ÷ (100 + rate)       (the part that is not tax)
 *               tax      = final − taxable
 *               intra-state: cgst = sgst = tax ÷ 2 (the odd paisa goes to SGST)   inter-state: igst = tax
 *   totals:     payable  = Σ final = taxable total + tax total
 *               roundOff = to the nearest rupee, only when the organization asks for it
 *               total    = payable + roundOff,   due = total − paid
 */
const paise = (rupees) => Math.round(Number(rupees || 0) * 100);
const basis = (percent) => Math.round(Number(percent || 0) * 100); // 12.5% -> 1250 basis points
const pct = (amountP, percent) => Math.round((amountP * basis(percent)) / 10000);
export const rupees = (p) => Math.round(p) / 100;

/** The part of a GST-inclusive amount that is not tax. */
export const taxableOf = (inclusiveP, percent) => Math.round((inclusiveP * 10000) / (10000 + basis(percent)));

/**
 * Shares `totalP` across `weights` in proportion, without losing or inventing a paisa: everyone gets the floor of their share, and the paise left over go to
 * the largest remainders first. Σ shares === totalP, always.
 */
export function share(totalP, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !totalP) return weights.map(() => 0);
  const exact = weights.map((w) => (totalP * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = totalP - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k][1]] += 1;
  return out;
}

/**
 * The whole bill.
 *   items: [{ quantity, price, discountPercent, gstPercent }]   price = the GST-inclusive selling price
 *   discount: { type: 'percent' | 'amount', value }             the bill-level discount
 *   interState: true -> IGST instead of CGST + SGST
 *   roundOff: true -> round the payable to the nearest rupee; a number (e.g. 0.5) -> to that many rupees
 *   paid: what the customer has handed over
 * Everything comes back in paise; `rupees()` turns a figure into what is stored and shown.
 */
export function computeBill({ items = [], discount = null, interState = false, roundOff = false, paid = 0 } = {}) {
  const lines = items.map((it) => {
    const quantity = Math.max(0, Math.round(Number(it.quantity || 0)));
    const gross = quantity * paise(it.price);
    const itemDiscount = pct(gross, it.discountPercent);
    return { quantity, gross, itemDiscount, net: gross - itemDiscount, gstPercent: Number(it.gstPercent || 0) };
  });

  const subtotal = lines.reduce((n, l) => n + l.gross, 0);
  const itemDiscountTotal = lines.reduce((n, l) => n + l.itemDiscount, 0);
  const netTotal = lines.reduce((n, l) => n + l.net, 0);

  // a bill-level discount never takes more than the bill is worth
  let billDiscount = 0;
  if (discount && Number(discount.value) > 0) {
    billDiscount = discount.type === 'amount' ? paise(discount.value) : pct(netTotal, Math.min(Number(discount.value), 100));
    billDiscount = Math.min(billDiscount, netTotal);
  }
  const shares = share(billDiscount, lines.map((l) => l.net));

  const detailed = lines.map((l, i) => {
    const final = l.net - shares[i];
    const taxable = taxableOf(final, l.gstPercent);
    const tax = final - taxable;
    const cgst = interState ? 0 : Math.floor(tax / 2);
    const sgst = interState ? 0 : tax - cgst; // the odd paisa goes to SGST, so the halves always add back up
    return { ...l, billDiscount: shares[i], final, taxable, tax, cgst, sgst, igst: interState ? tax : 0 };
  });

  const sum = (k) => detailed.reduce((n, l) => n + l[k], 0);
  const payable = sum('final');
  // `roundOff` is false (exact), true (the nearest rupee — what it has always meant) or a number of rupees to round
  // to, such as 0.5. The step is held in whole paise like every other amount, so 0.5 is 50 and never 0.5000001.
  const step = roundOff === true ? 100 : roundOff ? Math.round(Number(roundOff) * 100) : 0;
  const off = step > 0 ? Math.round(payable / step) * step - payable : 0;
  const total = payable + off;
  const paidP = Math.max(0, paise(paid));

  // what the invoice prints: one row per GST rate
  const byRate = new Map();
  for (const l of detailed) {
    const r = byRate.get(l.gstPercent) || { gstPercent: l.gstPercent, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    r.taxable += l.taxable;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    r.tax += l.tax;
    byRate.set(l.gstPercent, r);
  }

  return {
    lines: detailed,
    subtotal,
    itemDiscountTotal,
    billDiscount,
    discountTotal: itemDiscountTotal + billDiscount,
    taxableTotal: sum('taxable'),
    cgstTotal: sum('cgst'),
    sgstTotal: sum('sgst'),
    igstTotal: sum('igst'),
    taxTotal: sum('tax'),
    payable,
    roundOff: off,
    total,
    paid: Math.min(paidP, total),
    due: Math.max(0, total - paidP),
    change: Math.max(0, paidP - total), // what to hand back when more cash was given than the bill
    interState: Boolean(interState),
    gstSummary: [...byRate.values()].sort((a, b) => a.gstPercent - b.gstPercent),
  };
}

/**
 * The `roundOff` to hand computeBill for an organization's settings: `false` (exact totals - what an organization gets
 * until it asks otherwise), or the step in rupees (1 = nearest rupee, 0.5 = nearest 50 paise).
 *
 * It lives HERE, beside computeBill, so the server that saves an invoice and the Selling Point that shows the cart ask
 * the same question the same way. Two places each deciding "does this organization round?" is how a cart said one
 * total and the printed invoice another.
 */
export function roundOffFor(settings) {
  return settings?.posRoundOff ? settings?.invoice?.calculation?.roundOffNearest || 1 : false;
}
