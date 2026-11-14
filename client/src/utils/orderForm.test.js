import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankCharges, blankPayment, computeOrder, lineFromProduct, orderErrorsFromServer, orderToForm, toCalcInput, toOrderPayload, toOrderUpdatePayload, validateOrder , supplierOrderTerms, supplierTermsNote } from './orderForm.js';

const product = (id, over = {}) => ({ _id: id, name: `P${id}`, purchasePrice: 0, gstPercent: 12, ...over });
const line = (id, over = {}) => ({ ...lineFromProduct(product(id)), rate: '10', ...over });
const form = (over = {}) => ({ supplierId: 's1', orderDate: '2026-11-08', expectedDate: '', lines: [line('a')], charges: blankCharges(), payment: blankPayment(), notes: '', referenceNo: '', ...over });

describe('the arithmetic (the same figures as the server tests)', () => {
  it('lines, discount, GST, charges and grand total, to the paisa', () => {
    const c = computeOrder({
      items: [
        { quantity: 10, rate: 100, discountPercent: 10, gstPercent: 12 },
        { quantity: 5, rate: 33.33, gstPercent: 5 },
      ],
      charges: { shipping: 50, packaging: 20, other: 10, gstPercent: 18, additionalDiscount: 25 },
    });
    assert.deepEqual(c.lines.map((l) => [l.amount, l.discountAmount, l.gstAmount, l.total]), [[1000, 100, 108, 1008], [166.65, 0, 8.33, 174.98]]);
    assert.deepEqual([c.subtotal, c.discount, c.gst, c.chargesGst, c.grandTotal], [1166.65, 100, 116.33, 14.4, 1252.38]);
    assert.deepEqual([c.totalItems, c.totalQuantity], [2, 15]);
  });
  it('free units cost nothing; decimal GST rates work', () => {
    const c = computeOrder({ items: [{ quantity: 20, freeQuantity: 4, rate: 12.5, gstPercent: 2.5 }] });
    assert.deepEqual([c.lines[0].amount, c.lines[0].gstAmount, c.lines[0].total, c.grandTotal, c.totalFreeQuantity], [250, 6.25, 256.25, 256.25, 4]);
  });
  it('is exact where floating point would drift', () => {
    const c = computeOrder({ items: [{ quantity: 3, rate: 0.1 }, { quantity: 3, rate: 0.2 }, { quantity: 7, rate: 19.99, discountPercent: 3.5, gstPercent: 12 }] });
    assert.deepEqual(c.lines.map((l) => l.amount), [0.3, 0.6, 139.93]);
    assert.equal(c.subtotal, 140.83);
    assert.deepEqual([c.lines[2].discountAmount, c.lines[2].gstAmount], [4.9, 16.2]);
  });
  it('payment: remaining and status follow the advance', () => {
    const items = [{ quantity: 10, rate: 100 }];
    assert.deepEqual([computeOrder({ items, advance: 0 }).paymentStatus, computeOrder({ items, advance: 0 }).remaining], ['unpaid', 1000]);
    assert.deepEqual([computeOrder({ items, advance: 400 }).paymentStatus, computeOrder({ items, advance: 400 }).remaining], ['partially_paid', 600]);
    assert.deepEqual([computeOrder({ items, advance: 1000 }).paymentStatus, computeOrder({ items, advance: 1000 }).remaining], ['paid', 0]);
  });
  it('half-typed values count as zero instead of breaking the total', () => {
    const c = computeOrder(toCalcInput({ lines: [line('a', { quantity: '', rate: '1.' })], charges: blankCharges(), payment: blankPayment() }));
    assert.equal(c.grandTotal, 0);
  });
  it('a new line starts from the product’s last purchase price and its own GST rate', () => {
    const l = lineFromProduct(product('x', { purchasePrice: 62.5, gstPercent: 5 }));
    assert.deepEqual([l.rate, l.gstPercent, l.quantity, l.freeQuantity, l.discountPercent], ['62.5', '5', '1', '0', '0']);
    assert.equal(lineFromProduct(product('y')).rate, '');
  });
});

describe('validation', () => {
  it('a sensible order is valid', () => {
    assert.deepEqual(validateOrder(form()), {});
  });
  it('needs a supplier, at least one product and a sensible expected date', () => {
    assert.equal(validateOrder(form({ supplierId: '' })).supplierId, 'Choose a supplier.');
    assert.match(validateOrder(form({ lines: [] })).lines, /at least one product/);
    assert.match(validateOrder(form({ expectedDate: '2026-11-07' })).expectedDate, /cannot be before the order date/);
    assert.deepEqual(validateOrder(form({ expectedDate: '2026-11-08' })), {});
  });
  it('quantities, prices and percentages', () => {
    const k = 'line.a';
    const v = (over) => validateOrder(form({ lines: [line('a', over)] }));
    assert.match(v({ quantity: '0' })[`${k}.quantity`], /at least 1/);
    assert.match(v({ quantity: '-2' })[`${k}.quantity`], /at least 1/);
    assert.match(v({ quantity: '1.5' })[`${k}.quantity`], /whole number/);
    assert.match(v({ quantity: '' })[`${k}.quantity`], /Enter a quantity/);
    assert.match(v({ rate: '-5' })[`${k}.rate`], /cannot be negative/);
    assert.match(v({ rate: '' })[`${k}.rate`], /Enter the purchase rate/);
    assert.match(v({ rate: '1.234' })[`${k}.rate`], /2 decimals/);
    assert.match(v({ freeQuantity: '-1' })[`${k}.freeQuantity`], /negative/);
    assert.match(v({ discountPercent: '101' })[`${k}.discountPercent`], /more than 100/);
    assert.match(v({ gstPercent: '-1' })[`${k}.gstPercent`], /negative/);
    assert.deepEqual(v({ rate: '0' }), {}, 'a free sample at rate 0 is allowed');
  });
  it('charges and the additional discount', () => {
    assert.match(validateOrder(form({ charges: { ...blankCharges(), shipping: '-1' } }))['charges.shipping'], /cannot be negative/);
    assert.match(validateOrder(form({ charges: { ...blankCharges(), additionalDiscount: '20' } }))['charges.additionalDiscount'], /Cannot be more than the order value before it \(₹11.20\)/);
    assert.deepEqual(validateOrder(form({ charges: { ...blankCharges(), shipping: '5', additionalDiscount: '16.2' } })), {});
  });
  it('payment follows the terms and always needs a method for money paid', () => {
    const p = (payment) => validateOrder(form({ payment: { ...blankPayment(), ...payment } }));
    assert.match(p({ terms: 'cod', advance: '5', method: 'Cash' })['payment.advance'], /no advance/);
    assert.match(p({ terms: 'advance', advance: '' })['payment.advance'], /Enter the advance/);
    assert.match(p({ terms: 'advance', advance: '99', method: 'Cash' })['payment.advance'], /order total \(₹11.20\)/);
    assert.match(p({ terms: 'partial', advance: '11.20', method: 'Cash' })['payment.advance'], /more than 0 and less than/);
    assert.match(p({ terms: 'partial', advance: '5' })['payment.method'], /Choose how/);
    assert.deepEqual(p({ terms: 'partial', advance: '5', method: 'UPI' }), {});
    assert.deepEqual(p({ terms: 'advance', advance: '11.20', method: 'Card' }), {});
  });
});

describe('the request', () => {
  it('sends ids, quantities, rates and choices, never totals or the payment status', () => {
    const f = form({ branchId: 'b1', referenceNo: ' QT-1 ', notes: ' hi ', charges: { ...blankCharges(), shipping: '50' }, payment: { terms: 'partial', method: 'UPI', advance: '5' } });
    const p = toOrderPayload(f, 'ordered', 'key-12345678');
    assert.deepEqual(p.items, [{ medicineId: 'a', quantity: 1, freeQuantity: 0, rate: 10, discountPercent: 0, gstPercent: 12 }]);
    assert.deepEqual([p.referenceNo, p.notes, p.status, p.branchId, p.idempotencyKey], ['QT-1', 'hi', 'ordered', 'b1', 'key-12345678']);
    assert.deepEqual(p.payment, { terms: 'partial', method: 'UPI', advance: 5 });
    assert.ok(!('grandTotal' in p) && !('subtotal' in p) && !('status' in p.payment));
  });
  it('puts server messages on the right fields', () => {
    const f = form();
    const { fields } = orderErrorsFromServer({ details: [{ path: 'items.0.rate', message: 'Too high' }, { path: 'payment.method', message: 'Pick one' }, { path: 'items', message: 'Add one' }] }, f.lines);
    assert.equal(fields['line.a.rate'], 'Too high');
    assert.equal(fields['payment.method'], 'Pick one');
    assert.equal(fields.lines, 'Add one');
    assert.equal(orderErrorsFromServer({ message: 'Boom' }, f.lines).general, 'Boom');
  });
});

describe('editing a draft', () => {
  const order = {
    orderDate: '2026-11-05T00:00:00.000Z', expectedDate: '2026-11-12T00:00:00.000Z', supplier: { supplierId: 's9' }, branchId: 'b2', referenceNo: 'QT-5', notes: 'hi',
    items: [{ medicineId: 'm1', name: 'Dolo 650', unit: 'Strip', quantity: 10, freeQuantity: 2, rate: 20, discountPercent: 10, gstPercent: 12 }],
    charges: { shipping: 50, packaging: 0, other: 0, additionalDiscount: 0, gstPercent: 18 }, payment: { terms: 'partial', method: 'UPI', advance: 100 },
  };
  it('turns a saved order back into the form’s state', () => {
    const s = orderToForm(order);
    assert.deepEqual(s.f, { orderDate: '2026-11-05', expectedDate: '2026-11-12', supplierId: 's9', branchId: 'b2', referenceNo: 'QT-5', notes: 'hi' });
    assert.deepEqual([s.lines[0].key, s.lines[0].quantity, s.lines[0].freeQuantity, s.lines[0].rate, s.lines[0].discountPercent, s.lines[0].gstPercent], ['m1', '10', '2', '20', '10', '12']);
    assert.deepEqual(s.charges, { shipping: '50', packaging: '', other: '', additionalDiscount: '', gstPercent: '18' });
    assert.deepEqual(s.payment, { terms: 'partial', method: 'UPI', advance: '100' });
    assert.deepEqual(validateOrder({ ...s.f, lines: s.lines, charges: s.charges, payment: s.payment }), {}, 'a saved order is a valid form');
  });
  it('sends no status or key when editing', () => {
    const s = orderToForm(order);
    const p = toOrderUpdatePayload({ ...s.f, lines: s.lines, charges: s.charges, payment: s.payment });
    assert.ok(!('status' in p) && !('idempotencyKey' in p));
    assert.equal(p.items[0].quantity, 10);
    assert.equal(p.supplierId, 's9');
  });
});

describe('the payment terms a supplier is normally paid on', () => {
  it('maps the supplier’s standing terms onto an order’s own vocabulary', () => {
    const of = (paymentTerms) => supplierOrderTerms({ procurement: { paymentTerms } });
    assert.equal(of('advance'), 'advance');
    assert.equal(of('cod'), 'cod');
    for (const days of ['net7', 'net15', 'net30', 'net45', 'custom']) assert.equal(of(days), 'credit', `${days} means the order is on credit`);
  });

  it('says nothing when the supplier says nothing', () => {
    assert.equal(supplierOrderTerms(undefined), null);
    assert.equal(supplierOrderTerms({}), null);
    assert.equal(supplierOrderTerms({ procurement: {} }), null);
  });

  it('explains where the suggestion came from', () => {
    assert.equal(supplierTermsNote({ name: 'Sun Pharma', paymentTermsLabel: '30 days', creditDays: 30 }), 'Sun Pharma is normally paid: 30 days (30 days credit).');
    assert.equal(supplierTermsNote({ name: 'Cash Co', paymentTermsLabel: 'Cash on delivery', creditDays: 0 }), 'Cash Co is normally paid: Cash on delivery.');
    assert.equal(supplierTermsNote({ name: 'Unknown' }), '');
  });
});
