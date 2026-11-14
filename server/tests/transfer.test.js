// Inter-store transfers: stores, the draft -> send -> receive workflow, conservation of stock, atomicity, concurrency,
// the stock ledger, selling only from the default store, permissions and organization isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { COLUMNS } from '../services/importValidation.js';
import { toCsv } from '../utils/csv.js';

let h;
let T;
let other;
let main; // default store
let north;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const TODAY = new Date().toISOString().slice(0, 10);

const medicine = async (client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Transfer Med'), reorderLevel: 5, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const receiveStock = async (client, medicineId, quantity, extra = {}) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('LOT'), expiryDate: futureDate(2), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: quantity, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** A medicine with one batch of `qty` units in the default store. */
const stocked = async (qty = 100, client = T.client) => {
  const m = await medicine(client);
  const b = await receiveStock(client, m._id, qty);
  return { m, b };
};
const body = (over = {}) => ({ fromBranchId: main._id, toBranchId: north._id, transferDate: TODAY, notes: '', items: [], ...over });
const draft = async (items, over = {}, client = T.client) => {
  const r = await client.post('/transfers', body({ items, ...over }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** `send` is shorthand for the two steps that put stock on the road when approval is not required: submit, then dispatch. */
const act = async (id, what, client = T.client, payload) => {
  if (what === 'send') {
    const submitted = await client.post(`/transfers/${id}/submit`);
    return submitted.status === 200 ? client.post(`/transfers/${id}/dispatch`) : submitted;
  }
  return client.post(`/transfers/${id}/${what}`, payload);
};
const batchOf = async (id, client = T.client) => (await client.get(`/batches/${id}`)).data;
const inStore = async (medicineId, branchId, client = T.client) => (await client.get(`/batches?medicineId=${medicineId}&branchId=${branchId}&limit=50`)).data.items;
const units = (rows) => rows.reduce((s, r) => s + r.availableQuantity, 0);
const reconciled = async (client = T.client) => (await client.get('/stock/reconciliation')).data.consistent;
const expiredBatch = (org, medicineId, number, qty) =>
  h.tenant.runWithTenant(org._id, async () => {
    const b = await h.models.Batch.create({ medicineId, batchNumber: number, expiryDate: new Date(Date.now() - 3 * 86400000), mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty, branchId: main._id });
    await h.models.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty, reason: 'Batch received' });
    return b.toObject();
  });

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Transfer Org');
  other = await h.makeTenant('Transfer Other Org');
  const stores = (await T.client.get('/branches')).data;
  main = stores.find((s) => s.isDefault);
  const r = await T.client.post('/branches', { name: 'North Branch Store', code: 'north' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  north = r.data;
});

after(async () => {
  await h?.stop();
});

describe('Stores', () => {
  it('every organization has a default Main Store from the start', async () => {
    assert.equal(main.name, 'Main Store');
    assert.equal(main.isDefault, true);
    assert.equal(main.status, 'active');
    const theirs = (await other.client.get('/branches')).data;
    assert.equal(theirs.length, 1);
    assert.notEqual(String(theirs[0]._id), String(main._id));
  });

  it('adds stores, uppercases the code, and refuses duplicate names or codes (any case)', async () => {
    assert.equal(north.code, 'NORTH');
    for (const dup of [{ name: 'north branch store', code: 'X1' }, { name: 'Other', code: 'NORTH' }, { name: 'Another', code: 'north' }]) {
      const r = await T.client.post('/branches', dup);
      assert.equal(r.status, 409, JSON.stringify(dup));
      assert.equal(r.body.code, 'DUPLICATE');
    }
    assert.equal((await other.client.post('/branches', { name: 'North Branch Store', code: 'NORTH' })).status, 201, 'another organization may reuse them');
  });

  it('validates store input', async () => {
    for (const b of [{}, { name: '', code: 'A' }, { name: 'X', code: '' }, { name: 'X', code: 'has space' }, { name: 'x'.repeat(101), code: 'A' }]) {
      assert.equal((await T.client.post('/branches', b)).status, 400, JSON.stringify(b));
    }
    assert.equal((await T.client.put(`/branches/${north._id}`, {})).status, 400);
  });

  it('edits a store; the default store cannot be deactivated or deleted', async () => {
    const r = await T.client.put(`/branches/${north._id}`, { address: '12 North Road', phone: '9876543210' });
    assert.equal(r.data.address, '12 North Road');
    for (const res of [await T.client.put(`/branches/${main._id}`, { status: 'inactive' }), await T.client.del(`/branches/${main._id}`)]) {
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'DEFAULT_BRANCH');
    }
  });

  it('lists stores with their stock and open transfers', async () => {
    const { m, b } = await stocked(40);
    const t = await draft([{ batchId: b._id, quantity: 15 }]);
    await act(t._id, 'send');
    const list = (await T.client.get('/branches')).data;
    const mainRow = list.find((s) => s.isDefault);
    assert.ok(mainRow.unitsOnHand >= 25 && mainRow.batchCount >= 1);
    assert.ok(mainRow.openTransfers >= 1, 'a sent transfer is still open');
    assert.deepEqual(list.map((s) => s.isDefault), [true, false], 'the default store comes first');
    await act(t._id, 'cancel'); // tidy: return the units
    assert.ok(m);
  });

  it('a store with stock or transfers cannot be deleted, only deactivated; an unused one can be deleted', async () => {
    const empty = (await T.client.post('/branches', { name: 'Never Used', code: 'NU' })).data;
    assert.equal((await T.client.del(`/branches/${empty._id}`)).status, 200);
    const used = await T.client.del(`/branches/${north._id}`);
    assert.equal(used.status, 409);
    assert.equal(used.body.code, 'IN_USE');
  });

  it('a store with open transfers cannot be deactivated', async () => {
    const east = (await T.client.post('/branches', { name: 'East Store', code: 'EAST' })).data;
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 1 }], { toBranchId: east._id });
    const r = await T.client.put(`/branches/${east._id}`, { status: 'inactive' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BRANCH_IN_USE');
    await T.client.del(`/transfers/${t._id}`);
    assert.equal((await T.client.put(`/branches/${east._id}`, { status: 'inactive' })).status, 200);
    const to = await T.client.post('/transfers', body({ toBranchId: east._id, items: [{ batchId: b._id, quantity: 1 }] }));
    assert.equal(to.status, 409, 'and an inactive store cannot be a destination');
    assert.equal(to.body.code, 'BRANCH_INACTIVE');
  });

  it('stores are private to their organization', async () => {
    assert.equal((await other.client.put(`/branches/${north._id}`, { name: 'Hacked' })).status, 404);
    assert.equal((await other.client.del(`/branches/${north._id}`)).status, 404);
    assert.ok(!(await other.client.get('/branches')).data.some((s) => String(s._id) === String(north._id)));
  });
});

describe('Batches and stores', () => {
  it('a received batch is held in the default store and its store cannot be edited', async () => {
    const { b } = await stocked(10);
    assert.equal(String((await batchOf(b._id)).branchId), String(main._id));
    const r = await T.client.patch(`/batches/${b._id}`, { branchId: north._id });
    assert.equal(r.status, 400, 'the store is not an editable field');
    assert.equal(String((await batchOf(b._id)).branchId), String(main._id));
  });

  it('a batch can be received into another store of the same organization, but not into a foreign or inactive one', async () => {
    const m = await medicine(T.client);
    const ok = await receiveStock(T.client, m._id, 5, { branchId: north._id });
    assert.equal(String((await batchOf(ok._id)).branchId), String(north._id));
    const theirs = (await other.client.get('/branches')).data[0];
    const foreign = await T.client.post('/batches', { medicineId: m._id, batchNumber: uniq('F'), expiryDate: futureDate(2), mrp: 10, sellingPrice: 9, initialQuantity: 1, branchId: theirs._id });
    assert.equal(foreign.status, 404, 'another organization’s store is rejected');
    assert.equal((await T.client.post('/batches', { medicineId: m._id, batchNumber: uniq('F'), expiryDate: futureDate(2), mrp: 10, sellingPrice: 9, initialQuantity: 1, branchId: 'nope' })).status, 400);
  });

  it('the same batch number can exist in two stores, but not twice in one store', async () => {
    const m = await medicine(T.client);
    await receiveStock(T.client, m._id, 5, { batchNumber: 'SAME-1' });
    assert.equal((await T.client.post('/batches', { medicineId: m._id, batchNumber: 'SAME-1', expiryDate: futureDate(2), mrp: 10, sellingPrice: 9, initialQuantity: 1 })).status, 409);
    await receiveStock(T.client, m._id, 5, { batchNumber: 'SAME-1', branchId: north._id });
  });

  it('the batch list can be filtered by store and shows each batch’s store', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 7);
    const b = await receiveStock(T.client, m._id, 3, { branchId: north._id });
    const inMain = await inStore(m._id, main._id);
    const inNorth = await inStore(m._id, north._id);
    assert.deepEqual(inMain.map((x) => x._id), [a._id]);
    assert.deepEqual(inNorth.map((x) => x._id), [b._id]);
    assert.equal(inMain[0].branchName, 'Main Store');
    assert.equal(inNorth[0].branchName, 'North Branch Store');
  });
});

describe('Creating a draft', () => {
  it('numbers transfers per organization (TRF-0001 …) and records the lines without moving stock', async () => {
    const { b } = await stocked(50);
    const t = await draft([{ batchId: b._id, quantity: 20 }], { notes: 'Weekly top-up' });
    assert.match(t.reference, /^TRF-\d{4}$/);
    assert.equal(t.status, 'draft');
    assert.equal(t.itemCount, 1);
    assert.equal(t.totalUnits, 20);
    assert.equal(t.fromBranch.name, 'Main Store');
    assert.equal(t.toBranch.name, 'North Branch Store');
    assert.equal(t.notes, 'Weekly top-up');
    assert.equal(t.items[0].batchNumber, b.batchNumber);
    assert.equal((await batchOf(b._id)).availableQuantity, 50, 'a draft moves nothing');
    const next = await draft([{ batchId: b._id, quantity: 1 }]);
    assert.equal(Number(next.reference.slice(4)), Number(t.reference.slice(4)) + 1);
    const theirs = await draft([{ batchId: (await stocked(5, other.client)).b._id, quantity: 1 }], { fromBranchId: (await other.client.get('/branches')).data[0]._id, toBranchId: (await other.client.get('/branches')).data.find((s) => !s.isDefault)?._id || (await other.client.post('/branches', { name: 'Their Second', code: 'T2' })).data._id }, other.client);
    assert.equal(theirs.reference, 'TRF-0001', 'each organization has its own numbering');
  });

  it('shows a draft’s lines with what each batch has available right now', async () => {
    const m = await medicine(T.client, { strength: '500 mg', dosageForm: 'Tablet' });
    const b = await receiveStock(T.client, m._id, 40);
    const d = await draft([{ batchId: b._id, quantity: 10 }]);
    assert.equal(d.items[0].availableNow, 40);
    assert.equal(d.items[0].subtitle, '500 mg · Tablet');
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -25, reason: 'Stock take: fifteen left' });
    assert.equal((await T.client.get(`/transfers/${d._id}`)).data.items[0].availableNow, 15, 'it follows the batch');
    await act(d._id, 'send');
    assert.equal((await T.client.get(`/transfers/${d._id}`)).data.items[0].availableNow, undefined, 'only drafts carry it');
  });

  it('rejects an invalid draft with a message for each problem, on the right field', async () => {
    const { b } = await stocked(10);
    const bad = async (over, path, fragment) => {
      const r = await T.client.post('/transfers', body(over));
      assert.equal(r.status, 400, JSON.stringify(over));
      const d = (r.body.details || []).find((x) => x.path === path);
      assert.ok(d, `${path}: ${JSON.stringify(r.body.details)}`);
      if (fragment) assert.match(d.message, fragment);
    };
    await bad({ items: [] }, 'items', /at least one/i);
    await bad({ items: [{ batchId: b._id, quantity: 0 }] }, 'items.0.quantity', /at least 1/);
    await bad({ items: [{ batchId: b._id, quantity: 2.5 }] }, 'items.0.quantity', /whole/);
    await bad({ items: [{ batchId: b._id, quantity: 11 }] }, 'items.0.quantity', /Only 10 unit/);
    await bad({ items: [{ batchId: b._id, quantity: 1 }, { batchId: b._id, quantity: 1 }] }, 'items.1.batchId', /already on the transfer/);
    await bad({ items: [{ batchId: b._id, quantity: 1 }], toBranchId: main._id }, 'toBranchId', /different destination/);
    await bad({ items: [{ batchId: b._id, quantity: 1 }], transferDate: '2026-02-30' }, 'transferDate');
    await bad({ items: [{ batchId: b._id, quantity: 1 }], transferDate: 'soon' }, 'transferDate');
    await bad({ items: [{ batchId: b._id, quantity: 1 }], notes: 'x'.repeat(501) }, 'notes');
    await bad({ items: [{ batchId: 'nope', quantity: 1 }] }, 'items.0.batchId');
  });

  it('only batches held in the source store can be transferred from it', async () => {
    const m = await medicine(T.client);
    const northBatch = await receiveStock(T.client, m._id, 9, { branchId: north._id });
    const r = await T.client.post('/transfers', body({ items: [{ batchId: northBatch._id, quantity: 1 }] }));
    assert.equal(r.status, 400);
    assert.match(r.body.details[0].message, /not held in Main Store/);
    const back = await T.client.post('/transfers', body({ fromBranchId: north._id, toBranchId: main._id, items: [{ batchId: northBatch._id, quantity: 9 }] }));
    assert.equal(back.status, 201, 'but it can go the other way');
  });

  it('refuses expired, quarantined and reserved stock', async () => {
    const m = await medicine(T.client);
    const old = await expiredBatch(T.org, m._id, uniq('OLD'), 10);
    const r = await T.client.post('/transfers', body({ items: [{ batchId: String(old._id), quantity: 1 }] }));
    assert.equal(r.status, 400);
    assert.match(r.body.details[0].message, /has expired/);

    const q = await receiveStock(T.client, m._id, 10);
    await T.client.patch(`/batches/${q._id}`, { status: 'quarantined' });
    assert.match((await T.client.post('/transfers', body({ items: [{ batchId: q._id, quantity: 1 }] }))).body.details[0].message, /quarantined/);

    const res = await receiveStock(T.client, m._id, 10);
    await T.client.patch(`/batches/${res._id}`, { reservedQuantity: 8 });
    const only2 = await T.client.post('/transfers', body({ items: [{ batchId: res._id, quantity: 3 }] }));
    assert.match(only2.body.details[0].message, /Only 2 unit/, 'reserved units are not available');
  });

  it('refuses an archived medicine', async () => {
    const { m, b } = await stocked(10);
    await T.client.del(`/inventory/${m._id}`);
    const r = await T.client.post('/transfers', body({ items: [{ batchId: b._id, quantity: 1 }] }));
    assert.equal(r.status, 400);
    assert.match(r.body.details[0].message, /archived/);
  });
});

describe('Editing and deleting drafts', () => {
  it('a draft can be edited and deleted; once sent it can be neither', async () => {
    const { b } = await stocked(30);
    const t = await draft([{ batchId: b._id, quantity: 5 }]);
    const edited = await T.client.put(`/transfers/${t._id}`, body({ items: [{ batchId: b._id, quantity: 12 }], notes: 'Changed' }));
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.data.totalUnits, 12);
    assert.equal(edited.data.notes, 'Changed');
    assert.equal(edited.data.reference, t.reference, 'the reference never changes');

    await act(t._id, 'send');
    const put = await T.client.put(`/transfers/${t._id}`, body({ items: [{ batchId: b._id, quantity: 1 }] }));
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'TRANSFER_STATE');
    const del = await T.client.del(`/transfers/${t._id}`);
    assert.equal(del.status, 409);
    assert.match(del.body.message, /Only a draft can be deleted/);
    assert.equal((await T.client.get(`/transfers/${t._id}`)).status, 200, 'it is still there');
  });

  it('deleting a draft removes it', async () => {
    const { b } = await stocked(5);
    const t = await draft([{ batchId: b._id, quantity: 1 }]);
    assert.equal((await T.client.del(`/transfers/${t._id}`)).status, 200);
    assert.equal((await T.client.get(`/transfers/${t._id}`)).status, 404);
  });
});

describe('Sending and receiving', () => {
  it('send takes the units out of the source store; receive puts them in the destination; nothing is created or lost', async () => {
    const { m, b } = await stocked(100);
    const totalBefore = (await T.client.get(`/inventory/${m._id}`)).data.totalStock;
    const t = await draft([{ batchId: b._id, quantity: 30 }]);

    const sent = await act(t._id, 'send');
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.data.status, 'in_transit');
    assert.equal((await batchOf(b._id)).availableQuantity, 70, 'the units left the source batch');
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.totalStock, 70, 'and are in transit: counted in no store');
    assert.equal(units(await inStore(m._id, north._id)), 0, 'the destination has nothing yet');
    assert.ok((await T.client.get('/transfers/in-transit')).data.units >= 30);
    assert.ok(await reconciled());

    const received = await act(t._id, 'receive');
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.data.status, 'completed');
    const north1 = await inStore(m._id, north._id);
    assert.equal(north1.length, 1);
    assert.equal(north1[0].batchNumber, b.batchNumber, 'the same lot');
    assert.equal(north1[0].availableQuantity, 30);
    assert.equal(new Date(north1[0].expiryDate).getTime(), new Date(b.expiryDate).getTime(), 'with the same expiry');
    assert.deepEqual([north1[0].sellingPrice, north1[0].mrp, north1[0].purchasePrice], [90, 100, 60], 'and the same prices');
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.totalStock, totalBefore, 'total stock is conserved');
    assert.equal(units(await inStore(m._id, main._id)), 70);
    assert.ok(await reconciled(), 'the ledger still adds up to every batch');
  });

  it('writes a TRANSFER_OUT and a TRANSFER_IN ledger entry that point at the transfer', async () => {
    const { b } = await stocked(20);
    const t = await draft([{ batchId: b._id, quantity: 8 }]);
    await act(t._id, 'send');
    await act(t._id, 'receive');
    const out = (await T.client.get(`/batches/${b._id}/movements`)).data.items;
    assert.deepEqual(out.map((x) => [x.type, x.quantity, x.balanceAfter]), [['TRANSFER_OUT', -8, 12], ['PURCHASE', 20, 20]]);
    assert.match(out[0].reason, new RegExp(`Dispatch DSP-[0-9]+ for transfer ${t.reference} to North Branch Store`));
    const dest = (await T.client.get(`/batches?search=${encodeURIComponent(b.batchNumber)}&branchId=${north._id}`)).data.items[0];
    const inn = (await T.client.get(`/batches/${dest._id}/movements`)).data.items;
    assert.deepEqual(inn.map((x) => [x.type, x.quantity, x.balanceAfter]), [['TRANSFER_IN', 8, 8]]);
    assert.match(inn[0].reason, new RegExp(`Receipt RCV-[0-9]+ for transfer ${t.reference} from Main Store`));
  });

  it('a second transfer of the same lot adds to the destination batch instead of creating another', async () => {
    const { m, b } = await stocked(50);
    for (const q of [10, 15]) {
      const t = await draft([{ batchId: b._id, quantity: q }]);
      await act(t._id, 'send');
      assert.equal((await act(t._id, 'receive')).status, 200);
    }
    const north1 = await inStore(m._id, north._id);
    assert.equal(north1.length, 1);
    assert.equal(north1[0].availableQuantity, 25);
    assert.equal((await batchOf(b._id)).availableQuantity, 25);
    assert.ok(await reconciled());
  });

  it('transfers several lines at once, including two lots of one medicine', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 10, { expiryDate: futureDate(1) });
    const c = await receiveStock(T.client, m._id, 20, { expiryDate: futureDate(3) });
    const { b: other1 } = await stocked(9);
    const t = await draft([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 5 }, { batchId: other1._id, quantity: 9 }]);
    await act(t._id, 'send');
    await act(t._id, 'receive');
    assert.equal((await batchOf(a._id)).availableQuantity, 0);
    assert.equal((await batchOf(c._id)).availableQuantity, 15);
    assert.equal(units(await inStore(m._id, north._id)), 15);
    assert.equal((await T.client.get(`/transfers/${t._id}`)).data.totalUnits, 24);
  });

  it('each step happens once: a repeated send, receive or out-of-order step is refused', async () => {
    const { b } = await stocked(20);
    const t = await draft([{ batchId: b._id, quantity: 5 }]);
    assert.equal((await act(t._id, 'receive')).status, 409, 'cannot receive a draft');
    assert.equal((await act(t._id, 'send')).status, 200);
    const again = await act(t._id, 'send');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'TRANSFER_STATE');
    assert.equal((await act(t._id, 'receive')).status, 200);
    assert.equal((await act(t._id, 'receive')).status, 409);
    assert.equal((await batchOf(b._id)).availableQuantity, 15, 'stock moved exactly once');
    assert.equal(units(await inStore((await batchOf(b._id)).medicineId, north._id)), 5);
  });

  it('two simultaneous sends of one draft move the stock once', async () => {
    const { b } = await stocked(20);
    const t = await draft([{ batchId: b._id, quantity: 6 }]);
    const [x, y] = await Promise.all([act(t._id, 'send'), act(t._id, 'send')]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((await batchOf(b._id)).availableQuantity, 14);
    const [r1, r2] = await Promise.all([act(t._id, 'receive'), act(t._id, 'receive')]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(units(await inStore((await batchOf(b._id)).medicineId, north._id)), 6);
    assert.ok(await reconciled());
  });

  it('two drafts competing for the same units: one sends, the other is refused, and stock never goes negative', async () => {
    const { b } = await stocked(10);
    const t1 = await draft([{ batchId: b._id, quantity: 8 }]);
    const t2 = await draft([{ batchId: b._id, quantity: 8 }]);
    const [x, y] = await Promise.all([act(t1._id, 'send'), act(t2._id, 'send')]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const loser = x.status === 409 ? x : y;
    assert.equal(loser.body.code, 'INSUFFICIENT_STOCK');
    assert.equal((await batchOf(b._id)).availableQuantity, 2);
    const states = [(await T.client.get(`/transfers/${t1._id}`)).data.status, (await T.client.get(`/transfers/${t2._id}`)).data.status].sort();
    assert.deepEqual(states, ['approved', 'in_transit'], 'the refused one stays approved, ready to try again');
    assert.ok(await reconciled());
  });

  it('is all-or-nothing: if one line cannot be sent, no line is', async () => {
    const m = await medicine(T.client);
    const a = await receiveStock(T.client, m._id, 20);
    const c = await receiveStock(T.client, m._id, 20);
    const t = await draft([{ batchId: a._id, quantity: 10 }, { batchId: c._id, quantity: 10 }]);
    assert.equal((await act(t._id, 'submit')).status, 200);
    assert.equal((await T.client.post('/stock/adjustments', { batchId: c._id, quantity: -15, reason: 'Damaged before dispatch' })).status, 201);
    const r = await act(t._id, 'dispatch');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'INSUFFICIENT_STOCK');
    assert.equal(r.body.details[0].path, 'items.1.quantity');
    assert.equal((await batchOf(a._id)).availableQuantity, 20, 'the first line was not taken');
    assert.equal((await T.client.get(`/transfers/${t._id}`)).data.status, 'approved', 'and the transfer is still approved, waiting');
    assert.equal((await T.client.get(`/batches/${a._id}/movements`)).data.total, 1, 'no ledger entry was left behind');
    assert.ok(await reconciled());
  });

  it('a batch that expired after the draft was made cannot be sent', async () => {
    const m = await medicine(T.client);
    const b = await receiveStock(T.client, m._id, 10);
    const t = await draft([{ batchId: b._id, quantity: 4 }]);
    await h.models.Batch.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(b._id) }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
    const r = await act(t._id, 'send');
    assert.ok([400, 409].includes(r.status), `an expired batch must not be dispatched (got ${r.status})`);
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
  });

  it('receiving fails cleanly, and can be retried, when the destination already holds that lot with a different expiry', async () => {
    const { m, b } = await stocked(10);
    await h.tenant.runWithTenant(T.org._id, async () => {
      const held = await h.models.Batch.create({ medicineId: m._id, batchNumber: b.batchNumber, expiryDate: new Date(Date.now() + 5 * 86400000), mrp: 1, sellingPrice: 1, initialQuantity: 3, availableQuantity: 3, branchId: north._id });
      await h.models.StockMovement.create({ medicineId: m._id, batchId: held._id, type: 'PURCHASE', quantity: 3, balanceAfter: 3, reason: 'Batch received' });
    });
    const t = await draft([{ batchId: b._id, quantity: 4 }]);
    await act(t._id, 'send');
    const r = await act(t._id, 'receive');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BATCH_CONFLICT');
    assert.equal((await T.client.get(`/transfers/${t._id}`)).data.status, 'in_transit', 'still in transit, nothing half-done');
    assert.equal(units(await inStore(m._id, north._id)), 3, 'the destination batch was not touched');
    assert.equal((await act(t._id, 'cancel')).status, 200, 'it can still be called back');
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
  });
});

describe('Cancelling', () => {
  it('cancelling a draft changes no stock', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 5 }]);
    const r = await act(t._id, 'cancel', T.client, { reason: 'Changed my mind' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'cancelled');
    assert.equal(r.data.cancelReason, 'Changed my mind');
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
    assert.equal((await T.client.get(`/batches/${b._id}/movements`)).data.total, 1);
  });

  it('cancelling a sent transfer returns the units to the source store, with a ledger entry', async () => {
    const { b } = await stocked(30);
    const t = await draft([{ batchId: b._id, quantity: 12 }]);
    await act(t._id, 'send');
    assert.equal((await batchOf(b._id)).availableQuantity, 18);
    const r = await act(t._id, 'cancel', T.client, { reason: 'Wrong store' });
    assert.equal(r.data.status, 'cancelled');
    assert.equal((await batchOf(b._id)).availableQuantity, 30, 'the units are back');
    const ledger = (await T.client.get(`/batches/${b._id}/movements`)).data.items;
    assert.deepEqual(ledger.map((x) => [x.type, x.quantity, x.balanceAfter]), [['TRANSFER_IN', 12, 30], ['TRANSFER_OUT', -12, 18], ['PURCHASE', 30, 30]]);
    assert.match(ledger[0].reason, /cancelled — units returned/);
    assert.ok(await reconciled());
  });

  it('a received or cancelled transfer cannot be cancelled', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 2 }]);
    await act(t._id, 'send');
    await act(t._id, 'receive');
    assert.equal((await act(t._id, 'cancel')).status, 409);
    const t2 = await draft([{ batchId: b._id, quantity: 1 }]);
    await act(t2._id, 'cancel');
    assert.equal((await act(t2._id, 'cancel')).status, 409);
    assert.equal((await act(t2._id, 'send')).status, 409, 'and a cancelled transfer cannot be sent');
  });

  it('two simultaneous cancels return the units once', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 4 }]);
    await act(t._id, 'send');
    const [x, y] = await Promise.all([act(t._id, 'cancel'), act(t._id, 'cancel')]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((await batchOf(b._id)).availableQuantity, 10);
  });
});

describe('Reading transfers', () => {
  it('lists with search (reference, medicine, batch), status, store filters and pagination', async () => {
    const { m, b } = await stocked(500);
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await draft([{ batchId: b._id, quantity: 1 + i }]));
    await act(made[0]._id, 'send');
    const q = async (s) => (await T.client.get(`/transfers?${s}`)).data;
    assert.ok((await q(`search=${made[1].reference}`)).items.some((t) => t._id === made[1]._id));
    assert.equal((await q(`search=${made[1].reference}`)).total, 1);
    assert.ok((await q(`search=${encodeURIComponent(m.medicineName)}`)).total >= 3, 'found by medicine name');
    assert.ok((await q(`search=${encodeURIComponent(b.batchNumber)}`)).total >= 3, 'and by batch number');
    assert.ok((await q('status=in_transit')).total >= 1 && (await q('status=in_transit')).items.every((t) => t.status === 'in_transit'));
    assert.ok((await q('status=draft')).items.every((t) => t.status === 'draft'));
    assert.equal((await q(`fromBranchId=${north._id}&search=${made[0].reference}`)).total, 0);
    assert.ok((await q(`toBranchId=${north._id}`)).total >= 3);
    const p1 = await q('limit=2&page=1');
    assert.equal(p1.items.length, 2);
    assert.ok(p1.pages >= 2);
    assert.ok(p1.items.every((t) => t.reference && t.fromBranch.name && t.toBranch.name && 'itemCount' in t && 'totalUnits' in t));
    assert.equal(JSON.stringify(p1.items).includes('"items":'), false, 'the list does not carry every line');
    assert.equal((await T.client.get('/transfers?status=weird')).status, 400);
    assert.equal((await T.client.get('/transfers?search=&status=&fromBranchId=&toBranchId=&page=1&limit=10')).status, 200, 'empty filters mean no filter');
    assert.equal((await T.client.get('/transfers?search=.*')).data.total, 0, 'search text is literal');
  });

  it('shows the history of a transfer: who did what, and when', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 3 }]);
    await act(t._id, 'send');
    await act(t._id, 'receive');
    const got = (await T.client.get(`/transfers/${t._id}`)).data;
    assert.deepEqual(got.timeline.map((e) => e.event), ['created', 'submitted', 'approved', 'dispatched', 'received']);
    assert.ok(got.timeline.every((e) => e.at), 'every step has a time');
    assert.ok(got.timeline.filter((e) => e.event !== 'approved').every((e) => e.by), 'and names the person (an automatic approval has none)');
    assert.equal(got.createdByName, got.timeline[0].by);
  });

  it('unknown or malformed ids are 404', async () => {
    assert.equal((await T.client.get('/transfers/not-an-id')).status, 404);
    assert.equal((await T.client.get(`/transfers/${'0'.repeat(24)}`)).status, 404);
    assert.equal((await act('not-an-id', 'send')).status, 404);
  });

  it('records each step in the activity log', async () => {
    const log = JSON.stringify((await T.client.get('/activity?limit=100')).body);
    for (const w of [/drafted/, /Transfer TRF-\d+ submitted/, /Dispatch DSP-\d+ for transfer TRF-\d+/, /Receipt RCV-\d+ for transfer TRF-\d+ at/, /cancelled/]) assert.match(log, w);
  });
});

describe('Selling and stores', () => {
  it('the Selling Point sells from the default store only; stock sitting in another store is not sold', async () => {
    const { m, b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 10 }]);
    await act(t._id, 'send');
    await act(t._id, 'receive'); // everything is now in North
    const pos = (await T.client.get(`/pos/products?q=${encodeURIComponent(m.medicineName)}`)).data;
    const item = (pos.items || pos).find((x) => x.medicineName === m.medicineName);
    assert.ok(!item || item.availableStock === 0, 'not offered for sale in the main store');
    const sale = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 1 }], idempotencyKey: uniq('store-sale-0000') });
    assert.equal(sale.status, 409);
    assert.equal(units(await inStore(m._id, north._id)), 10, 'North’s stock is untouched');

    const back = await draft([{ batchId: (await inStore(m._id, north._id))[0]._id, quantity: 4 }], { fromBranchId: north._id, toBranchId: main._id });
    await act(back._id, 'send');
    await act(back._id, 'receive');
    const sale2 = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 3 }], idempotencyKey: uniq('store-sale-0001') });
    assert.equal(sale2.status, 201, JSON.stringify(sale2.body));
    assert.equal(units(await inStore(m._id, main._id)), 1, '4 came back, 3 were sold');
    assert.ok(await reconciled());
  });

  it('CSV import puts stock in the default store, and a lot held in another store is not a duplicate', async () => {
    const m = await medicine(T.client, { sku: uniq('IMPSKU') });
    await receiveStock(T.client, m._id, 5, { batchNumber: 'IMP-LOT', branchId: north._id });
    const HEAD = COLUMNS.map((c) => c.key);
    const row = { medicineName: m.medicineName, sku: m.sku, batchNumber: 'IMP-LOT', expiryDate: '2031-01-31', mrp: '10', sellingPrice: '9', quantity: '7' };
    const text = toCsv([HEAD, HEAD.map((k) => row[k] ?? '')]);
    const pv = await T.client.post('/import/inventory/preview?fileName=s.csv', text, { headers: { 'content-type': 'text/csv' } });
    assert.equal(pv.data.summary.valid, 1, JSON.stringify(pv.data.summary));
    const done = await T.client.post(`/import/inventory/${pv.data._id}/confirm`, { skipInvalid: true });
    assert.equal(done.data.summary.imported, 1);
    assert.equal(units(await inStore(m._id, main._id)), 7);
    assert.equal(units(await inStore(m._id, north._id)), 5);
  });
});

describe('Permissions and organization isolation', () => {
  it('only people with transfer permission can change transfers; everyone who reads inventory can view them', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 1 }]);
    const as = async (role) => {
      const u = await h.makeUser(T.org, { role });
      const c = h.client();
      await c.login(u.email);
      return c;
    };
    const staff = await as('STAFF');
    assert.equal((await staff.get('/transfers')).status, 200);
    assert.equal((await staff.get(`/transfers/${t._id}`)).status, 200);
    assert.equal((await staff.post('/transfers', body({ items: [{ batchId: b._id, quantity: 1 }] }))).status, 403);
    assert.equal((await act(t._id, 'send', staff)).status, 403);
    assert.equal((await act(t._id, 'cancel', staff)).status, 403);
    assert.equal((await staff.del(`/transfers/${t._id}`)).status, 403);
    assert.equal((await staff.post('/branches', { name: 'Nope', code: 'N' })).status, 403, 'managing stores is a settings permission');
    const billing = await as('BILLING_STAFF');
    assert.equal((await act(t._id, 'send', billing)).status, 403);
    for (const role of ['INVENTORY_MANAGER', 'BRANCH_MANAGER']) {
      const c = await as(role);
      assert.equal((await c.post('/transfers', body({ items: [{ batchId: b._id, quantity: 1 }] }))).status, 201, role);
    }
    assert.equal((await h.client().get('/transfers')).status, 401);
    assert.equal((await h.client().post('/transfers', body())).status, 401);
  });

  it('another organization can not see, edit, send, receive, cancel or delete my transfer', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 2 }]);
    await act(t._id, 'send');
    const o = other.client;
    assert.equal((await o.get(`/transfers/${t._id}`)).status, 404);
    assert.ok(!(await o.get('/transfers?limit=100')).data.items.some((x) => x._id === t._id));
    for (const what of ['send', 'receive', 'cancel']) assert.equal((await act(t._id, what, o)).status, 404, what);
    assert.equal((await o.del(`/transfers/${t._id}`)).status, 404);
    assert.equal((await o.put(`/transfers/${t._id}`, body({ items: [{ batchId: b._id, quantity: 1 }] }))).status, 404);
    assert.equal((await T.client.get(`/transfers/${t._id}`)).data.status, 'in_transit', 'unchanged');
    assert.equal((await batchOf(b._id)).availableQuantity, 8);
  });

  it('another organization’s stores and batches cannot be used in a transfer', async () => {
    const mine = await stocked(10);
    const theirs = await stocked(10, other.client);
    const theirStores = (await other.client.get('/branches')).data;
    const r1 = await T.client.post('/transfers', body({ toBranchId: theirStores[0]._id, items: [{ batchId: mine.b._id, quantity: 1 }] }));
    assert.equal(r1.status, 404, 'their store as my destination');
    const r2 = await T.client.post('/transfers', body({ items: [{ batchId: theirs.b._id, quantity: 1 }] }));
    assert.equal(r2.status, 400, 'their batch in my transfer');
    assert.match(r2.body.details[0].message, /not held in/);
    const r3 = await other.client.post('/transfers', { ...body({ items: [{ batchId: theirs.b._id, quantity: 1 }] }), fromBranchId: main._id, toBranchId: theirStores[0]._id });
    assert.ok([400, 404].includes(r3.status), 'my store as their source');
  });

  it('request bodies cannot choose the organization or the status', async () => {
    const { b } = await stocked(10);
    const r = await T.client.post('/transfers', { ...body({ items: [{ batchId: b._id, quantity: 1 }] }), organizationId: other.org._id, status: 'completed', reference: 'TRF-9999', sentAt: '2000-01-01' });
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'draft');
    assert.notEqual(r.data.reference, 'TRF-9999');
    assert.equal(String(r.data.organizationId), String(T.org._id));
    assert.equal(r.data.sentAt, undefined);
  });
});

describe('Approval workflow', () => {
  const setApproval = (on, client = T.client) => client.put('/transfers/settings', { approvalRequired: on });
  const as = async (role) => {
    const u = await h.makeUser(T.org, { role });
    const c = h.client();
    await c.login(u.email);
    return c;
  };

  it('approval is off by default: submit approves straight away and dispatch follows', async () => {
    assert.equal((await T.client.get('/transfers/settings')).data.approvalRequired, false);
    const { b } = await stocked(20);
    const t = await draft([{ batchId: b._id, quantity: 5 }]);
    const s = await act(t._id, 'submit');
    assert.equal(s.data.status, 'approved');
    assert.equal(s.data.autoApproved, true);
    assert.equal((await batchOf(b._id)).availableQuantity, 20, 'nothing moves until it is dispatched');
    assert.equal((await act(t._id, 'dispatch')).data.status, 'in_transit');
  });

  it('with approval required: draft -> submitted -> approved -> in transit -> completed, each by the right step', async () => {
    assert.equal((await setApproval(true)).data.approvalRequired, true);
    try {
      const { m, b } = await stocked(30);
      const t = await draft([{ batchId: b._id, quantity: 12 }]);
      const submitted = await act(t._id, 'submit');
      assert.equal(submitted.data.status, 'submitted');
      assert.equal(submitted.data.approvalRequired, true);
      assert.equal((await act(t._id, 'dispatch')).status, 409, 'cannot dispatch before it is approved');
      assert.equal((await batchOf(b._id)).availableQuantity, 30);

      const approved = await act(t._id, 'approve');
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.data.status, 'approved');
      assert.equal(approved.data.autoApproved, undefined);
      assert.equal((await batchOf(b._id)).availableQuantity, 30, 'approving moves no stock');
      assert.equal((await act(t._id, 'dispatch')).data.status, 'in_transit');
      assert.equal((await batchOf(b._id)).availableQuantity, 18);
      assert.equal((await act(t._id, 'receive')).data.status, 'completed');
      assert.equal(units(await inStore(m._id, north._id)), 12);
      assert.deepEqual((await T.client.get(`/transfers/${t._id}`)).data.timeline.map((e) => e.event), ['created', 'submitted', 'approved', 'dispatched', 'received']);
      assert.ok(await reconciled());
    } finally {
      await setApproval(false);
    }
  });

  it('an approver can reject with a reason; a rejected transfer is final and moves nothing', async () => {
    await setApproval(true);
    try {
      const { b } = await stocked(10);
      const t = await draft([{ batchId: b._id, quantity: 4 }]);
      await act(t._id, 'submit');
      assert.equal((await act(t._id, 'reject', T.client, {})).status, 400, 'a reason is required');
      assert.equal((await act(t._id, 'reject', T.client, { reason: 'ok' })).status, 400, 'and a real one');
      const r = await act(t._id, 'reject', T.client, { reason: 'Not needed at North' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.data.status, 'rejected');
      assert.equal(r.data.rejectReason, 'Not needed at North');
      const tl = r.data.timeline.find((e) => e.event === 'rejected');
      assert.equal(tl.note, 'Not needed at North');
      assert.ok(tl.by);
      for (const what of ['approve', 'dispatch', 'receive', 'submit']) assert.equal((await act(t._id, what, T.client, { reason: 'x' })).status, 409, what);
      assert.equal((await T.client.put(`/transfers/${t._id}`, body({ items: [{ batchId: b._id, quantity: 1 }] }))).status, 409, 'it cannot be edited');
      assert.equal((await T.client.del(`/transfers/${t._id}`)).status, 409, 'or deleted');
      assert.equal((await batchOf(b._id)).availableQuantity, 10);
    } finally {
      await setApproval(false);
    }
  });

  it('only approvers can approve or reject, and only settings managers change the setting', async () => {
    await setApproval(true);
    try {
      const { b } = await stocked(10);
      const t = await draft([{ batchId: b._id, quantity: 2 }]);
      await act(t._id, 'submit');
      const inventoryManager = await as('INVENTORY_MANAGER');
      assert.equal((await act(t._id, 'approve', inventoryManager)).status, 403, 'the people who prepare transfers cannot approve them');
      assert.equal((await act(t._id, 'reject', inventoryManager, { reason: 'no way' })).status, 403);
      assert.equal((await inventoryManager.put('/transfers/settings', { approvalRequired: false })).status, 403);
      assert.equal((await (await as('STAFF')).get('/transfers/settings')).status, 200, 'anyone can read it');
      const branchManager = await as('BRANCH_MANAGER');
      assert.equal((await act(t._id, 'approve', branchManager)).status, 200, 'a branch manager approves');
      assert.equal((await h.client().post(`/transfers/${t._id}/approve`)).status, 401);
    } finally {
      await setApproval(false);
    }
  });

  it('an approval can only be given once, and a transfer cannot be approved unless it was submitted', async () => {
    await setApproval(true);
    try {
      const { b } = await stocked(10);
      const t = await draft([{ batchId: b._id, quantity: 2 }]);
      assert.equal((await act(t._id, 'approve')).status, 409, 'a draft cannot be approved');
      await act(t._id, 'submit');
      const [x, y] = await Promise.all([act(t._id, 'approve'), act(t._id, 'approve')]);
      assert.deepEqual([x.status, y.status].sort(), [200, 409]);
      const [r, a] = await Promise.all([act(t._id, 'reject', T.client, { reason: 'too late now' }), act(t._id, 'dispatch')]);
      assert.deepEqual([r.status, a.status].sort(), [200, 409].sort(), 'once approved it can no longer be rejected');
    } finally {
      await setApproval(false);
    }
  });

  it('a transfer can be cancelled while it waits for approval or dispatch, without touching stock', async () => {
    await setApproval(true);
    try {
      const { b } = await stocked(10);
      for (const stop of ['submit', 'approve']) {
        const t = await draft([{ batchId: b._id, quantity: 3 }]);
        await act(t._id, 'submit');
        if (stop === 'approve') await act(t._id, 'approve');
        const c = await act(t._id, 'cancel', T.client, { reason: `Cancelled after ${stop}` });
        assert.equal(c.data.status, 'cancelled');
        assert.equal(c.data.cancelReason, `Cancelled after ${stop}`);
      }
      assert.equal((await batchOf(b._id)).availableQuantity, 10);
      assert.equal((await T.client.get(`/batches/${b._id}/movements`)).data.total, 1, 'no ledger entries');
    } finally {
      await setApproval(false);
    }
  });

  it('submitting re-checks the stock, so a draft that is no longer possible cannot be submitted', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 8 }]);
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -6, reason: 'Stock take: only four left' });
    const r = await act(t._id, 'submit');
    assert.equal(r.status, 400);
    assert.match(r.body.details[0].message, /Only 4 unit/);
    assert.equal((await T.client.get(`/transfers/${t._id}`)).data.status, 'draft');
  });

  it('the approval setting is private to each organization and is audited', async () => {
    await setApproval(true);
    try {
      assert.equal((await other.client.get('/transfers/settings')).data.approvalRequired, false);
      assert.equal((await T.client.get('/transfers/settings')).data.approvalRequired, true);
      assert.equal((await T.client.put('/transfers/settings', { approvalRequired: 'yes' })).status, 400);
      assert.match(JSON.stringify((await T.client.get('/activity?limit=100')).body), /Transfer approval is now required/);
    } finally {
      await setApproval(false);
    }
  });
});

describe('Summary, filters and the list columns', () => {
  it('the summary cards are counted from the database', async () => {
    const before = (await T.client.get('/transfers/summary')).data;
    const { b } = await stocked(100);
    const a = await draft([{ batchId: b._id, quantity: 1 }]);
    const c = await draft([{ batchId: b._id, quantity: 2 }]);
    const d = await draft([{ batchId: b._id, quantity: 3 }]);
    await act(a._id, 'submit'); // approved, waiting to be dispatched = pending
    await act(c._id, 'send'); // in transit
    await act(d._id, 'send');
    await act(d._id, 'receive'); // completed
    const after = (await T.client.get('/transfers/summary')).data;
    assert.equal(after.total - before.total, 3);
    assert.equal(after.pending - before.pending, 1);
    assert.equal(after.inTransit - before.inTransit, 1);
    assert.equal(after.completed - before.completed, 1);
    assert.equal(after.byStatus.completed, after.completed);
    const theirs = (await other.client.get('/transfers/summary')).data;
    assert.ok(theirs.total < after.total, 'each organization has its own numbers');
    assert.equal((await h.client().get('/transfers/summary')).status, 401);
  });

  it('the list shows who created each transfer and the number of items', async () => {
    const { b } = await stocked(10);
    const t = await draft([{ batchId: b._id, quantity: 1 }]);
    const row = (await T.client.get(`/transfers?search=${t.reference}`)).data.items[0];
    assert.equal(row.createdByName, T.user.name);
    assert.equal(row.itemCount, 1);
    assert.equal(row.fromBranch.name, 'Main Store');
  });

  it('filters by the pending group, and by transfer date range (both days included)', async () => {
    const { b } = await stocked(100);
    const mk = (date) => draft([{ batchId: b._id, quantity: 1 }], { transferDate: date });
    const jan = await mk('2025-01-10');
    const feb = await mk('2025-02-10');
    const mar = await mk('2025-03-10');
    const refs = async (q) => (await T.client.get(`/transfers?limit=100&${q}`)).data.items.map((x) => x.reference);
    const mine = [jan.reference, feb.reference, mar.reference];
    const only = async (q) => (await refs(q)).filter((r) => mine.includes(r)).sort();
    assert.deepEqual(await only('dateFrom=2025-02-01&dateTo=2025-02-28'), [feb.reference]);
    assert.deepEqual(await only('dateFrom=2025-01-10&dateTo=2025-03-10'), [...mine].sort(), 'both end days are included');
    assert.deepEqual(await only('dateFrom=2025-02-11'), [mar.reference]);
    assert.deepEqual(await only('dateTo=2025-01-31'), [jan.reference]);
    assert.equal((await T.client.get('/transfers?dateFrom=2025-03-01&dateTo=2025-01-01')).status, 400, 'an end before the start is refused');
    assert.equal((await T.client.get('/transfers?dateFrom=yesterday')).status, 400);
    assert.equal((await T.client.get('/transfers?dateFrom=&dateTo=')).status, 200);

    await act(jan._id, 'submit');
    const pending = (await T.client.get('/transfers?status=pending&limit=100')).data.items;
    assert.ok(pending.every((x) => ['submitted', 'approved'].includes(x.status)));
    assert.ok(pending.some((x) => x._id === jan._id));
    assert.ok(!pending.some((x) => x._id === feb._id), 'drafts are not pending');
  });
});
