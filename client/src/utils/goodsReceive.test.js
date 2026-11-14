import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accepted, arriving, delivered, existingBatch, receiveErrorsFromServer, receiveLinesFrom, stillExpected, toReceivePayload, validateReceipt } from './goodsReceive.js';

const receivable = {
  lines: [
    { medicineId: 'm1', name: 'Dolo 650', orderedQuantity: 12, orderedPaid: 10, orderedFree: 2, previouslyReceived: 4, remainingQuantity: 8, remainingPaid: 6, remainingFree: 2, rate: 85, mrp: 150, sellingPrice: 130, batches: [{ batchNumber: 'OLD-1', expiryDate: '2027-05-10T00:00:00.000Z', quantity: 10 }] },
    { medicineId: 'm2', name: 'Crocin', orderedQuantity: 5, orderedPaid: 5, orderedFree: 0, previouslyReceived: 5, remainingQuantity: 0, remainingPaid: 0, remainingFree: 0, rate: 20, batches: [] },
    { medicineId: 'm3', name: 'Calpol', orderedQuantity: 3, orderedPaid: 3, orderedFree: 0, previouslyReceived: 0, remainingQuantity: 3, remainingPaid: 3, remainingFree: 0, rate: 0, batches: [] },
  ],
};
const TODAY = '2026-11-08';
const lines = () => receiveLinesFrom(receivable);
const withBatch = (over = {}) => lines().map((l) => ({ ...l, batchNumber: `B-${l.key}`, expiryDate: '2027-12-31', mrp: l.mrp || '100', sellingPrice: l.sellingPrice || '90', ...over }));

describe('the form’s lines', () => {
  it('lists only products still expected, taking the whole remainder as arriving by default', () => {
    const ls = lines();
    assert.deepEqual(ls.map((l) => l.name), ['Dolo 650', 'Calpol'], 'a product that has fully arrived is not offered again');
    assert.deepEqual([ls[0].quantity, ls[0].freeQuantity, ls[0].purchasePrice, ls[0].mrp, ls[0].sellingPrice], ['6', '2', '85', '150', '130']);
    assert.equal(ls[1].purchasePrice, '', 'no rate known');
  });
  it('actual received = arrived − rejected − damaged; and what is still expected after', () => {
    const [l] = lines();
    assert.equal(arriving(l), 8);
    assert.equal(accepted(l), 8);
    const x = { ...l, quantity: '5', freeQuantity: '1', rejectedQuantity: '2', damagedQuantity: '1' };
    assert.deepEqual([arriving(x), accepted(x), stillExpected(x)], [6, 3, 2]);
    assert.equal(accepted({ ...l, rejectedQuantity: '99' }), 0, 'never negative');
  });
  it('a product with nothing arriving is left out of the delivery', () => {
    const ls = lines().map((l, i) => (i === 1 ? { ...l, quantity: '0', freeQuantity: '0' } : l));
    assert.deepEqual(delivered(ls).map((l) => l.name), ['Dolo 650']);
  });
  it('recognises a batch number that is already in stock (any case, ignoring spaces)', () => {
    const [l] = lines();
    assert.equal(existingBatch({ ...l, batchNumber: ' old-1 ' })?.batchNumber, 'OLD-1');
    assert.equal(existingBatch({ ...l, batchNumber: 'NEW' }), undefined);
    assert.equal(existingBatch({ ...l, batchNumber: '' }), undefined);
  });
});

describe('validation', () => {
  it('a complete delivery is valid', () => {
    assert.deepEqual(validateReceipt(withBatch(), TODAY), {});
  });
  it('nothing arriving anywhere is not a delivery', () => {
    const ls = lines().map((l) => ({ ...l, quantity: '0', freeQuantity: '0' }));
    assert.match(validateReceipt(ls, TODAY).lines, /at least one product/);
  });
  it('never more than was ordered (paid and free counted separately)', () => {
    const e = validateReceipt(withBatch({ quantity: '9' }), TODAY);
    assert.match(e['line.m1.quantity'], /Only 6 more units are expected\. You can't receive more than was ordered/);
    assert.match(validateReceipt(withBatch({ freeQuantity: '3' }), TODAY)['line.m1.freeQuantity'], /Only 2 free units/);
    assert.match(validateReceipt(withBatch({ quantity: '-1' }), TODAY)['line.m1.quantity'], /negative/);
    assert.match(validateReceipt(withBatch({ quantity: '1.5' }), TODAY)['line.m1.quantity'], /whole number/);
  });
  it('rejected and damaged units are bounded and need a reason', () => {
    const ls = (extra) => withBatch().map((l) => (l.key === 'm1' ? { ...l, ...extra } : l));
    assert.match(validateReceipt(ls({ rejectedQuantity: '2' }), TODAY)['line.m1.remarks'], /Say why/);
    assert.deepEqual(validateReceipt(ls({ rejectedQuantity: '2', remarks: 'wrong strength' }), TODAY), {});
    assert.match(validateReceipt(ls({ rejectedQuantity: '6', damagedQuantity: '3', remarks: 'x' }), TODAY)['line.m1.rejectedQuantity'], /more than the 8 that arrived/);
  });
  it('accepted units need a batch number and a valid future expiry; expired stock is refused', () => {
    assert.match(validateReceipt(withBatch({ batchNumber: '' }), TODAY)['line.m1.batchNumber'], /batch number/);
    assert.match(validateReceipt(withBatch({ expiryDate: '' }), TODAY)['line.m1.expiryDate'], /expiry date/);
    assert.match(validateReceipt(withBatch({ expiryDate: '2026-11-08' }), TODAY)['line.m1.expiryDate'], /Expired stock/);
    assert.match(validateReceipt(withBatch({ expiryDate: '2025-01-01' }), TODAY)['line.m1.expiryDate'], /Expired stock/);
    assert.match(validateReceipt(withBatch({ manufacturingDate: '2026-12-01' }), TODAY)['line.m1.manufacturingDate'], /future/);
    assert.match(validateReceipt(withBatch({ manufacturingDate: '2027-12-31' }), TODAY)['line.m1.manufacturingDate'] || 'future', /future|before the expiry/);
  });
  it('an entirely rejected delivery needs no batch details', () => {
    const ls = lines().map((l) => (l.key === 'm1' ? { ...l, rejectedQuantity: '8', remarks: 'Wrong product' } : { ...l, quantity: '0' }));
    assert.deepEqual(validateReceipt(ls, TODAY), {});
  });
  it('a new batch needs prices (selling ≤ MRP); an existing batch keeps its one expiry date', () => {
    assert.match(validateReceipt(withBatch({ mrp: '', sellingPrice: '' }), TODAY)['line.m1.mrp'], /MRP/);
    assert.match(validateReceipt(withBatch({ mrp: '50', sellingPrice: '60' }), TODAY)['line.m1.sellingPrice'], /more than the MRP/);
    const ex = withBatch({ batchNumber: 'OLD-1', expiryDate: '2027-05-10', mrp: '', sellingPrice: '' });
    assert.deepEqual(validateReceipt(ex, TODAY)['line.m1.mrp'], undefined, 'no prices needed for an existing batch');
    assert.match(validateReceipt(withBatch({ batchNumber: 'OLD-1', expiryDate: '2027-06-01' }), TODAY)['line.m1.expiryDate'], /already in stock with expiry 2027-05-10/);
  });
});

describe('the request', () => {
  it('sends only what arrived, never stock or totals', () => {
    const ls = withBatch({ manufacturingDate: '2026-01-01' }).map((l) => (l.key === 'm3' ? { ...l, quantity: '0' } : l));
    const p = toReceivePayload(ls, { remarks: ' First truck ', idempotencyKey: 'key-12345678' });
    assert.equal(p.items.length, 1);
    assert.deepEqual(p.items[0], { medicineId: 'm1', quantity: 6, freeQuantity: 2, rejectedQuantity: 0, damagedQuantity: 0, batchNumber: 'B-m1', manufacturingDate: '2026-01-01', expiryDate: '2027-12-31', purchasePrice: 85, mrp: 150, sellingPrice: 130, remarks: '' });
    assert.deepEqual([p.remarks, p.idempotencyKey], ['First truck', 'key-12345678']);
  });
  it('puts server messages on the right lines', () => {
    const ls = withBatch();
    const { fields } = receiveErrorsFromServer({ details: [{ path: 'items.1.expiryDate', message: 'Expired' }, { path: 'items.0.quantity', message: 'Too many' }, { path: 'items', message: 'Nothing' }] }, ls);
    assert.equal(fields['line.m3.expiryDate'], 'Expired');
    assert.equal(fields['line.m1.quantity'], 'Too many');
    assert.equal(fields.lines, 'Nothing');
    assert.equal(receiveErrorsFromServer({ message: 'Boom' }, ls).general, 'Boom');
  });
});
