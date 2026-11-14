// Transfer permissions: granular permissions, store-level access (source dispatches, destination receives, managers see their stores),
// no self-approval, and organization isolation, all enforced by the API.
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
const submitted = async (qty = 5) => {
  const { b } = await stocked(40);
  const d = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: qty }]))).data;
  return { b, d };
};
const codeOf = (r) => r.body.code || r.body.error?.code;

describe('Granular permissions', () => {
  it('transfer:manage still covers create/edit/submit/cancel; inventory:read covers view and print; approve covers reject', async () => {
    const { effectivePermissions } = await import('../config/permissions.js');
    const mgr = effectivePermissions({ role: 'INVENTORY_MANAGER' });
    for (const p of ['transfer:view', 'transfer:create', 'transfer:edit', 'transfer:submit', 'transfer:cancel', 'transfer:print', 'transfer:dispatch', 'transfer:receive']) assert.ok(mgr.includes(p), p);
    assert.ok(!mgr.includes('transfer:approve'));
    assert.ok(effectivePermissions({ role: 'BRANCH_MANAGER' }).includes('transfer:reject'));
    assert.deepEqual(effectivePermissions({ role: 'STAFF' }).filter((p) => p.startsWith('transfer:')).sort(), ['transfer:print', 'transfer:view']);
  });

  it('each endpoint needs its own permission', async () => {
    const { d } = await submitted();
    const viewer = await user('STAFF');
    assert.equal((await viewer.c.get('/transfers')).status, 200);
    assert.equal((await viewer.c.get(`/transfers/${d._id}/print`)).status, 200);
    assert.equal((await viewer.c.post('/transfers', body([]))).status, 403);
    assert.equal((await viewer.c.put(`/transfers/${d._id}`, body([]))).status, 403);
    assert.equal((await viewer.c.post(`/transfers/${d._id}/submit`)).status, 403);
    assert.equal((await viewer.c.post(`/transfers/${d._id}/cancel`, {})).status, 403);
    assert.equal((await viewer.c.post(`/transfers/${d._id}/reject`, { reason: 'No thanks' })).status, 403);
    const creatorOnly = await user('STAFF', { permissions: ['transfer:create'] });
    assert.notEqual((await creatorOnly.c.post('/transfers', body([]))).status, 403, 'create is enough to create (validation may still fail)');
    assert.equal((await creatorOnly.c.post(`/transfers/${d._id}/submit`)).status, 403, 'but not to submit');
  });
});

describe('Stores: source dispatches, destination receives, managers see their own stores', () => {
  it('a user limited to the source store can dispatch but not receive; the destination user the reverse', async () => {
    const { d } = await submitted();
    const src = await user('INVENTORY_MANAGER', { branchIds: [main._id] });
    const dst = await user('INVENTORY_MANAGER', { branchIds: [north._id] });
    assert.equal((await src.c.post(`/transfers/${d._id}/submit`)).status, 200);
    const wrong = await dst.c.post(`/transfers/${d._id}/dispatch`, {});
    assert.equal(wrong.status, 403);
    assert.equal(codeOf(wrong), 'NOT_SOURCE_STORE');
    assert.equal((await src.c.post(`/transfers/${d._id}/dispatch`, {})).status, 200);
    const wrong2 = await src.c.post(`/transfers/${d._id}/receive`, {});
    assert.equal(wrong2.status, 403);
    assert.equal(codeOf(wrong2), 'NOT_DESTINATION_STORE');
    assert.equal((await dst.c.post(`/transfers/${d._id}/receive`, {})).status, 200);
    assert.equal((await get(d._id)).status, 'completed');
  });

  it('users only see transfers that involve their stores (list, summary, details, history, print); others are 404', async () => {
    const { b } = await stocked(30);
    const mn = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 3 }]))).data; // main -> north
    const southOnly = await user('BRANCH_MANAGER', { branchIds: [south._id] });
    const northUser = await user('BRANCH_MANAGER', { branchIds: [north._id] });
    const ids = (r) => r.data.items.map((x) => x._id);
    assert.ok(!ids(await southOnly.c.get('/transfers?limit=100')).includes(mn._id));
    assert.ok(ids(await northUser.c.get('/transfers?limit=100')).includes(mn._id));
    assert.ok(ids(await T.client.get('/transfers?limit=100')).includes(mn._id), 'admin sees everything');
    for (const path of ['', '/history', '/print']) assert.equal((await southOnly.c.get(`/transfers/${mn._id}${path}`)).status, 404, path);
    assert.equal((await northUser.c.get(`/transfers/${mn._id}`)).status, 200);
    assert.ok((await southOnly.c.get('/transfers/summary')).data.total < (await T.client.get('/transfers/summary')).data.total, 'the cards count only their transfers');
    assert.equal((await southOnly.c.post(`/transfers/${mn._id}/cancel`, {})).status, 404);
  });

  it('a store user can only draft transfers that leave their own store', async () => {
    const { b } = await stocked(30);
    const n = await user('INVENTORY_MANAGER', { branchIds: [north._id] });
    const r = await n.c.post('/transfers', body([{ batchId: b._id, quantity: 1 }])); // from main
    assert.equal(r.status, 403);
  });

  it('the details say what this user may do (access)', async () => {
    const { d } = await submitted();
    const dst = await user('INVENTORY_MANAGER', { branchIds: [north._id] });
    const a = (await dst.c.get(`/transfers/${d._id}`)).data.access;
    assert.equal(a.dispatch, false);
    assert.equal(a.receive, true);
    assert.equal((await T.client.get(`/transfers/${d._id}`)).data.access.dispatch, true);
  });
});

describe('Approving your own transfer', () => {
  it('is refused unless the organization allows it; org admins are exempt', async () => {
    await T.client.put('/transfers/settings', { approvalRequired: true });
    try {
      const { b } = await stocked(30);
      const bm = await user('BRANCH_MANAGER');
      const mine = (await bm.c.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
      assert.equal((await bm.c.post(`/transfers/${mine._id}/submit`)).data.status, 'submitted');
      const denied = await bm.c.post(`/transfers/${mine._id}/approve`);
      assert.equal(denied.status, 403);
      assert.equal(codeOf(denied), 'SELF_APPROVAL');
      const second = await user('BRANCH_MANAGER');
      assert.equal((await second.c.post(`/transfers/${mine._id}/approve`)).status, 200, 'someone else can');
      const adminOwn = (await T.client.post('/transfers', body([{ batchId: b._id, quantity: 2 }]))).data;
      await T.client.post(`/transfers/${adminOwn._id}/submit`);
      assert.equal((await T.client.post(`/transfers/${adminOwn._id}/approve`)).status, 200, 'org admin is exempt');
      assert.equal((await T.client.put('/transfers/settings', { approvalRequired: true, allowSelfApproval: true })).data.allowSelfApproval, true);
      const again = (await bm.c.post('/transfers', body([{ batchId: b._id, quantity: 1 }]))).data;
      await bm.c.post(`/transfers/${again._id}/submit`);
      assert.equal((await bm.c.post(`/transfers/${again._id}/approve`)).status, 200);
    } finally {
      await T.client.put('/transfers/settings', { approvalRequired: false, allowSelfApproval: false });
    }
  });
});

describe('Other organizations', () => {
  it('can never see or change these transfers', async () => {
    const { d } = await submitted();
    const calls = [['get', ''], ['get', '/history'], ['get', '/print'], ['post', '/submit'], ['post', '/approve'], ['post', '/reject', { reason: 'nope nope' }], ['post', '/dispatch', {}], ['post', '/receive', {}], ['post', '/cancel', {}], ['del', ''], ['put', '', body([{ batchId: d.items[0].batchId, quantity: 1 }])]];
    for (const [m, path, payload] of calls) {
      const r = await other.client[m](`/transfers/${d._id}${path}`, payload);
      assert.equal(r.status, 404, `${m} ${path} -> ${r.status}`);
    }
    assert.ok(!(await other.client.get('/transfers?limit=100')).data.items.some((x) => x._id === d._id));
    assert.equal((await get(d._id)).status, 'draft', 'nothing changed');
  });
});
