// Sales return workflow: approval, rejection, refund steps, invoice consistency, history and audit trail, dashboard figures, permissions.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}`;

const medicine = async (client = T.client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Return Med'), reorderLevel: 1, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const stock = async (medicineId, quantity, price = 100, client = T.client) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('LOT'), expiryDate: futureDate(2), mrp: price, sellingPrice: price, purchasePrice: 60, initialQuantity: quantity });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** Sells `qty` units of a fresh medicine (price per unit) and returns the invoice with its single line. */
const sale = async ({ qty = 5, price = 100, discount, client = T.client, customer } = {}) => {
  const m = await medicine(client);
  const b = await stock(m._id, 50, price, client);
  const r = await client.post('/invoices', { customer: customer || { name: 'Meera Nair', phone: '9811122233' }, items: [{ medicineId: m._id, quantity: qty }], ...(discount && { discount }), paymentType: 'UPI' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { m, b, inv: r.data };
};
const batchOf = async (id, client = T.client) => (await client.get(`/batches/${id}`)).data;
const reconciled = async () => (await T.client.get('/stock/reconciliation')).data.consistent;
const key = () => `rk-${++n}-${Date.now()}`;

const body = (inv, lines, over = {}) => ({
  invoiceId: inv._id,
  reason: 'changed_mind',
  notes: '',
  items: lines.map(([quantity, extra = {}]) => ({ medicineId: inv.items[0].medicineId, batchId: inv.items[0].batchId, quantity, condition: 'good', restock: false, verified: false, ...extra })),
  refund: { method: 'Cash', amount: 0, status: 'pending', reference: '', remarks: '' },
  idempotencyKey: key(),
  ...over,
});
/** A return whose refund equals the value of the units (unit price = the invoice's price). */
const ret = (inv, lines, over = {}, price) => {
  const qty = lines.reduce((s, [q]) => s + q, 0);
  const b = body(inv, lines, over);
  if (over.refund === undefined) b.refund.amount = price !== undefined ? price * qty : Math.round(inv.items[0].price * qty * 100) / 100;
  return b;
};
const post = (b, client = T.client) => client.post('/sales-returns', b);

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Return Process Org');
  other = await h.makeTenant('Return Process Other Org');
});
after(async () => {
  await h?.stop();
});


const asRole = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const get = async (id) => (await T.client.get(`/sales-returns/${id}`)).data;
const approve = (id, c = T.client, b = {}) => c.post(`/sales-returns/${id}/approve`, b);
const reject = (id, reason = 'Not eligible for return', c = T.client) => c.post(`/sales-returns/${id}/reject`, { reason });
const refundStep = (id, b, c = T.client) => c.post(`/sales-returns/${id}/refund`, b);
const invoiceOf = async (id) => (await T.client.get(`/invoices/${id}`)).data;
const cashier = async () => asRole('BILLING_STAFF'); // may record returns and refunds, may not approve

describe('Approval: staff who cannot approve record pending returns that claim units but touch no stock', () => {
  it('a cashier’s return is pending: the invoice units are claimed, nothing is restocked, no refund can start', async () => {
    const { m, inv, b } = await sale({ qty: 5, price: 50 });
    const c = await cashier();
    const before = (await batchOf(b._id)).availableQuantity;
    const r = await post(ret(inv, [[3, { restock: true, verified: true }]], { refund: { method: 'Cash', amount: 150, status: 'completed' } }), c);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.refund.status, 'pending', 'a completed refund cannot be claimed before approval');
    assert.equal(r.data.items[0].restock, true, 'the staff decision is kept');
    assert.equal(r.data.items[0].restockedQuantity, 0, 'but nothing was restocked yet');
    assert.equal((await batchOf(b._id)).availableQuantity, before);
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].returnableQuantity, 2, 'the units are claimed, so they cannot be returned again');
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.filter((x) => x.type === 'SALE_RETURN').length, 0);
    assert.equal((await refundStep(r.data._id, { status: 'completed' }, c)).status, 409, 'not before approval');
    assert.equal((await T.client.get('/sales-returns/summary')).status, 200);
  });

  it('only people with approval rights can approve or reject; the cashier cannot', async () => {
    const { inv } = await sale({ qty: 2 });
    const c = await cashier();
    const r = (await post(ret(inv, [[1]]), c)).data;
    assert.equal((await approve(r._id, c)).status, 403);
    assert.equal((await reject(r._id, 'No', c)).status, 403);
    assert.equal((await h.client().post(`/sales-returns/${r._id}/approve`)).status, 401);
    const staff = await asRole('STAFF');
    assert.equal((await approve(r._id, staff)).status, 403);
    const manager = await asRole('BRANCH_MANAGER');
    assert.equal((await approve(r._id, manager)).status, 200);
  });

  it('approving applies the restocking staff already verified — into the same batch, with a ledger entry — and not otherwise', async () => {
    const { m, inv, b } = await sale({ qty: 6, price: 40 });
    const c = await cashier();
    const r = (await post(ret(inv, [[4, { restock: true, verified: true }]]), c)).data;
    const before = (await batchOf(b._id)).availableQuantity;
    const a = await approve(r._id);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.data.status, 'approved');
    assert.equal(a.data.items[0].restockedQuantity, 4);
    assert.equal((await batchOf(b._id)).availableQuantity, before + 4);
    const mv = (await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.find((x) => x.type === 'SALE_RETURN');
    assert.equal(mv.refType, 'SalesReturn');
    assert.equal(mv.quantity, 4);
    assert.equal(await reconciled(), true);
    assert.equal((await approve(r._id)).status, 409, 'approving twice restocks nothing twice');
    assert.equal((await batchOf(b._id)).availableQuantity, before + 4);
    // an un-flagged return is approved without touching stock — approval itself never restocks
    const plain = (await post(ret(inv, [[1]]), c)).data;
    assert.equal((await approve(plain._id)).data.items[0].restockedQuantity, 0);
    assert.equal((await batchOf(b._id)).availableQuantity, before + 4);
  });

  it('"approve without restocking" leaves stock alone and clears the restock decision', async () => {
    const { inv, b } = await sale({ qty: 3 });
    const c = await cashier();
    const r = (await post(ret(inv, [[2, { restock: true, verified: true }]]), c)).data;
    const before = (await batchOf(b._id)).availableQuantity;
    const a = await approve(r._id, T.client, { doNotRestock: true });
    assert.equal(a.data.status, 'approved');
    assert.equal(a.data.items[0].restock, false);
    assert.equal(a.data.items[0].restockedQuantity, 0);
    assert.equal((await batchOf(b._id)).availableQuantity, before);
  });

  it('if the batch has expired by the time of approval, the approval fails whole and can be redone without restocking', async () => {
    const { inv, b } = await sale({ qty: 3 });
    const c = await cashier();
    const r = (await post(ret(inv, [[2, { restock: true, verified: true }]]), c)).data;
    await h.models.Batch.collection.updateOne({ _id: new h.models.Batch.base.Types.ObjectId(b._id) }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
    const a = await approve(r._id);
    assert.equal(a.status, 400);
    assert.match(a.body.details[0].message, /expired|no longer active/);
    assert.equal((await get(r._id)).status, 'pending', 'nothing changed');
    assert.equal((await approve(r._id, T.client, { doNotRestock: true })).status, 200);
  });
});

describe('Rejecting releases the units and the refund back to the invoice', () => {
  it('a rejected return can be returned again, with a reason and history', async () => {
    const { inv } = await sale({ qty: 4, price: 25 });
    const c = await cashier();
    const r = (await post(ret(inv, [[4]]), c)).data;
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].returnableQuantity, 0);
    assert.equal((await reject(r._id, 'x')).status, 400, 'a real reason is needed');
    const rej = await reject(r._id, 'Customer bought them from another shop');
    assert.equal(rej.status, 200);
    assert.equal(rej.data.status, 'rejected');
    assert.equal(rej.data.rejectReason, 'Customer bought them from another shop');
    const after = (await T.client.get(`/sales-returns/invoices/${inv._id}`)).data;
    assert.equal(after.lines[0].returnableQuantity, 4, 'the units are returnable again');
    assert.equal(after.returnedAmount, 0);
    assert.equal(after.refundedAmount, 0);
    assert.equal((await post(ret(inv, [[4]]))).status, 201);
    assert.deepEqual((await get(r._id)).history.map((x) => x.action), ['CREATED', 'REJECTED']);
    assert.equal((await reject(r._id)).status, 409, 'rejecting twice releases nothing twice');
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].returnableQuantity, 0);
  });

  it('cannot reject a return that already restocked units or whose refund is paid', async () => {
    const { inv } = await sale({ qty: 6 });
    const restocked = (await post(ret(inv, [[2, { restock: true, verified: true }]]))).data;
    const r1 = await reject(restocked._id);
    assert.equal(r1.status, 409);
    assert.match(r1.body.message, /already put units back into stock/);
    const paid = (await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: inv.items[0].price, status: 'completed' } }))).data;
    assert.equal((await reject(paid._id)).status, 409);
    assert.equal((await get(paid._id)).status, 'completed');
  });

  it('is restricted to approvers and the organization', async () => {
    const { inv } = await sale({ qty: 2 });
    const r = (await post(ret(inv, [[1]]))).data;
    assert.equal((await reject(r._id, 'Nope nope', await cashier())).status, 403);
    assert.equal((await reject(r._id, 'Nope nope', other.client)).status, 404);
    assert.equal((await approve(r._id, other.client)).status, 404);
  });
});

describe('Refunds: recorded step by step, paid once', () => {
  it('moves pending → processing → completed, and the return status follows; completed is final', async () => {
    const { inv } = await sale({ qty: 4, price: 30 });
    const r = (await post(ret(inv, [[2]], { refund: { method: 'UPI', amount: 60, status: 'pending' } }))).data;
    assert.equal(r.status, 'refund_pending');
    const p = await refundStep(r._id, { status: 'processing' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.data.status, 'refund_pending');
    assert.equal((await refundStep(r._id, { status: 'processing' })).status, 409, 'already processing');
    assert.equal((await refundStep(r._id, { status: 'completed' })).status, 400, 'UPI needs a reference');
    const done = await refundStep(r._id, { status: 'completed', reference: 'UPI-5521', remarks: 'Paid via the store app' });
    assert.equal(done.data.status, 'completed');
    assert.equal(done.data.refund.reference, 'UPI-5521');
    assert.ok(done.data.refund.paidAt && done.data.refund.paidBy);
    const again = await refundStep(r._id, { status: 'completed', reference: 'UPI-5521' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code || again.body.error?.code, 'REFUND_ALREADY_PAID');
    assert.equal((await refundStep(r._id, { status: 'failed' })).status, 409, 'a paid refund cannot be undone');
    assert.deepEqual((await get(r._id)).history.map((x) => x.action), ['CREATED', 'REFUND', 'REFUND']);
  });

  it('a failed refund leaves the return approved and can be retried', async () => {
    const { inv } = await sale({ qty: 2, price: 10 });
    const r = (await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 10, status: 'pending' } }))).data;
    const f = await refundStep(r._id, { status: 'failed', remarks: 'Till was short' });
    assert.equal(f.data.status, 'approved');
    assert.equal(f.data.refund.status, 'failed');
    const retry = await refundStep(r._id, { status: 'completed' });
    assert.equal(retry.data.status, 'completed');
  });

  it('two simultaneous "completed" requests pay the refund once', async () => {
    const { inv } = await sale({ qty: 2, price: 10 });
    const r = (await post(ret(inv, [[2]], { refund: { method: 'Cash', amount: 20, status: 'pending' } }))).data;
    const [a, b2] = await Promise.all([refundStep(r._id, { status: 'completed' }), refundStep(r._id, { status: 'completed' })]);
    assert.equal([a.status, b2.status].filter((s) => s === 200).length, 1, `one winner (${a.status}, ${b2.status})`);
    assert.equal((await get(r._id)).history.filter((x) => x.action === 'REFUND').length, 1);
  });

  it('needs the refund permission, and rejected returns have no refund', async () => {
    const { inv } = await sale({ qty: 3, price: 10 });
    const r = (await post(ret(inv, [[1]]))).data;
    const inventory = await asRole('INVENTORY_MANAGER');
    assert.equal((await refundStep(r._id, { status: 'processing' }, inventory)).status, 403);
    assert.equal((await refundStep(r._id, { status: 'processing' }, await cashier())).status, 200, 'billing staff pay refunds');
    assert.equal((await refundStep(r._id, { status: 'processing' }, other.client)).status, 404);
    assert.equal((await refundStep(r._id, { status: 'paid' })).status, 400);
    const r2 = (await post(ret(inv, [[1]]))).data;
    await reject(r2._id);
    assert.equal((await refundStep(r2._id, { status: 'completed' })).status, 409);
  });
});

describe('Invoice totals and returned amounts stay consistent', () => {
  it('the original invoice never changes, returned value is tracked beside it, and a full return equals the total to the paisa', async () => {
    const m1 = await medicine();
    const m2 = await medicine();
    await stock(m1._id, 40, 33.33);
    await stock(m2._id, 40, 19.99);
    const r = await T.client.post('/invoices', { customer: { name: 'Exact Customer', phone: '9876500001' }, items: [{ medicineId: m1._id, quantity: 3 }, { medicineId: m2._id, quantity: 7, discountPercent: 5 }], discount: { type: 'percent', value: 12 }, paymentType: 'Cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inv = r.data;
    const original = { total: inv.total, subTotal: inv.subTotal, items: inv.items.map((i) => [i.quantity, i.amount]), status: inv.status };
    const make = (idx, q) => ({ medicineId: inv.items[idx].medicineId, batchId: inv.items[idx].batchId, quantity: q, condition: 'good' });
    let value = 0;
    // return everything in awkward pieces: 1+2 of line 0, 3+4 of line 1
    for (const [idx, q] of [[0, 1], [1, 3], [0, 2], [1, 4]]) {
      const b = { invoiceId: inv._id, reason: 'changed_mind', items: [make(idx, q)], refund: { method: 'Cash', amount: 0, status: 'pending', remarks: 'recording only' }, idempotencyKey: key() };
      const probe = await post({ ...b, refund: { ...b.refund, amount: 999 } });
      assert.equal(probe.status, 400);
      const val = Number(/at most|value of the returned products \(₹([\d.]+)\)/.exec(probe.body.details[0].message)?.[1]);
      assert.ok(val > 0, probe.body.details[0].message);
      b.refund.amount = val;
      const ok = await post(b);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      value = Math.round((value + ok.data.returnValue) * 100) / 100;
    }
    assert.equal(value, inv.total, 'the pieces add up to the invoice total exactly');
    const after = await invoiceOf(inv._id);
    assert.equal(after.returnedAmount, inv.total);
    assert.deepEqual({ total: after.total, subTotal: after.subTotal, items: after.items.map((i) => [i.quantity, i.amount]), status: after.status }, original, 'the original invoice is untouched');
    assert.deepEqual(after.items.map((i) => i.returnedQuantity), [3, 7]);
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines.every((l) => l.returnableQuantity === 0), true);
  });

  it('refunds can never add up to more than the customer actually paid', async () => {
    const m = await medicine();
    await stock(m._id, 20, 100);
    const sold = (await T.client.post('/invoices', { customer: { name: 'Credit Customer', phone: '9876500002' }, items: [{ medicineId: m._id, quantity: 4 }], paymentType: 'Credit', paid: 100 })).data;
    assert.equal(sold.paid, 100);
    assert.equal(sold.due, 300);
    const info = (await T.client.get(`/sales-returns/invoices/${sold._id}`)).data;
    assert.equal(info.refundableLeft, 100);
    const line = { medicineId: sold.items[0].medicineId, batchId: sold.items[0].batchId, condition: 'good' };
    const tooMuch = await post({ invoiceId: sold._id, reason: 'changed_mind', items: [{ ...line, quantity: 2 }], refund: { method: 'Cash', amount: 200, status: 'pending' }, idempotencyKey: key() });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.details[0].message, /has paid ₹100\.00 .* at most ₹100\.00 can be refunded/);
    const ok = await post({ invoiceId: sold._id, reason: 'changed_mind', items: [{ ...line, quantity: 2 }], refund: { method: 'Cash', amount: 100, status: 'pending', remarks: 'Refund only what was paid' }, idempotencyKey: key() });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await invoiceOf(sold._id)).refundedAmount, 100);
    const more = await post({ invoiceId: sold._id, reason: 'changed_mind', items: [{ ...line, quantity: 1 }], refund: { method: 'Cash', amount: 1, status: 'pending', remarks: 'x' }, idempotencyKey: key() });
    assert.equal(more.status, 400, 'nothing paid is left to refund');
    assert.equal((await post({ invoiceId: sold._id, reason: 'changed_mind', items: [{ ...line, quantity: 1 }], refund: { method: 'Cash', amount: 0, status: 'pending', remarks: 'Reduces what is owed' }, idempotencyKey: key() })).status, 201, 'a return with no refund is fine');
  });
});

describe('Edit, history and audit trail', () => {
  it('edits notes and refund method/remarks of an open return only, and keeps the history', async () => {
    const { inv } = await sale({ qty: 3, price: 10 });
    const r = (await post(ret(inv, [[1]]))).data;
    const e = await T.client.patch(`/sales-returns/${r._id}`, { notes: 'Box was dented', refund: { method: 'Card', remarks: 'Card refund' } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.data.notes, 'Box was dented');
    assert.equal(e.data.refund.method, 'Card');
    assert.equal(e.data.returnValue, 10, 'amounts and products are not editable');
    await refundStep(r._id, { status: 'completed', reference: 'CARD-1' });
    assert.equal((await T.client.patch(`/sales-returns/${r._id}`, { notes: 'late change' })).status, 409, 'a paid return is final');
    assert.equal((await (await cashier()).patch(`/sales-returns/${r._id}`, { notes: 'x' })).status, 409);
    assert.equal((await asRole('STAFF').then((c) => c.patch(`/sales-returns/${r._id}`, { notes: 'x' }))).status, 403);
    assert.equal((await other.client.patch(`/sales-returns/${r._id}`, { notes: 'x' })).status, 404);
  });

  it('every step is in the return’s history and in the activity log, with inventory adjustments in the ledger', async () => {
    const { m, inv } = await sale({ qty: 5, price: 10 });
    const c = await cashier();
    const r = (await post(ret(inv, [[2, { restock: true, verified: true }]]), c)).data;
    await approve(r._id);
    await refundStep(r._id, { status: 'processing' }, c);
    await refundStep(r._id, { status: 'completed' }, c);
    const d = await get(r._id);
    assert.deepEqual(d.history.map((x) => x.action), ['CREATED', 'APPROVED', 'REFUND', 'REFUND']);
    assert.ok(d.history.every((x) => x.byName && x.at));
    assert.deepEqual(d.history.map((x) => x.newStatus), ['pending', 'approved', 'refund_pending', 'completed']);
    const actions = (await T.client.get('/activity?limit=100')).data.items.filter((x) => x.message.includes(d.returnNo)).map((x) => x.action);
    for (const a of ['SALES_RETURN_CREATE', 'SALES_RETURN_APPROVE', 'SALES_RETURN_REFUND']) assert.ok(actions.includes(a), a);
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.filter((x) => x.type === 'SALE_RETURN').length, 1);
    assert.equal(await reconciled(), true);
  });
});

describe('Dashboard and reports', () => {
  it('shows refunded money next to revenue, without changing the invoice-based revenue', async () => {
    const o0 = (await T.client.get('/dashboard/overview')).data;
    const { inv } = await sale({ qty: 2, price: 100 });
    const r = (await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 100, status: 'completed' } }))).data;
    assert.equal(r.status, 'completed');
    const o1 = (await T.client.get('/dashboard/overview')).data;
    assert.equal(Math.round((o1.totalRevenue - o0.totalRevenue) * 100) / 100, 200, 'revenue is still the original invoice total');
    assert.equal(Math.round((o1.totalRefunds - o0.totalRefunds) * 100) / 100, 100);
    assert.equal(Math.round((o1.netRevenue - o0.netRevenue) * 100) / 100, 100, 'net = sold 200 − refunded 100');
    const c = await cashier();
    await post(ret(inv, [[1]]), c);
    assert.equal((await T.client.get('/dashboard/overview')).data.returnsAwaitingApproval - o1.returnsAwaitingApproval, 1);
    assert.equal((await other.client.get('/dashboard/overview')).data.totalRefunds, 0, 'only this organization’s refunds');
  });
});
