// Supplier order workflow (draft → submit → approve → ordered → received) and the Goods Received process: batches, expiry rules, partial and
// free deliveries, rejected / damaged units, stock and ledger updates through the existing stock module, duplicate and racing requests,
// rollback on failure, the permanent goods received history, permissions and organization isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const key = () => `rk-${++n}-${Date.now()}`;
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const medicine = async (client = T.client) => {
  const r = await client.post('/inventory', { medicineName: uniq('Recv Med'), genericName: 'Paracetamol', manufacturer: 'Cipla', unit: 'Strip', gstPercentage: 12 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const supplier = async (client = T.client) => (await client.post('/suppliers', { name: uniq('Supplier'), contactPerson: 'Ramesh', phone: '9811100022' })).data;
/** A new order (approval not required): lines are [medicine, quantity, rate, freeQuantity]. */
const order = async (lines, over = {}, client = T.client) => {
  const s = await supplier(client);
  const r = await client.post('/orders', {
    supplierId: s._id,
    items: lines.map(([m, quantity, rate = 10, freeQuantity = 0]) => ({ medicineId: m._id, quantity, rate, freeQuantity })),
    payment: { terms: 'credit', advance: 0 },
    status: 'submitted',
    idempotencyKey: key(),
    ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const act = (o, step, body, client = T.client) => client.post(`/orders/${o._id}/${step}`, body);
/** An order that has been sent to the supplier: ready to receive. */
const placed = async (lines, over, client = T.client) => {
  const o = await order(lines, over, client);
  assert.equal((await act(o, 'order', undefined, client)).status, 200);
  return o;
};
const receive = (o, items, extra = {}, client = T.client) => client.post(`/orders/${o._id}/receive`, { items, idempotencyKey: key(), ...extra });
const arrive = (m, quantity, extra = {}) => ({ medicineId: m._id, quantity, batchNumber: uniq('BN'), expiryDate: iso(400), mrp: 120, sellingPrice: 100, ...extra });
const get = async (o, client = T.client) => (await client.get(`/orders/${o._id}`)).data;
const batchesOf = async (m, client = T.client) => (await client.get(`/batches?medicineId=${m._id}&limit=50`)).data.items;
const units = async (m) => (await batchesOf(m)).reduce((s, b) => s + b.availableQuantity, 0);
const reconciled = async () => (await T.client.get('/stock/reconciliation')).data.consistent;
const asRole = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Order Receive Org');
  other = await h.makeTenant('Order Receive Other Org');
});
after(async () => {
  await h?.stop();
});

describe('The order workflow', () => {
  it('draft → submit → (approved, as approval is not required) → ordered, with a history', async () => {
    const m = await medicine();
    const s = await supplier();
    const d = (await T.client.post('/orders', { supplierId: s._id, items: [{ medicineId: m._id, quantity: 5, rate: 10 }], payment: { terms: 'credit' }, status: 'draft', idempotencyKey: key() })).data;
    assert.equal(d.status, 'draft');
    assert.equal((await act(d, 'order')).status, 409, 'a draft cannot be marked as ordered');
    assert.equal((await act(d, 'approve')).status, 409);
    const sub = await act(d, 'submit');
    assert.equal(sub.data.status, 'approved');
    assert.equal((await act(d, 'submit')).status, 409, 'only a draft can be submitted');
    const ord = await act(d, 'order');
    assert.equal(ord.data.status, 'ordered');
    assert.equal((await act(d, 'order')).status, 409);
    assert.deepEqual((await get(d)).history.map((x) => [x.action, x.newStatus]), [['CREATED', 'draft'], ['SUBMITTED', 'approved'], ['ORDERED', 'ordered']]);
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'ORDER_PLACE' && x.message.includes(d.orderNo)));
  });

  it('with approval required: submit → pending; only approvers approve or send it back; then ordered', async () => {
    assert.equal((await (await asRole('STAFF')).put('/orders/settings', { approvalRequired: true })).status, 403, 'only settings managers');
    assert.equal((await T.client.put('/orders/settings', { approvalRequired: true })).data.approvalRequired, true);
    try {
      const m = await medicine();
      const o = await order([[m, 5]]);
      assert.equal(o.status, 'pending', 'submitted for approval');
      assert.equal((await act(o, 'order')).status, 409, 'cannot be ordered before it is approved');
      const clerk = await asRole('INVENTORY_MANAGER');
      assert.equal((await act(o, 'approve', undefined, clerk)).status, 403);
      assert.equal((await act(o, 'reject', { reason: 'Too much' }, clerk)).status, 403);
      const manager = await asRole('BRANCH_MANAGER');
      assert.equal((await act(o, 'reject', { reason: 'x' }, manager)).status, 400, 'a real reason');
      const back = await act(o, 'reject', { reason: 'Quantity looks too high' }, manager);
      assert.equal(back.data.status, 'draft');
      assert.equal(back.data.rejectReason, 'Quantity looks too high');
      assert.equal((await act(o, 'submit')).data.status, 'pending');
      assert.equal((await act(o, 'approve', undefined, manager)).data.status, 'approved');
      assert.equal((await act(o, 'approve', undefined, manager)).status, 409, 'approving twice');
      assert.equal((await act(o, 'order')).data.status, 'ordered');
      assert.deepEqual((await get(o)).history.map((x) => x.action), ['CREATED', 'REJECTED', 'SUBMITTED', 'APPROVED', 'ORDERED']);
      const d = (await T.client.post('/orders', { supplierId: o.supplier.supplierId, items: [{ medicineId: m._id, quantity: 1, rate: 1 }], payment: { terms: 'credit' }, status: 'draft' })).data;
      assert.equal((await act(d, 'submit')).data.status, 'pending', 'draft → pending when approval is required');
    } finally {
      await T.client.put('/orders/settings', { approvalRequired: false });
    }
  });

  it('can be cancelled before anything arrives, never after; and cancelling twice does nothing more', async () => {
    const m = await medicine();
    const a = await order([[m, 5]]);
    assert.equal((await act(a, 'cancel', { reason: 'Supplier closed' })).data.status, 'cancelled');
    assert.equal((await get(a)).cancelReason, 'Supplier closed');
    assert.equal((await act(a, 'cancel', {})).status, 409);
    assert.equal((await act(a, 'order')).status, 409, 'a cancelled order cannot go on');
    const b = await placed([[m, 5]]);
    assert.equal((await act(b, 'cancel', {})).data.status, 'cancelled');
    const c = await placed([[m, 5]]);
    assert.equal((await receive(c, [arrive(m, 2)])).status, 201);
    assert.equal((await act(c, 'cancel', {})).status, 409, 'goods have already arrived');
    const full = await placed([[m, 1]]);
    await receive(full, [arrive(m, 1)]);
    assert.equal((await act(full, 'cancel', {})).status, 409);
  });

  it('needs the right permissions and the right organization', async () => {
    const m = await medicine();
    const o = await order([[m, 5]]);
    const billing = await asRole('BILLING_STAFF');
    for (const step of ['submit', 'order', 'cancel']) assert.equal((await act(o, step, {}, billing)).status, 403, step);
    assert.equal((await receive(o, [arrive(m, 1)], {}, billing)).status, 403);
    for (const [step, body] of [['submit'], ['approve'], ['reject', { reason: 'nope nope' }], ['order'], ['cancel', {}], ['receive', { items: [arrive(m, 1)] }]]) {
      assert.equal((await act(o, step, body, other.client)).status, 404, `${step} from another organization`);
    }
    assert.equal((await other.client.get(`/orders/${o._id}/receivable`)).status, 404);
    assert.equal((await h.client().post(`/orders/${o._id}/order`)).status, 401);
    assert.equal((await get(o)).status, 'approved', 'nothing changed');
  });

  it('two people marking it ordered at the same moment: one wins', async () => {
    const m = await medicine();
    const o = await order([[m, 5]]);
    const [a, b] = await Promise.all([act(o, 'order'), act(o, 'order')]);
    assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
    assert.equal((await get(o)).history.filter((x) => x.action === 'ORDERED').length, 1);
  });
});

describe('The goods received form’s data', () => {
  it('lists each product with ordered, previously received and remaining, and the defaults for a batch', async () => {
    const m = await medicine();
    await T.client.post('/batches', { medicineId: m._id, batchNumber: 'OLD-1', expiryDate: futureDate(2), mrp: 150, sellingPrice: 130, purchasePrice: 80, initialQuantity: 10 });
    const o = await placed([[m, 10, 85, 2]]);
    await receive(o, [arrive(m, 4, { batchNumber: 'NEW-1' })]);
    const r = (await T.client.get(`/orders/${o._id}/receivable`)).data;
    assert.equal(r.receivable, true);
    const l = r.lines[0];
    assert.deepEqual([l.orderedQuantity, l.previouslyReceived, l.remainingQuantity, l.remainingPaid, l.remainingFree, l.rate], [12, 4, 8, 6, 2, 85]);
    assert.ok(l.mrp > 0 && l.sellingPrice > 0, 'prices from the last batch are offered');
    assert.ok(l.batches.some((b) => b.batchNumber === 'OLD-1'));
    const draft = await order([[m, 1]]);
    assert.equal((await T.client.get(`/orders/${draft._id}/receivable`)).data.receivable, false, 'an order that has not been marked as ordered cannot be received');
  });
});

describe('Receiving goods', () => {
  it('only an order that has been marked as ordered can be received against', async () => {
    const m = await medicine();
    const o = await order([[m, 5]]);
    const r = await receive(o, [arrive(m, 1)]);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /marked as ordered/);
    assert.equal(await units(m), 0);
    await act(o, 'cancel', {});
    assert.equal((await receive(o, [arrive(m, 1)])).status, 409);
  });

  it('a partial delivery creates the batch, adds the stock, writes a ledger entry, and the order becomes partially received', async () => {
    const m = await medicine();
    const o = await placed([[m, 10, 62.5]]);
    const r = await receive(o, [arrive(m, 6, { batchNumber: 'BN-100', manufacturingDate: iso(-60), expiryDate: iso(500), mrp: 99, sellingPrice: 90 })], { remarks: 'First truck' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { receipt, order: after } = r.data;
    assert.match(receipt.receiptNo, /^GRN-\d{4}$/);
    assert.equal(after.status, 'partially_received');
    assert.deepEqual([receipt.totalArrived, receipt.totalAccepted, receipt.totalRejected, receipt.totalDamaged], [6, 6, 0, 0]);
    const line = receipt.items[0];
    assert.deepEqual([line.orderedQuantity, line.previouslyReceived, line.remainingBefore, line.remainingAfter, line.acceptedQuantity], [10, 0, 10, 4, 6]);
    assert.equal(line.newBatch, true);
    const bs = await batchesOf(m);
    assert.equal(bs.length, 1);
    assert.deepEqual([bs[0].batchNumber, bs[0].availableQuantity, bs[0].purchasePrice, bs[0].mrp, bs[0].sellingPrice], ['BN-100', 6, 62.5, 99, 90], 'the purchase price comes from the order line');
    assert.equal(String(bs[0].supplierId), String(after.supplier.supplierId));
    assert.ok(bs[0].manufacturingDate && bs[0].expiryDate);
    const mv = (await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.find((x) => x.type === 'PURCHASE');
    assert.deepEqual([mv.quantity, mv.refType, mv.balanceAfter], [6, 'GoodsReceipt', 6]);
    assert.equal(String(mv.refId), String(receipt._id));
    assert.equal(await reconciled(), true);
    const l = after.items[0];
    assert.deepEqual([l.receivedQuantity, l.acceptedQuantity, l.rejectedQuantity, l.damagedQuantity], [6, 6, 0, 0]);
    assert.equal((await get(o)).history.at(-1).action, 'RECEIVED');
  });

  it('the rest arrives later: the order completes automatically, and batch numbers are kept batch-wise', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    await receive(o, [arrive(m, 6, { batchNumber: 'SAME-1', expiryDate: iso(300) })]);
    const second = await receive(o, [arrive(m, 4, { batchNumber: 'SAME-1', expiryDate: iso(300) })]);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.data.order.status, 'received');
    assert.ok((await get(o)).receivedAt);
    const bs = await batchesOf(m);
    assert.equal(bs.length, 1, 'the same batch number tops up the same batch');
    assert.equal(bs[0].availableQuantity, 10);
    assert.equal(second.data.receipt.items[0].newBatch, undefined);
    const third = await receive(o, [arrive(m, 1)]);
    assert.equal(third.status, 409, 'a completed order receives nothing more');
    const diff = await placed([[m, 5]]);
    await receive(diff, [arrive(m, 5, { batchNumber: 'OTHER-2', expiryDate: iso(200) })]);
    assert.equal((await batchesOf(m)).length, 2, 'a different batch number is a different batch');
    assert.equal(await units(m), 15);
    assert.equal(await reconciled(), true);
  });

  it('free units arrive on top of the paid ones; neither can exceed what was ordered', async () => {
    const m = await medicine();
    const o = await placed([[m, 10, 20, 2]]);
    const free = await receive(o, [arrive(m, 10, { freeQuantity: 2 })]);
    assert.equal(free.status, 201);
    assert.equal(free.data.order.status, 'received');
    assert.equal(await units(m), 12, 'paid + free are both stock');
    assert.deepEqual([free.data.receipt.items[0].quantity, free.data.receipt.items[0].freeQuantity], [10, 2]);
    const o2 = await placed([[m, 10, 20, 2]]);
    const moreFree = await receive(o2, [arrive(m, 5, { freeQuantity: 3 })]);
    assert.equal(moreFree.status, 400);
    assert.equal(moreFree.body.details[0].path, 'items.0.freeQuantity');
  });

  it('never more than was ordered, counting what already arrived', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const over = await receive(o, [arrive(m, 11)]);
    assert.equal(over.status, 400);
    assert.match(over.body.details[0].message, /Only 10 more units .* are expected .*More than ordered can't be received/);
    assert.equal((await receive(o, [arrive(m, 7)])).status, 201);
    const again = await receive(o, [arrive(m, 4)]);
    assert.equal(again.status, 400);
    assert.match(again.body.details[0].message, /Only 3 more units/);
    assert.equal((await receive(o, [arrive(m, 0)])).status, 400, 'nothing arrived');
    assert.equal(await units(m), 7);
  });
});

describe('Rejected and damaged units', () => {
  it('are recorded separately and never reach stock, and they still count as having arrived', async () => {
    const m = await medicine();
    const o = await placed([[m, 20]]);
    const r = await receive(o, [arrive(m, 20, { rejectedQuantity: 3, damagedQuantity: 2, remarks: 'Strips crushed; 3 wrong strength' })]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const l = r.data.receipt.items[0];
    assert.deepEqual([l.quantity, l.rejectedQuantity, l.damagedQuantity, l.acceptedQuantity], [20, 3, 2, 15]);
    assert.deepEqual([r.data.receipt.totalAccepted, r.data.receipt.totalRejected, r.data.receipt.totalDamaged], [15, 3, 2]);
    assert.equal(await units(m), 15, 'only the accepted units are stock');
    assert.equal(r.data.order.status, 'received', 'everything expected has arrived');
    const line = r.data.order.items[0];
    assert.deepEqual([line.receivedQuantity, line.acceptedQuantity, line.rejectedQuantity, line.damagedQuantity], [20, 15, 3, 2]);
    assert.equal(await reconciled(), true);
  });
  it('need a reason and cannot be more than arrived', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const noReason = await receive(o, [arrive(m, 10, { damagedQuantity: 1 })]);
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.details[0].path, 'items.0.remarks');
    const tooMany = await receive(o, [arrive(m, 5, { rejectedQuantity: 4, damagedQuantity: 2, remarks: 'x' })]);
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.details[0].path, 'items.0.rejectedQuantity');
    assert.equal(await units(m), 0);
  });
  it('a delivery that is entirely rejected adds no stock and needs no batch details', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const r = await receive(o, [{ medicineId: m._id, quantity: 4, rejectedQuantity: 4, remarks: 'Wrong product sent' }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.order.status, 'partially_received');
    assert.equal((await batchesOf(m)).length, 0);
    assert.equal(r.data.receipt.items[0].acceptedQuantity, 0);
    assert.equal(r.data.order.items[0].receivedQuantity, 4);
  });
});

describe('Pharmacy rules: batch, dates and verified stock', () => {
  const bad = async (extra, path, re, lines = 1) => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const r = await receive(o, [arrive(m, lines, extra)]);
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.ok(r.body.details.some((d) => d.path === path && re.test(d.message)), `${path}: ${JSON.stringify(r.body.details)}`);
    assert.equal(await units(m), 0, 'nothing was added');
    assert.equal((await get(o)).status, 'ordered', 'the order did not move');
    assert.equal((await T.client.get(`/orders/receipts?orderId=${o._id}`)).data.total, 0, 'no goods received record was kept');
  };
  it('every accepted unit needs a batch number and an expiry date', async () => {
    await bad({ batchNumber: '' }, 'items.0.batchNumber', /Enter the batch number/);
    await bad({ batchNumber: '   ' }, 'items.0.batchNumber', /Enter the batch number/);
    await bad({ expiryDate: '' }, 'items.0.expiryDate', /Enter the expiry date/);
  });
  it('expired (or expiring today) stock cannot be accepted into sellable inventory', async () => {
    await bad({ expiryDate: iso(-1) }, 'items.0.expiryDate', /already expired/);
    await bad({ expiryDate: iso(0) }, 'items.0.expiryDate', /already expired/);
    await bad({ expiryDate: '2026-02-30' }, 'items.0.expiryDate', /real calendar date/);
  });
  it('the manufacturing date must be real, in the past and before the expiry', async () => {
    await bad({ manufacturingDate: iso(5) }, 'items.0.manufacturingDate', /cannot be in the future/);
    await bad({ manufacturingDate: iso(-10), expiryDate: iso(-20) }, 'items.0.expiryDate', /expired/);
    await bad({ manufacturingDate: '2026-02-30' }, 'items.0.manufacturingDate', /real calendar date/);
  });
  it('a new batch needs prices, and the selling price cannot exceed the MRP', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const noPrices = await receive(o, [{ medicineId: m._id, quantity: 2, batchNumber: 'NP-1', expiryDate: iso(300) }]);
    assert.equal(noPrices.status, 400);
    assert.equal(noPrices.body.details[0].path, 'items.0.mrp');
    const over = await receive(o, [arrive(m, 2, { mrp: 50, sellingPrice: 60 })]);
    assert.equal(over.status, 400);
    assert.equal(over.body.details[0].path, 'items.0.sellingPrice');
    assert.equal(await units(m), 0);
  });
  it('an existing batch keeps its single expiry date and must still be active', async () => {
    const m = await medicine();
    const o = await placed([[m, 30]]);
    await receive(o, [arrive(m, 5, { batchNumber: 'KEEP-1', expiryDate: iso(300) })]);
    const wrongExpiry = await receive(o, [arrive(m, 5, { batchNumber: 'KEEP-1', expiryDate: iso(400) })]);
    assert.equal(wrongExpiry.status, 400);
    assert.match(wrongExpiry.body.details[0].message, /already in stock with expiry/);
    const batch = (await batchesOf(m))[0];
    await T.client.patch(`/batches/${batch._id}`, { status: 'quarantined' });
    const quarantined = await receive(o, [arrive(m, 5, { batchNumber: 'KEEP-1', expiryDate: iso(300) })]);
    assert.equal(quarantined.status, 400);
    assert.match(quarantined.body.details[0].message, /quarantined/);
    assert.equal((await batchesOf(m))[0].availableQuantity, 5);
  });
  it('one batch of a product may appear once per delivery (several batches may share it), and only products of this order', async () => {
    const m = await medicine();
    const other2 = await medicine();
    const o = await placed([[m, 10]]);
    const dup = await receive(o, [arrive(m, 1, { batchNumber: 'SAME-1' }), arrive(m, 1, { batchNumber: 'SAME-1' })]);
    assert.equal(dup.status, 400);
    assert.match(dup.body.details[0].message, /listed twice/);
    const tooMany = await receive(o, [arrive(m, 6), arrive(m, 6)]); // two batches, but together more than was ordered
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.details[0].message, /Only 4 more unit/);
    const stranger = await receive(o, [arrive(other2, 1)]);
    assert.equal(stranger.status, 400);
    assert.match(stranger.body.details[0].message, /not on this order/);
    const two = await receive(o, [arrive(m, 4), arrive(m, 6)]); // two batches that together are exactly what was ordered
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.equal((await batchesOf(m)).length, 2);
  });
});

describe('Several products at once, the stock module and legacy orders', () => {
  it('receives several products in one delivery, each into its own batch', async () => {
    const a = await medicine();
    const b = await medicine();
    const o = await placed([[a, 10], [b, 6]]);
    const r = await receive(o, [arrive(a, 10), arrive(b, 2)]);
    assert.equal(r.status, 201);
    assert.equal(r.data.order.status, 'partially_received', 'b is still expected');
    assert.equal(await units(a), 10);
    assert.equal(await units(b), 2);
    assert.equal(r.data.receipt.items.length, 2);
    // the inventory list (the existing stock module's own figures) agrees
    const listed = (await T.client.get(`/inventory?search=${encodeURIComponent(a.medicineName)}`)).data.items.find((x) => x._id === a._id);
    assert.equal(listed.availableStock, 10);
    assert.equal(await reconciled(), true);
  });
  it('stock goes to the store the order names', async () => {
    const north = (await T.client.post('/branches', { name: uniq('North'), code: uniq('N').toUpperCase().slice(0, 8) })).data;
    const m = await medicine();
    const o = await placed([[m, 4]], { branchId: north._id });
    await receive(o, [arrive(m, 4)]);
    const b = (await batchesOf(m))[0];
    assert.equal(String(b.branchId), String(north._id));
    assert.equal((await T.client.get(`/batches?medicineId=${m._id}&branchId=${north._id}`)).data.items.length, 1);
  });
  it('lines made before receiving existed can still be received against', async () => {
    const m = await medicine();
    const s = await supplier();
    const legacy = await h.tenant.runWithTenant(T.org._id, () => h.models.Order.create({
      orderNo: uniq('LEG'), supplier: { supplierId: s._id, name: s.name }, status: 'partially_received',
      items: [{ medicineId: m._id, name: m.medicineName, unit: 'Strip', quantity: 10, receivedQuantity: 4 }],
    }));
    const r = await receive({ _id: String(legacy._id) }, [arrive(m, 6)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.order.status, 'received');
    assert.equal((await receive({ _id: String(legacy._id) }, [arrive(m, 1)])).status, 409);
    const over = await h.tenant.runWithTenant(T.org._id, () => h.models.Order.create({
      orderNo: uniq('LEG'), supplier: { name: 'x' }, status: 'ordered', items: [{ medicineId: m._id, name: m.medicineName, quantity: 10, receivedQuantity: 4 }],
    }));
    const tooMuch = await receive({ _id: String(over._id) }, [arrive(m, 7)]);
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.details[0].message, /Only 6 more/);
  });
});

describe('Duplicate, racing and failing requests', () => {
  it('the same idempotency key adds the stock once', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    const payload = { items: [arrive(m, 5)], idempotencyKey: key() };
    const a = await T.client.post(`/orders/${o._id}/receive`, payload);
    const b = await T.client.post(`/orders/${o._id}/receive`, payload);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.data.duplicate, true);
    assert.equal(b.data.receipt._id, a.data.receipt._id);
    assert.equal(await units(m), 5);
    assert.equal((await T.client.get(`/orders/receipts?orderId=${o._id}`)).data.total, 1);
  });
  it('two deliveries racing for the last units: exactly one wins, stock is added once', async () => {
    const m = await medicine();
    const o = await placed([[m, 5]]);
    const [x, y] = await Promise.all([receive(o, [arrive(m, 5)]), receive(o, [arrive(m, 5)])]);
    assert.equal([x.status, y.status].filter((s) => s === 201).length, 1, `one winner (${x.status}, ${y.status})`);
    assert.equal(await units(m), 5);
    assert.equal((await get(o)).status, 'received');
    assert.equal(await reconciled(), true);
  });
  it('a failure part-way rolls back the stock, the ledger, the order lines and the record; a retry works', async () => {
    const a = await medicine();
    const b = await medicine();
    const o = await placed([[a, 5], [b, 5]]);
    const original = h.models.StockMovement.create.bind(h.models.StockMovement);
    let calls = 0;
    h.models.StockMovement.create = async (...args) => {
      if (++calls === 2) throw new Error('simulated database failure');
      return original(...args);
    };
    let r;
    try {
      r = await receive(o, [arrive(a, 5), arrive(b, 5)]);
    } finally {
      h.models.StockMovement.create = original;
    }
    assert.ok(r.status >= 500, `a failed receipt is an error (${r.status})`);
    assert.equal(await units(a), 0, 'the first line’s stock was rolled back');
    assert.equal(await units(b), 0);
    assert.equal((await batchesOf(a)).length, 0, 'no batch was left behind');
    const after = await get(o);
    assert.equal(after.status, 'ordered');
    assert.deepEqual(after.items.map((i) => i.receivedQuantity || 0), [0, 0], 'the claim on the order lines rolled back');
    assert.equal(after.receipts.length, 0);
    assert.equal((await receive(o, [arrive(a, 5), arrive(b, 5)])).status, 201, 'a retry works');
    assert.equal(await reconciled(), true);
  });
});

describe('The goods received history', () => {
  it('lists every receipt, newest first, and can be limited to one order; records are permanent', async () => {
    const m = await medicine();
    const o = await placed([[m, 10]]);
    await receive(o, [arrive(m, 4)]);
    await receive(o, [arrive(m, 6)]);
    const list = (await T.client.get(`/orders/receipts?orderId=${o._id}`)).data;
    assert.equal(list.total, 2);
    assert.ok(new Date(list.items[0].receivedAt) >= new Date(list.items[1].receivedAt), 'newest first');
    for (const k of ['receiptNo', 'orderNo', 'receivedByName', 'receivedAt', 'totalAccepted']) assert.ok(k in list.items[0], k);
    assert.equal(list.items[0].receivedByName, T.user.name);
    assert.ok((await T.client.get('/orders/receipts')).data.total >= 2);
    assert.deepEqual((await get(o)).receipts.map((r) => r.receiptNo), list.items.map((r) => r.receiptNo).reverse(), 'the order shows its own, oldest first');
    await assert.rejects(() => h.tenant.runWithTenant(T.org._id, () => h.models.GoodsReceipt.updateOne({ _id: list.items[0]._id }, { $set: { remarks: 'tampered' } })), /permanent/);
    await assert.rejects(() => h.tenant.runWithTenant(T.org._id, () => h.models.GoodsReceipt.deleteOne({ _id: list.items[0]._id })), /permanent/);
    assert.equal((await other.client.get(`/orders/receipts?orderId=${o._id}`)).status, 404, 'another organization’s order is not found');
    assert.ok(!(await other.client.get('/orders/receipts')).data.items.some((x) => x.orderNo === o.orderNo), 'and its receipts never appear in another organization’s list');
    assert.equal((await h.client().get('/orders/receipts')).status, 401);
    assert.ok((await T.client.get('/activity?limit=100')).data.items.some((x) => x.action === 'ORDER_RECEIVE' && x.message.includes(o.orderNo)));
  });
});

describe('Editing a draft, who did what, and the printable order', () => {
  const draft = async (lines = [], over = {}) => {
    const s = await supplier();
    const ms = lines.length ? lines : [[await medicine(), 5, 10]];
    const r = await T.client.post('/orders', { supplierId: s._id, items: ms.map(([m, quantity, rate]) => ({ medicineId: m._id, quantity, rate })), payment: { terms: 'credit' }, status: 'draft', idempotencyKey: key(), ...over });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { o: r.data, s, ms };
  };
  const edit = (o, body, client = T.client) => client.put(`/orders/${o._id}`, body);
  const bodyFor = (s, ms, over = {}) => ({ supplierId: s._id, items: ms.map(([m, quantity, rate, extra = {}]) => ({ medicineId: m._id, quantity, rate, ...extra })), payment: { terms: 'credit', advance: 0 }, ...over });

  it('changes a draft’s products and prices, recalculates everything, and keeps its number, status and creator', async () => {
    const { o, s, ms } = await draft();
    const m2 = await medicine();
    const r = await edit(o, bodyFor(s, [[ms[0][0], 10, 20, { discountPercent: 10, gstPercent: 12 }], [m2, 2, 50]], { referenceNo: 'QT-EDIT', notes: 'Edited' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.data.orderNo, r.data.status, r.data.referenceNo, r.data.notes], [o.orderNo, 'draft', 'QT-EDIT', 'Edited']);
    assert.deepEqual([r.data.itemCount, r.data.subtotal, r.data.discountTotal, r.data.gstTotal, r.data.grandTotal], [2, 300, 20, 21.6, 301.6]);
    assert.equal(String(r.data.createdBy), String(T.user._id));
    assert.deepEqual((await get(o)).history.map((x) => x.action), ['CREATED', 'EDITED']);
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'ORDER_EDIT' && x.message.includes(o.orderNo)));
    assert.equal((await edit(o, bodyFor(s, [[ms[0][0], -1, 20]]))).status, 400, 'the same rules as creating');
    assert.equal((await edit(o, bodyFor(s, [[ms[0][0], 1, 20], [ms[0][0], 1, 20]]))).status, 400);
    assert.equal((await get(o)).grandTotal, 301.6, 'a refused edit changes nothing');
  });
  it('only a draft can be edited: a submitted order must be sent back first', async () => {
    const { o, s, ms } = await draft();
    assert.equal((await act(o, 'submit')).data.status, 'approved');
    const r = await edit(o, bodyFor(s, ms));
    assert.equal(r.status, 409);
    assert.match(r.body.message, /only a draft can be edited/);
    const placedOrder = await placed([[ms[0][0], 1]]);
    assert.equal((await edit(placedOrder, bodyFor(s, ms))).status, 409);
  });
  it('needs stock-management rights and the right organization', async () => {
    const { o, s, ms } = await draft();
    assert.equal((await edit(o, bodyFor(s, ms), await asRole('BILLING_STAFF'))).status, 403);
    assert.equal((await edit(o, bodyFor(s, ms), other.client)).status, 404);
    assert.equal((await h.client().put(`/orders/${o._id}`, bodyFor(s, ms))).status, 401);
    assert.equal((await edit(o, { ...bodyFor(s, ms), status: 'ordered', orderNo: 'ORD-9999' })).data.status, 'draft', 'an edit never changes the status');
  });
  it('shows who created, submitted, approved and ordered it', async () => {
    const m = await medicine();
    const manager = await asRole('BRANCH_MANAGER');
    await T.client.put('/orders/settings', { approvalRequired: true });
    try {
      const o = await order([[m, 3]]);
      await act(o, 'approve', undefined, manager);
      await act(o, 'order');
      const d = await get(o);
      assert.deepEqual([d.createdByName, d.submittedByName, d.orderedByName], [T.user.name, T.user.name, T.user.name]);
      assert.ok(d.approvedByName && d.approvedByName !== T.user.name, 'approved by the manager');
      assert.equal(d.history.find((x) => x.action === 'APPROVED').byName, d.approvedByName);
    } finally {
      await T.client.put('/orders/settings', { approvalRequired: false });
    }
  });
  it('provides the printable order: organization details, the order, who printed it', async () => {
    const m = await medicine();
    const o = await placed([[m, 4, 25]]);
    const p = (await T.client.get(`/orders/${o._id}/print`)).data;
    assert.equal(p.organization.name, 'Order Receive Org');
    for (const k of ['email', 'phone', 'address', 'gstin']) assert.ok(k in p.organization, k);
    assert.equal(p.order.orderNo, o.orderNo);
    assert.equal(p.order.grandTotal, 100);
    assert.equal(p.printedBy.name, T.user.name);
    assert.ok(p.printedAt);
    assert.equal((await other.client.get(`/orders/${o._id}/print`)).status, 404);
    assert.equal((await h.client().get(`/orders/${o._id}/print`)).status, 401);
  });
});

describe('The orders API: documented field names, filters, summary, delete and status updates', () => {
  const draftOf = async (s, m, over = {}) => (await T.client.post('/orders', { supplierId: s._id, items: [{ medicineId: m._id, quantity: 1, rate: 1 }], payment: { terms: 'credit' }, status: 'draft', idempotencyKey: key(), ...over })).data;

  it('returns an order under the documented names as well as the stored ones', async () => {
    const m = await medicine();
    const s = await supplier();
    const r = await T.client.post('/orders', {
      supplierId: s._id, expectedDate: iso(5), referenceNo: 'QT-1', notes: 'n', status: 'submitted', idempotencyKey: key(),
      items: [{ medicineId: m._id, quantity: 10, freeQuantity: 2, rate: 20, discountPercent: 10, gstPercent: 12 }],
      charges: { shipping: 50, packaging: 20, other: 10, gstPercent: 18, additionalDiscount: 25 }, payment: { terms: 'partial', method: 'UPI', advance: 100 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = await get(r.data);
    assert.deepEqual([o.orderId, String(o.supplierId), o.orderStatus, o.paymentTerms, o.paymentStatus, o.advancePayment], [o.orderNo, String(s._id), 'approved', 'partial', 'partially_paid', 100]);
    assert.deepEqual([o.shippingCharges, o.otherCharges, o.discount, o.taxAmount], [50, 30, 20, 21.6], 'packaging + other are the "other charges"');
    assert.equal(o.remainingAmount, Math.round((o.grandTotal - 100) * 100) / 100);
    assert.ok(o.expectedDeliveryDate);
    const i = o.items[0];
    assert.deepEqual([String(i.productId), i.orderedQuantity, i.freeQuantity, i.receivedQuantity, i.rejectedQuantity, i.purchaseRate, i.discount, i.gstPercentage, i.gstAmount, i.totalAmount], [String(m._id), 10, 2, 0, 0, 20, 20, 12, 21.6, 201.6]);
    assert.ok('createdBy' in o && 'createdAt' in o && 'updatedAt' in o);
    assert.deepEqual(o.receivedHistory, []);
    await act(r.data, 'order');
    await receive(r.data, [arrive(m, 10, { freeQuantity: 2, rejectedQuantity: 1, remarks: 'torn foil' })]);
    const after = await get(r.data);
    assert.equal(after.receivedHistory.length, 1);
    assert.equal(after.receivedHistory[0].receiptNo, after.receipts[0].receiptNo);
    assert.deepEqual([after.items[0].receivedQuantity, after.items[0].rejectedQuantity], [12, 1]);
  });

  it('filters by supplier, store, payment status, order date and overdue, and combines filters', async () => {
    const m = await medicine();
    const s1 = await supplier();
    const s2 = await supplier();
    const north = (await T.client.post('/branches', { name: uniq('FNorth'), code: uniq('F').toUpperCase().slice(0, 8) })).data;
    const mk = (s, over = {}) => T.client.post('/orders', { supplierId: s._id, items: [{ medicineId: m._id, quantity: 1, rate: 10 }], payment: { terms: 'credit' }, status: 'submitted', idempotencyKey: key(), ...over });
    const a = (await mk(s1, { orderDate: '2026-01-10' })).data;
    const b = (await mk(s2, { branchId: north._id, orderDate: '2026-02-10', payment: { terms: 'advance', method: 'Cash', advance: 10 } })).data;
    const c = (await mk(s2, { orderDate: '2026-03-10', expectedDate: '2026-03-12' })).data;
    await act(c, 'order');
    const ids = async (qs) => (await T.client.get(`/orders?limit=100&${qs}`)).data.items.map((x) => x._id);
    assert.deepEqual(await ids(`supplierId=${s1._id}`), [a._id]);
    assert.deepEqual((await ids(`supplierId=${s2._id}`)).sort(), [b._id, c._id].sort());
    assert.deepEqual(await ids(`branchId=${north._id}`), [b._id]);
    assert.deepEqual(await ids(`paymentStatus=paid&supplierId=${s2._id}`), [b._id]);
    assert.deepEqual(await ids('dateFrom=2026-02-01&dateTo=2026-02-28'), [b._id], 'both end days are included');
    assert.deepEqual(await ids('dateFrom=2026-02-10&dateTo=2026-02-10'), [b._id]);
    assert.deepEqual(await ids('overdue=true'), [c._id], 'expected before today and still not complete');
    assert.deepEqual(await ids(`overdue=true&supplierId=${s1._id}`), []);
    assert.equal((await T.client.get('/orders?supplierId=nope')).status, 400);
    assert.equal((await T.client.get('/orders?paymentStatus=weird')).status, 400);
    assert.equal((await T.client.get('/orders?dateFrom=yesterday')).status, 400);
    assert.equal((await T.client.get('/orders?supplierId=&paymentStatus=&overdue=')).status, 200, 'empty filters mean "all"');
    assert.equal((await other.client.get(`/orders?supplierId=${s1._id}`)).data.total, 0, 'only this organization’s orders');
  });

  it('summarises the orders: by status, awaiting approval or goods, overdue, values and what is unpaid', async () => {
    const before = (await T.client.get('/orders/summary')).data;
    for (const k of ['total', 'byStatus', 'awaitingApproval', 'awaitingReceipt', 'overdue', 'openValue', 'receivedValue', 'unpaidOrders', 'unpaidAmount', 'thisMonthOrders', 'thisMonthValue']) assert.ok(k in before, k);
    assert.deepEqual(Object.keys(before.byStatus), ['draft', 'pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled']);
    assert.equal(before.total, Object.values(before.byStatus).reduce((a, b) => a + b, 0));
    const m = await medicine();
    const s = await supplier();
    const mk = (status, rate) => T.client.post('/orders', { supplierId: s._id, items: [{ medicineId: m._id, quantity: 10, rate }], payment: { terms: 'credit' }, status, idempotencyKey: key() });
    await mk('draft', 1000);
    await mk('submitted', 10); // approved, 100
    const ordered = (await mk('submitted', 20)).data; // 200
    await act(ordered, 'order');
    const done = (await mk('submitted', 30)).data; // 300
    await act(done, 'order');
    await receive(done, [arrive(m, 10)]);
    const cancelled = (await mk('submitted', 5000)).data;
    await act(cancelled, 'cancel', {});
    const after = (await T.client.get('/orders/summary')).data;
    const d = (k) => Math.round((after[k] - before[k]) * 100) / 100;
    assert.equal(after.total - before.total, 5);
    assert.deepEqual(['draft', 'approved', 'ordered', 'received', 'cancelled'].map((k) => after.byStatus[k] - before.byStatus[k]), [1, 1, 1, 1, 1]);
    assert.equal(d('awaitingReceipt'), 1);
    assert.equal(d('openValue'), 300, 'approved 100 + ordered 200; drafts and cancelled orders are not committed money');
    assert.equal(d('receivedValue'), 300);
    assert.equal(d('unpaidAmount'), 600, 'credit orders that are not cancelled or drafts: 100 + 200 + 300');
    assert.equal(d('thisMonthValue'), 600);
    assert.equal((await other.client.get('/orders/summary')).data.total, 0, 'only this organization’s orders');
    assert.equal((await h.client().get('/orders/summary')).status, 401);
  });

  it('deletes a draft for good, and refuses anything that has been submitted', async () => {
    const m = await medicine();
    const s = await supplier();
    const d = await draftOf(s, m);
    assert.equal((await T.client.del(`/orders/${d._id}`)).status, 200);
    assert.equal((await T.client.get(`/orders/${d._id}`)).status, 404);
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'ORDER_DELETE' && x.message.includes(d.orderNo)));
    const o = await order([[m, 1]]);
    const r = await T.client.del(`/orders/${o._id}`);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /only a draft can be deleted/);
    const d2 = await draftOf(s, m);
    assert.equal((await (await asRole('BILLING_STAFF')).del(`/orders/${d2._id}`)).status, 403);
    assert.equal((await other.client.del(`/orders/${d2._id}`)).status, 404);
    assert.equal((await h.client().del(`/orders/${d2._id}`)).status, 401);
    assert.equal((await T.client.get(`/orders/${d2._id}`)).status, 200, 'still there');
  });

  it('updates the status by name through the workflow, with the same rules and permissions', async () => {
    const setStatus = (o, body, client = T.client) => client.patch(`/orders/${o._id}/status`, body);
    const m = await medicine();
    const s = await supplier();
    const o = await draftOf(s, m);
    assert.equal((await setStatus(o, { status: 'received' })).status, 400, 'received is never set by hand');
    assert.equal((await setStatus(o, { status: 'partially_received' })).status, 400);
    assert.equal((await setStatus(o, { status: 'bogus' })).status, 400);
    assert.equal((await setStatus(o, { status: 'ordered' })).status, 409, 'a draft cannot jump to ordered');
    assert.equal((await setStatus(o, { status: 'draft' })).status, 409, 'already there');
    assert.equal((await setStatus(o, { status: 'approved' })).data.status, 'approved', 'submitted; approval is not required');
    assert.equal((await setStatus(o, { status: 'ordered' })).data.status, 'ordered');
    assert.equal((await setStatus(o, { status: 'cancelled', reason: 'Supplier closed' })).data.status, 'cancelled');
    assert.equal((await get(o)).cancelReason, 'Supplier closed');
    assert.deepEqual((await get(o)).history.map((x) => x.action), ['CREATED', 'SUBMITTED', 'ORDERED', 'CANCELLED']);
    assert.equal((await setStatus(o, { status: 'ordered' })).status, 409, 'a cancelled order cannot go on');
    // with approval required: pending, approve (only approvers), send back (a reason is needed)
    await T.client.put('/orders/settings', { approvalRequired: true });
    try {
      const p = await draftOf(s, m);
      assert.equal((await setStatus(p, { status: 'approved' })).status, 409, 'submission left it pending, not approved');
      assert.equal((await get(p)).status, 'pending');
      const clerk = await asRole('INVENTORY_MANAGER');
      const manager = await asRole('BRANCH_MANAGER');
      assert.equal((await setStatus(p, { status: 'approved' }, clerk)).status, 403);
      assert.equal((await setStatus(p, { status: 'draft', reason: '' }, manager)).status, 400);
      assert.equal((await setStatus(p, { status: 'approved' }, manager)).data.status, 'approved');
      const q = await draftOf(s, m);
      await setStatus(q, { status: 'pending' });
      const back = await setStatus(q, { status: 'draft', reason: 'Wrong quantities' }, manager);
      assert.equal(back.data.status, 'draft');
      assert.equal(back.data.rejectReason, 'Wrong quantities');
    } finally {
      await T.client.put('/orders/settings', { approvalRequired: false });
    }
    assert.equal((await setStatus(await draftOf(s, m), { status: 'cancelled' }, await asRole('BILLING_STAFF'))).status, 403);
    assert.equal((await setStatus(o, { status: 'cancelled' }, other.client)).status, 404);
    assert.equal((await h.client().patch(`/orders/${o._id}/status`, { status: 'cancelled' })).status, 401);
  });
});

describe('Branch-level access to orders, and what each supplier is owed', () => {
  const store = async (name) => (await T.client.post('/branches', { name: uniq(name), code: uniq(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) })).data;
  const staffFor = async (branchIds, role = 'INVENTORY_MANAGER') => {
    const u = await h.makeUser(T.org, { role, branchIds });
    const c = h.client();
    assert.equal((await c.login(u.email)).status, 200);
    return c;
  };

  it('a user limited to a store sees and works with only that store’s orders', async () => {
    const north = await store('BNorth');
    const south = await store('BSouth');
    const m = await medicine();
    const s = await supplier();
    const mk = (branchId) => T.client.post('/orders', { supplierId: s._id, branchId, items: [{ medicineId: m._id, quantity: 5, rate: 10 }], payment: { terms: 'credit' }, status: 'submitted', idempotencyKey: key() });
    const atNorth = (await mk(north._id)).data;
    const atSouth = (await mk(south._id)).data;
    const northUser = await staffFor([north._id]);
    const ids = async (c, path = '/orders?limit=100') => (await c.get(path)).data.items.map((x) => x._id);
    assert.ok((await ids(northUser)).includes(atNorth._id));
    assert.ok(!(await ids(northUser)).includes(atSouth._id), 'the other store’s order is not listed');
    assert.ok((await ids(T.client)).includes(atSouth._id), 'an admin sees every store');
    for (const path of ['', '/print', '/receivable']) assert.equal((await northUser.get(`/orders/${atSouth._id}${path}`)).status, 404, path);
    assert.equal((await northUser.get(`/orders/${atNorth._id}`)).status, 200);
    for (const [step, body] of [['order'], ['cancel', {}], ['submit'], ['receive', { items: [arrive(m, 1)] }]]) assert.equal((await northUser.post(`/orders/${atSouth._id}/${step}`, body)).status, 404, `${step} at another store`);
    assert.equal((await northUser.patch(`/orders/${atSouth._id}/status`, { status: 'cancelled' })).status, 404);
    assert.equal((await northUser.put(`/orders/${atSouth._id}`, { supplierId: s._id, items: [{ medicineId: m._id, quantity: 1, rate: 1 }], payment: { terms: 'credit' } })).status, 404);
    assert.equal((await northUser.del(`/orders/${atSouth._id}`)).status, 404);
    assert.equal((await northUser.get(`/orders/receipts?orderId=${atSouth._id}`)).status, 404);
    // …and can act on their own store's order
    assert.equal((await northUser.post(`/orders/${atNorth._id}/order`)).status, 200);
    assert.equal((await northUser.post(`/orders/${atNorth._id}/receive`, { items: [arrive(m, 5)], idempotencyKey: key() })).status, 201);
    assert.equal((await northUser.get(`/orders/receipts`)).data.items.every((x) => String(x.branchId) === String(north._id)), true, 'only their store’s goods received records');
    // the summary counts only their store's orders
    assert.ok((await northUser.get('/orders/summary')).data.total < (await T.client.get('/orders/summary')).data.total);
    assert.equal((await T.client.get(`/orders/${atSouth._id}`)).data.status, 'approved', 'nothing happened to the other store’s order');
  });

  it('a store-limited user can only order for their own store', async () => {
    const north = await store('CNorth');
    const south = await store('CSouth');
    const m = await medicine();
    const s = await supplier();
    const body = (branchId) => ({ supplierId: s._id, ...(branchId && { branchId }), items: [{ medicineId: m._id, quantity: 1, rate: 1 }], payment: { terms: 'credit' }, status: 'draft', idempotencyKey: key() });
    const northUser = await staffFor([north._id]);
    assert.equal((await northUser.post('/orders', body(north._id))).status, 201);
    const wrong = await northUser.post('/orders', body(south._id));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code || wrong.body.error?.code, 'NOT_YOUR_STORE');
    assert.equal((await northUser.post('/orders', body())).status, 403, 'no store named means the main store, which is not theirs');
    const mainUser = await staffFor([(await T.client.get('/branches')).data.find((b) => b.isDefault)._id]);
    assert.equal((await mainUser.post('/orders', body())).status, 201, 'but it is the main store for someone who works there');
  });

  it('shows what each supplier is owed, from their orders: unpaid balances of orders that are not drafts or cancelled', async () => {
    const m = await medicine();
    const s = await supplier();
    const fresh = (await T.client.get(`/suppliers/${s._id}`)).data;
    assert.deepEqual([fresh.outstandingAmount, fresh.openOrders, fresh.totalOrders], [0, 0, 0]);
    const mk = (over) => T.client.post('/orders', { supplierId: s._id, items: [{ medicineId: m._id, quantity: 10, rate: 10 }], payment: { terms: 'credit' }, status: 'submitted', idempotencyKey: key(), ...over });
    await mk({ status: 'draft' }); // not counted
    const a = (await mk()).data; // 100 owed, open
    await mk({ payment: { terms: 'advance', method: 'Cash', advance: 100 } }); // paid in full: owes nothing
    await mk({ payment: { terms: 'partial', method: 'UPI', advance: 30 } }); // 70 owed
    const cancelled = (await mk()).data;
    await act(cancelled, 'cancel', {}); // not counted
    const b = (await T.client.get(`/suppliers/${s._id}`)).data;
    assert.deepEqual([b.outstandingAmount, b.openOrders, b.totalOrders], [170, 3, 3]);
    await act(a, 'order');
    await receive(a, [arrive(m, 10)]);
    const c = (await T.client.get(`/suppliers/${s._id}`)).data;
    assert.deepEqual([c.outstandingAmount, c.openOrders], [170, 2], 'receiving goods completes the order but the money is still owed');
    const listed = (await T.client.get(`/suppliers?search=${encodeURIComponent(s.name)}`)).data.items.find((x) => x._id === s._id);
    assert.equal(listed.outstandingAmount, 170, 'the list shows it too');
    assert.equal((await other.client.get(`/suppliers/${s._id}`)).status, 404);
  });
});
