// Orders (supplier orders): the list with search by order id / supplier / product, status filter and pagination, one order,
// permissions and organization isolation. Orders are written straight to the database here: this step only reads them.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const oid = () => new mongoose.Types.ObjectId();
const item = (name, quantity, receivedQuantity = 0) => ({ medicineId: oid(), name, unit: 'Strip', quantity, receivedQuantity });
const makeOrder = (org, over = {}) =>
  h.tenant.runWithTenant(org._id, () =>
    h.models.Order.create({
      orderNo: `ORD-${String(++n).padStart(4, '0')}`,
      supplier: { name: 'Sun Pharma Distributors', phone: '9811100011' },
      status: 'ordered',
      orderDate: new Date(Date.now() - n * 3600000),
      items: [item('Dolo 650', 100)],
      ...over,
    }),
  );

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Orders Org');
  other = await h.makeTenant('Orders Other Org');
});
after(async () => {
  await h?.stop();
});

describe('The orders list', () => {
  it('is empty before any order exists', async () => {
    const r = await T.client.get('/orders');
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.items.length, r.data.total, r.data.page, r.data.pages], [0, 0, 1, 1]);
  });

  it('shows each order with its supplier, date, number of products and status, newest first', async () => {
    await makeOrder(T.org, { supplier: { name: 'Cipla Wholesale' }, items: [item('Crocin', 50), item('Calpol', 20, 20), item('Azithral', 10)], status: 'partially_received' });
    await makeOrder(T.org, { supplier: { name: 'Zydus Traders' }, status: 'received', items: [item('Pan 40', 30, 30)] });
    await makeOrder(T.org, { supplier: { name: 'Mankind Stockists' }, status: 'draft', items: [item('Telma 40', 15)] });
    await makeOrder(T.org, { supplier: { name: 'Alkem Supplies' }, status: 'cancelled', items: [item('Rantac', 5)] });
    const r = (await T.client.get('/orders')).data;
    assert.equal(r.total, 4);
    const first = r.items[0];
    for (const k of ['_id', 'orderNo', 'supplier', 'orderDate', 'status', 'statusLabel', 'itemCount', 'units', 'receivedUnits', 'preview']) assert.ok(k in first, k);
    assert.ok(!('items' in first), 'lines are loaded one order at a time');
    const cipla = r.items.find((o) => o.supplier.name === 'Cipla Wholesale');
    assert.deepEqual([cipla.itemCount, cipla.units, cipla.receivedUnits, cipla.statusLabel], [3, 80, 20, 'Partially received']);
    assert.deepEqual(cipla.preview, ['Crocin', 'Calpol']);
    const dates = r.items.map((o) => new Date(o.orderDate).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  });

  it('searches by order id, supplier name and product name', async () => {
    const all = (await T.client.get('/orders?limit=100')).data.items;
    const one = all[0];
    assert.ok((await T.client.get(`/orders?search=${one.orderNo}`)).data.items.some((o) => o._id === one._id), 'order id');
    assert.equal((await T.client.get('/orders?search=zydus')).data.total, 1, 'supplier');
    assert.equal((await T.client.get('/orders?search=telma')).data.total, 1, 'product');
    assert.equal((await T.client.get('/orders?search=calpol')).data.items[0].supplier.name, 'Cipla Wholesale', 'any product on the order');
    assert.equal((await T.client.get('/orders?search=no-such-thing')).data.total, 0);
    assert.equal((await T.client.get('/orders?search=.*')).data.total, 0, 'search text is not a pattern');
  });

  it('filters by status and paginates with 10, 25 or 50 rows', async () => {
    assert.equal((await T.client.get('/orders?status=received')).data.total, 1);
    assert.ok((await T.client.get('/orders?status=draft&limit=50')).data.items.every((o) => o.status === 'draft'));
    assert.equal((await T.client.get('/orders?status=')).status, 200, 'an empty filter means "all"');
    assert.equal((await T.client.get('/orders?status=weird')).status, 400);
    for (let i = 0; i < 12; i += 1) await makeOrder(T.org, { supplier: { name: `Bulk Supplier ${i}` } });
    const p1 = (await T.client.get('/orders')).data;
    assert.equal(p1.limit, 10, '10 rows by default');
    assert.equal(p1.items.length, 10);
    assert.ok(p1.total >= 16 && p1.pages >= 2);
    const p2 = (await T.client.get('/orders?page=2')).data;
    assert.ok(p2.items.every((x) => !p1.items.some((y) => y._id === x._id)), 'pages do not overlap');
    assert.equal((await T.client.get('/orders?limit=25')).data.items.length, Math.min(25, p1.total));
    assert.equal((await T.client.get('/orders?limit=50')).data.items.length, p1.total);
    assert.equal((await T.client.get('/orders?limit=500')).status, 400);
    assert.equal((await T.client.get('/orders?page=0')).status, 400);
  });
});

describe('One order', () => {
  it('returns the order with its lines', async () => {
    const id = (await T.client.get('/orders?search=Crocin')).data.items[0]._id;
    const o = (await T.client.get(`/orders/${id}`)).data;
    assert.equal(o.supplier.name, 'Cipla Wholesale');
    assert.deepEqual(o.items.map((i) => [i.name, i.quantity, i.receivedQuantity]), [['Crocin', 50, 0], ['Calpol', 20, 20], ['Azithral', 10, 0]]);
    assert.equal(o.itemCount, 3);
    assert.equal((await T.client.get('/orders/not-an-id')).status, 404);
    assert.equal((await T.client.get(`/orders/${oid()}`)).status, 404);
  });
});

describe('Who can see them', () => {
  it('needs a login; other organizations only see their own', async () => {
    assert.equal((await h.client().get('/orders')).status, 401);
    await makeOrder(other.org, { supplier: { name: 'Their Only Supplier' } });
    const theirs = (await other.client.get('/orders?limit=100')).data;
    assert.equal(theirs.total, 1);
    assert.equal(theirs.items[0].supplier.name, 'Their Only Supplier');
    assert.equal((await T.client.get('/orders?search=Their Only')).data.total, 0);
    const mine = (await T.client.get('/orders?limit=1')).data.items[0]._id;
    assert.equal((await other.client.get(`/orders/${mine}`)).status, 404);
  });

  it('is open to anyone who can read inventory', async () => {
    const staff = await h.makeUser(T.org, { role: 'STAFF' });
    const c = h.client();
    await c.login(staff.email);
    assert.equal((await c.get('/orders')).status, 200);
  });
});
