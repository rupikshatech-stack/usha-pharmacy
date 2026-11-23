// An invoice line keeps the HSN the medicine had when it was sold. A GST invoice must show it; it used to be dropped on the way in,
// so the printed TAX INVOICE had "—" in its HSN column however carefully the code had been entered on the medicine.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, futureDate } from './helpers/harness.js';

let h;
let T;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;

const stocked = async (extra = {}) => {
  const med = (await T.client.post('/inventory', { medicineName: uniq('Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0, ...extra })).data;
  await T.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 112, initialQuantity: 50 });
  return med;
};
const sell = (med) => T.client.post('/invoices', { idempotencyKey: uniq('hsn'), items: [{ medicineId: med._id, quantity: 1 }] });

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('HSN Org');
});
after(async () => {
  await h?.stop();
});

describe('HSN on an invoice line', () => {
  it('is copied from the medicine, in the response and when the invoice is read back', async () => {
    const med = await stocked({ hsnCode: '30049099' });
    const made = await sell(med);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data.items[0].hsnCode, '30049099');
    const read = await T.client.get(`/invoices/${made.data._id}`);
    assert.equal(read.data.items[0].hsnCode, '30049099', 'it was persisted, not just echoed');
  });

  it('is a snapshot: editing the medicine afterwards does not rewrite an invoice already issued', async () => {
    const med = await stocked({ hsnCode: '30049099' });
    const made = await sell(med);
    const edit = await T.client.put(`/inventory/${med._id}`, { medicineName: med.medicineName, unit: 'Strip', gstPercentage: 12, reorderLevel: 0, hsnCode: '21069099' });
    assert.ok([200, 204].includes(edit.status), JSON.stringify(edit.body));
    const read = await T.client.get(`/invoices/${made.data._id}`);
    assert.equal(read.data.items[0].hsnCode, '30049099', 'the invoice keeps what was sold');
    const next = await sell(med);
    assert.equal(next.data.items[0].hsnCode, '21069099', 'a NEW invoice carries the new code');
  });

  it('is an empty string, not a missing field, for a medicine with no HSN', async () => {
    const med = await stocked();
    const made = await sell(med);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.data.items[0].hsnCode, '');
  });
});
