import { computeBill, rupees } from './billMath.js';

/**
 * The Selling Point's running bill, as one pure function.
 *
 * The same arithmetic the server applies when the bill is saved - prices are GST-inclusive, so the tax is split OUT
 * of them, never added on - and the same `roundOff` the server is given, so the figure on the cart is the figure that
 * will be printed. It lives outside the page so a test can put a cart through it and through the real invoice endpoint
 * and compare the two.
 */
export function cartBill({ cart, discount, customerGstin, orgState, paymentType, paid, roundOff }) {
  const bill = computeBill({
    items: cart.map((i) => ({ quantity: i.quantity, price: i.price, discountPercent: i.discountPercent, gstPercent: i.gstPercent })),
    discount: discount?.value ? { type: discount.type === 'percent' ? 'percent' : 'amount', value: Number(discount.value) || 0 } : null,
    interState: /^\d{2}/.test(customerGstin || '') && Boolean(orgState) && customerGstin.slice(0, 2) !== orgState,
    roundOff,
    paid: paymentType === 'Credit' ? Number(paid) || 0 : undefined,
  });
  return {
    bill,
    subTotal: rupees(bill.subtotal),
    itemDisc: rupees(bill.itemDiscountTotal),
    disc: rupees(bill.billDiscount),
    taxable: rupees(bill.taxableTotal),
    cgst: rupees(bill.cgstTotal),
    sgst: rupees(bill.sgstTotal),
    igst: rupees(bill.igstTotal),
    tax: rupees(bill.taxTotal),
    roundOff: rupees(bill.roundOff),
    total: rupees(bill.total),
    paid: paymentType === 'Credit' ? rupees(bill.paid) : rupees(bill.total),
    due: paymentType === 'Credit' ? rupees(bill.due) : 0,
    lineTotals: bill.lines.map((l) => ({ final: rupees(l.final), tax: rupees(l.tax), taxable: rupees(l.taxable) })),
  };
}
