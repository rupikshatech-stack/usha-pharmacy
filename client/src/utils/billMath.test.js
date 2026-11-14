// The browser's copy of the Selling Point's arithmetic — the same vectors the server checks, so the cart can never show a different figure from the bill.
// The Selling Point's arithmetic. Prices are GST-INCLUSIVE, so the tax is split out of the price and the total is exactly what it was before tax was shown.
// What matters: nothing is ever lost or invented by rounding — the parts always add back up to the total, in whole paise.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, share, taxableOf } from './billMath.js';

const line = (over = {}) => ({ quantity: 1, price: 100, discountPercent: 0, gstPercent: 12, ...over });
const r = (p) => Math.round(p) / 100;

describe('Splitting tax out of an inclusive price', () => {
  it('takes the tax out, never adds it on', () => {
    assert.equal(taxableOf(11200, 12), 10000, '₹112 at 12% is ₹100 plus ₹12 tax');
    assert.equal(taxableOf(10500, 5), 10000);
    assert.equal(taxableOf(10000, 0), 10000, 'no rate, no tax');
    assert.equal(taxableOf(10250, 2.5), 10000, 'fractional rates work');
  });

  it('gives a bill whose parts add up to the price on the shelf', () => {
    const b = computeBill({ items: [line({ price: 112, gstPercent: 12 })] });
    assert.equal(b.total, 11200, 'the customer pays the marked price');
    assert.equal(b.taxableTotal, 10000);
    assert.equal(b.taxTotal, 1200);
    assert.equal(b.cgstTotal + b.sgstTotal, b.taxTotal, 'CGST and SGST are the whole tax');
    assert.equal(b.taxableTotal + b.taxTotal, b.total);
  });

  it('splits an odd paisa of tax without losing it', () => {
    const b = computeBill({ items: [line({ price: 10.05, gstPercent: 5 })] });
    assert.equal(b.cgstTotal + b.sgstTotal, b.taxTotal);
    assert.equal(b.sgstTotal - b.cgstTotal <= 1, true, 'the halves differ by at most one paisa');
    assert.equal(b.taxableTotal + b.taxTotal, b.payable);
  });

  it('uses IGST instead of CGST and SGST when the sale crosses a state line', () => {
    const b = computeBill({ items: [line({ price: 112 })], interState: true });
    assert.deepEqual({ c: b.cgstTotal, s: b.sgstTotal, i: b.igstTotal }, { c: 0, s: 0, i: 1200 });
    assert.equal(b.taxableTotal + b.igstTotal, b.total);
  });
});

describe('Discounts', () => {
  it('takes an item discount off the inclusive price, so the tax falls with it', () => {
    const b = computeBill({ items: [line({ price: 112, quantity: 2, discountPercent: 10 })] });
    assert.equal(b.subtotal, 22400);
    assert.equal(b.itemDiscountTotal, 2240);
    assert.equal(b.total, 20160);
    assert.equal(b.taxableTotal + b.taxTotal, b.total);
    assert.equal(b.taxTotal, 20160 - Math.round((20160 * 10000) / 11200));
  });

  it('shares a bill discount across the lines so every line is taxed on what was actually charged', () => {
    const b = computeBill({
      items: [line({ price: 100, gstPercent: 5 }), line({ price: 300, gstPercent: 12 })],
      discount: { type: 'amount', value: 40 },
    });
    assert.equal(b.billDiscount, 4000);
    assert.equal(b.lines[0].billDiscount + b.lines[1].billDiscount, 4000, 'every paisa of the discount is allocated');
    assert.equal(b.lines[0].billDiscount, 1000, 'in proportion: ₹100 of ₹400');
    assert.equal(b.lines[1].billDiscount, 3000);
    assert.equal(b.total, 36000);
    assert.equal(b.taxableTotal + b.taxTotal, b.total);
  });

  it('never gives away more than the bill is worth', () => {
    const b = computeBill({ items: [line({ price: 100 })], discount: { type: 'amount', value: 500 } });
    assert.equal(b.billDiscount, 10000);
    assert.equal(b.total, 0);
    assert.equal(b.taxTotal, 0);
    const p = computeBill({ items: [line({ price: 100 })], discount: { type: 'percent', value: 150 } });
    assert.equal(p.billDiscount, 10000, 'a percentage above 100 is capped');
  });

  it('is exact where floating point would drift', () => {
    const b = computeBill({ items: Array.from({ length: 3 }, () => line({ price: 0.1, quantity: 3, gstPercent: 5 })) });
    assert.equal(b.subtotal, 90, '0.1 × 3 × 3 is exactly ₹0.90');
    assert.equal(b.taxableTotal + b.taxTotal, b.total);
  });
});

describe('Sharing an amount out', () => {
  it('always adds back up, whatever the weights', () => {
    for (const [total, weights] of [[100, [1, 1, 1]], [1, [5, 5]], [999, [7, 11, 13]], [12345, [1]], [0, [1, 2]]]) {
      const parts = share(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} over ${weights}`);
      assert.ok(parts.every((p) => p >= 0));
    }
  });

  it('gives nothing when there is nothing to share', () => {
    assert.deepEqual(share(500, [0, 0]), [0, 0]);
  });
});

describe('What the customer pays', () => {
  it('works out the change when more cash is handed over', () => {
    const b = computeBill({ items: [line({ price: 112 })], paid: 200 });
    assert.equal(b.change, 8800);
    assert.equal(b.due, 0);
    assert.equal(b.paid, 11200, 'the bill records what it was owed, not what was in the hand');
  });

  it('leaves the rest due when only part is paid', () => {
    const b = computeBill({ items: [line({ price: 112 })], paid: 50 });
    assert.deepEqual({ paid: b.paid, due: b.due, change: b.change }, { paid: 5000, due: 6200, change: 0 });
  });

  it('rounds to the nearest rupee only when asked, and says what it rounded', () => {
    const exact = computeBill({ items: [line({ price: 112.4 })] });
    assert.deepEqual({ off: exact.roundOff, total: exact.total }, { off: 0, total: 11240 }, 'off by default: the total is to the paisa');
    const rounded = computeBill({ items: [line({ price: 112.4 })], roundOff: true });
    assert.deepEqual({ off: rounded.roundOff, total: rounded.total }, { off: -40, total: 11200 });
    const up = computeBill({ items: [line({ price: 112.6 })], roundOff: true });
    assert.deepEqual({ off: up.roundOff, total: up.total }, { off: 40, total: 11300 });
    assert.equal(up.taxableTotal + up.taxTotal + up.roundOff, up.total, 'the round-off is the only thing between the parts and the total');
  });

  it('adds nothing for an empty bill', () => {
    const b = computeBill({ items: [] });
    assert.deepEqual({ total: b.total, tax: b.taxTotal, due: b.due }, { total: 0, tax: 0, due: 0 });
    assert.deepEqual(b.gstSummary, []);
  });
});

describe('The GST breakdown an invoice prints', () => {
  it('is one row per rate, and the rows add up to the tax', () => {
    const b = computeBill({
      items: [line({ price: 105, gstPercent: 5 }), line({ price: 112, gstPercent: 12 }), line({ price: 210, gstPercent: 5, quantity: 2 })],
    });
    assert.deepEqual(b.gstSummary.map((g) => g.gstPercent), [5, 12], 'sorted, one row per rate');
    assert.equal(b.gstSummary.reduce((n, g) => n + g.tax, 0), b.taxTotal);
    assert.equal(b.gstSummary.reduce((n, g) => n + g.taxable, 0), b.taxableTotal);
    const five = b.gstSummary[0];
    assert.equal(five.cgst + five.sgst, five.tax);
    assert.equal(r(b.total), 105 + 112 + 420);
  });
});

describe('Rounding to a chosen step', () => {
  it('rounds to the nearest rupee exactly as before, to ₹0.50 when asked, and not at all by default', async () => {
  const { computeBill } = await import('./billMath.js');
  const items = [{ quantity: 1, price: 99.3, discountPercent: 0, gstPercent: 12 }];
  const total = (roundOff) => computeBill({ items, roundOff }).total / 100;
  assert.equal(total(undefined), 99.3, 'exact unless asked');
  assert.equal(total(false), 99.3);
  assert.equal(total(true), 99, 'true has always meant the nearest rupee');
  assert.equal(total(1), 99, 'and 1 means the same thing');
  assert.equal(total(0.5), 99.5, '99.30 is nearer to 99.50 than to 99.00');
  assert.equal(computeBill({ items, roundOff: 0.5 }).roundOff, 20, 'held in whole paise: 20, never 19.999999');
});
});
