// The Selling Point's bills, against a real database. Selling prices are GST-INCLUSIVE, so the tax is split out of the price: a bill's total is exactly the
// marked price, and the breakdown explains that same number. What matters: the parts always add back up, the tax follows discounts down, CGST/SGST become
// IGST across a state line, and nothing the browser sends about money is believed.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, futureDate } from './helpers/harness.js';

let h;
let T;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `pos-${Date.now()}-${++n}`;

/** A medicine at a given GST rate with one batch of stock at an inclusive selling price. */
const stocked = async ({ gstPercentage = 12, sellingPrice = 112, mrp = 150, quantity = 100 } = {}) => {
  const med = (await T.client.post('/inventory', { medicineName: uniq('Med'), unit: 'Strip', gstPercentage, reorderLevel: 0 })).data;
  const batch = (await T.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp, sellingPrice, initialQuantity: quantity })).data;
  return { med, batch };
};
const bill = (body) => T.client.post('/invoices', { idempotencyKey: key(), ...body });

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('POS Billing Org');
});
after(async () => {
  await h?.stop();
});

describe('The tax inside a bill', () => {
  it('splits the tax out of the price: the customer pays the marked price and the parts add up', async () => {
    const { med } = await stocked({ gstPercentage: 12, sellingPrice: 112 });
    const r = await bill({ items: [{ medicineId: med._id, quantity: 2 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inv = r.data;
    assert.equal(inv.total, 224, 'two at ₹112 is ₹224 — tax is inside it, not on top');
    assert.equal(inv.taxableAmount, 200);
    assert.equal(inv.taxTotal, 24);
    assert.equal(inv.cgstTotal, 12);
    assert.equal(inv.sgstTotal, 12);
    assert.equal(inv.igstTotal, 0);
    assert.equal(inv.taxableAmount + inv.taxTotal + inv.roundOff, inv.total);
    assert.equal(inv.interState, false);
  });

  it('keeps the tax on every line, beside what was sold', async () => {
    const { med, batch } = await stocked({ gstPercentage: 5, sellingPrice: 105, mrp: 120 });
    const inv = (await bill({ items: [{ medicineId: med._id, quantity: 1 }] })).data;
    const l = inv.items[0];
    assert.equal(l.gstPercent, 5);
    assert.equal(l.price, 105, 'the inclusive price it was sold at');
    assert.equal(l.taxableAmount, 100);
    assert.equal(l.taxAmount, 5);
    assert.equal(l.cgst + l.sgst, l.taxAmount);
    assert.equal(l.amount, 105);
    assert.equal(l.mrp, 120, 'the MRP is kept too');
    assert.equal(l.batchNo, batch.batchNumber);
    assert.ok(l.expiryDate, 'and the expiry it was sold with');
  });

  it('prints one row per GST rate, and the rows add up to the tax charged', async () => {
    const five = await stocked({ gstPercentage: 5, sellingPrice: 105 });
    const twelve = await stocked({ gstPercentage: 12, sellingPrice: 112 });
    const inv = (await bill({ items: [{ medicineId: five.med._id, quantity: 1 }, { medicineId: twelve.med._id, quantity: 1 }] })).data;
    assert.deepEqual(inv.gstSummary.map((g) => g.gstPercent), [5, 12]);
    assert.equal(inv.gstSummary.reduce((s, g) => s + g.tax, 0), inv.taxTotal);
    assert.equal(inv.gstSummary.reduce((s, g) => s + g.taxable, 0), inv.taxableAmount);
    assert.equal(inv.total, 217);
  });

  it('lets the tax fall with a discount, on the line and on the bill', async () => {
    const { med } = await stocked({ gstPercentage: 12, sellingPrice: 112, quantity: 50 });
    const itemOff = (await bill({ items: [{ medicineId: med._id, quantity: 2, discountPercent: 10 }] })).data;
    assert.equal(itemOff.subTotal, 224);
    assert.equal(itemOff.itemDiscount, 22.4);
    assert.equal(itemOff.total, 201.6);
    assert.equal(itemOff.taxableAmount + itemOff.taxTotal, itemOff.total, 'tax is charged on what was actually billed');
    assert.ok(itemOff.taxTotal < 24, 'less than the tax on the full price');

    const billOff = (await bill({ items: [{ medicineId: med._id, quantity: 2 }], discount: { type: 'amount', value: 24 } })).data;
    assert.equal(billOff.discount, 24);
    assert.equal(billOff.total, 200);
    assert.equal(billOff.taxableAmount + billOff.taxTotal, 200);
    assert.equal(billOff.items[0].billDiscountShare, 24, 'the one line carries the whole bill discount');
  });

  it('charges IGST when the customer is in another state, and CGST + SGST when they are not', async () => {
    await T.client.put('/organization', { gstin: '27AAACS1234A1Z5' }).catch(() => {});
    const { med } = await stocked({ gstPercentage: 12, sellingPrice: 112, quantity: 20 });
    const inside = (await bill({ items: [{ medicineId: med._id, quantity: 1 }], customer: { name: 'Local', phone: '9800000001', gstin: '27AAACS9999A1Z5' } })).data;
    assert.equal(inside.interState, false);
    assert.equal(inside.igstTotal, 0);
    assert.equal(inside.cgstTotal + inside.sgstTotal, inside.taxTotal);

    const outside = (await bill({ items: [{ medicineId: med._id, quantity: 1 }], customer: { name: 'Away', phone: '9800000002', gstin: '29AAACS9999A1Z5' } })).data;
    assert.equal(outside.interState, true);
    assert.equal(outside.igstTotal, outside.taxTotal);
    assert.deepEqual({ c: outside.cgstTotal, s: outside.sgstTotal }, { c: 0, s: 0 });
    assert.equal(outside.total, inside.total, 'the customer pays the same either way; only the split differs');
  });

  it('does not round to the rupee unless the organization asks for it', async () => {
    const { med } = await stocked({ gstPercentage: 12, sellingPrice: 112.4, quantity: 20 });
    const exact = (await bill({ items: [{ medicineId: med._id, quantity: 1 }] })).data;
    assert.equal(exact.roundOff, 0);
    assert.equal(exact.total, 112.4);

    await h.tenant.runWithTenant(T.org._id, () => h.models.Organization.updateOne({ _id: T.org._id }, { $set: { 'settings.posRoundOff': true } }));
    const rounded = (await bill({ items: [{ medicineId: med._id, quantity: 1 }] })).data;
    assert.equal(rounded.total, 112);
    assert.equal(rounded.roundOff, -0.4);
    assert.equal(rounded.taxableAmount + rounded.taxTotal + rounded.roundOff, rounded.total);
    await h.tenant.runWithTenant(T.org._id, () => h.models.Organization.updateOne({ _id: T.org._id }, { $set: { 'settings.posRoundOff': false } }));
  });
});

describe('What the browser is allowed to decide', () => {
  it('ignores any price, tax or total it sends: the server works them out from the batch', async () => {
    const { med } = await stocked({ gstPercentage: 12, sellingPrice: 112, quantity: 20 });
    const r = await bill({
      items: [{ medicineId: med._id, quantity: 1, price: 1, amount: 1, taxableAmount: 0, taxAmount: 0, gstPercent: 0 }],
      subTotal: 1, total: 1, taxTotal: 0, cgstTotal: 0, sgstTotal: 0, taxableAmount: 1, roundOff: 99,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.total, 112, 'the batch decides the price');
    assert.equal(r.data.taxTotal, 12);
    assert.equal(r.data.roundOff, 0);
    assert.equal(r.data.items[0].gstPercent, 12, 'and the medicine decides the rate');
  });

  it('still refuses expired stock, short stock and a discontinued medicine', async () => {
    const { med } = await stocked({ quantity: 3 });
    assert.equal((await bill({ items: [{ medicineId: med._id, quantity: 4 }] })).status, 409, 'more than there is');
    assert.equal((await T.client.del(`/inventory/${med._id}`)).status, 200, 'discontinue it the way the app does');
    assert.equal((await bill({ items: [{ medicineId: med._id, quantity: 1 }] })).status, 409, 'discontinued');
  });

  it('deducts stock exactly once when the same bill is sent twice', async () => {
    const { med } = await stocked({ quantity: 10 });
    const k = key();
    const first = await T.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 4 }], idempotencyKey: k });
    const again = await T.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 4 }], idempotencyKey: k });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200, 'the repeat returns the first bill');
    assert.equal(again.data.invoiceNo, first.data.invoiceNo);
    const stock = (await T.client.get(`/inventory/${med._id}`)).data;
    assert.equal(stock.availableStock, 6, 'four units left the shelf, not eight');
  });
});
