// Acceptance scenarios for the Inter Store Transfer module, end to end through the real API and a real (in-memory) MongoDB replica set.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let main;
let north;
let south;
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
  south = (await T.client.post('/branches', { name: 'South Branch Store', code: 'SOUTH' })).data;
});

after(async () => {
  await h?.stop();
});



const expiredBatch = (org, medicineId, number, qty) =>
  h.tenant.runWithTenant(org._id, async () => {
    const b = await h.models.Batch.create({ medicineId, batchNumber: number, expiryDate: new Date(Date.now() - 3 * 86400000), mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty, branchId: main._id });
    await h.models.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty, reason: 'Batch received' });
    return b.toObject();
  });
const mainUnits = async (medicineId) => (await T.client.get(`/batches?medicineId=${medicineId}&branchId=${main._id}`)).data.items.reduce((s, b) => s + b.availableQuantity, 0);
const user = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return { u, c };
};
/** Makes the Nth stock-ledger write inside a transaction fail, to prove that everything done before it is rolled back. */
const failLedgerWrite = (nth) => {
  const original = h.models.StockMovement.create.bind(h.models.StockMovement);
  let calls = 0;
  h.models.StockMovement.create = async (...args) => {
    if (++calls === nth) throw new Error('simulated database failure');
    return original(...args);
  };
  return () => {
    h.models.StockMovement.create = original;
  };
};

describe('Acceptance: the transfer scenarios, end to end', () => {
  it('1-5. valid draft; same store, foreign organization, expired batch and over-stock are refused; nothing moves', async () => {
    const { m, b } = await stocked(30);
    const ok = await T.client.post('/transfers', body([{ batchId: b._id, quantity: 10 }]));
    assert.equal(ok.status, 201);
    assert.equal(ok.data.status, 'draft');
    assert.equal((await batchOf(b._id)).availableQuantity, 30, 'a draft moves no stock');

    const same = await T.client.post('/transfers', body([{ batchId: b._id, quantity: 1 }], { toBranchId: main._id }));
    assert.equal(same.status, 400);
    assert.ok(same.body.details.some((d) => d.path === 'toBranchId'));

    const foreignStore = (await other.client.get('/branches')).data[0];
    const cross = await T.client.post('/transfers', body([{ batchId: b._id, quantity: 1 }], { toBranchId: foreignStore._id }));
    assert.ok([400, 404].includes(cross.status), `cross-organization destination refused (${cross.status})`);
    const theirs = await other.client.post('/transfers', body([{ batchId: b._id, quantity: 1 }], { fromBranchId: foreignStore._id, toBranchId: foreignStore._id }));
    assert.ok(theirs.status >= 400, 'another organization cannot use my batch');

    const old = await expiredBatch(T.org, m._id, uniq('OLD'), 10);
    const expired = await T.client.post('/transfers', body([{ batchId: String(old._id), quantity: 1 }]));
    assert.equal(expired.status, 400);
    assert.match(expired.body.details[0].message, /expired/);

    const over = await T.client.post('/transfers', body([{ batchId: b._id, quantity: 31 }]));
    assert.equal(over.status, 400);
    assert.match(over.body.details[0].message, /Only 30 unit/);
    assert.equal(await reconciled(), true);
  });

  it('6-9. submit, approve, reject with a reason; dispatch moves stock exactly once', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { m, b } = await stocked(50);
      const approver = await user('BRANCH_MANAGER');
      const mk = async (q) => {
        const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: q }]))).data;
        assert.equal((await T.client.post(`/transfers/${d._id}/submit`)).data.status, 'submitted');
        return d;
      };
      const a = await mk(10);
      const r = await mk(5);
      assert.equal((await approver.c.post(`/transfers/${r._id}/reject`, {})).status, 400, 'a reason is required');
      const rej = await approver.c.post(`/transfers/${r._id}/reject`, { reason: 'Not needed at North' });
      assert.equal(rej.data.status, 'rejected');
      assert.equal((await get(r._id)).rejectionReason, 'Not needed at North');
      assert.equal((await approver.c.post(`/transfers/${a._id}/approve`)).data.status, 'approved');
      assert.equal(await mainUnits(m._id), 50, 'approving moves nothing');

      const k = `dup-${Date.now()}`;
      const d1 = await T.client.post(`/transfers/${a._id}/dispatch`, { idempotencyKey: k });
      const d2 = await T.client.post(`/transfers/${a._id}/dispatch`, { idempotencyKey: k });
      assert.equal(d1.status, 200);
      assert.equal(d2.data.duplicate, true, 'the same request again is recognised');
      const d3 = await T.client.post(`/transfers/${a._id}/dispatch`, {});
      assert.equal(d3.status, 409, 'a different, second dispatch of a fully dispatched transfer is refused');
      assert.equal(await mainUnits(m._id), 40, 'stock left the source exactly once');
      assert.equal((await get(a._id)).dispatches.length, 1);
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false });
    }
  });

  it('10-15. full, partial, damaged and missing receipts; over-receiving refused; balances at both stores are right', async () => {
    const { m, b } = await stocked(100);
    const t = await inTransit([{ batchId: b._id, quantity: 40 }]);
    assert.equal(await mainUnits(m._id), 60);
    assert.equal(await northUnits(m._id), 0, 'nothing is credited before it is confirmed');

    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 41 }] })).status, 400, 'more than dispatched');
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 20 }] })).data.status, 'partially_received');
    assert.equal(await northUnits(m._id), 20, 'partial receipt credits what arrived');

    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 17, damagedQuantity: 2, missingQuantity: 1 }] })).status, 400, 'damaged/missing need remarks');
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 19, damagedQuantity: 2 }] })).status, 400, 'more than the 20 still expected');
    const last = await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 17, damagedQuantity: 2, missingQuantity: 1, remarks: 'Two crushed, one never loaded' }] });
    assert.equal(last.data.status, 'completed');
    const done = await get(t._id);
    assert.deepEqual([done.items[0].receivedQuantity, done.items[0].damagedQuantity, done.items[0].missingQuantity], [37, 2, 1]);
    assert.equal(await mainUnits(m._id), 60, 'source: 100 - 40 dispatched');
    assert.equal(await northUnits(m._id), 37, 'destination: only the good units');
    assert.equal(await reconciled(), true, 'the ledger explains every unit');
    assert.equal((await batchOf(b._id)).availableQuantity, 60, 'batch-level tracking: the source batch keeps its own balance');

    const full = await inTransit([{ batchId: b._id, quantity: 10 }]);
    assert.equal((await receive(full._id, { items: [{ batchId: b._id, receivedQuantity: 10 }] })).data.status, 'completed');
    assert.equal(await northUnits(m._id), 47);
  });

  it('16. the audit history lists every step with who, where and the status before and after', async () => {
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 6 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6 }] });
    const ev = (await events(t._id)).items;
    assert.deepEqual(ev.map((e) => e.action), ['CREATED', 'SUBMITTED', 'DISPATCHED', 'RECEIVED']);
    assert.ok(ev.every((e) => e.performedByName && e.timestamp && e.branchName));
    const log = (await T.client.get('/activity?limit=50')).data.items.map((x) => x.action);
    for (const a of ['TRANSFER_CREATE', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIVE']) assert.ok(log.includes(a), a);
  });

  it('17. branch-level access: only the source dispatches, only the destination receives', async () => {
    const { b } = await stocked(20);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 4 }]))).data;
    await T.client.post(`/transfers/${d._id}/submit`);
    const src = await user('INVENTORY_MANAGER', { branchIds: [main._id] });
    const dst = await user('INVENTORY_MANAGER', { branchIds: [north._id] });
    assert.equal((await dst.c.post(`/transfers/${d._id}/dispatch`, {})).status, 403);
    assert.equal((await src.c.post(`/transfers/${d._id}/dispatch`, {})).status, 200);
    assert.equal((await src.c.post(`/transfers/${d._id}/receive`, {})).status, 403);
    assert.equal((await dst.c.post(`/transfers/${d._id}/receive`, {})).status, 200);
  });

  it('18. cancelling returns exactly what left and never corrupts stock', async () => {
    const { m, b } = await stocked(30);
    const draft = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 5 }]))).data;
    assert.equal((await T.client.post(`/transfers/${draft._id}/cancel`, {})).status, 200);
    assert.equal(await mainUnits(m._id), 30);
    const sent = await inTransit([{ batchId: b._id, quantity: 12 }]);
    assert.equal(await mainUnits(m._id), 18);
    assert.equal((await T.client.post(`/transfers/${sent._id}/cancel`, { reason: 'Wrong store' })).status, 200);
    assert.equal(await mainUnits(m._id), 30, 'the 12 came back');
    assert.equal((await T.client.post(`/transfers/${sent._id}/cancel`, {})).status, 409, 'cancelling twice returns nothing twice');
    assert.equal(await mainUnits(m._id), 30);
    assert.equal(await northUnits(m._id), 0);
    assert.equal(await reconciled(), true);
  });

  it('19. a failure in the middle of a dispatch or a receipt rolls everything back, and a retry then works', async () => {
    const a = await stocked(20);
    const c = await stocked(20);
    const d = (await T.client.post('/transfers', body([{ batchId: a.b._id, quantity: 5 }, { batchId: c.b._id, quantity: 6 }]))).data;
    await T.client.post(`/transfers/${d._id}/submit`);

    let restore = failLedgerWrite(2); // the second line's ledger entry fails after the first line was already taken
    let r;
    try {
      r = await T.client.post(`/transfers/${d._id}/dispatch`, {});
    } finally {
      restore();
    }
    assert.ok(r.status >= 500, `a failed dispatch is an error (${r.status})`);
    assert.equal((await batchOf(a.b._id)).availableQuantity, 20, 'the first line was rolled back');
    assert.equal((await batchOf(c.b._id)).availableQuantity, 20);
    const after = await get(d._id);
    assert.equal(after.status, 'approved');
    assert.equal(after.dispatches.length, 0, 'no dispatch record');
    assert.deepEqual((await events(d._id)).items.map((e) => e.action), ['CREATED', 'SUBMITTED'], 'no event for the failed attempt');
    assert.equal(await reconciled(), true);
    assert.equal((await T.client.post(`/transfers/${d._id}/dispatch`, {})).status, 200, 'retry works');

    restore = failLedgerWrite(2);
    try {
      r = await receive(d._id, { items: [{ batchId: a.b._id, receivedQuantity: 5 }, { batchId: c.b._id, receivedQuantity: 6 }] });
    } finally {
      restore();
    }
    assert.ok(r.status >= 500);
    assert.equal(await northUnits(a.m._id), 0, 'nothing credited');
    assert.equal(await northUnits(c.m._id), 0);
    assert.equal((await get(d._id)).receipts.length, 0);
    assert.equal((await get(d._id)).status, 'in_transit');
    assert.equal((await receive(d._id, { items: [{ batchId: a.b._id, receivedQuantity: 5 }, { batchId: c.b._id, receivedQuantity: 6 }] })).data.status, 'completed', 'retry works');
    assert.equal(await northUnits(a.m._id), 5);
    assert.equal(await reconciled(), true);
  });

  it('20. pagination, search and filters', async () => {
    const { b } = await stocked(200);
    for (let i = 0; i < 7; i += 1) await T.client.post('/transfers', body([{ batchId: b._id, quantity: 1 }], { notes: `bulk ${i}` }));
    const p1 = (await T.client.get('/transfers?limit=5&page=1')).data;
    const p2 = (await T.client.get('/transfers?limit=5&page=2')).data;
    assert.equal(p1.items.length, 5);
    assert.ok(p1.total >= 7 && p1.pages >= 2 && p1.page === 1 && p2.page === 2);
    assert.ok(p2.items.every((x) => !p1.items.some((y) => y._id === x._id)), 'pages do not overlap');
    const byRef = (await T.client.get(`/transfers?search=${p1.items[0].reference}`)).data.items;
    assert.ok(byRef.length >= 1 && byRef.every((x) => x.reference.includes(p1.items[0].reference)));
    assert.equal((await T.client.get('/transfers?search=zzz-no-such-thing')).data.items.length, 0);
    assert.ok((await T.client.get('/transfers?status=draft&limit=100')).data.items.every((x) => x.status === 'draft'));
    assert.ok((await T.client.get(`/transfers?fromBranchId=${north._id}&limit=100`)).data.items.length === 0, 'no transfer leaves the north store');
    assert.ok((await T.client.get(`/transfers?toBranchId=${north._id}&limit=100`)).data.items.length > 0);
    assert.ok((await T.client.get(`/transfers?dateFrom=${TODAY}&dateTo=${TODAY}&limit=100`)).data.items.length > 0);
    assert.equal((await T.client.get('/transfers?dateFrom=2000-01-01&dateTo=2000-01-02')).data.items.length, 0);
  });
});
