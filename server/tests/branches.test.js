// Branch Management: the branch profile (address, contact, manager, GSTIN, opening date, notes) on top of the existing stores. What matters: the profile is
// checked in full whenever it is sent (address line 1 and PIN required; email, phone, PIN, GSTIN, date formats), codes and names stay unique per organization,
// the list can be paged / searched / filtered while the old plain list keeps working for the transfer, order and batch screens, the default branch is protected,
// and only people who may manage settings can change branches.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}${++n}`;
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const full = (over = {}) => ({
  name: uniq('Branch '), code: uniq('BR').toUpperCase(), phone: '9876543210', email: 'north@example.com', status: 'active', addressLine1: '12 Market Road', addressLine2: 'Near the temple', country: 'India', state: 'Maharashtra', city: 'Pune',
  pincode: '411001', landmark: 'Opposite the bus stand', managerName: 'Asha Verma', gstin: '27ABCDE1234F1Z5', openingDate: '2026-04-01', notes: 'Second store', ...over,
});
const code = (r) => r.body.code || r.body.error?.code;
const paths = (r) => (r.body.details || []).map((d) => d.path);

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Branch Org');
  other = await h.makeTenant('Branch Other Org');
});
after(() => h?.stop());

describe('Adding a branch', () => {
  it('saves the whole profile, builds the one-line address from its parts, and normalizes GSTIN, code and date', async () => {
    const r = await T.client.post('/branches', full({ code: 'pune-1', gstin: '27abcde1234f1z5' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.data;
    assert.deepEqual([b.code, b.gstin, b.status, b.isDefault, b.managerName, b.city, b.pincode, b.email], ['PUNE-1', '27ABCDE1234F1Z5', 'active', false, 'Asha Verma', 'Pune', '411001', 'north@example.com']);
    assert.equal(b.address, '12 Market Road, Near the temple, Opposite the bus stand, Pune, Maharashtra, 411001, India');
    assert.equal(new Date(b.openingDate).toISOString().slice(0, 10), '2026-04-01');
    assert.ok(b.createdAt && b.updatedAt);
  });

  it('defaults the country to India and accepts the minimum: name, code, address line 1 and PIN code', async () => {
    const r = await T.client.post('/branches', { name: uniq('Min '), code: uniq('MN'), addressLine1: '5 Lane', pincode: '560001' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.data.country, r.data.address, r.data.status], ['India', '5 Lane, 560001, India', 'active']);
  });

  it('requires address line 1 and PIN code once the profile is sent, with a message for each', async () => {
    const r = await T.client.post('/branches', { name: uniq('Bad '), code: uniq('BD'), addressLine1: '', pincode: '', city: 'Pune' });
    assert.equal(r.status, 400);
    assert.deepEqual(paths(r).sort(), ['addressLine1', 'pincode']);
    assert.match(r.body.details.find((d) => d.path === 'addressLine1').message, /Address line 1 is required/);
    assert.match(r.body.details.find((d) => d.path === 'pincode').message, /PIN code is required/);
    assert.equal((await T.client.post('/branches', { name: '', code: '', addressLine1: 'x', pincode: '411001' })).status, 400);
  });

  it('checks the format of email, phone, PIN code, GSTIN and opening date', async () => {
    const bad = async (over, field, msg) => {
      const r = await T.client.post('/branches', full(over));
      assert.equal(r.status, 400, field);
      assert.ok(paths(r).includes(field), `${field}: ${JSON.stringify(r.body.details)}`);
      assert.match(r.body.details.find((d) => d.path === field).message, msg);
    };
    await bad({ email: 'not-an-email' }, 'email', /valid email/);
    await bad({ phone: 'call me' }, 'phone', /valid phone/);
    await bad({ phone: '12345' }, 'phone', /7 to 15 digits/);
    await bad({ pincode: '41100' }, 'pincode', /6 digits/);
    await bad({ pincode: '011001' }, 'pincode', /6 digits/);
    await bad({ gstin: '27ABCDE1234' }, 'gstin', /valid format/);
    await bad({ openingDate: '2026-02-30' }, 'openingDate', /real date/);
    await bad({ code: 'has space' }, 'code', /letters, numbers/);
    const ok = await T.client.post('/branches', full({ phone: '+91 98765-43210', email: '', gstin: '', openingDate: '', landmark: '', managerName: '' }));
    assert.equal(ok.status, 201, 'optional values may be left empty');
    const abroad = await T.client.post('/branches', full({ country: 'Nepal', pincode: '44600' }));
    assert.equal(abroad.status, 201, 'a postal code outside India is not held to the Indian format');
  });

  it('prevents a duplicate code or name (in any letter case) with a message that says which', async () => {
    const a = (await T.client.post('/branches', full())).data;
    const sameCode = await T.client.post('/branches', full({ code: a.code.toLowerCase() }));
    assert.equal(sameCode.status, 409);
    assert.equal(sameCode.body.message, 'A branch with this code already exists');
    assert.deepEqual(paths(sameCode), ['code']);
    const sameName = await T.client.post('/branches', full({ name: a.name.toUpperCase() }));
    assert.equal(sameName.status, 409);
    assert.equal(sameName.body.message, 'A branch with this name already exists');
    assert.equal((await other.client.post('/branches', full({ name: a.name, code: a.code }))).status, 201, 'another organization may use the same');
  });

  it('still accepts the older small shape (name and code only), as transfers and orders use it', async () => {
    const r = await T.client.post('/branches', { name: uniq('Quick '), code: uniq('QK') });
    assert.equal(r.status, 201);
    assert.deepEqual([r.data.addressLine1, r.data.address, r.data.status], ['', '', 'active']);
  });
});

describe('The list', () => {
  it('is the plain array of every branch when no paging is asked for, so older screens keep working', async () => {
    const r = await T.client.get('/branches');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data));
    assert.ok(r.data.length >= 4);
    assert.equal(r.data[0].isDefault, true, 'the default branch is first');
    assert.ok('batchCount' in r.data[0] && 'unitsOnHand' in r.data[0] && 'openTransfers' in r.data[0]);
  });

  it('is a page with its total when asked: paging, search by name or code, and a status filter', async () => {
    const t = await h.makeTenant('Paging Org');
    for (let i = 1; i <= 7; i += 1) assert.equal((await t.client.post('/branches', full({ name: `Zone ${i}`, code: `Z${i}` }))).status, 201);
    await t.client.post('/branches', full({ name: 'Harbour Store', code: 'HRB', status: 'inactive' }));
    const first = (await t.client.get('/branches?page=1&limit=5')).data;
    assert.deepEqual([first.items.length, first.page, first.limit, first.total, first.pages], [5, 1, 5, 9, 2], 'Main Store + 8 new');
    assert.equal(first.items[0].isDefault, true);
    const second = (await t.client.get('/branches?page=2&limit=5')).data;
    assert.equal(second.items.length, 4);
    assert.equal((await t.client.get('/branches?search=zone%203')).data.items[0].name, 'Zone 3');
    assert.equal((await t.client.get('/branches?search=hrb')).data.items[0].name, 'Harbour Store', 'the code is searched too');
    assert.equal((await t.client.get('/branches?search=.*')).data.total, 0, 'text, not a pattern');
    assert.deepEqual((await t.client.get('/branches?status=inactive')).data.items.map((b) => b.name), ['Harbour Store']);
    assert.equal((await t.client.get('/branches?status=active&limit=100')).data.total, 8);
    assert.equal((await t.client.get('/branches?status=')).data.total, 9, 'an empty filter means no filter');
    assert.equal((await t.client.get('/branches?status=weird')).status, 400);
    assert.equal((await t.client.get('/branches?limit=1000')).status, 400);
    assert.equal((await t.client.get('/branches?search=nothing-like-this')).data.total, 0);
  });

  it('shows only this organization’s branches, to people who can read inventory', async () => {
    const mine = (await T.client.get('/branches?limit=100')).data.items;
    const theirs = (await other.client.get('/branches?limit=100')).data.items;
    assert.ok(mine.every((b) => String(b.organizationId) === String(T.org._id)));
    assert.ok(theirs.every((b) => String(b.organizationId) === String(other.org._id)));
    assert.equal((await h.client().get('/branches')).status, 401);
    assert.equal((await (await asRole('STAFF')).get('/branches?limit=5')).status, 200);
  });

  it('gives one branch by id, with its figures, and 404 for another organization’s', async () => {
    const b = (await T.client.post('/branches', full())).data;
    const r = await T.client.get(`/branches/${b._id}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.name, r.data.managerName, r.data.batchCount], [b.name, 'Asha Verma', 0]);
    assert.equal((await other.client.get(`/branches/${b._id}`)).status, 404);
    assert.equal((await T.client.get('/branches/nope')).status, 404);
  });
});

describe('Editing, activating and deleting', () => {
  it('edits the profile (the same checks apply), rebuilds the address and keeps the code unique', async () => {
    const a = (await T.client.post('/branches', full())).data;
    const b = (await T.client.post('/branches', full())).data;
    const r = await T.client.put(`/branches/${a._id}`, full({ name: a.name, code: a.code, city: 'Mumbai', pincode: '400001', managerName: 'Ravi Kumar' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.data.city, r.data.managerName], ['Mumbai', 'Ravi Kumar']);
    assert.match(r.data.address, /Mumbai, Maharashtra, 400001, India$/);
    assert.ok(new Date(r.data.updatedAt) >= new Date(a.updatedAt));
    assert.equal((await T.client.put(`/branches/${a._id}`, full({ name: a.name, code: a.code, pincode: '1' }))).status, 400);
    assert.equal((await T.client.put(`/branches/${a._id}`, full({ name: a.name, code: a.code, addressLine1: '' }))).status, 400, 'line 1 cannot be emptied');
    const clash = await T.client.put(`/branches/${a._id}`, { code: b.code });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.message, 'A branch with this code already exists');
    assert.equal((await T.client.put(`/branches/${a._id}`, {})).status, 400);
    assert.equal((await T.client.put(`/branches/${a._id}`, { status: 'inactive' })).status, 200, 'a status change on its own needs no profile');
  });

  it('completes an older quick-made branch when it is edited through the profile', async () => {
    const q = (await T.client.post('/branches', { name: uniq('Old '), code: uniq('OL') })).data;
    assert.equal((await T.client.put(`/branches/${q._id}`, { name: q.name, code: q.code, addressLine1: '', pincode: '' })).status, 400);
    const r = await T.client.put(`/branches/${q._id}`, { name: q.name, code: q.code, addressLine1: '9 New Road', pincode: '110001', city: 'Delhi' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.address, '9 New Road, Delhi, 110001, India');
  });

  it('activates and deactivates, protects the default branch, and refuses to deactivate one with open transfers', async () => {
    const b = (await T.client.post('/branches', full())).data;
    assert.equal((await T.client.put(`/branches/${b._id}`, { status: 'inactive' })).data.status, 'inactive');
    assert.equal((await T.client.put(`/branches/${b._id}`, { status: 'active' })).data.status, 'active');
    const main = (await T.client.get('/branches')).data.find((x) => x.isDefault);
    const r = await T.client.put(`/branches/${main._id}`, { status: 'inactive' });
    assert.equal(r.status, 409);
    assert.equal(code(r), 'DEFAULT_BRANCH');
  });

  it('deletes an unused branch only; the default one and any with stock or transfers are kept', async () => {
    const unused = (await T.client.post('/branches', full())).data;
    assert.equal((await T.client.del(`/branches/${unused._id}`)).status, 200);
    assert.equal((await T.client.get(`/branches/${unused._id}`)).status, 404);
    const main = (await T.client.get('/branches')).data.find((x) => x.isDefault);
    const r = await T.client.del(`/branches/${main._id}`);
    assert.equal(r.status, 409);
    assert.equal(code(r), 'DEFAULT_BRANCH');
    const used = (await T.client.post('/branches', full())).data;
    await h.models.Batch.collection.insertOne({ organizationId: T.org._id, medicineId: main._id, branchId: new (await import('mongoose')).default.Types.ObjectId(used._id), batchNumber: 'X', availableQuantity: 5, initialQuantity: 5, status: 'active', createdAt: new Date(), updatedAt: new Date() });
    const kept = await T.client.del(`/branches/${used._id}`);
    assert.equal(kept.status, 409);
    assert.equal(code(kept), 'IN_USE');
    assert.equal((await T.client.get(`/branches/${used._id}`)).status, 200, 'still there');
  });

  it('is for people who may manage settings; everyone else can only look', async () => {
    const b = (await T.client.post('/branches', full())).data;
    for (const role of ['STAFF', 'INVENTORY_MANAGER', 'BILLING_STAFF']) {
      const c = await asRole(role);
      assert.equal((await c.post('/branches', full())).status, 403, role);
      assert.equal((await c.put(`/branches/${b._id}`, { status: 'inactive' })).status, 403, role);
      assert.equal((await c.del(`/branches/${b._id}`)).status, 403, role);
      assert.equal((await c.get('/branches?limit=5')).status, 200, role);
    }
    const c = h.client();
    assert.equal((await c.post('/branches', full())).status, 401);
    assert.equal((await other.client.put(`/branches/${b._id}`, { status: 'inactive' })).status, 404, 'another organization cannot touch it');
    assert.equal((await other.client.del(`/branches/${b._id}`)).status, 404);
  });
});

describe('Deleting safely, and inactive branches', () => {
  const mongoose = () => import('mongoose').then((m) => m.default);
  const med = async () => {
    const now = new Date();
    const r = await h.models.Medicine.collection.insertOne({ organizationId: T.org._id, medicineName: uniq('Med '), unit: 'Strip', gstPercentage: 12, isActive: true, attributes: [], barcode: '', sku: '', createdAt: now, updatedAt: now });
    return String(r.insertedId);
  };
  const supplier = async () => (await T.client.post('/suppliers', { name: uniq('Supplier '), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data._id;
  const orderBody = (supplierId, medicineId, branchId) => ({ supplierId, branchId, status: 'draft', orderDate: '2026-11-01', items: [{ medicineId, quantity: 10, rate: 10, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });

  it('keeps a branch that has purchase orders, says why, and recommends deactivating; nothing related is deleted', async () => {
    const b = (await T.client.post('/branches', full())).data;
    const order = await T.client.post('/orders', orderBody(await supplier(), await med(), b._id));
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const r = await T.client.del(`/branches/${b._id}`);
    assert.equal(r.status, 409);
    assert.equal(code(r), 'IN_USE');
    assert.match(r.body.message, /purchase orders or goods receipts/);
    assert.match(r.body.message, /Deactivate it instead/);
    assert.equal((await T.client.get(`/orders/${order.data._id}`)).status, 200, 'the order is untouched');
    assert.equal((await T.client.get(`/branches/${b._id}`)).status, 200);
  });

  it('keeps a branch with stock, stock history, staff, goods receipts or transfers — each named in the message', async () => {
    const M = await (await mongoose()).Types.ObjectId;
    const mk = async () => (await T.client.post('/branches', full())).data;
    const refuse = async (b, what) => {
      const r = await T.client.del(`/branches/${b._id}`);
      assert.equal(r.status, 409, what);
      assert.equal(code(r), 'IN_USE');
      assert.ok(r.body.message.includes(what), `${what}: ${r.body.message}`);
      assert.equal((await T.client.get(`/branches/${b._id}`)).status, 200, 'still there');
    };
    const now = new Date();
    const stock = await mk();
    await h.models.StockMovement.collection.insertOne({ organizationId: T.org._id, medicineId: new M(), batchId: new M(), type: 'ADJUSTMENT', quantity: 1, branchId: new M(stock._id), createdAt: now });
    await refuse(stock, 'stock or stock history');
    const staff = await mk();
    await h.makeUser(T.org, { role: 'INVENTORY_MANAGER', branchIds: [staff._id] });
    await refuse(staff, 'staff assigned to it');
    const grn = await mk();
    await h.models.GoodsReceiptDraft.collection.insertOne({ organizationId: T.org._id, branchId: new M(grn._id), status: 'draft', createdAt: now });
    await refuse(grn, 'purchase orders or goods receipts');
    const tr = await mk();
    await h.models.Transfer.collection.insertOne({ organizationId: T.org._id, fromBranchId: new M(tr._id), toBranchId: new M(), status: 'draft', createdAt: now });
    await refuse(tr, 'transfers');
    const many = await mk();
    await h.models.Order.collection.insertOne({ organizationId: T.org._id, branchId: new M(many._id), status: 'draft', createdAt: now });
    await h.models.Batch.collection.insertOne({ organizationId: T.org._id, branchId: new M(many._id), createdAt: now });
    const r = await T.client.del(`/branches/${many._id}`);
    assert.match(r.body.message, /stock or stock history, purchase orders or goods receipts/, 'every reason is listed');
  });

  it('refuses an inactive branch for new orders, stock batches and transfers — and keeps its history readable', async () => {
    const b = (await T.client.post('/branches', full())).data;
    const sup = await supplier();
    const m = await med();
    const placed = await T.client.post('/orders', orderBody(sup, m, b._id));
    assert.equal(placed.status, 201);
    assert.equal((await T.client.put(`/branches/${b._id}`, { status: 'inactive' })).status, 200);
    const order = await T.client.post('/orders', orderBody(sup, m, b._id));
    assert.equal(order.status, 409);
    assert.equal(code(order), 'BRANCH_INACTIVE');
    assert.match(order.body.message, /is inactive/);
    const main = (await T.client.get('/branches')).data.find((x) => x.isDefault);
    const transfer = await T.client.post('/transfers', { fromBranchId: main._id, toBranchId: b._id, items: [{ medicineId: m, quantity: 1 }] });
    assert.ok([400, 409, 422].includes(transfer.status), `transfer to an inactive branch: ${transfer.status}`);
    assert.equal((await T.client.get(`/orders/${placed.data._id}`)).status, 200, 'its earlier order is still there');
    assert.equal((await T.client.get(`/branches/${b._id}`)).data.status, 'inactive');
    assert.equal((await T.client.get('/branches?status=inactive&search=' + encodeURIComponent(b.name))).data.total, 1);
    assert.equal((await T.client.put(`/branches/${b._id}`, { status: 'active' })).data.status, 'active');
    assert.equal((await T.client.post('/orders', orderBody(sup, m, b._id))).status, 201, 'usable again once activated');
  });

  it('does not receive goods into a branch that was deactivated after the order was placed', async () => {
    const b = (await T.client.post('/branches', full())).data;
    const m = await med();
    const o = (await T.client.post('/orders', orderBody(await supplier(), m, b._id))).data;
    await T.client.post(`/orders/${o._id}/submit`);
    await T.client.post(`/orders/${o._id}/order`);
    await T.client.put(`/branches/${b._id}`, { status: 'inactive' });
    const r = await T.client.post(`/orders/${o._id}/receive`, { items: [{ medicineId: m, quantity: 10, batchNumber: 'IB-1', expiryDate: '2030-01-31', mrp: 30, sellingPrice: 28 }] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(code(r), 'BRANCH_INACTIVE');
    assert.equal(await h.models.Batch.collection.countDocuments({ batchNumber: 'IB-1' }), 0, 'no stock was added');
    await T.client.put(`/branches/${b._id}`, { status: 'active' });
    assert.equal((await T.client.post(`/orders/${o._id}/receive`, { items: [{ medicineId: m, quantity: 10, batchNumber: 'IB-1', expiryDate: '2030-01-31', mrp: 30, sellingPrice: 28 }] })).status, 201);
  });

  it('an unused branch is deleted and the deletion is recorded in the audit log', async () => {
    const b = (await T.client.post('/branches', full())).data;
    assert.equal((await T.client.del(`/branches/${b._id}`)).status, 200);
    assert.equal(await h.models.AuditLog.collection.countDocuments({ action: 'BRANCH_DELETE', message: new RegExp(b.name) }), 1);
    assert.equal((await T.client.del(`/branches/${b._id}`)).status, 404);
  });
});

describe('Working with the rest of the system', () => {
  it('shows what connects to a branch — stock, transfers, purchase orders, staff — and editing it moves nothing', async () => {
    const M = (await import('mongoose')).default.Types.ObjectId;
    const b = (await T.client.post('/branches', full())).data;
    const now = new Date();
    const batch = await h.models.Batch.collection.insertOne({ organizationId: T.org._id, medicineId: new M(), branchId: new M(b._id), batchNumber: 'KEEP-1', availableQuantity: 40, initialQuantity: 40, status: 'active', createdAt: now, updatedAt: now });
    const move = await h.models.StockMovement.collection.insertOne({ organizationId: T.org._id, medicineId: new M(), batchId: batch.insertedId, type: 'PURCHASE', quantity: 40, balanceAfter: 40, branchId: new M(b._id), createdAt: now });
    const sup = (await T.client.post('/suppliers', { name: uniq('Sup '), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data._id;
    const medicine = (await h.models.Medicine.collection.insertOne({ organizationId: T.org._id, medicineName: uniq('M '), unit: 'Strip', gstPercentage: 12, isActive: true, attributes: [], barcode: '', sku: '', createdAt: now, updatedAt: now })).insertedId;
    const order = await T.client.post('/orders', { supplierId: sup, branchId: b._id, status: 'draft', orderDate: '2026-11-01', items: [{ medicineId: String(medicine), quantity: 5, rate: 10, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    assert.equal(order.status, 201);
    await h.makeUser(T.org, { role: 'INVENTORY_MANAGER', branchIds: [b._id] });
    const before = (await T.client.get(`/branches/${b._id}`)).data;
    assert.deepEqual([before.batchCount, before.unitsOnHand, before.orderCount, before.staffCount, before.openTransfers], [1, 40, 1, 1, 0]);

    // editing the branch changes the branch only
    const edited = await T.client.put(`/branches/${b._id}`, full({ name: `${b.name} (renamed)`, code: `${b.code}X`, city: 'Nashik', pincode: '422001', managerName: 'Someone Else' }));
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const after = (await T.client.get(`/branches/${b._id}`)).data;
    assert.deepEqual([after.batchCount, after.unitsOnHand, after.orderCount, after.staffCount], [1, 40, 1, 1], 'the same stock, orders and staff');
    const kept = await h.models.Batch.collection.findOne({ _id: batch.insertedId });
    assert.deepEqual([String(kept.branchId), kept.availableQuantity, kept.batchNumber], [b._id, 40, 'KEEP-1']);
    assert.equal(await h.models.StockMovement.collection.countDocuments({ _id: move.insertedId, branchId: new M(b._id) }), 1, 'the ledger still points at the branch');
    assert.equal(String((await h.models.Order.collection.findOne({ _id: new M(order.data._id) })).branchId), b._id);
    assert.equal(await h.models.StockMovement.collection.countDocuments({ organizationId: T.org._id, createdAt: { $gt: now } }), 0, 'editing posts no stock entry');
  });

  it('stock stays separate per branch: a batch in one branch is not counted in another', async () => {
    const M = (await import('mongoose')).default.Types.ObjectId;
    const a = (await T.client.post('/branches', full())).data;
    const c = (await T.client.post('/branches', full())).data;
    const now = new Date();
    await h.models.Batch.collection.insertOne({ organizationId: T.org._id, medicineId: new M(), branchId: new M(a._id), batchNumber: 'A-ONLY', availableQuantity: 12, initialQuantity: 12, status: 'active', createdAt: now, updatedAt: now });
    assert.deepEqual([(await T.client.get(`/branches/${a._id}`)).data.unitsOnHand, (await T.client.get(`/branches/${c._id}`)).data.unitsOnHand], [12, 0]);
  });
});

describe('Who did what, and what a request cannot change', () => {
  it('records who created and last updated a branch, and keeps an audit trail', async () => {
    const admin = await asRole('ORG_ADMIN');
    const b = (await admin.post('/branches', full())).data;
    assert.ok(b.createdByName && b.updatedByName);
    assert.equal(b.createdByName, b.updatedByName);
    const mgr = await asRole('BRANCH_MANAGER'); // may not manage settings
    assert.equal((await mgr.put(`/branches/${b._id}`, { notes: 'x' })).status, 403);
    const second = await asRole('ORG_ADMIN');
    const u = (await second.put(`/branches/${b._id}`, { managerName: 'New Manager' })).data;
    assert.equal(u.createdByName, b.createdByName, 'the creator stays');
    assert.notEqual(u.updatedByName, b.createdByName);
    const log = await h.models.AuditLog.collection.find({ message: new RegExp(b.name) }).toArray();
    assert.ok(log.some((l) => l.action === 'BRANCH_CREATE') && log.some((l) => l.action === 'BRANCH_UPDATE'));
    assert.ok(log.every((l) => l.userId && l.userName));
  });

  it('ignores fields a request must not set: the default flag, another organization, who created it', async () => {
    const r = await T.client.post('/branches', full({ isDefault: true, organizationId: String(other.org._id), createdByName: 'Someone Else', _id: '000000000000000000000001' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.isDefault, false);
    assert.equal(String(r.data.organizationId), String(T.org._id));
    assert.notEqual(r.data.createdByName, 'Someone Else');
    assert.notEqual(r.data._id, '000000000000000000000001');
    const u = await T.client.put(`/branches/${r.data._id}`, { isDefault: true, organizationId: String(other.org._id), status: 'inactive' });
    assert.equal(u.status, 200);
    assert.deepEqual([u.data.isDefault, String(u.data.organizationId)], [false, String(T.org._id)]);
    assert.equal((await T.client.get('/branches')).data.filter((x) => x.isDefault).length, 1, 'still exactly one default branch');
  });

  it('shows text as text: markup in a name is stored and returned as plain text, never executed or altered by the search', async () => {
    const r = await T.client.post('/branches', full({ name: '<img src=x onerror=alert(1)> Store', notes: '<script>alert(1)</script>' }));
    assert.equal(r.status, 201);
    assert.equal(r.data.name, '<img src=x onerror=alert(1)> Store');
    assert.equal((await T.client.get('/branches?search=' + encodeURIComponent('<img'))).data.total, 1);
    assert.match(r.headers?.['content-type'] || 'application/json', /json/);
  });

  it('does not reveal internals in errors', async () => {
    const r = await T.client.get('/branches/not-an-id');
    assert.equal(r.status, 404);
    assert.ok(!/mongo|stack|at \w+ \(|node_modules/i.test(JSON.stringify(r.body)));
    const dup = await T.client.post('/branches', full({ code: (await T.client.get('/branches')).data[0].code }));
    assert.equal(dup.status, 409);
    assert.ok(!/E11000|index|collection|mongo/i.test(JSON.stringify(dup.body)));
  });
});
