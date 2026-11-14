import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankRefund, defaultRefund, fieldErrorsFromServer, linesFromInvoice, lineAmount, normalizeRestock, restockBlock, returnAmount, returnTotal, toPayload, validateReturn } from './salesReturnValidation.js';

const invoice = {
  _id: 'inv1',
  invoiceNo: 'INV-00001',
  lines: [
    { medicineId: 'm1', batchId: 'b1', name: 'Dolo 650', batchNo: 'B1', originalQuantity: 5, previouslyReturned: 1, returnableQuantity: 4, unitPrice: 90, lineTotalPaise: 45000, canRestock: true, batchExpired: false },
    { medicineId: 'm2', batchId: 'b2', name: 'Crocin', batchNo: 'B2', originalQuantity: 3, previouslyReturned: 0, returnableQuantity: 3, unitPrice: 33.33, lineTotalPaise: 9999, canRestock: false, batchExpired: true },
  ],
};
const pick = (lines, i, extra) => lines.map((l, n) => (n === i ? { ...l, selected: true, quantity: '2', ...extra } : l));
const form = (over = {}) => {
  const lines = pick(linesFromInvoice(invoice), 0);
  return { invoice, lines, reason: 'changed_mind', notes: '', refund: { ...blankRefund(), amount: '180.00' }, ...over };
};

describe('amounts', () => {
  it('values returned units at what the customer paid, rounded once to the paisa', () => {
    assert.equal(returnAmount(45000, 5, 2), 180);
    assert.equal(returnAmount(9999, 3, 1), 33.33);
    assert.equal(returnAmount(9999, 3, 3), 99.99, 'the whole line is exactly the line total');
    assert.equal(returnAmount(45000, 5, 0), 0);
    assert.equal(returnAmount(45000, 5, 'x'), 0);
    assert.equal(returnAmount(45000, 5, 1.5), 0);
  });
  it('returns made in pieces add up to the line total exactly', () => {
    // a line of 3 units worth ₹100.00: 1 + 1 + 1 must be 100.00, not 99.99
    const pieces = [0, 1, 2].map((already) => returnAmount(10000, 3, 1, already));
    assert.deepEqual(pieces, [33.33, 33.34, 33.33]);
    assert.equal(Math.round(pieces.reduce((a, b) => a + b, 0) * 100) / 100, 100);
    assert.equal(returnAmount(10000, 3, 2, 1), 66.67);
  });
  it('the refund starts at the full value but never above what the customer paid', () => {
    assert.equal(defaultRefund({ refundableLeft: 500 }, 180), 180);
    assert.equal(defaultRefund({ refundableLeft: 100 }, 180), 100);
    assert.equal(defaultRefund({}, 180), 180);
    assert.equal(defaultRefund({ refundableLeft: 100 }, 0), 0);
    assert.match(validateReturn({ ...form({ invoice: { ...invoice, refundableLeft: 100 } }), refund: { ...blankRefund(), amount: '120', remarks: 'r' } })['refund.amount'], /paid only ₹100.00/);
  });
  it('totals only the selected lines', () => {
    const lines = pick(pick(linesFromInvoice(invoice), 0), 1, { quantity: '1' });
    assert.equal(lineAmount(lines[1]), 33.33);
    assert.equal(returnTotal(lines), 213.33);
    assert.equal(returnTotal(linesFromInvoice(invoice)), 0);
  });
});

describe('validation', () => {
  it('a sensible return is valid', () => {
    assert.deepEqual(validateReturn(form()), {});
  });
  it('needs an invoice, a product, a quantity within what is returnable, and a reason', () => {
    assert.equal(validateReturn(form({ invoice: null })).invoice, 'Choose the original invoice.');
    assert.match(validateReturn({ ...form(), lines: linesFromInvoice(invoice) }).lines, /at least one product/);
    const k = 'line.b1:m1.quantity';
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { quantity: '5' }) }))[k], /Only 4 can still be returned \(bought 5, already returned 1\)/);
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { quantity: '' }) }))[k], /Enter a quantity/);
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { quantity: '1.5' }) }))[k], /whole number/);
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { quantity: '0' }) }))[k], /at least 1/);
    assert.match(validateReturn(form({ reason: '' })).reason, /Choose why/);
  });
  it('restocking is never automatic: it needs good condition, an allowing reason and batch, and an inspection tick', () => {
    const good = form({ lines: pick(linesFromInvoice(invoice), 0, { restock: true }) });
    assert.match(validateReturn(good)['line.b1:m1.verified'], /inspected/);
    assert.deepEqual(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { restock: true, verified: true }), refund: { ...blankRefund(), amount: '180' } })), {});
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 0, { restock: true, verified: true, condition: 'damaged' }) }))['line.b1:m1.restock'], /good condition/);
    for (const reason of ['expired', 'damaged']) assert.match(validateReturn(form({ reason, lines: pick(linesFromInvoice(invoice), 0, { restock: true, verified: true }) }))['line.b1:m1.restock'], /never be added back/);
    assert.match(validateReturn(form({ lines: pick(linesFromInvoice(invoice), 1, { restock: true, verified: true, quantity: '1' }), refund: { ...blankRefund(), amount: '33.33' } }))['line.b2:m2.restock'], /expired/);
  });
  it('blocked lines are quietly un-restocked when the reason or condition changes', () => {
    const l = { ...linesFromInvoice(invoice)[0], restock: true, verified: true };
    assert.equal(normalizeRestock(l, 'changed_mind').restock, true);
    assert.deepEqual([normalizeRestock(l, 'damaged').restock, normalizeRestock(l, 'damaged').verified], [false, false]);
    assert.equal(normalizeRestock({ ...l, condition: 'compromised' }, 'other').restock, false);
    assert.equal(restockBlock(l, 'other'), '');
  });
  it('refund: not more than the returned value, a remark when less, a reference when a completed non-cash refund', () => {
    assert.match(validateReturn(form({ refund: { ...blankRefund(), amount: '180.01' } }))['refund.amount'], /cannot be more than the value of the returned products \(₹180.00\)/);
    assert.match(validateReturn(form({ refund: { ...blankRefund(), amount: '150' } }))['refund.remarks'], /Explain why less/);
    assert.deepEqual(validateReturn(form({ refund: { ...blankRefund(), amount: '150', remarks: 'Opened strip' } })), {});
    assert.match(validateReturn(form({ refund: { ...blankRefund(), amount: 'abc' } }))['refund.amount'], /at most 2 decimals/);
    assert.match(validateReturn(form({ refund: { ...blankRefund(), amount: '' } }))['refund.amount'], /Enter the refund amount/);
    for (const method of ['UPI', 'Card', 'Bank Transfer']) assert.match(validateReturn(form({ refund: { ...blankRefund(), amount: '180', method, status: 'completed' } }))['refund.reference'], new RegExp(method));
    assert.deepEqual(validateReturn(form({ refund: { ...blankRefund(), amount: '180', method: 'UPI', status: 'completed', reference: 'UPI-1' } })), {});
    assert.deepEqual(validateReturn(form({ refund: { ...blankRefund(), amount: '180', method: 'Cash', status: 'completed' } })), {}, 'cash needs no reference');
    assert.deepEqual(validateReturn(form({ refund: { ...blankRefund(), amount: '180', method: 'UPI', status: 'pending' } })), {}, 'a pending refund needs no reference yet');
  });
});

describe('the request', () => {
  it('sends ids, quantities and choices only', () => {
    const p = toPayload(form({ notes: ' box crushed ', lines: pick(linesFromInvoice(invoice), 0, { restock: true, verified: true }), refund: { ...blankRefund(), amount: '180', reference: ' R1 ' } }), 'key-12345678');
    assert.deepEqual(p, {
      invoiceId: 'inv1',
      reason: 'changed_mind',
      notes: 'box crushed',
      items: [{ medicineId: 'm1', batchId: 'b1', quantity: 2, condition: 'good', restock: true, verified: true }],
      refund: { method: 'Cash', amount: 180, status: 'pending', reference: 'R1', remarks: '' },
      idempotencyKey: 'key-12345678',
    });
    assert.ok(!('price' in p.items[0]) && !('amount' in p.items[0]), 'no prices or amounts are sent');
  });
  it('an un-restocked line is never sent as verified', () => {
    const p = toPayload(form({ lines: pick(linesFromInvoice(invoice), 0, { restock: false, verified: true }) }), 'key-12345678');
    assert.equal(p.items[0].verified, false);
  });
  it('puts server messages on the right fields', () => {
    const lines = pick(linesFromInvoice(invoice), 0);
    const { fields } = fieldErrorsFromServer({ details: [{ path: 'items.0.quantity', message: 'Only 3 units' }, { path: 'refund.amount', message: 'Too much' }, { path: 'items', message: 'Choose one' }] }, lines);
    assert.equal(fields['line.b1:m1.quantity'], 'Only 3 units');
    assert.equal(fields['refund.amount'], 'Too much');
    assert.equal(fields.lines, 'Choose one');
    assert.equal(fieldErrorsFromServer({ message: 'Boom' }, lines).general, 'Boom');
  });
});
