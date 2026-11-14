// Receiving transfers at the destination: the receiving screen's data, partial receipts, discrepancies (damaged / missing / short) with
// required remarks, "no credit until confirmed", atomicity, automatic status, permanent receipt records, duplicate protection,
// permissions, and the transfer's complete event history.
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
  const r = await client.post('/inventory', { medicineName: uniq('Receive Med'), reorderLevel: 5, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const receiveStock = async (client, medicineId, quantity, extra = {}) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('LOT'), expiryDate: futureDate(2), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: quantity, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const stocked = async (qty = 100, client = T.client) => {
  const m = await medicine(client, { unit: 'Strip' });
  return { m, b: await receiveStock(client, m._id, qty) };
};
const body = (items, over = {}) => ({ fromBranchId: main._id, toBranchId: north._id, transferDate: TODAY, notes: '', items, ...over });
/** A transfer that has been dispatched in full: the units are on the road. */
const inTransit = async (items, over = {}, client = T.client) => {
  const d = await client.post('/transfers', body(items, over));
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal((await client.post(`/transfers/${d.data._id}/submit`)).status, 200);
  const s = await client.post(`/transfers/${d.data._id}/dispatch`, {});
  assert.equal(s.data.status, 'in_transit', JSON.stringify(s.body));
  return s.data;
};
const receive = (id, payload, client = T.client) => client.post(`/transfers/${id}/receive`, payload);
const get = async (id, client = T.client) => (await client.get(`/transfers/${id}`)).data;
const events = async (id, client = T.client) => (await client.get(`/transfers/${id}/events?limit=100`)).data;
const batchOf = async (id, client = T.client) => (await client.get(`/batches/${id}`)).data;
const northUnits = async (medicineId) => (await T.client.get(`/batches?medicineId=${medicineId}&branchId=${north._id}`)).data.items.reduce((s, b) => s + b.availableQuantity, 0);
const reconciled = async (client = T.client) => (await client.get('/stock/reconciliation')).data.consistent;
const asRole = async (role, permissions) => {
  const u = await h.makeUser(T.org, { role, ...(permissions && { permissions }) });
  const c = h.client();
  await c.login(u.email);
  return { c, u };
};
const key = () => `rkey-${++n}-${Date.now()}`;

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Receive Org');
  other = await h.makeTenant('Receive Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
  north = (await T.client.post('/branches', { name: 'North Branch Store', code: 'NORTH' })).data;
});

after(async () => {
  await h?.stop();
});

describe('The receiving screen’s data', () => {
  it('shows the dispatched, previously received and remaining quantity of each line, with the dispatch date', async () => {
    const { b } = await stocked(40);
    const t = await inTransit([{ batchId: b._id, quantity: 25 }]);
    const got = await get(t._id);
    assert.equal(got.reference, t.reference);
    assert.equal(got.fromBranch.name, 'Main Store');
    assert.equal(got.toBranch.name, 'North Branch Store');
    assert.ok(got.dispatches[0].dispatchedAt, 'the dispatch date');
    assert.ok(got.dispatchedAt);
    const line = got.items[0];
    assert.equal(line.medicineName.startsWith('Receive Med'), true);
    assert.equal(line.batchNumber, b.batchNumber);
    assert.deepEqual([line.dispatchedQuantity, line.receivedQuantity, line.damagedQuantity, line.missingQuantity, line.remainingToReceive], [25, 0, 0, 0, 25]);
    assert.equal(line.unit, 'Strip', 'the unit is snapshotted');
    assert.equal(line.requestedQuantity, 25);
    assert.equal(line.approvedQuantity, 25);
  });

  it('credits nothing to the destination until the receipt is confirmed', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 12 }]);
    assert.equal(await northUnits(m._id), 0, 'dispatched stock is on the road, not in the destination');
    assert.equal((await batchOf(b._id)).availableQuantity, 18);
    assert.equal((await get(t._id)).status, 'in_transit');
    assert.equal((await T.client.get('/transfers/in-transit')).data.units >= 12, true);
    await receive(t._id, {});
    assert.equal(await northUnits(m._id), 12);
  });
});

describe('Receiving', () => {
  it('confirming a full receipt credits the destination, records who and when, and completes the transfer automatically', async () => {
    const { m, b } = await stocked(50);
    const t = await inTransit([{ batchId: b._id, quantity: 20 }]);
    const before = Date.now();
    const r = await receive(t._id, { idempotencyKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.status, 'completed');
    const rc = r.data.receipt;
    assert.match(rc.reference, /^RCV-[0-9]{4}$/);
    assert.equal(rc.transferReference, t.reference);
    assert.equal(String(rc.receivedBy), String(T.user._id));
    assert.equal(rc.receivedByName, T.user.name);
    assert.ok(Math.abs(new Date(rc.receivedAt).getTime() - before) < 15000, 'receiving time is now');
    assert.deepEqual([rc.totalReceived, rc.totalDamaged, rc.totalMissing], [20, 0, 0]);
    assert.deepEqual([rc.items[0].dispatchedQuantity, rc.items[0].previouslyReceived, rc.items[0].receivedQuantity, rc.items[0].remainingQuantity, rc.items[0].balanceAfter], [20, 0, 20, 0, 20]);
    assert.equal(await northUnits(m._id), 20);
    const after = await get(t._id);
    assert.equal(String(after.receivedBy), String(T.user._id));
    assert.ok(after.receivedAt);
    assert.equal(after.receivedUnits, 20);
    assert.equal(after.hasDiscrepancy, false);
    assert.ok(await reconciled());
  });

  it('writes a TRANSFER_IN ledger entry that points at the receipt', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 9 }]);
    const { data } = await receive(t._id, {});
    const dest = (await T.client.get(`/batches?medicineId=${m._id}&branchId=${north._id}`)).data.items[0];
    const ledger = (await T.client.get(`/batches/${dest._id}/movements`)).data.items[0];
    assert.deepEqual([ledger.type, ledger.quantity, ledger.balanceAfter, ledger.refType], ['TRANSFER_IN', 9, 9, 'Receipt']);
    assert.match(ledger.reason, new RegExp(`Receipt ${data.receipt.reference} for transfer ${t.reference} from Main Store`));
    assert.equal(String(ledger.refId), String(data.receipt._id));
  });

  it('supports partial receipt: the transfer stays "partially received" until every unit is accounted for', async () => {
    const { m, b } = await stocked(60);
    const t = await inTransit([{ batchId: b._id, quantity: 20 }]);
    const p1 = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 8 }] });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.data.status, 'partially_received');
    const line = p1.data.items[0];
    assert.deepEqual([line.dispatchedQuantity, line.receivedQuantity, line.remainingToReceive], [20, 8, 12]);
    assert.equal(p1.data.receipt.items[0].remainingQuantity, 12);
    assert.equal(await northUnits(m._id), 8, 'only what was received is credited');
    assert.equal((await T.client.get('/transfers/in-transit')).data.units > 0, true);

    const p2 = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 12 }] });
    assert.equal(p2.data.status, 'completed');
    assert.equal(p2.data.receipt.items[0].previouslyReceived, 8, 'the second receipt remembers the first');
    assert.equal(await northUnits(m._id), 20);
    const done = await get(t._id);
    assert.equal(done.receipts.length, 2);
    assert.deepEqual(done.timeline.filter((e) => e.event === 'received').map((e) => e.ref), done.receipts.map((r) => r.reference));
    assert.ok(done.timeline.filter((e) => e.event === 'received').every((e) => e.by));
    assert.ok(await reconciled());
  });

  it('with no lines given, everything still expected is received', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 4 }] });
    const rest = await receive(t._id, {});
    assert.equal(rest.data.status, 'completed');
    assert.equal(rest.data.receipt.totalReceived, 6);
    assert.equal(await northUnits(m._id), 10);
  });

  it('receives several lines at once, each with its own counts', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 20);
    const c = await receiveStock(T.client, m._id, 20);
    const t = await inTransit([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 6 }]);
    const r = await receive(t._id, { items: [{ batchId: a._id, receivedQuantity: 10 }, { batchId: c._id, receivedQuantity: 3 }] });
    assert.equal(r.data.status, 'partially_received', 'one line is still short');
    assert.deepEqual(r.data.items.map((i) => i.remainingToReceive), [0, 3]);
    assert.equal(await northUnits(m._id), 13);
  });
});

describe('Quantity rules', () => {
  it('never allows more than was dispatched minus what was already received', async () => {
    const { b } = await stocked(100);
    const t = await inTransit([{ batchId: b._id, quantity: 20 }]);
    const over = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 21 }] });
    assert.equal(over.status, 400);
    assert.equal(over.body.code, 'RECEIPT_INVALID');
    assert.equal(over.body.details[0].path, 'items.0.receivedQuantity');
    assert.match(over.body.details[0].message, /Cannot receive more than the 20 still expected \(dispatched 20, already received 0\)/);
    assert.equal((await get(t._id)).status, 'in_transit', 'nothing changed');

    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 8 }] });
    const again = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 13 }] });
    assert.equal(again.status, 400);
    assert.match(again.body.details[0].message, /Cannot receive more than the 12 still expected \(dispatched 20, already received 8\)/, 'the limit shrinks as units arrive');
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 12 }] })).status, 200);
  });

  it('received + damaged + missing together cannot exceed what is still expected', async () => {
    const { b } = await stocked(50);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const r = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 8, damagedQuantity: 2, missingQuantity: 1, remarks: 'Box crushed' }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.details[0].path, 'items.0.missingQuantity');
    assert.match(r.body.details[0].message, /\(11\) is more than the 10 still expected/);
  });

  it('rejects malformed counts', async () => {
    const { b } = await stocked(50);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const bad = async (payload, fragment) => {
      const r = await receive(t._id, payload);
      assert.equal(r.status, 400, JSON.stringify(payload));
      if (fragment) assert.match(JSON.stringify(r.body), fragment);
    };
    await bad({ items: [] }, /at least one line/);
    await bad({ items: [{ batchId: b._id, receivedQuantity: 0 }] }, /Enter what arrived/);
    await bad({ items: [{ batchId: b._id }] }, /Enter what arrived/);
    await bad({ items: [{ batchId: b._id, receivedQuantity: -1 }] }, /negative/);
    await bad({ items: [{ batchId: b._id, receivedQuantity: 2.5 }] }, /whole number/);
    await bad({ items: [{ batchId: b._id, receivedQuantity: 'lots' }] });
    await bad({ items: [{ batchId: 'nope', receivedQuantity: 1 }] });
    await bad({ items: [{ batchId: '0'.repeat(24), receivedQuantity: 1 }] }, /not part of the transfer/);
    await bad({ items: [{ batchId: b._id, receivedQuantity: 1 }, { batchId: b._id, receivedQuantity: 1 }] }, /already on the receipt/);
    await bad({ closeReceipt: 'yes' });
    await bad({ remarks: 'x'.repeat(501) });
    await bad({ idempotencyKey: 'short' }, /at least 8/);
    assert.equal((await get(t._id)).status, 'in_transit');
  });
});

describe('Discrepancies: damaged, missing and short quantities', () => {
  it('requires remarks whenever units are damaged or missing, and says which line needs them', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    for (const counts of [{ damagedQuantity: 2 }, { missingQuantity: 3 }]) {
      const r = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 5, ...counts }] });
      assert.equal(r.status, 400, JSON.stringify(counts));
      assert.equal(r.body.details[0].path, 'items.0.remarks');
      assert.match(r.body.details[0].message, /Explain the damaged or missing quantity/);
    }
    const short = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 5, damagedQuantity: 2, remarks: 'ok' }] });
    assert.equal(short.status, 400, 'remarks must be a real explanation (3+ characters)');
    assert.equal((await get(t._id)).status, 'in_transit');
  });

  it('records damaged units, credits only the good ones, and keeps the books balanced', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const r = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6, damagedQuantity: 2, remarks: 'Two strips water-damaged in the van' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.status, 'partially_received', '2 units are still unaccounted for');
    assert.equal(await northUnits(m._id), 6, 'damaged units are not credited as stock');
    const line = r.data.items[0];
    assert.deepEqual([line.receivedQuantity, line.damagedQuantity, line.missingQuantity, line.remainingToReceive], [6, 2, 0, 2]);
    assert.match(line.remarks, /water-damaged/);
    assert.deepEqual([r.data.receipt.totalReceived, r.data.receipt.totalDamaged], [6, 2]);
    assert.equal(r.data.hasDiscrepancy, true);
    assert.equal(r.data.damagedUnits, 2);
    assert.ok(await reconciled(), 'the ledger still adds up to every batch');
  });

  it('records missing / short units the same way, and completes the transfer once every unit is accounted for', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const r = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 7, missingQuantity: 3, remarks: 'Carton arrived 3 strips short' }] });
    assert.equal(r.data.status, 'completed', 'received + missing = dispatched: nothing is left to wait for');
    assert.equal(await northUnits(m._id), 7);
    assert.deepEqual([r.data.receivedUnits, r.data.missingUnits, r.data.damagedUnits], [7, 3, 0]);
    assert.equal(r.data.hasDiscrepancy, true);
    const row = (await T.client.get(`/transfers?search=${t.reference}`)).data.items[0];
    assert.equal(row.hasDiscrepancy, true, 'the list can flag it');
    assert.equal(row.discrepancyUnits, 3);
    assert.ok(await reconciled());
  });

  it('a receipt can be closed: what is still expected is written off as missing, with an explanation', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6, damagedQuantity: 2, remarks: 'Crushed box' }] });
    const noReason = await receive(t._id, { closeReceipt: true });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.details[0].path, 'remarks');
    const closed = await receive(t._id, { closeReceipt: true, remarks: 'Supplier confirmed the last 2 strips were not loaded' });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.data.status, 'completed');
    assert.equal(closed.data.receipt.closed, true);
    assert.equal(closed.data.receipt.totalMissing, 2);
    assert.equal(closed.data.receiptClosed, true);
    const line = closed.data.items[0];
    assert.deepEqual([line.receivedQuantity, line.damagedQuantity, line.missingQuantity, line.remainingToReceive], [6, 2, 2, 0]);
    assert.match(line.remarks, /Receipt closed: Supplier confirmed/);
    assert.equal(await northUnits(m._id), 6);
    assert.ok(await reconciled());
  });

  it('closing a receipt can include the final counts of the same visit', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const r = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 7 }], closeReceipt: true, remarks: 'The rest was never loaded' });
    assert.equal(r.data.status, 'completed');
    assert.deepEqual([r.data.items[0].receivedQuantity, r.data.items[0].missingQuantity], [7, 3]);
    assert.equal(await northUnits(m._id), 7);
  });
});

describe('Which transfers can be received', () => {
  it('only an in-transit or partially received transfer can be received', async () => {
    const { b } = await stocked(50);
    const line = [{ batchId: b._id, quantity: 4 }];
    const draft = (await T.client.post('/transfers', body(line))).data;
    assert.equal((await receive(draft._id, {})).status, 409, 'a draft');
    await T.client.post(`/transfers/${draft._id}/submit`);
    assert.equal((await receive(draft._id, {})).status, 409, 'approved but not dispatched');
    const t = await inTransit(line);
    await receive(t._id, {});
    assert.equal((await receive(t._id, {})).status, 409, 'completed');
    const c = await inTransit(line);
    await T.client.post(`/transfers/${c._id}/cancel`);
    assert.equal((await receive(c._id, {})).status, 409, 'cancelled');
    assert.equal((await receive('not-an-id', {})).status, 404);
    assert.equal((await receive('0'.repeat(24), {})).status, 404);
  });

  it('a partly dispatched transfer cannot be received until it is fully out', async () => {
    const { b } = await stocked(30);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 10 }]))).data;
    await T.client.post(`/transfers/${d._id}/submit`);
    await T.client.post(`/transfers/${d._id}/dispatch`, { items: [{ batchId: b._id, quantity: 4 }] });
    assert.equal((await get(d._id)).status, 'partially_dispatched');
    assert.equal((await receive(d._id, {})).status, 409);
  });

  it('once receiving has started the transfer cannot be cancelled or dispatched again', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 4 }] });
    const cancel = await T.client.post(`/transfers/${t._id}/cancel`, { reason: 'too late' });
    assert.equal(cancel.status, 409, 'units are already in the destination');
    assert.equal((await T.client.post(`/transfers/${t._id}/dispatch`, {})).status, 409);
    assert.equal((await get(t._id)).status, 'partially_received');
    assert.equal((await batchOf(b._id)).availableQuantity, 20, 'the source is untouched');
  });

  it('cancelling an in-transit transfer (nothing received) still returns the units', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    assert.equal((await T.client.post(`/transfers/${t._id}/cancel`)).status, 200);
    assert.equal((await batchOf(b._id)).availableQuantity, 30);
    assert.ok(await reconciled());
  });
});

describe('All or nothing', () => {
  it('a problem on one line stops the whole receipt: no stock, no receipt, no reference used, no event', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 20);
    const c = await receiveStock(T.client, m._id, 20);
    const t = await inTransit([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 10 }]);
    // the destination already holds lot C with a different expiry date, so line 2 cannot be credited
    await h.tenant.runWithTenant(T.org._id, async () => {
      const held = await h.models.Batch.create({ medicineId: m._id, batchNumber: c.batchNumber, expiryDate: new Date(Date.now() + 5 * 86400000), mrp: 1, sellingPrice: 1, initialQuantity: 2, availableQuantity: 2, branchId: north._id });
      await h.models.StockMovement.create({ medicineId: m._id, batchId: held._id, type: 'PURCHASE', quantity: 2, balanceAfter: 2, reason: 'Batch received' });
    });
    const eventsBefore = (await events(t._id)).total;
    const r = await receive(t._id, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BATCH_CONFLICT');
    assert.equal(await northUnits(m._id), 2, 'line 1 was not credited either');
    const after = await get(t._id);
    assert.equal(after.status, 'in_transit');
    assert.equal(after.receipts.length, 0);
    assert.deepEqual(after.items.map((i) => i.receivedQuantity), [0, 0]);
    assert.equal((await events(t._id)).total, eventsBefore, 'a failed receipt leaves no history entry');
    assert.ok(await reconciled());
    assert.equal((await T.client.post(`/transfers/${t._id}/cancel`)).status, 200, 'it can still be called back');
  });

  it('a failed attempt does not use up a receipt number', async () => {
    const { b } = await stocked(30);
    const first = await inTransit([{ batchId: b._id, quantity: 5 }]);
    const ref1 = (await receive(first._id, {})).data.receipt.reference;
    const t = await inTransit([{ batchId: b._id, quantity: 5 }]);
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 99 }] })).status, 400);
    const ref2 = (await receive(t._id, {})).data.receipt.reference;
    assert.equal(Number(ref2.slice(4)), Number(ref1.slice(4)) + 1);
  });
});

describe('Duplicate submissions', () => {
  it('repeating a receipt with the same key returns the original and credits nothing twice', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const k = key();
    const first = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6 }], idempotencyKey: k });
    const second = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6 }], idempotencyKey: k });
    assert.equal(first.data.duplicate, false);
    assert.equal(second.data.duplicate, true);
    assert.equal(second.data.receipt.reference, first.data.receipt.reference);
    assert.equal(await northUnits(m._id), 6, 'credited once');
    assert.equal((await get(t._id)).receipts.length, 1);
  });

  it('a double click (two requests at once, same key) credits once', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 12 }]);
    const k = key();
    const [x, y] = await Promise.all([receive(t._id, { idempotencyKey: k }), receive(t._id, { idempotencyKey: k })]);
    assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.equal(y.status, 200, JSON.stringify(y.body));
    assert.deepEqual([x.data.duplicate, y.data.duplicate].sort(), [false, true]);
    assert.equal(await northUnits(m._id), 12);
    assert.ok(await reconciled());
  });

  it('two receipts of the same transfer without a key also credit it once', async () => {
    const { m, b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 9 }]);
    const [x, y] = await Promise.all([receive(t._id, {}), receive(t._id, {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(await northUnits(m._id), 9);
  });

  it('a key belongs to one transfer', async () => {
    const a = await stocked(20);
    const c = await stocked(20);
    const t1 = await inTransit([{ batchId: a.b._id, quantity: 3 }]);
    const t2 = await inTransit([{ batchId: c.b._id, quantity: 3 }]);
    const k = key();
    await receive(t1._id, { idempotencyKey: k });
    const reused = await receive(t2._id, { idempotencyKey: k });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(await northUnits(c.m._id), 0);
  });
});

describe('Permanent records and who may receive', () => {
  it('receipts and history events can never be changed or deleted', async () => {
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 5 }]);
    const { data } = await receive(t._id, {});
    const { Receipt, ReceiptImmutableError, TransferEvent, TransferEventImmutableError } = h.models;
    const run = (fn) => h.tenant.runWithTenant(T.org._id, fn);
    await assert.rejects(run(() => Receipt.updateOne({ _id: data.receipt._id }, { $set: { totalReceived: 999 } })), ReceiptImmutableError);
    await assert.rejects(run(() => Receipt.deleteMany({})), ReceiptImmutableError);
    await assert.rejects(run(async () => {
      const doc = await Receipt.findById(data.receipt._id);
      doc.remarks = 'edited';
      await doc.save();
    }), ReceiptImmutableError);
    await assert.rejects(run(() => TransferEvent.updateMany({}, { $set: { remarks: 'x' } })), TransferEventImmutableError);
    await assert.rejects(run(() => TransferEvent.deleteMany({})), TransferEventImmutableError);
    await assert.rejects(run(async () => {
      const doc = await TransferEvent.findOne({ transferId: t._id });
      doc.remarks = 'edited';
      await doc.save();
    }), TransferEventImmutableError);
    assert.equal((await get(t._id)).receipts[0].totalReceived, 5);
  });

  it('needs the receive permission; preparing, dispatching or approving is not enough', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 3 }]);
    const roles = [await asRole('STAFF'), await asRole('BILLING_STAFF'), await asRole('STAFF', ['transfer:manage']), await asRole('STAFF', ['transfer:dispatch']), await asRole('STAFF', ['transfer:approve'])];
    for (const { c } of roles) assert.equal((await receive(t._id, {}, c)).status, 403);
    assert.equal((await receive(t._id, {}, h.client())).status, 401);
    assert.equal((await get(t._id)).status, 'in_transit');
    const mgr = await asRole('INVENTORY_MANAGER');
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 1 }] }, mgr.c)).status, 200);
    const branchManager = await asRole('BRANCH_MANAGER');
    assert.equal((await receive(t._id, {}, branchManager.c)).status, 200);
  });

  it('records each receiver on their own receipt, and the latest one on the transfer', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    const { c, u } = await asRole('INVENTORY_MANAGER');
    const first = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 4 }] }, c);
    const second = await receive(t._id, {});
    const got = await get(t._id);
    assert.equal(String(first.data.receipt.receivedBy), String(u._id));
    assert.equal(String(second.data.receipt.receivedBy), String(T.user._id));
    assert.equal(String(got.receivedBy), String(T.user._id), 'the transfer shows the latest receiver');
    assert.deepEqual(got.timeline.filter((e) => e.event === 'received').map((e) => e.by), [u.name, T.user.name]);
  });

  it('another organization cannot receive, see or reuse my transfer’s receipts', async () => {
    const { m, b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 5 }]);
    assert.equal((await receive(t._id, {}, other.client)).status, 404);
    assert.equal((await receive(t._id, { idempotencyKey: key() }, other.client)).status, 404);
    assert.equal((await other.client.get(`/transfers/${t._id}/events`)).status, 404);
    assert.equal(await northUnits(m._id), 0);
    const r = await receive(t._id, { organizationId: other.org._id, reference: 'RCV-9999', receivedBy: other.user._id, receivedAt: '2000-01-01' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.data.receipt.reference, 'RCV-9999');
    assert.equal(String(r.data.receipt.organizationId), String(T.org._id));
    assert.equal(String(r.data.receipt.receivedBy), String(T.user._id));
    assert.ok(new Date(r.data.receipt.receivedAt) > new Date('2020-01-01'));
  });
});

describe('The transfer’s complete history', () => {
  it('records every step with who, where, the status before and after, remarks and details', async () => {
    const { b } = await stocked(40);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 10 }], { notes: 'Weekly top-up' }))).data;
    await T.client.post(`/transfers/${d._id}/submit`);
    await T.client.post(`/transfers/${d._id}/dispatch`, { notes: 'Van 7' });
    await receive(d._id, { items: [{ batchId: b._id, receivedQuantity: 7, damagedQuantity: 1, remarks: 'One strip crushed' }] });
    await receive(d._id, { closeReceipt: true, remarks: 'Last two were never loaded' });

    const ev = (await events(d._id)).items;
    assert.deepEqual(ev.map((e) => e.action), ['CREATED', 'SUBMITTED', 'DISPATCHED', 'RECEIVED', 'RECEIVED']);
    assert.deepEqual(ev.map((e) => [e.previousStatus, e.newStatus]), [[undefined, 'draft'], ['draft', 'approved'], ['approved', 'in_transit'], ['in_transit', 'partially_received'], ['partially_received', 'completed']]);
    assert.ok(ev.every((e) => String(e.performedBy) === String(T.user._id) && e.performedByName === T.user.name && e.timestamp));
    assert.deepEqual(ev.map((e) => e.branchName), ['Main Store', 'Main Store', 'Main Store', 'North Branch Store', 'North Branch Store'], 'dispatch happens at the source, receiving at the destination');
    assert.equal(ev[0].remarks, 'Weekly top-up');
    assert.equal(ev[2].remarks, 'Van 7');
    assert.match(ev[3].remarks, /One strip crushed/);
    assert.equal(ev[4].remarks, 'Last two were never loaded');
    assert.match(ev[2].metadata.dispatchReference, /^DSP-/);
    assert.deepEqual([ev[3].metadata.received, ev[3].metadata.damaged, ev[3].metadata.missing], [7, 1, 0]);
    assert.deepEqual([ev[4].metadata.received, ev[4].metadata.missing, ev[4].metadata.closed], [0, 2, true]);
    assert.ok(ev.map((e) => new Date(e.timestamp).getTime()).every((t, i, a) => i === 0 || t >= a[i - 1]), 'oldest first');
  });

  it('records rejections, approvals, edits and cancellations too', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { b } = await stocked(30);
      const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 4 }]))).data;
      await T.client.put(`/transfers/${d._id}`, body([{ batchId: b._id, quantity: 5 }]));
      await T.client.post(`/transfers/${d._id}/submit`);
      await T.client.post(`/transfers/${d._id}/reject`, { reason: 'Not needed at North' });
      const rejected = (await events(d._id)).items;
      assert.deepEqual(rejected.map((e) => e.action), ['CREATED', 'UPDATED', 'SUBMITTED', 'REJECTED']);
      assert.deepEqual([rejected[3].previousStatus, rejected[3].newStatus, rejected[3].remarks], ['submitted', 'rejected', 'Not needed at North']);
      assert.equal(rejected[2].newStatus, 'submitted');

      const e = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 4 }]))).data;
      await T.client.post(`/transfers/${e._id}/submit`);
      await T.client.post(`/transfers/${e._id}/approve`);
      await T.client.post(`/transfers/${e._id}/cancel`, { reason: 'Plans changed' });
      const cancelled = (await events(e._id)).items;
      assert.deepEqual(cancelled.map((x) => x.action), ['CREATED', 'SUBMITTED', 'APPROVED', 'CANCELLED']);
      assert.equal(cancelled[3].remarks, 'Plans changed');
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false });
    }
  });

  it('keeps the history of a draft that was deleted', async () => {
    const { b } = await stocked(10);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
    await T.client.del(`/transfers/${d._id}`);
    assert.equal((await T.client.get(`/transfers/${d._id}`)).status, 404);
    const ev = (await events(d._id)).items;
    assert.deepEqual(ev.map((e) => e.action), ['CREATED', 'DELETED']);
    assert.equal(ev[1].previousStatus, 'draft');
    assert.equal(ev[1].transferReference, d.reference);
  });

  it('a failed step writes no event', async () => {
    const { b } = await stocked(10);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 8 }]))).data;
    await T.client.post(`/transfers/${d._id}/submit`);
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -6, reason: 'Damaged before dispatch' });
    assert.equal((await T.client.post(`/transfers/${d._id}/dispatch`, {})).status, 409);
    assert.deepEqual((await events(d._id)).items.map((e) => e.action), ['CREATED', 'SUBMITTED']);
  });

  it('is paginated and readable by anyone who can read inventory, but never writable', async () => {
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 4 }]);
    const p = (await T.client.get(`/transfers/${t._id}/events?limit=2&page=1`)).data;
    assert.equal(p.items.length, 2);
    assert.ok(p.total >= 3 && p.pages >= 2);
    assert.equal((await (await asRole('STAFF')).c.get(`/transfers/${t._id}/events`)).status, 200);
    assert.equal((await h.client().get(`/transfers/${t._id}/events`)).status, 401);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await T.client.request(method, `/transfers/${t._id}/events`, { body: {} });
      assert.ok([404, 405].includes(r.status), `${method} -> ${r.status}`);
    }
    assert.equal((await T.client.get('/transfers/not-an-id/events')).status, 404);
    assert.equal((await T.client.get(`/transfers/${'0'.repeat(24)}/events`)).status, 404);
  });
});

describe('Summaries and older data', () => {
  it('units in transit are what is still expected: received, damaged and missing units are no longer on the road', async () => {
    const { b } = await stocked(50);
    const base = (await T.client.get('/transfers/in-transit')).data.units;
    const t = await inTransit([{ batchId: b._id, quantity: 20 }]);
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base + 20);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 8, damagedQuantity: 2, remarks: 'Crushed' }] });
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base + 10);
    await receive(t._id, {});
    assert.equal((await T.client.get('/transfers/in-transit')).data.units, base);
  });

  it('a partly received transfer still counts as in transit, and can be filtered', async () => {
    const before = (await T.client.get('/transfers/summary')).data;
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 3 }] });
    const after = (await T.client.get('/transfers/summary')).data;
    assert.equal(after.inTransit - before.inTransit, 1);
    assert.equal(after.byStatus.partially_received, (before.byStatus.partially_received || 0) + 1);
    const ids = async (q) => (await T.client.get(`/transfers?limit=100&${q}`)).data.items.map((x) => x._id);
    assert.ok((await ids('status=partially_received')).includes(t._id));
    assert.ok((await ids('status=transit')).includes(t._id));
    assert.ok(!(await ids('status=completed')).includes(t._id));
  });

  it('older transfers without receiving fields still read and receive correctly', async () => {
    const { m, b } = await stocked(40);
    const done = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(done._id, {});
    await h.models.Transfer.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(done._id) }, { $unset: { 'items.0.receivedQuantity': '', 'items.0.damagedQuantity': '', 'items.0.missingQuantity': '' } });
    const legacyDone = (await get(done._id)).items[0];
    assert.deepEqual([legacyDone.receivedQuantity, legacyDone.remainingToReceive], [10, 0], 'a completed transfer counts as received in full');

    const open = await inTransit([{ batchId: b._id, quantity: 6 }]);
    const r = await receive(open._id, {});
    assert.equal(r.data.status, 'completed');
    assert.equal(await northUnits(m._id), 16);
  });
});

describe('The transfer record', () => {
  it('keeps the expected arrival date and internal remarks, and refuses an arrival before the transfer date', async () => {
    const { b } = await stocked(10);
    const line = [{ batchId: b._id, quantity: 2 }];
    const ok = await T.client.post('/transfers', body(line, { expectedArrivalDate: '2099-01-02', transferDate: '2099-01-01', internalRemarks: 'Courier: ask for Ravi' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.data.expectedArrivalDate.slice(0, 10), '2099-01-02');
    assert.equal(ok.data.internalRemarks, 'Courier: ask for Ravi');
    const early = await T.client.post('/transfers', body(line, { expectedArrivalDate: '2098-12-31', transferDate: '2099-01-01' }));
    assert.equal(early.status, 400);
    assert.equal(early.body.details[0].path, 'expectedArrivalDate');
    assert.equal((await T.client.post('/transfers', body(line, { expectedArrivalDate: '' }))).status, 201, 'optional');
    const edited = await T.client.put(`/transfers/${ok.data._id}`, body(line, { transferDate: '2099-01-01', internalRemarks: '' }));
    assert.equal(edited.data.expectedArrivalDate, undefined, 'clearing it works');
    assert.equal(edited.data.internalRemarks, '');
  });

  it('shows the reasons for a rejection or cancellation under the names used in the transfer record', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { b } = await stocked(10);
      const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
      await T.client.post(`/transfers/${d._id}/submit`);
      assert.equal((await T.client.post(`/transfers/${d._id}/reject`, { reason: 'Over budget' })).data.rejectionReason, 'Over budget');
      const e = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
      assert.equal((await T.client.post(`/transfers/${e._id}/cancel`, { reason: 'Duplicate request' })).data.cancellationReason, 'Duplicate request');
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false });
    }
  });
});
