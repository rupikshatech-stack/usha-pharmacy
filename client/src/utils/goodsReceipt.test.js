import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirm, differences, extraBatch, lineFigures, lineProblems, purchaseMode, toForm, toPayload, totals } from './goodsReceipt.js';

const draft = {
  notes: '',
  revision: 3,
  items: [
    {
      _id: 'l1',
      medicineId: 'm1',
      name: 'Paracetamol 500mg Tablet',
      unit: 'Strip',
      itemId: 'itm_1',
      invoice: { quantity: 100, freeQuantity: 10 },
      receivedQuantity: null,
      receivedFree: null,
      rejectedQuantity: 0,
      damagedQuantity: 0,
      batchNumber: 'B1',
      expiryDate: '2029-06-30',
      purchasePrice: 20,
      mrp: 30,
    },
  ],
};

describe('what arrived is not what the invoice says', () => {
  it('leaves the received quantities EMPTY (never copied from the invoice) and keeps the invoice figures apart', () => {
    const f = toForm(draft);
    assert.equal(f.items[0].receivedQuantity, '');
    assert.equal(f.items[0].receivedFree, '');
    assert.equal(f.items[0].invoice.quantity, 100);
    assert.equal(canConfirm(f), false);
    assert.equal(toPayload(f).items[0].receivedQuantity, null, 'an empty box is sent as “not entered”, not as 0 or 100');
  });
  it('accepted = arrived - rejected - damaged: invoice 100, arrived 95, rejected 5 -> 90', () => {
    assert.deepEqual(lineFigures({ receivedQuantity: '95', receivedFree: '0', rejectedQuantity: '3', damagedQuantity: '2' }), { arrived: 95, accepted: 90 });
    assert.deepEqual(lineFigures({ receivedQuantity: '10', receivedFree: '2', rejectedQuantity: '20', damagedQuantity: '0' }), { arrived: 12, accepted: 0 });
  });
});

describe('line checks', () => {
  const ok = { ...toForm(draft).items[0], receivedQuantity: '95', receivedFree: '10', rejectedQuantity: '5', damagedQuantity: '0', remarks: 'short expiry' };
  it('accepts a complete line and explains what is missing otherwise', () => {
    assert.deepEqual(lineProblems(ok, '2026-11-08'), {});
    assert.match(lineProblems({ ...ok, receivedQuantity: '' }).receivedQuantity, /not assumed/);
    assert.match(lineProblems({ ...ok, receivedFree: '' }).receivedFree, /free units/);
    assert.match(lineProblems({ ...ok, rejectedQuantity: '200' }, '2026-11-08').rejectedQuantity, /cannot be more/);
    assert.match(lineProblems({ ...ok, remarks: '' }, '2026-11-08').remarks, /Say why/);
    assert.match(lineProblems({ ...ok, batchNumber: '' }, '2026-11-08').batchNumber, /batch number/);
    assert.match(lineProblems({ ...ok, expiryDate: '2026-01-01' }, '2026-11-08').expiryDate, /record those units as rejected/);
    assert.match(lineProblems({ ...ok, receivedQuantity: '9.5' }).receivedQuantity, /whole number/);
  });
  it('a fully rejected line needs no batch or expiry; a line that did not arrive needs nothing', () => {
    assert.deepEqual(lineProblems({ ...ok, rejectedQuantity: '105', batchNumber: '', expiryDate: '' }, '2026-11-08'), {});
    assert.deepEqual(lineProblems({ ...ok, receivedQuantity: '0', receivedFree: '0', batchNumber: '', expiryDate: '' }), {});
  });
});

describe('summary', () => {
  it('totals the lines and lists where the delivery differs from the invoice', () => {
    const f = toForm(draft);
    f.items[0] = { ...f.items[0], receivedQuantity: '95', receivedFree: '10', rejectedQuantity: '5', remarks: 'x' };
    assert.deepEqual(totals(f), { invoice: 110, arrived: 105, accepted: 100, rejected: 5, damaged: 0 });
    assert.deepEqual(differences(f), [{ name: 'Paracetamol 500mg Tablet', invoice: 110, arrived: 105 }]);
    assert.equal(canConfirm(f), true);
  });
  it('another batch of the same product starts with an empty delivery and no invoice figures', () => {
    const b = extraBatch(toForm(draft).items[0]);
    assert.deepEqual([b.medicineId, b.receivedQuantity, b.batchNumber, b.invoice, b.itemId], ['m1', '', '', {}, '']);
    assert.equal(toPayload({ notes: '', revision: 0, items: [b] }).items[0].medicineId, 'm1');
  });
  it('describes the purchase order step', () => {
    assert.equal(purchaseMode(null), 'No purchase order yet');
    assert.equal(purchaseMode({ mode: 'linked', orderNo: 'ORD-0007' }), 'Linked to ORD-0007');
    assert.equal(purchaseMode({ mode: 'created', orderNo: 'ORD-0008' }), 'Order ORD-0008 created');
  });
});
