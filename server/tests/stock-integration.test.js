// Stock movement integration and the transfer API surface: every stock change leaves a complete ledger entry, /history and /print exist,
// and the server never trusts organizationId, user, status or quantities sent by the client.
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


describe('Stock movements written by transfers', () => {
  it('every dispatch, receipt and cancellation leaves a complete ledger entry', async () => {
    const { m, b } = await stocked(50);
    const t = await inTransit([{ batchId: b._id, quantity: 10 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 8, damagedQuantity: 2, remarks: 'Wet box' }] });
    const mv = (await T.client.get(`/stock/movements?medicineId=${m._id}&limit=50`)).data.items.filter((x) => x.type.startsWith('TRANSFER'));
    assert.equal(mv.length, 2, 'one TRANSFER_OUT and one TRANSFER_IN, nothing duplicated (damaged units create no entry)');
    for (const x of mv) {
      assert.ok(x.medicineId && x.batchId && x.type && x.quantity && x.refType && x.refId && x.createdAt, JSON.stringify(x));
      assert.equal(String(x.createdBy?._id || x.createdBy), String(T.user._id));
      assert.ok(x.branchId, 'the store the stock changed in');
    }
    const out = mv.find((x) => x.type === 'TRANSFER_OUT');
    const inn = mv.find((x) => x.type === 'TRANSFER_IN');
    assert.deepEqual([out.quantity, out.refType, String(out.branchId)], [-10, 'Dispatch', String(main._id)]);
    assert.deepEqual([inn.quantity, inn.refType, String(inn.branchId)], [8, 'Receipt', String(north._id)]);
    assert.equal(await reconciled(), true);
    // a cancelled draft or an unreceived transfer writes nothing extra
    const before = (await T.client.get(`/stock/movements?medicineId=${m._id}&limit=50`)).data.items.length;
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 5 }]))).data;
    await T.client.post(`/transfers/${d._id}/cancel`, {});
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=50`)).data.items.length, before, 'no stock moved, no entry');
  });
});

describe('/history and /print', () => {
  it('history is the same trail as events, and print returns the document data', async () => {
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 4 }]);
    const hist = await T.client.get(`/transfers/${t._id}/history`);
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.data.items.map((e) => e.action), (await events(t._id)).items.map((e) => e.action));
    const p = await T.client.get(`/transfers/${t._id}/print`);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.data.organization.name, 'Receive Org');
    assert.equal(p.data.transfer.reference, t.reference);
    assert.equal(p.data.printedBy.name, T.user.name);
    assert.ok(p.data.printedAt);
  });
  it('are tenant-isolated and need authentication', async () => {
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 2 }]);
    assert.equal((await other.client.get(`/transfers/${t._id}/history`)).status, 404);
    assert.equal((await other.client.get(`/transfers/${t._id}/print`)).status, 404);
    assert.equal((await h.client().get(`/transfers/${t._id}/print`)).status, 401);
  });
});

describe('Nothing the client says about identity, status or stock is trusted', () => {
  it('ignores organizationId, createdBy, status, reference and received/dispatched totals sent in a create', async () => {
    const { b } = await stocked(30);
    const r = await T.client.post('/transfers', {
      ...body([{ batchId: b._id, quantity: 5, dispatchedQuantity: 5, receivedQuantity: 5, availableQuantity: 9999 }]),
      organizationId: other.org._id, createdBy: other.user._id, status: 'completed', reference: 'TRF-HACK', approvedBy: other.user._id,
    });
    assert.ok([201, 400].includes(r.status), JSON.stringify(r.body));
    if (r.status === 201) {
      const t = await get(r.data._id);
      assert.equal(t.status, 'draft');
      assert.notEqual(t.reference, 'TRF-HACK');
      assert.equal(String(t.createdBy?._id || t.createdBy), String(T.user._id));
      assert.ok(!t.items[0].dispatchedQuantity && !t.items[0].receivedQuantity);
      assert.equal((await batchOf(b._id)).availableQuantity, 30, 'no stock moved');
      assert.equal((await other.client.get(`/transfers/${r.data._id}`)).status, 404, 'it belongs to the caller organization');
    }
  });
  it('cannot force a status or move stock through update, and cannot receive more than was dispatched', async () => {
    const { b } = await stocked(30);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 5 }]))).data;
    await T.client.put(`/transfers/${d._id}`, { ...body([{ batchId: b._id, quantity: 5 }]), status: 'completed' });
    assert.equal((await get(d._id)).status, 'draft');
    assert.equal((await receive(d._id, { items: [{ batchId: b._id, receivedQuantity: 5 }] })).status, 409, 'a draft cannot be received');
    const t = await inTransit([{ batchId: b._id, quantity: 5 }]);
    assert.equal((await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 6 }] })).status, 400);
    assert.equal((await batchOf(b._id)).availableQuantity, 25);
  });
});
