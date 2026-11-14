import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { batchEditPayload, blankBatch, expiryNote, expiryUrgency, newBatchPayload, validateBatchEdit, validateNewBatch } from './batchValidation.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const good = () => ({ ...blankBatch, medicineId: 'abc', batchNumber: 'B-1', expiryDate: '2027-06-30', mrp: '100', sellingPrice: '90', initialQuantity: '10' });

describe('validateNewBatch', () => {
  it('accepts a complete batch', () => assert.deepEqual(validateNewBatch(good(), NOW), {}));

  it('requires medicine, batch number, expiry, quantity and prices', () => {
    const e = validateNewBatch(blankBatch, NOW);
    assert.deepEqual(Object.keys(e).sort(), ['batchNumber', 'expiryDate', 'initialQuantity', 'medicineId', 'mrp', 'sellingPrice']);
  });

  it('never accepts an expiry date that is today or earlier', () => {
    assert.match(validateNewBatch({ ...good(), expiryDate: '2026-11-07' }, NOW).expiryDate, /future/);
    assert.match(validateNewBatch({ ...good(), expiryDate: '2025-01-01' }, NOW).expiryDate, /future/);
    assert.equal(validateNewBatch({ ...good(), expiryDate: '2026-11-08' }, NOW).expiryDate, undefined);
  });

  it('checks the manufacturing date', () => {
    assert.match(validateNewBatch({ ...good(), manufacturingDate: '2027-07-01' }, NOW).manufacturingDate, /future/);
    assert.equal(validateNewBatch({ ...good(), manufacturingDate: '2026-01-01', expiryDate: '2026-12-01' }, NOW).manufacturingDate, undefined);
    assert.match(validateNewBatch({ ...good(), manufacturingDate: '2026-11-07', expiryDate: '2026-11-07' }, NOW).manufacturingDate, /future|before/);
    assert.equal(validateNewBatch({ ...good(), manufacturingDate: '2026-01-01' }, NOW).manufacturingDate, undefined);
  });

  it('checks quantity', () => {
    assert.match(validateNewBatch({ ...good(), initialQuantity: '0' }, NOW).initialQuantity, /at least 1/);
    assert.match(validateNewBatch({ ...good(), initialQuantity: '2.5' }, NOW).initialQuantity, /whole/);
    assert.match(validateNewBatch({ ...good(), initialQuantity: '-4' }, NOW).initialQuantity, /at least 1/);
  });

  it('keeps the selling price at or below the MRP and rejects negatives', () => {
    assert.match(validateNewBatch({ ...good(), sellingPrice: '101' }, NOW).sellingPrice, /exceed the MRP/);
    assert.equal(validateNewBatch({ ...good(), sellingPrice: '100' }, NOW).sellingPrice, undefined);
    assert.match(validateNewBatch({ ...good(), mrp: '-1' }, NOW).mrp, /negative/);
    assert.match(validateNewBatch({ ...good(), purchasePrice: '-2' }, NOW).purchasePrice, /negative/);
  });
});

describe('newBatchPayload', () => {
  it('converts numbers, trims, and omits blank optional fields', () => {
    const p = newBatchPayload({ ...good(), batchNumber: ' B-1 ', purchasePrice: '' });
    assert.equal(p.batchNumber, 'B-1');
    assert.equal(p.purchasePrice, 0);
    assert.equal(p.initialQuantity, 10);
    assert.equal(p.manufacturer, undefined);
    assert.equal(p.manufacturingDate, undefined);
  });
});

describe('batch editing', () => {
  const batch = { purchasePrice: 60, sellingPrice: 90, mrp: 100, manufacturer: 'Cipla', reservedQuantity: 0, status: 'active', availableQuantity: 50 };
  const values = (o = {}) => ({ purchasePrice: '60', sellingPrice: '90', mrp: '100', manufacturer: 'Cipla', reservedQuantity: '0', status: 'active', ...o });

  it('accepts unchanged values and sends nothing', () => {
    assert.deepEqual(validateBatchEdit(values(), batch), {});
    assert.deepEqual(batchEditPayload(values(), batch), {});
  });
  it('sends only what changed', () => {
    assert.deepEqual(batchEditPayload(values({ sellingPrice: '80', manufacturer: 'Sun' }), batch), { sellingPrice: 80, manufacturer: 'Sun' });
  });
  it('rejects bad prices, reserved above on-hand, and archiving a batch with stock', () => {
    assert.match(validateBatchEdit(values({ sellingPrice: '150' }), batch).sellingPrice, /MRP/);
    assert.match(validateBatchEdit(values({ reservedQuantity: '51' }), batch).reservedQuantity, /50 units/);
    assert.match(validateBatchEdit(values({ reservedQuantity: '1.5' }), batch).reservedQuantity, /whole/);
    assert.match(validateBatchEdit(values({ status: 'archived' }), batch).status, /can't be archived/);
    assert.equal(validateBatchEdit(values({ status: 'archived' }), { ...batch, availableQuantity: 0 }).status, undefined);
  });
});

describe('expiry urgency', () => {
  const b = (o) => ({ isExpired: false, daysToExpiry: 200, availableQuantity: 5, status: 'active', ...o });
  it('classifies by days left', () => {
    assert.equal(expiryUrgency(b({ isExpired: true, daysToExpiry: -3 })), 'expired');
    assert.equal(expiryUrgency(b({ daysToExpiry: 20 })), 'critical');
    assert.equal(expiryUrgency(b({ daysToExpiry: 45 })), 'soon');
    assert.equal(expiryUrgency(b({ daysToExpiry: 80 })), 'watch');
    assert.equal(expiryUrgency(b({ daysToExpiry: 300 })), 'ok');
    assert.equal(expiryUrgency(b({ daysToExpiry: 5, availableQuantity: 0 })), 'none');
  });
  it('describes it in words', () => {
    assert.equal(expiryNote(b({ isExpired: true, daysToExpiry: -1 })), 'Expired 1 day ago');
    assert.equal(expiryNote(b({ daysToExpiry: 1 })), '1 day left');
    assert.equal(expiryNote(b({ daysToExpiry: 400 })), '');
  });
});
