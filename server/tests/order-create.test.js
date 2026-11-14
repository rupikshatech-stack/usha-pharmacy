// Adding an order: suppliers (the minimal Suppliers API), the product search for the form, the arithmetic (GST, discounts, charges, grand total),
// validation, payment rules, duplicate protection, audit, permissions and organization isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let main;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const key = () => `ok-${++n}-${Date.now()}`;

const medicine = async (client = T.client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Order Med'), genericName: 'Paracetamol', manufacturer: 'Cipla', unit: 'Strip', gstPercentage: 12, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const supplier = async (client = T.client, over = {}) => {
  const r = await client.post('/suppliers', { name: uniq('Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022', email: 'sales@supplier.test', address: { line1: '12 Market Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' }, gstin: '27ABCDE1234F1Z5', ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const body = (s, items, over = {}) => ({
  supplierId: s._id,
  items: items.map(([m, quantity, rate, extra = {}]) => ({ medicineId: m._id, quantity, rate, ...extra })),
  payment: { terms: 'credit', advance: 0 },
  status: 'submitted',
  idempotencyKey: key(),
  ...over,
});
const post = (b, client = T.client) => client.post('/orders', b);
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Order Create Org');
  other = await h.makeTenant('Order Create Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
});
after(async () => {
  await h?.stop();
});

describe('Suppliers', () => {
  it('adds a supplier with contact details and GST number, and lists it', async () => {
    const s = await supplier(T.client, { name: 'Sun Pharma Distributors' });
    assert.equal(s.contactPerson, 'Ramesh Gupta');
    assert.equal(s.addressLine, '12 Market Road, Pune, Maharashtra, 411001');
    assert.equal(s.isActive, true);
    const list = (await T.client.get('/suppliers')).data;
    assert.ok(list.items.some((x) => x._id === s._id));
    assert.equal((await T.client.get('/suppliers?search=sun pharma')).data.total, 1);
    assert.equal((await T.client.get('/suppliers?search=9811100022')).data.items.length >= 1, true, 'search by phone');
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).data.gstin, '27ABCDE1234F1Z5');
  });
  it('refuses duplicate names (any case), bad GST numbers, bad emails and empty names', async () => {
    await supplier(T.client, { name: 'Unique Traders' });
    const dup = await T.client.post('/suppliers', { name: 'unique traders', contactPerson: 'Ramesh Gupta', phone: '9811100022' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.details[0].path, 'name');
    assert.equal((await T.client.post('/suppliers', { name: 'X1', contactPerson: 'Ramesh Gupta', phone: '9811100022', gstin: '123' })).status, 400);
    assert.equal((await T.client.post('/suppliers', { name: 'X2', contactPerson: 'Ramesh Gupta', phone: '9811100022', email: 'not-an-email' })).status, 400);
    assert.equal((await T.client.post('/suppliers', { name: '  ', contactPerson: 'Ramesh Gupta', phone: '9811100022' })).status, 400);
    assert.equal((await T.client.post('/suppliers', { name: 'X3', contactPerson: 'Ramesh Gupta', phone: 'call me' })).status, 400);
  });
  it('are private to the organization, need a login, and only stock managers add them', async () => {
    const mine = await supplier(T.client);
    assert.equal((await other.client.get(`/suppliers/${mine._id}`)).status, 404);
    assert.ok(!(await other.client.get('/suppliers?limit=100')).data.items.some((x) => x._id === mine._id));
    assert.equal((await other.client.post('/suppliers', { name: mine.name, contactPerson: 'Ramesh Gupta', phone: '9811100022' })).status, 201, 'the same name in another organization is fine');
    assert.equal((await h.client().get('/suppliers')).status, 401);
    const staff = await asRole('STAFF');
    assert.equal((await staff.get('/suppliers')).status, 200);
    assert.equal((await staff.post('/suppliers', { name: 'Staff Added', contactPerson: 'Ramesh Gupta', phone: '9811100022' })).status, 403);
  });
});

describe('The form’s data', () => {
  it('previews the next order number and lists the payment choices', async () => {
    const m = (await T.client.get('/orders/meta')).data;
    assert.match(m.nextOrderNo, /^ORD-\d{4}$/);
    assert.deepEqual(m.paymentTerms.map((x) => x.label), ['Cash on Delivery', 'Advance Payment', 'Credit', 'Partial Payment']);
    assert.deepEqual(m.paymentStatuses.map((x) => x.label), ['Unpaid', 'Partially Paid', 'Paid']);
    assert.ok(m.paymentMethods.includes('Bank Transfer'));
    const s = await supplier();
    const med = await medicine();
    const first = await post(body(s, [[med, 1, 10]]));
    assert.equal(first.data.orderNo, m.nextOrderNo, 'the preview is the number the next order gets');
  });

  it('searches existing products with stock, unit, GST, last purchase price and batches', async () => {
    const med = await medicine(T.client, { medicineName: 'Searchable Dolo 650', sku: 'DOLO-650' });
    const b = await T.client.post('/batches', { medicineId: med._id, batchNumber: 'LOT-S1', expiryDate: futureDate(2), mrp: 120, sellingPrice: 100, purchasePrice: 62.5, initialQuantity: 40 });
    assert.equal(b.status, 201);
    const r = (await T.client.get('/orders/products?search=searchable dolo')).data;
    assert.equal(r.length, 1);
    const p = r[0];
    assert.deepEqual([p.name, p.sku, p.genericName, p.manufacturer, p.unit, p.currentStock, p.gstPercent, p.purchasePrice], ['Searchable Dolo 650', 'DOLO-650', 'Paracetamol', 'Cipla', 'Strip', 40, 12, 62.5]);
    assert.equal(p.batches[0].batchNumber, 'LOT-S1');
    assert.equal(p.batches[0].quantity, 40);
    assert.equal((await T.client.get('/orders/products?search=DOLO-650')).data.length, 1, 'by SKU');
    assert.equal((await T.client.get('/orders/products?search=LOT-S1')).data.length, 1, 'by batch number');
    assert.equal((await other.client.get('/orders/products?search=searchable')).data.length, 0, 'only this organization’s products');
    assert.equal((await T.client.get('/orders/products?limit=100')).status, 400);
  });
});

describe('Creating an order: the arithmetic', () => {
  it('computes line amounts, discount, GST, charges and the grand total — to the paisa', async () => {
    const s = await supplier();
    const a = await medicine();
    const b = await medicine();
    const r = await post(body(s, [[a, 10, 100, { discountPercent: 10, gstPercent: 12 }], [b, 5, 33.33, { gstPercent: 5 }]], {
      charges: { shipping: 50, packaging: 20, other: 10, gstPercent: 18, additionalDiscount: 25 },
      grandTotal: 1, subtotal: 1, // the client cannot choose the totals
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.data;
    assert.deepEqual(o.items.map((i) => [i.amount, i.discountAmount, i.gstAmount, i.total]), [[1000, 100, 108, 1008], [166.65, 0, 8.33, 174.98]]);
    assert.equal(o.subtotal, 1166.65);
    assert.equal(o.discountTotal, 100);
    assert.equal(o.gstTotal, 116.33);
    assert.equal(o.charges.gstAmount, 14.4, '18% of the 80 of charges');
    assert.equal(o.grandTotal, 1252.38, '1166.65 − 100 + 116.33 + 80 + 14.40 − 25');
    assert.deepEqual([o.totalItems, o.totalQuantity], [2, 15]);
  });

  it('free units cost nothing but are counted, and decimal GST rates work', async () => {
    const s = await supplier();
    const a = await medicine();
    const r = await post(body(s, [[a, 20, 12.5, { freeQuantity: 4, gstPercent: 2.5 }]]));
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.items[0].amount, r.data.items[0].gstAmount, r.data.items[0].total, r.data.grandTotal], [250, 6.25, 256.25, 256.25]);
    assert.deepEqual([r.data.totalQuantity, r.data.totalFreeQuantity, r.data.items[0].freeQuantity], [20, 4, 4]);
  });

  it('is exact where floating point would drift', async () => {
    const s = await supplier();
    const a = await medicine();
    const b = await medicine();
    const c = await medicine();
    const r = await post(body(s, [[a, 3, 0.1], [b, 3, 0.2], [c, 7, 19.99, { discountPercent: 3.5, gstPercent: 12 }]]));
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.items.map((i) => i.amount), [0.3, 0.6, 139.93]);
    assert.equal(r.data.subtotal, 140.83);
    assert.equal(r.data.items[2].discountAmount, 4.9);
    assert.equal(r.data.items[2].gstAmount, 16.2);
    assert.equal(r.data.grandTotal, Math.round((140.83 - 4.9 + 16.2) * 100) / 100);
  });

  it('stores the supplier, product and branch details as they were on the day', async () => {
    const s = await supplier(T.client, { name: 'Snapshot Supplies' });
    const a = await medicine(T.client, { medicineName: 'Snapshot Med', sku: 'SNAP-1' });
    const r = await post(body(s, [[a, 2, 10]], { referenceNo: 'QT-2026-77', notes: 'Deliver before noon', expectedDate: futureDate(0).slice(0, 10) }));
    const o = (await T.client.get(`/orders/${r.data._id}`)).data;
    assert.deepEqual([o.supplier.name, o.supplier.contactPerson, o.supplier.phone, o.supplier.email, o.supplier.gstin, o.supplier.address], ['Snapshot Supplies', 'Ramesh Gupta', '9811100022', 'sales@supplier.test', '27ABCDE1234F1Z5', '12 Market Road, Pune, Maharashtra, 411001']);
    assert.deepEqual([o.items[0].name, o.items[0].sku, o.items[0].genericName, o.items[0].manufacturer, o.items[0].unit], ['Snapshot Med', 'SNAP-1', 'Paracetamol', 'Cipla', 'Strip']);
    assert.equal(o.branchName, 'Main Store', 'defaults to the main store');
    assert.equal(o.referenceNo, 'QT-2026-77');
    assert.equal(o.notes, 'Deliver before noon');
    assert.equal(o.status, 'approved', 'submitted, and authorized straight away because approval is not required');
    assert.equal((await post(body(s, [[a, 1, 5]], { status: 'draft' }))).data.status, 'draft');
  });
});

describe('Validation', () => {
  it('refuses invalid quantities, negative prices, bad percentages and an empty order', async () => {
    const s = await supplier();
    const a = await medicine();
    const bad = async (item, path, re) => {
      const r = await post(body(s, [[a, ...item]]));
      assert.equal(r.status, 400, JSON.stringify(item));
      assert.ok(r.body.details.some((d) => d.path === path && re.test(d.message)), `${path}: ${JSON.stringify(r.body.details)}`);
    };
    await bad([0, 10], 'items.0.quantity', /at least 1/);
    await bad([-3, 10], 'items.0.quantity', /at least 1/);
    await bad([1.5, 10], 'items.0.quantity', /whole number/);
    await bad([1, -10], 'items.0.rate', /cannot be negative/);
    await bad([1, 10.123], 'items.0.rate', /2 decimal/);
    await bad([1, 10, { freeQuantity: -1 }], 'items.0.freeQuantity', /cannot be negative/);
    await bad([1, 10, { discountPercent: 101 }], 'items.0.discountPercent', /more than 100/);
    await bad([1, 10, { discountPercent: -1 }], 'items.0.discountPercent', /negative/);
    await bad([1, 10, { gstPercent: 120 }], 'items.0.gstPercent', /more than 100/);
    assert.equal((await post(body(s, []))).status, 400);
    assert.equal((await post({ ...body(s, [[a, 1, 1]]), charges: { shipping: -5 } })).status, 400);
  });

  it('only products of this organization, active, and each once', async () => {
    const s = await supplier();
    const a = await medicine();
    const theirs = await medicine(other.client);
    const foreign = await post(body(s, [[theirs, 1, 10]]));
    assert.equal(foreign.status, 400);
    assert.match(foreign.body.details[0].message, /not found/);
    const twice = await post(body(s, [[a, 1, 10], [a, 2, 10]]));
    assert.equal(twice.status, 400);
    assert.match(twice.body.details[0].message, /on the order twice/);
    await h.models.Medicine.collection.updateOne({ _id: new h.models.Medicine.base.Types.ObjectId(a._id) }, { $set: { isActive: false } });
    assert.match((await post(body(s, [[a, 1, 10]]))).body.details[0].message, /archived/);
  });

  it('needs a real, active supplier of this organization and a real, active store', async () => {
    const a = await medicine();
    const theirs = await supplier(other.client);
    assert.equal((await post(body(theirs, [[a, 1, 10]]))).status, 404);
    assert.equal((await post(body({ _id: 'nope' }, [[a, 1, 10]]))).status, 400);
    const mine = await supplier();
    await h.models.Supplier.collection.updateOne({ _id: new h.models.Supplier.base.Types.ObjectId(mine._id) }, { $set: { isActive: false } });
    assert.equal((await post(body(mine, [[a, 1, 10]]))).status, 409);
    const ok = await supplier();
    const north = (await T.client.post('/branches', { name: uniq('North'), code: uniq('N').toUpperCase().slice(0, 8) })).data;
    assert.equal((await post(body(ok, [[a, 1, 10]], { branchId: north._id }))).data.branchId, north._id);
    assert.equal((await post(body(ok, [[a, 1, 10]], { branchId: 'nope' }))).status, 400);
    const theirBranch = (await other.client.get('/branches')).data[0];
    assert.equal((await post(body(ok, [[a, 1, 10]], { branchId: theirBranch._id }))).status, 404, 'another organization’s store');
  });

  it('dates: the expected delivery cannot be before the order date', async () => {
    const s = await supplier();
    const a = await medicine();
    const r = await post(body(s, [[a, 1, 10]], { orderDate: '2026-11-10', expectedDate: '2026-11-09' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.details[0].path, 'expectedDate');
    assert.equal((await post(body(s, [[a, 1, 10]], { orderDate: '2026-11-10', expectedDate: '2026-11-10' }))).status, 201);
    assert.equal((await post(body(s, [[a, 1, 10]], { orderDate: '2026-02-30' }))).status, 400);
  });

  it('the additional discount can’t take the order below zero', async () => {
    const s = await supplier();
    const a = await medicine();
    const r = await post(body(s, [[a, 1, 100]], { charges: { additionalDiscount: 100.01 } }));
    assert.equal(r.status, 400);
    assert.equal(r.body.details[0].path, 'charges.additionalDiscount');
    assert.equal((await post(body(s, [[a, 1, 100]], { charges: { additionalDiscount: 100 } }))).data.grandTotal, 0);
  });
});

describe('Payment information: recorded, never made', () => {
  it('follows the terms: COD and credit have no advance, advance needs one, partial sits between', async () => {
    const s = await supplier();
    const a = await medicine();
    const lines = [[a, 10, 100]]; // total 1000
    const p = (payment) => post(body(s, lines, { payment }));
    for (const terms of ['cod', 'credit']) {
      assert.equal((await p({ terms, advance: 100, method: 'Cash' })).status, 400, `${terms} with an advance`);
      const ok = await p({ terms, advance: 0 });
      assert.equal(ok.status, 201);
      assert.deepEqual([ok.data.payment.status, ok.data.payment.advance, ok.data.payment.remaining], ['unpaid', 0, 1000]);
    }
    assert.equal((await p({ terms: 'advance', advance: 0 })).status, 400);
    const adv = await p({ terms: 'advance', advance: 1000, method: 'UPI' });
    assert.deepEqual([adv.status, adv.data.payment.status, adv.data.payment.remaining, adv.data.payment.method], [201, 'paid', 0, 'UPI']);
    assert.equal((await p({ terms: 'partial', advance: 0, method: 'Cash' })).status, 400);
    assert.equal((await p({ terms: 'partial', advance: 1000, method: 'Cash' })).status, 400);
    const part = await p({ terms: 'partial', advance: 400, method: 'Bank Transfer' });
    assert.deepEqual([part.status, part.data.payment.status, part.data.payment.remaining], [201, 'partially_paid', 600]);
    assert.equal((await p({ terms: 'partial', advance: 400 })).body.details[0].path, 'payment.method', 'say how it was paid');
    assert.equal((await p({ terms: 'advance', advance: 1000.01, method: 'Cash' })).body.details[0].path, 'payment.advance', 'not more than the total');
    assert.equal((await p({ terms: 'barter', advance: 0 })).status, 400);
    assert.equal((await p({ terms: 'advance', advance: 10, method: 'Crypto' })).status, 400);
    assert.equal((await p({ terms: 'advance', advance: -10, method: 'Cash' })).status, 400);
  });
  it('the payment status is worked out by the server, whatever the client says', async () => {
    const s = await supplier();
    const a = await medicine();
    const r = await post(body(s, [[a, 2, 50]], { payment: { terms: 'partial', advance: 30, method: 'Cash', status: 'paid', remaining: 0 } }));
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.payment.status, r.data.payment.remaining], ['partially_paid', 70]);
  });
});

describe('Safety', () => {
  it('the same idempotency key makes one order; separate orders get separate numbers, even at the same moment', async () => {
    const s = await supplier();
    const a = await medicine();
    const payload = body(s, [[a, 1, 10]]);
    const x = await post(payload);
    const y = await post(payload);
    assert.equal(x.status, 201);
    assert.equal(y.status, 200);
    assert.equal(y.data._id, x.data._id);
    const [p, q] = await Promise.all([post(body(s, [[a, 1, 10]])), post(body(s, [[a, 1, 10]]))]);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.notEqual(p.data.orderNo, q.data.orderNo);
  });
  it('is audited, listed and searchable by the supplier’s reference', async () => {
    const s = await supplier();
    const a = await medicine();
    const r = (await post(body(s, [[a, 4, 25]], { referenceNo: 'REF-ZX-9' }))).data;
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'ORDER_CREATE' && x.message.includes(r.orderNo)));
    const found = (await T.client.get('/orders?search=REF-ZX-9')).data.items;
    assert.equal(found.length, 1);
    assert.equal(found[0].orderNo, r.orderNo);
    assert.equal(found[0].grandTotal, 100);
  });
  it('needs a login and stock-management rights; organization and status come from the server', async () => {
    const s = await supplier();
    const a = await medicine();
    assert.equal((await h.client().post('/orders', body(s, [[a, 1, 10]]))).status, 401);
    const billing = await asRole('BILLING_STAFF');
    assert.equal((await post(body(s, [[a, 1, 10]]), billing)).status, 403);
    const inv = await asRole('INVENTORY_MANAGER');
    assert.equal((await post(body(s, [[a, 1, 10]]), inv)).status, 201);
    const r = await post({ ...body(s, [[a, 1, 10]]), organizationId: other.org._id, createdBy: other.user._id, orderNo: 'ORD-9999', receivedAt: new Date().toISOString() });
    assert.equal(r.status, 201);
    assert.equal(String(r.data.organizationId), String(T.org._id));
    assert.notEqual(r.data.orderNo, 'ORD-9999');
    assert.equal(r.data.receivedAt, undefined);
    assert.equal((await other.client.get(`/orders/${r.data._id}`)).status, 404);
  });
});
