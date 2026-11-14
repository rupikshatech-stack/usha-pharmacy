import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_COPY, STATUS_LABEL, allowed, awaitsReceipt, can, hasLineDiscrepancy, leavesExpected, receiveLines, stillExpected, toReceivePayload, validateReceipt, dispatchLines, leavesRemainder, permissionFor, remainingAfter, removeAction, toDispatchPayload, transferCsvRows, validateDispatch, blankTransfer, expiryTone, fromTransfer, isDirty, newLine, serverErrors, stepQuantity, todayKey, toPayload, validateTransfer } from './transferValidation.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const batch = { _id: 'b1', medicineName: 'Dolo 650', batchNumber: 'BT1', expiryDate: '2028-01-01', sellableQuantity: 40 };
const good = () => ({ ...blankTransfer('main', NOW), toBranchId: 'north', lines: [newLine(batch, 5)] });

describe('validateTransfer', () => {
  it('accepts a complete transfer', () => assert.deepEqual(validateTransfer(good()), {}));

  it('needs both stores, different from each other', () => {
    assert.match(validateTransfer({ ...good(), fromBranchId: '' }).fromBranchId, /leaving/);
    assert.match(validateTransfer({ ...good(), toBranchId: '' }).toBranchId, /going to/);
    assert.match(validateTransfer({ ...good(), toBranchId: 'main' }).toBranchId, /different destination/);
  });

  it('needs a real date', () => {
    assert.match(validateTransfer({ ...good(), transferDate: '' }).transferDate, /Choose/);
    assert.match(validateTransfer({ ...good(), transferDate: '07/11/2026' }).transferDate, /Choose/);
    assert.match(validateTransfer({ ...good(), transferDate: '2026-02-30' }).transferDate, /Not a real/);
    assert.equal(validateTransfer({ ...good(), transferDate: '2026-11-07' }).transferDate, undefined);
  });

  it('needs at least one line, and limits notes', () => {
    assert.match(validateTransfer({ ...good(), lines: [] }).lines, /at least one/);
    assert.match(validateTransfer({ ...good(), notes: 'x'.repeat(501) }).notes, /500/);
  });

  it('checks every line’s quantity against what is available', () => {
    const lines = [newLine(batch, 5), { ...newLine(batch, 5), quantity: '0' }, { ...newLine(batch, 5), quantity: '2.5' }, { ...newLine(batch, 5), quantity: '' }, { ...newLine(batch, 5), quantity: '41' }, { ...newLine(batch, 5), quantity: '40' }];
    const e = validateTransfer({ ...good(), lines });
    assert.equal(e['line.0'], undefined);
    assert.match(e['line.1'], /at least 1/);
    assert.match(e['line.2'], /whole/);
    assert.match(e['line.3'], /Enter a quantity/);
    assert.match(e['line.4'], /Only 40 units available/);
    assert.equal(e['line.5'], undefined, 'exactly everything that is available is fine');
  });

  it('does not check availability for lines loaded from a saved draft (the server does)', () => {
    const saved = fromTransfer({ fromBranchId: 'main', toBranchId: 'north', transferDate: '2026-11-07T00:00:00.000Z', notes: '', items: [{ batchId: 'b1', quantity: 500, medicineName: 'X', batchNumber: 'B', expiryDate: '2028-01-01' }] });
    assert.deepEqual(validateTransfer(saved), {});
  });
});

describe('toPayload / fromTransfer', () => {
  it('sends only ids, quantities and the header fields', () => {
    const p = toPayload({ ...good(), notes: '  top-up  ' });
    assert.deepEqual(p, { fromBranchId: 'main', toBranchId: 'north', transferDate: '2026-11-07', expectedArrivalDate: undefined, notes: 'top-up', internalRemarks: '', items: [{ batchId: 'b1', quantity: 5 }] });
    assert.ok(!JSON.stringify(p).includes('Dolo'), 'names and prices are never sent');
  });
  it('round-trips a saved draft', () => {
    const f = fromTransfer({ fromBranchId: 'main', toBranchId: 'north', transferDate: '2026-11-07T00:00:00.000Z', notes: 'n', items: [{ batchId: 'b1', quantity: 3, medicineName: 'X', batchNumber: 'B', expiryDate: 'e' }] });
    assert.equal(f.transferDate, '2026-11-07');
    assert.deepEqual(toPayload(f).items, [{ batchId: 'b1', quantity: 3 }]);
  });
  it('detects changes', () => {
    const a = good();
    assert.equal(isDirty(a, structuredClone(a)), false);
    assert.equal(isDirty(a, { ...a, notes: 'x' }), true);
  });
  it('today is the local calendar day', () => assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/));
});

describe('serverErrors', () => {
  it('places errors on fields and on the right line', () => {
    const r = serverErrors({ details: [{ path: 'items.2.quantity', message: 'Only 3 units' }, { path: 'items', message: 'Add one' }, { path: 'toBranchId', message: 'Different' }, { path: 'branchId', message: 'inactive' }] });
    assert.deepEqual(r.fields, { 'line.2': 'Only 3 units', lines: 'Add one', toBranchId: 'Different' });
    assert.equal(r.general, '');
  });
  it('falls back to a general message', () => assert.equal(serverErrors({ message: 'Offline' }).general, 'Offline'));
});

describe('what can be done in each state', () => {
  const ACTIONS = ['edit', 'delete', 'submit', 'approve', 'reject', 'dispatch', 'receive', 'cancel'];
  const possible = (status) => ACTIONS.filter((a) => can(status, a));

  it('follows the workflow: draft, submitted, approved, in transit, then nothing', () => {
    assert.deepEqual(possible('draft'), ['edit', 'delete', 'submit']);
    assert.deepEqual(possible('submitted'), ['approve', 'reject', 'cancel']);
    assert.deepEqual(possible('approved'), ['dispatch', 'cancel']);
    assert.deepEqual(possible('in_transit'), ['receive', 'cancel']);
    for (const s of ['rejected', 'completed', 'cancelled']) assert.deepEqual(possible(s), [], s);
    assert.deepEqual(possible('unknown'), []);
  });

  it('only drafts can be edited or deleted; only a transfer that has not been received can be cancelled', () => {
    assert.deepEqual(ACTIONS.filter((a) => ['draft', 'submitted', 'approved', 'in_transit'].some((s) => can(s, a) && a === 'edit')), ['edit']);
    assert.equal(can('submitted', 'edit'), false);
    assert.equal(can('approved', 'delete'), false);
    assert.equal(can('completed', 'cancel'), false);
  });

  it('the row’s delete-or-cancel button depends on the status', () => {
    assert.equal(removeAction('draft'), 'delete');
    for (const s of ['submitted', 'approved', 'in_transit']) assert.equal(removeAction(s), 'cancel', s);
    for (const s of ['completed', 'rejected', 'cancelled']) assert.equal(removeAction(s), null, s);
  });

  it('permissions: approving needs the approve permission, everything else needs the manage permission', () => {
    const manager = ['inventory:read', 'transfer:manage'];
    const approver = ['inventory:read', 'transfer:approve'];
    assert.equal(allowed(manager, 'draft', 'submit'), true);
    assert.equal(allowed(manager, 'submitted', 'approve'), false, 'a preparer cannot approve');
    assert.equal(allowed(manager, 'submitted', 'cancel'), true);
    assert.equal(allowed(approver, 'submitted', 'approve'), true);
    assert.equal(allowed(approver, 'submitted', 'reject'), true);
    assert.equal(allowed(approver, 'draft', 'submit'), false, 'an approver alone cannot prepare');
    assert.equal(allowed([], 'draft', 'edit'), false);
    assert.equal(allowed(undefined, 'draft', 'edit'), false);
    assert.equal(allowed(manager, 'completed', 'cancel'), false, 'permission never overrides the workflow');
  });

  it('labels every status', () => {
    for (const s of ['draft', 'submitted', 'approved', 'rejected', 'in_transit', 'completed', 'cancelled']) assert.ok(STATUS_LABEL[s], s);
    assert.equal(STATUS_LABEL.submitted, 'Pending approval');
    assert.equal(STATUS_LABEL.in_transit, 'In transit');
  });

  it('explains what each step does to stock', () => {
    const t = { reference: 'TRF-0001', totalUnits: 12, status: 'in_transit', fromBranch: { name: 'Main Store' }, toBranch: { name: 'North' } };
    assert.match(ACTION_COPY.dispatch(t).message, /Stock will leave Main Store now and be marked in transit to North/);
    assert.match(ACTION_COPY.receive(t).message, /added to North/);
    assert.match(ACTION_COPY.cancel(t).message, /returned to Main Store/);
    assert.match(ACTION_COPY.cancel({ ...t, status: 'approved' }).message, /No stock has moved/);
    assert.match(ACTION_COPY.approve(t).message, /No stock moves until it is dispatched/);
    assert.match(ACTION_COPY.submit(t, { approvalRequired: true }).message, /sent for approval/);
    assert.match(ACTION_COPY.submit(t, { approvalRequired: false }).message, /approved straight away/);
    assert.equal(ACTION_COPY.cancel(t).danger, true);
    assert.equal(ACTION_COPY.reject(t).reason, 'required', 'rejecting needs a reason');
    assert.equal(ACTION_COPY.cancel(t).reason, 'optional');
    assert.equal(ACTION_COPY.dispatch(t).reason, undefined);
  });

  it('builds the CSV for a transfer document', () => {
    const t = { reference: 'TRF-0007', status: 'in_transit', fromBranch: { name: 'Main Store' }, toBranch: { name: 'North' }, transferDate: '2026-11-07T00:00:00.000Z', createdByName: 'Asha', notes: 'Top-up', totalUnits: 15, items: [{ medicineName: 'Dolo 650', batchNumber: 'B1', expiryDate: '2028-01-31T00:00:00.000Z', quantity: 15 }] };
    const rows = transferCsvRows(t, 'E2E Pharmacy');
    assert.deepEqual(rows[0], ['Stock transfer', 'TRF-0007']);
    assert.deepEqual(rows.find((r) => r[0] === 'Status'), ['Status', 'In transit']);
    assert.deepEqual(rows.find((r) => r[0] === 'Dolo 650'), ['Dolo 650', 'B1', '2028-01-31', 15]);
    assert.deepEqual(rows.at(-1), ['Total units', '', '', 15]);
  });
});

describe('line display helpers', () => {
  it('colours expiry dates by how soon they are', () => {
    const day = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();
    assert.equal(expiryTone(day(-2), NOW), 'expired');
    assert.equal(expiryTone(day(0), NOW), 'expired');
    assert.equal(expiryTone(day(20), NOW), 'soon');
    assert.equal(expiryTone(day(80), NOW), 'watch');
    assert.equal(expiryTone(day(400), NOW), 'ok');
  });
  it('the + and − buttons stay between 1 and what is available', () => {
    assert.equal(stepQuantity('5', 1, 10), '6');
    assert.equal(stepQuantity('10', 1, 10), '10');
    assert.equal(stepQuantity('1', -1, 10), '1');
    assert.equal(stepQuantity('', 1, 10), '1');
    assert.equal(stepQuantity('abc', 1, 10), '1');
    assert.equal(stepQuantity('3', 1, null), '4', 'no limit when availability is unknown');
  });
  it('a line shows the medicine’s strength and form under its name, and a saved draft its live availability', () => {
    assert.equal(newLine({ ...batch, strength: '500 mg', dosageForm: 'Tablet' }, 1).subtitle, '500 mg · Tablet');
    const saved = fromTransfer({ fromBranchId: 'a', toBranchId: 'b', transferDate: '2026-11-07', items: [{ batchId: 'b1', quantity: 3, medicineName: 'X', batchNumber: 'B', expiryDate: 'e', availableNow: 40, subtitle: '5 mg · Tablet' }] });
    assert.equal(saved.lines[0].available, 40);
    assert.equal(saved.lines[0].subtitle, '5 mg · Tablet');
  });
});

describe('dispatch screen helpers', () => {
  const transfer = {
    items: [
      { batchId: 'b1', medicineName: 'Dolo 650', batchNumber: 'B1', expiryDate: '2028-01-31', quantity: 20, dispatchedQuantity: 0, remainingQuantity: 20, availableNow: 15 },
      { batchId: 'b2', medicineName: 'Crocin', batchNumber: 'B2', expiryDate: '2028-01-31', quantity: 10, dispatchedQuantity: 10, remainingQuantity: 0, availableNow: 50 },
      { batchId: 'b3', medicineName: 'Calpol', batchNumber: 'B3', expiryDate: '2028-01-31', quantity: 8, dispatchedQuantity: 3, remainingQuantity: 5, availableNow: 100 },
    ],
  };

  it('lists only the lines that still have something to send, with sensible default quantities', () => {
    const lines = dispatchLines(transfer);
    assert.deepEqual(lines.map((l) => l.batchId), ['b1', 'b3'], 'a fully dispatched line is not offered again');
    assert.deepEqual(lines.map((l) => l.quantity), ['15', '5'], 'by default: as much as is approved AND in stock');
    assert.deepEqual([lines[0].approved, lines[0].dispatched, lines[0].remaining, lines[0].available], [20, 0, 20, 15]);
  });

  it('never allows more than the remaining approved quantity, or more than is in stock', () => {
    const lines = dispatchLines(transfer);
    assert.deepEqual(validateDispatch(lines), {});
    assert.match(validateDispatch([{ ...lines[0], quantity: '21' }])['line.0'], /Cannot dispatch more than the 20 still to send \(approved 20\)/);
    assert.match(validateDispatch([{ ...lines[0], quantity: '16' }])['line.0'], /Only 15 units available in stock/);
    assert.match(validateDispatch([{ ...lines[1], quantity: '6' }])['line.0'], /more than the 5 still to send/);
    assert.equal(validateDispatch([{ ...lines[0], quantity: '15' }])['line.0'], undefined, 'exactly what is in stock is fine');
  });

  it('checks the quantity is a whole number, not negative, and not empty', () => {
    const [l] = dispatchLines(transfer);
    assert.match(validateDispatch([{ ...l, quantity: '' }])['line.0'], /Enter a quantity/);
    assert.match(validateDispatch([{ ...l, quantity: 'abc' }])['line.0'], /Enter a quantity/);
    assert.match(validateDispatch([{ ...l, quantity: '2.5' }])['line.0'], /whole number/);
    assert.match(validateDispatch([{ ...l, quantity: '-1' }])['line.0'], /negative/);
  });

  it('needs at least one line above zero; a line left at zero is simply not sent', () => {
    const lines = dispatchLines(transfer);
    assert.match(validateDispatch(lines.map((l) => ({ ...l, quantity: '0' }))).lines, /at least one line/);
    assert.deepEqual(validateDispatch([{ ...lines[0], quantity: '0' }, lines[1]]), {});
  });

  it('shows what will remain after this dispatch', () => {
    const [a, b] = dispatchLines(transfer);
    assert.equal(remainingAfter({ ...a, quantity: '5' }), 15);
    assert.equal(remainingAfter({ ...a, quantity: '20' }), 0);
    assert.equal(remainingAfter({ ...a, quantity: '' }), 20);
    assert.equal(leavesRemainder([{ ...a, quantity: '20' }, { ...b, quantity: '5' }]), false);
    assert.equal(leavesRemainder([{ ...a, quantity: '15' }, { ...b, quantity: '5' }]), true);
  });

  it('builds the request: lines at zero left out, a key to make repeats harmless, and "close short" only when something would remain', () => {
    const [a, b] = dispatchLines(transfer);
    const p = toDispatchPayload([{ ...a, quantity: '0' }, { ...b, quantity: '5' }], { idempotencyKey: 'k-12345678', notes: ' van 7 ' });
    assert.deepEqual(p, { items: [{ batchId: 'b3', quantity: 5 }], closeShort: false, notes: 'van 7', idempotencyKey: 'k-12345678' });
    assert.equal(toDispatchPayload([{ ...a, quantity: '5' }, { ...b, quantity: '5' }], { closeShort: true }).closeShort, true);
    assert.equal(toDispatchPayload([{ ...a, quantity: '20' }, { ...b, quantity: '5' }], { closeShort: true }).closeShort, false, 'nothing left, so nothing to close');
  });

  it('dispatching has its own permission, and works on partially dispatched transfers too', () => {
    assert.equal(permissionFor('dispatch'), 'transfer:dispatch');
    assert.equal(permissionFor('approve'), 'transfer:approve');
    assert.equal(permissionFor('submit'), 'transfer:submit');
    assert.equal(permissionFor('reject'), 'transfer:reject');
    assert.equal(allowed(['transfer:submit'], 'draft', 'submit'), true);
    assert.equal(allowed(['transfer:view'], 'draft', 'submit'), false);
    assert.equal(allowed(['transfer:approve'], 'submitted', 'reject'), true, 'approvers can reject');
    assert.equal(allowed(['transfer:manage'], 'approved', 'dispatch'), false, 'preparing is not dispatching');
    assert.equal(allowed(['transfer:dispatch'], 'approved', 'dispatch'), true);
    assert.equal(allowed(['transfer:dispatch'], 'partially_dispatched', 'dispatch'), true);
    assert.equal(allowed(['transfer:dispatch'], 'in_transit', 'dispatch'), false, 'already fully dispatched');
    assert.equal(can('partially_dispatched', 'receive'), false, 'cannot receive until everything is out');
    assert.equal(can('partially_dispatched', 'cancel'), true);
    assert.equal(STATUS_LABEL.partially_dispatched, 'Partially dispatched');
  });
});

describe('receiving screen helpers', () => {
  const transfer = {
    items: [
      { batchId: 'b1', medicineName: 'Dolo 650', batchNumber: 'B1', unit: 'Strip', dispatchedQuantity: 20, receivedQuantity: 0, damagedQuantity: 0, missingQuantity: 0, remainingToReceive: 20 },
      { batchId: 'b2', medicineName: 'Crocin', batchNumber: 'B2', unit: 'Box', dispatchedQuantity: 10, receivedQuantity: 10, damagedQuantity: 0, missingQuantity: 0, remainingToReceive: 0 },
      { batchId: 'b3', medicineName: 'Calpol', batchNumber: 'B3', dispatchedQuantity: 15, receivedQuantity: 6, damagedQuantity: 2, missingQuantity: 1, remainingToReceive: 6 },
    ],
  };

  it('lists only lines with something still expected, defaulting to "everything arrived"', () => {
    const lines = receiveLines(transfer);
    assert.deepEqual(lines.map((l) => l.batchId), ['b1', 'b3'], 'a fully accounted-for line is not offered again');
    assert.deepEqual(lines.map((l) => l.quantity), ['20', '6']);
    assert.deepEqual([lines[1].dispatched, lines[1].previouslyReceived, lines[1].previouslyReported, lines[1].remaining], [15, 6, 3, 6]);
    assert.equal(lines[0].unit, 'Strip');
    assert.deepEqual(validateReceipt(lines), {}, 'the default is a valid receipt');
  });

  it('never allows more than what is still expected', () => {
    const [a] = receiveLines(transfer);
    assert.match(validateReceipt([{ ...a, quantity: '21' }])['line.0'], /Cannot receive more than the 20 still expected \(dispatched 20, already received 0\)/);
    assert.match(validateReceipt([{ ...a, quantity: '18', damaged: '2', missing: '1', remarks: 'crushed' }])['line.0'], /\(21\) is more than the 20 still expected/);
    assert.deepEqual(validateReceipt([{ ...a, quantity: '17', damaged: '2', missing: '1', remarks: 'crushed' }]), {}, 'exactly what is expected is fine');
  });

  it('supports a partial receipt: the rest stays expected', () => {
    const [a] = receiveLines(transfer);
    const partial = { ...a, quantity: '8' };
    assert.deepEqual(validateReceipt([partial]), {});
    assert.equal(stillExpected(partial), 12);
    assert.equal(leavesExpected([partial]), true);
    assert.equal(leavesExpected([{ ...a, quantity: '20' }]), false);
  });

  it('requires remarks whenever units are damaged or missing', () => {
    const [a] = receiveLines(transfer);
    const damaged = { ...a, quantity: '18', damaged: '2' };
    assert.match(validateReceipt([damaged])['line.0.remarks'], /Explain the damaged or missing units/);
    assert.match(validateReceipt([{ ...damaged, remarks: 'ok' }])['line.0.remarks'], /Explain/, 'a real explanation, not two letters');
    assert.deepEqual(validateReceipt([{ ...damaged, remarks: 'Water damage' }]), {});
    assert.match(validateReceipt([{ ...a, quantity: '19', missing: '1' }])['line.0.remarks'], /Explain/);
    assert.equal(hasLineDiscrepancy({ ...a, damaged: '0', missing: '0' }), false);
    assert.equal(hasLineDiscrepancy({ ...a, missing: '1' }), true);
  });

  it('checks every box holds a whole, non-negative number', () => {
    const [a] = receiveLines(transfer);
    assert.match(validateReceipt([{ ...a, quantity: '' }])['line.0'], /Enter a number/);
    assert.match(validateReceipt([{ ...a, damaged: 'x' }])['line.0'], /Enter a number/);
    assert.match(validateReceipt([{ ...a, quantity: '2.5' }])['line.0'], /whole numbers/);
    assert.match(validateReceipt([{ ...a, quantity: '-1' }])['line.0'], /negative/);
  });

  it('needs something counted on at least one line, unless the receipt is being closed', () => {
    const [a, c] = receiveLines(transfer);
    const none = [{ ...a, quantity: '0' }, { ...c, quantity: '0' }];
    assert.match(validateReceipt(none).lines, /at least one line/);
    assert.deepEqual(validateReceipt(none, { closeReceipt: true, remarks: 'Never loaded' }), {});
  });

  it('closing the receipt needs an explanation', () => {
    const [a] = receiveLines(transfer);
    assert.match(validateReceipt([{ ...a, quantity: '5' }], { closeReceipt: true, remarks: '' }).remarks, /Explain why the rest is not coming/);
    assert.deepEqual(validateReceipt([{ ...a, quantity: '5' }], { closeReceipt: true, remarks: 'Supplier confirmed' }), {});
  });

  it('builds the request: only counted lines, a key for safe retries, and "close" only when something is still expected', () => {
    const [a, c] = receiveLines(transfer);
    const p = toReceivePayload([{ ...a, quantity: '0' }, { ...c, quantity: '4', damaged: '2', remarks: ' crushed ' }], { idempotencyKey: 'rk-12345678', remarks: ' ' });
    assert.deepEqual(p, { items: [{ batchId: 'b3', receivedQuantity: 4, damagedQuantity: 2, missingQuantity: 0, remarks: 'crushed' }], closeReceipt: false, remarks: '', idempotencyKey: 'rk-12345678' });
    assert.equal(toReceivePayload([{ ...a, quantity: '5' }], { closeReceipt: true, remarks: 'x y z' }).closeReceipt, true);
    assert.equal(toReceivePayload([{ ...a, quantity: '20' }], { closeReceipt: true, remarks: 'x y z' }).closeReceipt, false, 'nothing is left to close');
  });

  it('receiving has its own permission and works on partially received transfers, but they cannot be cancelled', () => {
    assert.equal(permissionFor('receive'), 'transfer:receive');
    assert.equal(allowed(['transfer:manage'], 'in_transit', 'receive'), false, 'preparing is not receiving');
    assert.equal(allowed(['transfer:receive'], 'in_transit', 'receive'), true);
    assert.equal(allowed(['transfer:receive'], 'partially_received', 'receive'), true);
    assert.equal(allowed(['transfer:receive'], 'partially_dispatched', 'receive'), false, 'not until fully dispatched');
    assert.equal(can('partially_received', 'cancel'), false);
    assert.equal(awaitsReceipt('in_transit'), true);
    assert.equal(awaitsReceipt('completed'), false);
    assert.equal(STATUS_LABEL.partially_received, 'Partially received');
  });

  it('the new form fields: an expected arrival cannot precede the transfer date; both are optional', () => {
    const t = { ...good(), expectedArrivalDate: '' };
    assert.deepEqual(validateTransfer(t), {});
    assert.deepEqual(validateTransfer({ ...t, expectedArrivalDate: '2026-11-09' }), {});
    assert.match(validateTransfer({ ...t, expectedArrivalDate: '2026-11-01' }).expectedArrivalDate, /cannot be before the transfer date/);
    assert.match(validateTransfer({ ...t, expectedArrivalDate: '2026-02-30' }).expectedArrivalDate, /Not a real/);
    assert.match(validateTransfer({ ...t, internalRemarks: 'x'.repeat(501) }).internalRemarks, /500/);
    assert.equal(toPayload({ ...t, expectedArrivalDate: '2026-11-09', internalRemarks: ' ask Ravi ' }).internalRemarks, 'ask Ravi');
    const loaded = fromTransfer({ fromBranchId: 'a', toBranchId: 'b', transferDate: '2026-11-07T00:00:00.000Z', expectedArrivalDate: '2026-11-09T00:00:00.000Z', internalRemarks: 'r', items: [] });
    assert.equal(loaded.expectedArrivalDate, '2026-11-09');
    assert.equal(loaded.internalRemarks, 'r');
  });
});
