// Sales Returns dashboard: the four summary cards, the list (search, status and date filters, pagination), a single return,
// permissions and organization isolation. Returns are written straight to the database here: this step only reads them.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const oid = () => new mongoose.Types.ObjectId();

const line = (name, quantity, price, restocked = 0, condition = 'good') => ({
  medicineId: oid(), batchId: oid(), name, batchNo: `B${++n}`, quantity, price, amount: Math.round(quantity * price * 100) / 100, condition, restock: restocked > 0, verified: restocked > 0, restockedQuantity: restocked,
});
const makeReturn = (org, over = {}) =>
  h.tenant.runWithTenant(org._id, () => {
    const items = over.items || [line('Dolo 650', 2, 30, 2)];
    return h.models.SalesReturn.create({
      returnNo: `SR-${String(++n).padStart(4, '0')}`,
      invoiceId: oid(),
      invoiceNo: `INV-${1000 + n}`,
      customer: { name: 'Ravi Kumar', phone: '9876543210' },
      returnValue: items.reduce((s, i) => s + i.amount, 0),
      refundAmount: items.reduce((s, i) => s + i.amount, 0),
      refund: { method: 'Cash', status: 'completed' },
      status: 'completed',
      reason: 'damaged',
      returnDate: new Date(),
      ...over,
      items,
    });
  });

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Returns Org');
  other = await h.makeTenant('Returns Other Org');
});
after(async () => {
  await h?.stop();
});

describe('Summary cards', () => {
  it('are all zero before any return exists', async () => {
    const r = await T.client.get('/sales-returns/summary');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { totalRefunded: 0, returnsProcessed: 0, itemsRestocked: 0, pendingRefunds: 0, pendingCount: 0, totalReturns: 0 });
  });

  it('count refunded money, processed returns, restocked units and owed refunds from the database', async () => {
    await makeReturn(T.org, { items: [line('Dolo 650', 3, 30, 3), line('Crocin', 2, 12.5, 1)] }); // 115.00, 4 units back on the shelf? (3+1)
    await makeReturn(T.org, { status: 'refunded', reason: 'expired', items: [line('Calpol', 1, 45.1, 1)] }); // 45.10
    await makeReturn(T.org, { status: 'pending', reason: 'wrong_product', items: [line('Azithral', 2, 99.99, 0)] }); // 199.98 waiting
    await makeReturn(T.org, { status: 'refund_pending', reason: 'changed_mind', items: [line('Cetzine', 1, 20.05, 0)] }); // 20.05 waiting
    await makeReturn(T.org, { status: 'rejected', reason: 'other', items: [line('Zyrtec', 5, 10, 0)] }); // owes nothing, refunds nothing
    await makeReturn(T.org, { status: 'approved', reason: 'incorrect_quantity', items: [line('Pan 40', 1, 10, 0)] }); // 10.00 owed too
    await makeReturn(other.org, { items: [line('Not mine', 9, 100, 9)] }); // another organization
    const s = (await T.client.get('/sales-returns/summary')).data;
    assert.equal(s.totalRefunded, 160.1, 'only refunded and completed returns have paid money back: 115.00 + 45.10');
    assert.equal(s.returnsProcessed, 2);
    assert.equal(s.itemsRestocked, 5, 'units actually restocked: 3 + 1 + 1');
    assert.equal(s.pendingRefunds, 230.03, 'owed: pending 199.98 + refund-pending 20.05 + approved 10.00, exact to the paisa; rejected owes nothing');
    assert.equal(s.pendingCount, 3);
    assert.equal(s.totalReturns, 6);
  });

  it('follow the date range, including both end days', async () => {
    await makeReturn(T.org, { returnDate: new Date('2025-03-10T10:00:00Z'), items: [line('Old return', 1, 100, 1)] });
    const all = (await T.client.get('/sales-returns/summary')).data.totalRefunded;
    const old = (await T.client.get('/sales-returns/summary?dateFrom=2025-03-10&dateTo=2025-03-10')).data;
    assert.equal(old.totalRefunded, 100);
    assert.equal(old.returnsProcessed, 1);
    assert.equal(Math.round((all - old.totalRefunded) * 100) / 100, 160.1);
    assert.equal((await T.client.get('/sales-returns/summary?dateFrom=bad')).status, 400);
  });
});

describe('The returns list', () => {
  it('shows newest first with items, units, status and customer, paginated', async () => {
    const p1 = (await T.client.get('/sales-returns?limit=3&page=1')).data;
    const p2 = (await T.client.get('/sales-returns?limit=3&page=2')).data;
    assert.equal(p1.items.length, 3);
    assert.ok(p1.total >= 7 && p1.pages >= 2 && p2.page === 2);
    assert.ok(p2.items.every((x) => !p1.items.some((y) => y._id === x._id)));
    const dates = p1.items.map((x) => new Date(x.returnDate).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
    const first = p1.items[0];
    for (const k of ['returnNo', 'invoiceNo', 'customer', 'refundAmount', 'status', 'statusLabel', 'reason', 'reasonLabel', 'itemCount', 'units', 'restockedUnits', 'preview']) assert.ok(k in first, k);
    assert.ok(!('items' in first), 'lines are loaded one return at a time');
  });

  it('searches by return number, invoice, customer, phone and medicine; filters by status and date', async () => {
    const all = (await T.client.get('/sales-returns?limit=100')).data.items;
    const one = all.find((x) => x.status === 'pending');
    assert.ok((await T.client.get(`/sales-returns?search=${one.returnNo}`)).data.items.some((x) => x._id === one._id));
    assert.ok((await T.client.get(`/sales-returns?search=${one.invoiceNo}`)).data.items.length >= 1);
    assert.ok((await T.client.get('/sales-returns?search=ravi')).data.total >= 5);
    assert.ok((await T.client.get('/sales-returns?search=9876543210')).data.total >= 5);
    assert.equal((await T.client.get('/sales-returns?search=azithral')).data.total, 1);
    assert.equal((await T.client.get('/sales-returns?search=no-such-thing')).data.total, 0);
    assert.equal((await T.client.get('/sales-returns?search=.*')).data.total, 0, 'search text is not a pattern');
    const pending = (await T.client.get('/sales-returns?status=pending&limit=100')).data.items;
    assert.equal(pending.length, 1);
    assert.ok(pending.every((x) => x.status === 'pending'));
    for (const [status, count] of [['approved', 1], ['rejected', 1], ['refund_pending', 1], ['refunded', 1], ['completed', 2]]) assert.equal((await T.client.get(`/sales-returns?status=${status}&limit=100`)).data.total, count, status);
    assert.equal((await T.client.get('/sales-returns?reason=expired')).data.items[0].reasonLabel, 'Expired Medicine');
    assert.equal((await T.client.get('/sales-returns?reason=damaged&limit=100')).data.items.every((x) => x.reason === 'damaged'), true);
    assert.equal((await T.client.get('/sales-returns?reason=wrong_product&status=refunded')).data.total, 0, 'filters combine');
    assert.equal((await T.client.get('/sales-returns?reason=weird')).status, 400);
    assert.equal((await T.client.get('/sales-returns?reason=')).status, 200);
    assert.equal((await T.client.get('/sales-returns?status=')).status, 200, 'an empty filter means "all"');
    assert.equal((await T.client.get('/sales-returns?status=weird')).status, 400);
    assert.equal((await T.client.get('/sales-returns?dateFrom=2025-03-10&dateTo=2025-03-10')).data.total, 1);
  });

  it('returns one return with its lines', async () => {
    const id = (await T.client.get('/sales-returns?search=azithral')).data.items[0]._id;
    const r = (await T.client.get(`/sales-returns/${id}`)).data;
    assert.equal(r.items[0].name, 'Azithral');
    assert.equal(r.items[0].amount, 199.98);
    assert.equal(r.units, 2);
    assert.equal((await T.client.get('/sales-returns/not-an-id')).status, 404);
    assert.equal((await T.client.get(`/sales-returns/${oid()}`)).status, 404);
  });
});

describe('Filter choices', () => {
  it('lists the six statuses and the reasons for the dropdowns', async () => {
    const m = (await T.client.get('/sales-returns/meta')).data;
    assert.deepEqual(m.statuses.map((x) => x.label), ['Pending', 'Approved', 'Rejected', 'Refund Pending', 'Refunded', 'Completed']);
    assert.equal(m.reasons.length, 7);
    assert.equal((await h.client().get('/sales-returns/meta')).status, 401);
  });
});

describe('Who can see them', () => {
  it('needs a login and billing access; other organizations see only their own', async () => {
    assert.equal((await h.client().get('/sales-returns')).status, 401);
    assert.equal((await h.client().get('/sales-returns/summary')).status, 401);
    const noBilling = await h.makeUser(T.org, { role: 'STAFF' });
    const c = h.client();
    await c.login(noBilling.email);
    assert.equal((await c.get('/sales-returns')).status, 403);
    assert.equal((await c.get('/sales-returns/summary')).status, 403);
    const billing = await h.makeUser(T.org, { role: 'BILLING_STAFF' });
    const b = h.client();
    await b.login(billing.email);
    assert.equal((await b.get('/sales-returns')).status, 200);

    const theirs = (await other.client.get('/sales-returns?limit=100')).data;
    assert.equal(theirs.total, 1);
    assert.equal(theirs.items[0].preview[0], 'Not mine');
    const mine = (await T.client.get('/sales-returns?limit=100')).data.items[0]._id;
    assert.equal((await other.client.get(`/sales-returns/${mine}`)).status, 404);
    assert.equal((await other.client.get('/sales-returns/summary')).data.totalRefunded, 900);
  });
});
