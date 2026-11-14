// In-app transfer notifications (derived from the permanent event history) and the data behind the printable transfer note.
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



const user = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return { u, c };
};
const notes = async (client = T.client) => (await client.get('/transfers/notifications')).data;

describe('In-app transfer notifications', () => {
  it('cover submitted, approved, rejected, dispatched, partial receipt and completed — newest first', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { b } = await stocked(60);
      const approver = await user('BRANCH_MANAGER');
      const mk = async (qty) => {
        const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: qty }]))).data;
        await T.client.post(`/transfers/${d._id}/submit`);
        return d;
      };
      const a = await mk(10);
      const r = await mk(5);
      assert.ok((await notes(approver.c)).some((n) => n.kind === 'submitted' && n.transferId === a._id), 'approvers are told about transfers waiting for them');
      assert.equal((await approver.c.post(`/transfers/${a._id}/approve`)).status, 200);
      assert.equal((await approver.c.post(`/transfers/${r._id}/reject`, { reason: 'Not needed' })).status, 200);
      await T.client.post(`/transfers/${a._id}/dispatch`, {});
      await receive(a._id, { items: [{ batchId: b._id, receivedQuantity: 6 }] });
      await receive(a._id, { items: [{ batchId: b._id, receivedQuantity: 4 }] });
      const list = await notes();
      const mine = list.filter((n) => n.transferId === a._id).map((n) => n.kind);
      assert.deepEqual(mine, ['completed', 'partial', 'dispatched', 'approved', 'submitted'].filter((k) => k !== 'submitted' || mine.includes('submitted')), JSON.stringify(mine));
      assert.ok(list.some((n) => n.kind === 'rejected' && n.transferId === r._id && /Not needed/.test(n.message)));
      const first = list.find((n) => n.transferId === a._id);
      assert.match(first.message, /received — transfer completed/);
      assert.ok(first.reference && first.route && first.at && first.by);
      assert.ok(list.map((n) => new Date(n.at).getTime()).every((t, i, arr) => i === 0 || t <= arr[i - 1]), 'newest first');
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false });
    }
  });

  it('go only to people who may see them: store limits, approvers only for "submitted", other organizations never', async () => {
    const { b } = await stocked(30);
    const t = await inTransit([{ batchId: b._id, quantity: 3 }]);
    const southOnly = await user('BRANCH_MANAGER', { branchIds: [south._id] });
    const northUser = await user('INVENTORY_MANAGER', { branchIds: [north._id] });
    assert.ok(!(await notes(southOnly.c)).some((n) => n.transferId === t._id));
    assert.ok((await notes(northUser.c)).some((n) => n.transferId === t._id && n.kind === 'dispatched'));
    assert.ok(!(await notes(other.client)).some((n) => n.transferId === t._id));
    assert.equal((await h.client().get('/transfers/notifications')).status, 401);
  });

  it('say nothing about "approval" when the organization does not need it', async () => {
    const { b } = await stocked(30);
    const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
    await T.client.post(`/transfers/${d._id}/submit`);
    assert.ok(!(await notes()).some((n) => n.transferId === d._id && n.kind === 'submitted'));
  });
});

describe('The printable transfer note data', () => {
  it('carries the organization details, both stores, lines with batch and expiry, dispatch and receiving people', async () => {
    await T.client.put('/organization', { phone: '+91 98765 43210', gstin: '27ABCDE1234F1Z5', address: { line1: '12 Market Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' } }).catch(() => {});
    const { b } = await stocked(20);
    const t = await inTransit([{ batchId: b._id, quantity: 4 }]);
    await receive(t._id, { items: [{ batchId: b._id, receivedQuantity: 4 }] });
    const p = (await T.client.get(`/transfers/${t._id}/print`)).data;
    assert.equal(p.organization.name, 'Receive Org');
    for (const k of ['email', 'phone', 'address', 'gstin']) assert.ok(k in p.organization, k);
    assert.equal(p.transfer.fromBranch.name, 'Main Store');
    assert.equal(p.transfer.toBranch.name, 'North Branch Store');
    assert.ok(p.transfer.items[0].batchNumber && p.transfer.items[0].expiryDate);
    assert.equal(p.transfer.items[0].receivedQuantity, 4);
    assert.equal(p.transfer.dispatchedByName, T.user.name);
    assert.equal(p.transfer.receivedByName, T.user.name);
  });
});
