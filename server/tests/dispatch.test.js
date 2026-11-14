// Dispatching approved transfers: the dispatch screen's data, partial dispatch and remaining quantities, validation against approved /
// available / reserved stock, atomicity, unique references, permanent records, duplicate-submission protection, permissions, isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let main;
let north;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const TODAY = new Date().toISOString().slice(0, 10);

const medicine = async (client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Dispatch Med'), reorderLevel: 5, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const receiveStock = async (client, medicineId, quantity, extra = {}) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('LOT'), expiryDate: futureDate(2), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: quantity, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const stocked = async (qty = 100, client = T.client) => {
  const m = await medicine(client, { strength: '500 mg', dosageForm: 'Tablet' });
  return { m, b: await receiveStock(client, m._id, qty) };
};
const body = (items, over = {}) => ({ fromBranchId: main._id, toBranchId: north._id, transferDate: TODAY, notes: '', items, ...over });
/** An APPROVED transfer (approval is off by default, so submitting approves it). */
const approved = async (items, over = {}, client = T.client) => {
  const d = await client.post('/transfers', body(items, over));
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const s = await client.post(`/transfers/${d.data._id}/submit`);
  assert.equal(s.data.status, 'approved', JSON.stringify(s.body));
  return s.data;
};
const dispatch = (id, payload, client = T.client) => client.post(`/transfers/${id}/dispatch`, payload);
const get = async (id, client = T.client) => (await client.get(`/transfers/${id}`)).data;
const batchOf = async (id, client = T.client) => (await client.get(`/batches/${id}`)).data;
const reconciled = async (client = T.client) => (await client.get('/stock/reconciliation')).data.consistent;
const asRole = async (role, permissions) => {
  const u = await h.makeUser(T.org, { role, ...(permissions && { permissions }) });
  const c = h.client();
  await c.login(u.email);
  return { c, u };
};
const key = () => `key-${++n}-${Date.now()}`;

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Dispatch Org');
  other = await h.makeTenant('Dispatch Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
  north = (await T.client.post('/branches', { name: 'North Branch Store', code: 'NORTH' })).data;
});

after(async () => {
  await h?.stop();
});

describe('The dispatch screen’s data', () => {
  it('shows each line with its approved, dispatched and remaining quantity and what is available now', async () => {
    const { b } = await stocked(40);
    const t = await approved([{ batchId: b._id, quantity: 25 }]);
    const got = await get(t._id);
    assert.equal(got.status, 'approved');
    assert.equal(got.reference, t.reference);
    assert.equal(got.fromBranch.name, 'Main Store');
    assert.equal(got.toBranch.name, 'North Branch Store');
    const line = got.items[0];
    assert.equal(line.medicineName, b.medicineName ?? line.medicineName);
    assert.equal(line.batchNumber, b.batchNumber);
    assert.equal(line.quantity, 25, 'approved quantity');
    assert.equal(line.dispatchedQuantity, 0);
    assert.equal(line.remainingQuantity, 25);
    assert.equal(line.availableNow, 40, 'live stock, not the snapshot');
    assert.equal(line.subtitle, '500 mg · Tablet');
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -30, reason: 'Stock take: ten left' });
    assert.equal((await get(t._id)).items[0].availableNow, 10, 'it follows the batch');
  });
});

describe('Dispatching', () => {
  it('dispatching everything creates a dispatch record with a unique reference, the date and the user, and moves the stock', async () => {
    const { b } = await stocked(50);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    const before = Date.now();
    const r = await dispatch(t._id, { idempotencyKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.status, 'in_transit');
    const d = r.data.dispatch;
    assert.match(d.reference, /^DSP-[0-9]{4}$/);
    assert.equal(d.transferReference, t.reference);
    assert.equal(String(d.dispatchedBy), String(T.user._id));
    assert.ok(Math.abs(new Date(d.dispatchedAt).getTime() - before) < 15000, 'dispatch date is now');
    assert.equal(d.totalUnits, 20);
    assert.deepEqual([d.items[0].approvedQuantity, d.items[0].previouslyDispatched, d.items[0].dispatchedQuantity, d.items[0].remainingQuantity, d.items[0].balanceAfter], [20, 0, 20, 0, 30]);
    assert.equal(String(d.fromBranchId), String(main._id));
    assert.equal(String(d.toBranchId), String(north._id));
    assert.equal((await batchOf(b._id)).availableQuantity, 30);
    const after = await get(t._id);
    assert.equal(String(after.dispatchedBy), String(T.user._id));
    assert.ok(after.dispatchedAt);
    assert.equal(after.dispatches.length, 1);
    assert.equal(after.dispatchedUnits, 20);
    assert.ok(await reconciled());
  });

  it('writes an immutable stock movement that points at the dispatch', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 12 }]);
    const { data } = await dispatch(t._id, {});
    const ledger = (await T.client.get(`/batches/${b._id}/movements`)).data.items[0];
    assert.deepEqual([ledger.type, ledger.quantity, ledger.balanceAfter, ledger.refType], ['TRANSFER_OUT', -12, 18, 'Dispatch']);
    assert.match(ledger.reason, new RegExp(`Dispatch ${data.dispatch.reference} for transfer ${t.reference}`));
    assert.equal(String(ledger.refId), String(data.dispatch._id));
    await assert.rejects(h.tenant.runWithTenant(T.org._id, () => h.models.StockMovement.updateMany({}, { quantity: 1 })), /append-only/);
  });

  it('gives every dispatch its own reference, counted per organization', async () => {
    const { b } = await stocked(50);
    const t = await approved([{ batchId: b._id, quantity: 10 }, ]);
    const first = (await dispatch(t._id, { items: [{ batchId: b._id, quantity: 4 }] })).data.dispatch.reference;
    const second = (await dispatch(t._id, { items: [{ batchId: b._id, quantity: 6 }] })).data.dispatch.reference;
    assert.notEqual(first, second);
    assert.equal(Number(second.slice(4)), Number(first.slice(4)) + 1);
    const theirs = await stocked(10, other.client);
    const o = other.client;
    const oBranches = (await o.get('/branches')).data;
    const oSecond = (await o.post('/branches', { name: 'Their Second', code: 'T2' })).data;
    const ot = (await o.post('/transfers', { fromBranchId: oBranches[0]._id, toBranchId: oSecond._id, transferDate: TODAY, items: [{ batchId: theirs.b._id, quantity: 2 }] })).data;
    await o.post(`/transfers/${ot._id}/submit`);
    assert.equal((await dispatch(ot._id, {}, o)).data.dispatch.reference, 'DSP-0001', 'another organization has its own numbering');
  });

  it('can be sent in parts: the transfer stays "partially dispatched" until every line is out, then goes in transit', async () => {
    const { m, b } = await stocked(60);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    const p1 = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 8 }] });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.data.status, 'partially_dispatched');
    assert.deepEqual([p1.data.items[0].dispatchedQuantity, p1.data.items[0].remainingQuantity], [8, 12]);
    assert.equal(p1.data.dispatch.items[0].remainingQuantity, 12);
    assert.equal((await batchOf(b._id)).availableQuantity, 52);
    assert.equal((await dispatch(t._id, {})).status, 200, 'a partially dispatched transfer can be dispatched again');
    const done = await get(t._id);
    assert.equal(done.status, 'in_transit');
    assert.equal(done.dispatches.length, 2);
    assert.equal(done.dispatchedUnits, 20);
    assert.deepEqual(done.timeline.map((e) => e.event), ['created', 'submitted', 'approved', 'dispatched', 'dispatched']);
    assert.ok(done.timeline.filter((e) => e.event === 'dispatched').every((e) => e.ref && e.by));

    assert.equal((await T.client.post(`/transfers/${t._id}/receive`)).status, 200);
    const received = (await T.client.get(`/batches?medicineId=${m._id}&branchId=${north._id}`)).data.items;
    assert.equal(received[0].availableQuantity, 20, 'everything that was sent arrives');
    assert.equal(received.length, 1, 'in one batch');
    assert.ok(await reconciled());
  });

  it('a partly dispatched transfer cannot be received yet', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    await dispatch(t._id, { items: [{ batchId: b._id, quantity: 4 }] });
    const r = await T.client.post(`/transfers/${t._id}/receive`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'TRANSFER_STATE');
  });

  it('lines can be dispatched separately: a multi-line transfer goes out line by line', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 10);
    const c = await receiveStock(T.client, m._id, 10);
    const t = await approved([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 5 }]);
    const r1 = await dispatch(t._id, { items: [{ batchId: a._id, quantity: 10 }] });
    assert.equal(r1.data.status, 'partially_dispatched');
    assert.equal((await batchOf(c._id)).availableQuantity, 10, 'the other line has not moved');
    const r2 = await dispatch(t._id, {});
    assert.equal(r2.data.status, 'in_transit');
    assert.deepEqual(r2.data.dispatch.items.map((i) => i.batchNumber), [c.batchNumber], 'with no lines given, only what is still to be sent goes');
  });

  it('can be closed short: the unsent remainder is dropped and only what was sent is received', async () => {
    const { m, b } = await stocked(40);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    const r = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 8 }], closeShort: true });
    assert.equal(r.data.status, 'in_transit');
    assert.equal(r.data.closedShort, true);
    assert.equal(r.data.dispatch.closedShort, true);
    assert.equal(r.data.items[0].remainingQuantity, 12, 'the record still shows what was approved and not sent');
    assert.equal((await dispatch(t._id, {})).status, 409, 'nothing more can be dispatched');
    await T.client.post(`/transfers/${t._id}/receive`);
    assert.equal((await T.client.get(`/batches?medicineId=${m._id}&branchId=${north._id}`)).data.items[0].availableQuantity, 8);
    assert.equal((await batchOf(b._id)).availableQuantity, 32);
    assert.ok(await reconciled());
  });

  it('closing short is ignored when everything was sent anyway', async () => {
    const { b } = await stocked(10);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    const r = await dispatch(t._id, { closeShort: true });
    assert.equal(r.data.dispatch.closedShort, false);
    assert.equal(r.data.closedShort, undefined);
  });

  it('cancelling after a partial dispatch returns only what was sent', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    await dispatch(t._id, { items: [{ batchId: b._id, quantity: 7 }] });
    assert.equal((await batchOf(b._id)).availableQuantity, 23);
    const c = await T.client.post(`/transfers/${t._id}/cancel`, { reason: 'Changed plan' });
    assert.equal(c.data.status, 'cancelled');
    assert.equal((await batchOf(b._id)).availableQuantity, 30, 'exactly the 7 sent units came back');
    assert.ok(await reconciled());
  });
});

describe('Validation', () => {
  it('never dispatches more than was approved, and says how much is still to send', async () => {
    const { b } = await stocked(100);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    const over = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 21 }] });
    assert.equal(over.status, 400);
    assert.equal(over.body.code, 'DISPATCH_INVALID');
    assert.equal(over.body.details[0].path, 'items.0.quantity');
    assert.match(over.body.details[0].message, /Cannot dispatch more than the 20 still to send \(approved 20\)/);
    assert.equal((await batchOf(b._id)).availableQuantity, 100, 'nothing moved');

    await dispatch(t._id, { items: [{ batchId: b._id, quantity: 8 }] });
    const again = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 13 }] });
    assert.equal(again.status, 400);
    assert.match(again.body.details[0].message, /Cannot dispatch more than the 12 still to send \(approved 20\)/, 'the limit shrinks as stock goes out');
    assert.equal((await dispatch(t._id, { items: [{ batchId: b._id, quantity: 12 }] })).status, 200);
    assert.equal((await batchOf(b._id)).availableQuantity, 80);
  });

  it('rejects malformed requests', async () => {
    const { b } = await stocked(50);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    const bad = async (payload, fragment) => {
      const r = await dispatch(t._id, payload);
      assert.equal(r.status, 400, JSON.stringify(payload));
      if (fragment) assert.match(JSON.stringify(r.body), fragment);
    };
    await bad({ items: [] }, /at least one line/);
    await bad({ items: [{ batchId: b._id, quantity: 0 }] }, /at least 1/);
    await bad({ items: [{ batchId: b._id, quantity: -2 }] });
    await bad({ items: [{ batchId: b._id, quantity: 2.5 }] }, /whole number/);
    await bad({ items: [{ batchId: b._id, quantity: 'many' }] });
    await bad({ items: [{ batchId: 'nope', quantity: 1 }] });
    await bad({ items: [{ batchId: b._id, quantity: 1 }, { batchId: b._id, quantity: 1 }] }, /already on the dispatch/);
    await bad({ items: [{ batchId: '0'.repeat(24), quantity: 1 }] }, /not part of the transfer/);
    await bad({ closeShort: 'yes' });
    await bad({ notes: 'x'.repeat(301) });
    await bad({ idempotencyKey: 'short' }, /at least 8/);
    assert.equal((await batchOf(b._id)).availableQuantity, 50, 'none of them moved stock');
    assert.equal((await get(t._id)).status, 'approved');
  });

  it('checks real stock at dispatch time: available minus reserved, expiry and batch status', async () => {
    const { b } = await stocked(10);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    await T.client.patch(`/batches/${b._id}`, { reservedQuantity: 8 });
    const r = await dispatch(t._id, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'INSUFFICIENT_STOCK');
    assert.match(r.body.message, /only 2 unit\(s\) are available \(10 on hand, 8 reserved\)/);
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
    assert.equal((await get(t._id)).status, 'approved', 'still approved, ready to try again');

    await T.client.patch(`/batches/${b._id}`, { reservedQuantity: 0 });
    await T.client.patch(`/batches/${b._id}`, { status: 'quarantined' });
    assert.match((await dispatch(t._id, {})).body.message, /the batch is quarantined/);
    await T.client.patch(`/batches/${b._id}`, { status: 'active' });
    await h.models.Batch.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(b._id) }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
    assert.match((await dispatch(t._id, {})).body.message, /the batch has expired/);
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
  });

  it('stock that was written off after approval cannot be dispatched', async () => {
    const { b } = await stocked(10);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -6, reason: 'Damaged after approval' });
    const r = await dispatch(t._id, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.details[0].path, 'items.0.quantity');
    const partial = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 4 }] });
    assert.equal(partial.status, 200, 'what IS available can still be sent');
    assert.equal(partial.data.status, 'partially_dispatched');
  });

  it('only an approved (or partially dispatched) transfer can be dispatched', async () => {
    const { b } = await stocked(30);
    const line = [{ batchId: b._id, quantity: 2 }];
    const draft = (await T.client.post('/transfers', body(line))).data;
    assert.equal((await dispatch(draft._id, {})).status, 409, 'a draft');
    const t2 = await approved(line);
    await T.client.post(`/transfers/${t2._id}/cancel`);
    assert.equal((await dispatch(t2._id, {})).status, 409, 'cancelled');
    const t3 = await approved(line);
    await dispatch(t3._id, {});
    assert.equal((await dispatch(t3._id, {})).status, 409, 'already in transit');
    await T.client.post(`/transfers/${t3._id}/receive`);
    assert.equal((await dispatch(t3._id, {})).status, 409, 'completed');
    assert.equal((await dispatch('not-an-id', {})).status, 404);
    assert.equal((await dispatch('0'.repeat(24), {})).status, 404);
  });

  it('is not possible before approval when approval is required', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { b } = await stocked(10);
      const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
      await T.client.post(`/transfers/${d._id}/submit`);
      assert.equal((await get(d._id)).status, 'submitted');
      assert.equal((await dispatch(d._id, {})).status, 409);
      await T.client.post(`/transfers/${d._id}/approve`);
      assert.equal((await dispatch(d._id, {})).status, 200);
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false });
    }
  });
});

describe('All or nothing', () => {
  it('one line that cannot be sent stops the whole dispatch: no stock, no ledger entry, no dispatch record, no reference used', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 20);
    const c = await receiveStock(T.client, m._id, 20);
    const t = await approved([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 10 }]);
    const okRef = (await dispatch((await approved([{ batchId: a._id, quantity: 1 }]))._id, {})).data.dispatch.reference;
    await T.client.post('/stock/adjustments', { batchId: c._id, quantity: -15, reason: 'Damaged before dispatch' });
    const r = await dispatch(t._id, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.details[0].path, 'items.1.quantity');
    assert.equal((await batchOf(a._id)).availableQuantity, 19, 'the first line was not taken');
    const after = await get(t._id);
    assert.equal(after.status, 'approved');
    assert.equal(after.dispatches.length, 0, 'no dispatch record');
    assert.equal(after.items[0].dispatchedQuantity, 0);
    assert.equal((await T.client.get(`/batches/${a._id}/movements`)).data.items.filter((x) => x.refType === 'Dispatch').length, 1, 'only the earlier, successful dispatch');
    const next = (await dispatch(t._id, { items: [{ batchId: a._id, quantity: 10 }] })).data.dispatch.reference;
    assert.equal(Number(next.slice(4)), Number(okRef.slice(4)) + 1, 'the failed attempt did not use up a dispatch number');
    assert.ok(await reconciled());
  });

  it('two different dispatches racing for the same stock never overdraw it', async () => {
    const { b } = await stocked(10);
    const t1 = await approved([{ batchId: b._id, quantity: 8 }]);
    const t2 = await approved([{ batchId: b._id, quantity: 8 }]);
    const [x, y] = await Promise.all([dispatch(t1._id, {}), dispatch(t2._id, {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((x.status === 409 ? x : y).body.code, 'INSUFFICIENT_STOCK');
    assert.equal((await batchOf(b._id)).availableQuantity, 2);
    assert.ok(await reconciled());
  });
});

describe('Duplicate submissions', () => {
  it('repeating a dispatch with the same key returns the original and sends nothing twice', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    const k = key();
    const first = await dispatch(t._id, { idempotencyKey: k });
    const second = await dispatch(t._id, { idempotencyKey: k });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.data.duplicate, false);
    assert.equal(second.data.duplicate, true);
    assert.equal(second.data.dispatch.reference, first.data.dispatch.reference);
    assert.equal((await batchOf(b._id)).availableQuantity, 20, 'the stock moved once');
    assert.equal((await get(t._id)).dispatches.length, 1);
  });

  it('a double click (two requests at the same moment with the same key) dispatches once', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 12 }]);
    const k = key();
    const [x, y] = await Promise.all([dispatch(t._id, { idempotencyKey: k }), dispatch(t._id, { idempotencyKey: k })]);
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.equal(y.status, 200, JSON.stringify(y.body));
    assert.deepEqual([x.data.duplicate, y.data.duplicate].sort(), [false, true]);
    assert.equal(x.data.dispatch.reference, y.data.dispatch.reference);
    assert.equal((await batchOf(b._id)).availableQuantity, 18);
    assert.equal((await get(t._id)).dispatches.length, 1);
    assert.ok(await reconciled());
  });

  it('two dispatches of the same transfer without a key also send it only once', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 9 }]);
    const [x, y] = await Promise.all([dispatch(t._id, {}), dispatch(t._id, {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((await batchOf(b._id)).availableQuantity, 21);
    assert.equal((await get(t._id)).dispatches.length, 1);
  });

  it('a key belongs to one transfer, and keys are private to each organization', async () => {
    const a = await stocked(20);
    const b2 = await stocked(20);
    const t1 = await approved([{ batchId: a.b._id, quantity: 3 }]);
    const t2 = await approved([{ batchId: b2.b._id, quantity: 3 }]);
    const k = key();
    await dispatch(t1._id, { idempotencyKey: k });
    const reused = await dispatch(t2._id, { idempotencyKey: k });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await batchOf(b2.b._id)).availableQuantity, 20);

    const theirs = await stocked(10, other.client);
    const oSecond = (await other.client.post('/branches', { name: uniq('Their Store'), code: uniq('TS') })).data;
    const ot = (await other.client.post('/transfers', { fromBranchId: (await other.client.get('/branches')).data.find((s) => s.isDefault)._id, toBranchId: oSecond._id, transferDate: TODAY, items: [{ batchId: theirs.b._id, quantity: 2 }] })).data;
    await other.client.post(`/transfers/${ot._id}/submit`);
    const sameKey = await dispatch(ot._id, { idempotencyKey: k }, other.client);
    assert.equal(sameKey.status, 200, 'the same key text in another organization is unrelated');
    assert.equal(sameKey.data.duplicate, false);
  });
});

describe('Permanent records', () => {
  it('a dispatch record can never be changed or deleted, by any route', async () => {
    const { b } = await stocked(20);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    const { data } = await dispatch(t._id, { notes: 'Van 7' });
    const { Dispatch, DispatchImmutableError } = h.models;
    const run = (fn) => h.tenant.runWithTenant(T.org._id, fn);
    await assert.rejects(run(() => Dispatch.updateOne({ _id: data.dispatch._id }, { $set: { totalUnits: 999 } })), DispatchImmutableError);
    await assert.rejects(run(() => Dispatch.updateMany({}, { notes: 'x' })), DispatchImmutableError);
    await assert.rejects(run(() => Dispatch.findOneAndUpdate({ _id: data.dispatch._id }, { notes: 'x' })), DispatchImmutableError);
    await assert.rejects(run(() => Dispatch.deleteOne({ _id: data.dispatch._id })), DispatchImmutableError);
    await assert.rejects(run(() => Dispatch.deleteMany({})), DispatchImmutableError);
    await assert.rejects(run(async () => {
      const doc = await Dispatch.findById(data.dispatch._id);
      doc.notes = 'edited';
      await doc.save();
    }), DispatchImmutableError);
    await assert.rejects(run(async () => (await Dispatch.findById(data.dispatch._id)).deleteOne()), DispatchImmutableError);
    const still = (await get(t._id)).dispatches[0];
    assert.equal(still.totalUnits, 5);
    assert.equal(still.notes, 'Van 7');
  });

  it('cancelling a transfer keeps its dispatch records', async () => {
    const { b } = await stocked(20);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    const ref = (await dispatch(t._id, {})).data.dispatch.reference;
    await T.client.post(`/transfers/${t._id}/cancel`);
    assert.equal((await get(t._id)).dispatches[0].reference, ref);
  });

  it('there is no API to edit or delete a dispatch', async () => {
    const { b } = await stocked(20);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    const { data } = await dispatch(t._id, {});
    for (const [method, url] of [['PUT', `/transfers/${t._id}/dispatch`], ['DELETE', `/transfers/${t._id}/dispatch`], ['DELETE', `/transfers/${data.dispatch._id}`], ['PATCH', `/transfers/${t._id}/dispatch`]]) {
      const r = await T.client.request(method, url, { body: {} });
      assert.ok([404, 409, 405].includes(r.status), `${method} ${url} -> ${r.status}`);
    }
    assert.equal((await get(t._id)).dispatches.length, 1);
  });
});

describe('Who may dispatch, and organization isolation', () => {
  it('needs the dispatch permission; preparing or approving is not enough', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 3 }]);
    const staff = (await asRole('STAFF')).c;
    const billing = (await asRole('BILLING_STAFF')).c;
    const preparerOnly = (await asRole('STAFF', ['transfer:manage'])).c;
    const approverOnly = (await asRole('STAFF', ['transfer:approve'])).c;
    for (const c of [staff, billing, preparerOnly, approverOnly]) assert.equal((await dispatch(t._id, {}, c)).status, 403);
    assert.equal((await dispatch(t._id, {}, h.client())).status, 401);
    assert.equal((await get(t._id)).status, 'approved', 'nothing happened');
    const inv = (await asRole('INVENTORY_MANAGER')).c;
    assert.equal((await dispatch(t._id, { items: [{ batchId: b._id, quantity: 1 }] }, inv)).status, 200);
    const mgr = (await asRole('BRANCH_MANAGER')).c;
    assert.equal((await dispatch(t._id, {}, mgr)).status, 200);
  });

  it('records the first dispatcher on the transfer and each dispatcher on their own dispatch', async () => {
    const { b } = await stocked(30);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    const { c, u } = await asRole('INVENTORY_MANAGER');
    const first = await dispatch(t._id, { items: [{ batchId: b._id, quantity: 4 }] }, c);
    const second = await dispatch(t._id, {});
    const got = await get(t._id);
    assert.equal(String(got.dispatchedBy), String(u._id), 'the transfer remembers who started dispatching');
    assert.equal(String(first.data.dispatch.dispatchedBy), String(u._id));
    assert.equal(String(second.data.dispatch.dispatchedBy), String(T.user._id));
    assert.ok(new Date(got.lastDispatchedAt) >= new Date(got.dispatchedAt));
    assert.deepEqual(got.timeline.filter((e) => e.event === 'dispatched').map((e) => e.by), [u.name, T.user.name]);
  });

  it('another organization cannot dispatch, see or reuse my transfer’s dispatches', async () => {
    const { b } = await stocked(20);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    assert.equal((await dispatch(t._id, {}, other.client)).status, 404);
    assert.equal((await dispatch(t._id, { idempotencyKey: key() }, other.client)).status, 404);
    assert.equal((await get(t._id)).status, 'approved');
    await dispatch(t._id, {});
    assert.equal((await other.client.get(`/transfers/${t._id}`)).status, 404);
    assert.equal((await batchOf(b._id)).availableQuantity, 15);
  });

  it('request bodies cannot name another organization or set the record’s own fields', async () => {
    const { b } = await stocked(20);
    const t = await approved([{ batchId: b._id, quantity: 5 }]);
    const r = await dispatch(t._id, { organizationId: other.org._id, reference: 'DSP-9999', dispatchedBy: other.user._id, dispatchedAt: '2000-01-01', totalUnits: 99 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.data.dispatch.reference, 'DSP-9999');
    assert.equal(String(r.data.dispatch.organizationId), String(T.org._id));
    assert.equal(String(r.data.dispatch.dispatchedBy), String(T.user._id));
    assert.equal(r.data.dispatch.totalUnits, 5);
    assert.ok(new Date(r.data.dispatch.dispatchedAt) > new Date('2020-01-01'));
  });
});

describe('Lists and summaries', () => {
  it('a partly dispatched transfer counts as in transit, and can be filtered', async () => {
    const before = (await T.client.get('/transfers/summary')).data;
    const { b } = await stocked(50);
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    await dispatch(t._id, { items: [{ batchId: b._id, quantity: 5 }] });
    const after = (await T.client.get('/transfers/summary')).data;
    assert.equal(after.inTransit - before.inTransit, 1);
    assert.equal(after.byStatus.partially_dispatched, (before.byStatus.partially_dispatched || 0) + 1);
    const ids = async (q) => (await T.client.get(`/transfers?limit=100&${q}`)).data.items.map((x) => x._id);
    assert.ok((await ids('status=partially_dispatched')).includes(t._id));
    assert.ok((await ids('status=transit')).includes(t._id));
    assert.ok(!(await ids('status=pending')).includes(t._id));
    assert.ok(!(await ids('status=in_transit')).includes(t._id));
    const transit = (await T.client.get('/transfers/in-transit')).data;
    assert.ok(transit.units >= 5 && transit.transfers >= 1, 'only the dispatched 5 are on the road, not the unsent 15');
  });

  it('shows how many units are in transit by what was actually dispatched', async () => {
    const { b } = await stocked(50);
    const base = (await T.client.get('/transfers/in-transit')).data.units;
    const t = await approved([{ batchId: b._id, quantity: 20 }]);
    await dispatch(t._id, { items: [{ batchId: b._id, quantity: 6 }] });
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base + 6);
    await dispatch(t._id, {});
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base + 20);
    await T.client.post(`/transfers/${t._id}/receive`);
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base);
  });
});

describe('Transfers dispatched before partial dispatch existed', () => {
  it('are still received and cancelled correctly (everything that was approved is treated as sent)', async () => {
    const { m, b } = await stocked(40);
    const t = await approved([{ batchId: b._id, quantity: 10 }]);
    await dispatch(t._id, {});
    await h.models.Transfer.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(t._id) }, { $unset: { 'items.0.dispatchedQuantity': '' } });
    const legacy = await get(t._id);
    assert.equal(legacy.items[0].dispatchedQuantity, 10);
    assert.equal(legacy.items[0].remainingQuantity, 0);
    assert.equal((await T.client.post(`/transfers/${t._id}/receive`)).status, 200);
    assert.equal((await T.client.get(`/batches?medicineId=${m._id}&branchId=${north._id}`)).data.items[0].availableQuantity, 10);

    const t2 = await approved([{ batchId: b._id, quantity: 5 }]);
    await dispatch(t2._id, {});
    await h.models.Transfer.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(t2._id) }, { $unset: { 'items.0.dispatchedQuantity': '' } });
    await T.client.post(`/transfers/${t2._id}/cancel`);
    assert.equal((await batchOf(b._id)).availableQuantity, 30, '40 - 10 (received elsewhere), and the cancelled 5 are back');
    assert.ok(await reconciled());
  });
});
