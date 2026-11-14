// Inventory rules: medicines, compounds, attributes, batches, the immutable stock ledger,
// never-negative stock, expiry handling, calculated stock and audit trails.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMedicine, futureDate, startHarness } from './helpers/harness.js';

let h;
let M;
let T; // main tenant { org, user, client }
let other; // a second tenant

const day = 86400000;
const dateIn = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);
let n = 0;
const uniq = (p) => `${p}-${++n}-${Date.now().toString(36)}`;

const batchBody = (over = {}) => ({ batchNumber: uniq('B'), expiryDate: futureDate(), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: 10, ...over });
const newMed = async (client = T.client, over = {}) => {
  const r = await client.post('/medicines', { medicineName: uniq('Med'), ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const addBatch = (id, over, client = T.client) => client.post(`/medicines/${id}/batches`, batchBody(over));
const detail = async (id, client = T.client) => (await client.get(`/medicines/${id}`)).data;
const stockOf = async (id, client = T.client) => (await detail(id, client)).batches.reduce((s, b) => s + b.availableQuantity, 0);
const sell = (client, medicineId, quantity, extra = {}) => client.post('/invoices', { items: [{ medicineId, quantity }], ...extra });

/** Inserts a batch (and its receipt ledger entry) directly, e.g. one that is ALREADY expired — the API refuses to receive those. */
const seedBatch = async (org, medicineId, { batchNumber, expiryDate, qty, status = 'active' }) =>
  h.tenant.runWithTenant(org._id, async () => {
    const b = await M.Batch.create({ medicineId, batchNumber, expiryDate, mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty, status });
    await M.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty, refType: 'Batch', refId: b._id });
    return b;
  });

before(async () => {
  h = await startHarness();
  M = h.models;
  T = await h.makeTenant('Inventory Org');
  other = await h.makeTenant('Other Inventory Org');
});

after(async () => {
  await h?.stop();
});

describe('Medicine model', () => {
  it('stores every specified field', async () => {
    const r = await T.client.post('/medicines', {
      medicineName: 'Dolo 650',
      genericName: 'Paracetamol',
      salt: 'Paracetamol 650 mg',
      manufacturer: 'Micro Labs',
      categoryName: 'Tablets',
      dosageForm: 'Tablet',
      strength: '650 mg',
      packSize: '15 tablets',
      unit: 'Strip',
      hsnCode: '30049099',
      gstPercentage: 12,
      barcode: '8901234567890',
      sku: 'DOLO-650',
      reorderLevel: 20,
      description: 'Pain and fever relief',
      image: 'https://cdn.example/dolo.png',
      isActive: true,
    });
    assert.equal(r.status, 201);
    const m = r.data;
    for (const k of ['medicineName', 'genericName', 'salt', 'manufacturer', 'categoryId', 'dosageForm', 'strength', 'packSize', 'unit', 'hsnCode', 'gstPercentage', 'barcode', 'sku', 'reorderLevel', 'description', 'image', 'isActive', 'createdAt', 'updatedAt', 'organizationId']) {
      assert.ok(k in m, `missing ${k}`);
    }
    assert.equal(m.organizationId, String(T.org._id));
    assert.equal(m.gstPercentage, 12);
    assert.equal((await detail(m._id)).categoryName, 'Tablets');
  });

  it('categories are Attribute records; the same name (any case) reuses one record', async () => {
    const a = await newMed(T.client, { categoryName: 'Syrups Cat' });
    const b = await newMed(T.client, { categoryName: 'syrups cat' });
    assert.equal(a.categoryId, b.categoryId);
    const list = (await T.client.get('/attributes?type=category&search=Syrups Cat')).data.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].attributeType, 'category');
  });

  it("a categoryId from another organization is rejected", async () => {
    const foreign = (await other.client.post('/attributes', { attributeName: 'Foreign cat', attributeType: 'category' })).data;
    const r = await T.client.post('/medicines', { medicineName: uniq('X'), categoryId: foreign._id });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'UNKNOWN_CATEGORY');
  });

  it('compounds are found-or-created by name and linked with compoundId', async () => {
    const m = await newMed(T.client, { compoundName: 'Amoxicillin 500' });
    assert.ok(m.compoundId);
    assert.equal((await detail(m._id)).compoundName, 'Amoxicillin 500');
    await newMed(T.client, { compoundName: 'amoxicillin 500' });
    assert.equal((await T.client.get('/compounds?search=Amoxicillin 500')).data.items.length, 1);
  });

  it('a barcode and a SKU identify one medicine per organization', async () => {
    const barcode = uniq('BC');
    const sku = uniq('SKU');
    await newMed(T.client, { barcode, sku });
    const dupBarcode = await T.client.post('/medicines', { medicineName: uniq('A'), barcode });
    assert.equal(dupBarcode.status, 409);
    assert.equal(dupBarcode.body.code, 'DUPLICATE_BARCODE');
    const dupSku = await T.client.post('/medicines', { medicineName: uniq('B'), sku });
    assert.equal(dupSku.body.code, 'DUPLICATE_SKU');
    // other organizations may use the same codes, and "no barcode" is never a duplicate
    assert.equal((await other.client.post('/medicines', { medicineName: uniq('C'), barcode, sku })).status, 201);
    assert.equal((await newMed(T.client, { barcode: '' })).barcode, '');
    assert.equal((await newMed(T.client, { barcode: '' })).barcode, '');
  });

  it('validates input', async () => {
    const bad = async (body) => (await T.client.post('/medicines', { medicineName: uniq('V'), ...body })).status;
    assert.equal(await bad({ medicineName: '' }), 400);
    assert.equal(await bad({ gstPercentage: 101 }), 400);
    assert.equal(await bad({ reorderLevel: -1 }), 400);
    assert.equal(await bad({ image: 'javascript:alert(1)' }), 400);
  });

  it('a discontinued medicine (isActive=false) cannot be sold or restocked, and can be reactivated', async () => {
    const m = await newMed();
    await addBatch(m._id, {});
    assert.equal((await T.client.put(`/medicines/${m._id}`, { medicineName: m.medicineName, isActive: false })).status, 200);
    const s = await sell(T.client, m._id, 1);
    assert.equal(s.status, 409);
    assert.equal((await addBatch(m._id, {})).body.code, 'MEDICINE_INACTIVE');
    assert.ok(!(await T.client.get('/pos/products')).data.some((p) => p._id === m._id));
    assert.equal((await T.client.put(`/medicines/${m._id}`, { medicineName: m.medicineName, isActive: true })).status, 200);
    assert.equal((await sell(T.client, m._id, 1)).status, 201);
  });

  it('DELETE is a soft delete: a medicine with history is archived (and kept), one that never had any is removed', async () => {
    const clean = await newMed();
    const gone = await T.client.del(`/medicines/${clean._id}`);
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.data, { deleted: true, archived: false });
    assert.equal((await T.client.get(`/medicines/${clean._id}`)).status, 404);

    const stocked = await newMed();
    await addBatch(stocked._id, {});
    const archived = await T.client.del(`/medicines/${stocked._id}`);
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.data, { deleted: false, archived: true });
    const kept = await detail(stocked._id);
    assert.equal(kept.isActive, false);
    assert.equal(kept.batches.length, 1, 'it and its batches are still there');
    assert.ok(kept.archivedAt, 'with the time it was archived');
  });
});

describe('Batches', () => {
  it('a medicine can have many batches with different expiry dates and prices', async () => {
    const m = await newMed();
    const a = await addBatch(m._id, { batchNumber: 'LATE', expiryDate: dateIn(900), mrp: 120, sellingPrice: 110, purchasePrice: 80, initialQuantity: 30 });
    const b = await addBatch(m._id, { batchNumber: 'EARLY', expiryDate: dateIn(200), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: 5 });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const list = (await T.client.get(`/medicines/${m._id}/batches`)).data;
    assert.deepEqual(list.map((x) => x.batchNumber), ['EARLY', 'LATE'], 'listed by expiry, earliest first');
    assert.deepEqual(list.map((x) => x.sellingPrice), [90, 110]);
  });

  it('a new batch starts fully in stock, unreserved, active, and is recorded in the ledger', async () => {
    const m = await newMed();
    const store = (await T.client.post('/branches', { name: 'Ledger Test Store', code: 'LTS' })).data; // a store must be a real one of this organization
    const b = (await addBatch(m._id, { initialQuantity: 25, branchId: store._id, supplierId: String(new h.mongoose.Types.ObjectId()) })).data;
    assert.equal(b.initialQuantity, 25);
    assert.equal(b.availableQuantity, 25);
    assert.equal(b.reservedQuantity, 0);
    assert.equal(b.status, 'active');
    assert.equal(String(b.branchId), String(store._id));
    assert.ok(b.supplierId);
    const fake = await addBatch(m._id, { initialQuantity: 1, batchNumber: 'FAKE-STORE', branchId: String(new h.mongoose.Types.ObjectId()) });
    assert.equal(fake.status, 404, 'an unknown store id is refused, not stored');
    const ledger = (await T.client.get(`/stock/movements?batchId=${b._id}`)).data.items;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].type, 'PURCHASE');
    assert.equal(ledger[0].quantity, 25);
    assert.equal(ledger[0].balanceAfter, 25);
  });

  it('batch numbers are unique per medicine but can repeat across medicines', async () => {
    const m1 = await newMed();
    const m2 = await newMed();
    assert.equal((await addBatch(m1._id, { batchNumber: 'SAME' })).status, 201);
    const dup = await addBatch(m1._id, { batchNumber: 'SAME' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'DUPLICATE_BATCH');
    assert.equal((await addBatch(m2._id, { batchNumber: 'SAME' })).status, 201);
    assert.equal((await detail(m1._id)).batches.length, 1, 'the failed duplicate left no batch or stock behind');
  });

  it('validates batch input (expiry, prices, dates, quantity)', async () => {
    const m = await newMed();
    const bad = async (over) => (await addBatch(m._id, over)).status;
    assert.equal(await bad({ expiryDate: dateIn(-1) }), 400, 'cannot receive expired stock');
    assert.equal(await bad({ sellingPrice: 150, mrp: 100 }), 400, 'selling price cannot exceed MRP');
    assert.equal(await bad({ manufacturingDate: dateIn(400), expiryDate: dateIn(300) }), 400, 'manufactured after it expires');
    assert.equal(await bad({ manufacturingDate: dateIn(30) }), 400, 'manufacturing date in the future');
    assert.equal(await bad({ initialQuantity: 0 }), 400);
    assert.equal(await bad({ initialQuantity: 2.5 }), 400);
    assert.equal(await bad({ batchNumber: '' }), 400);
    assert.equal(await bad({ purchasePrice: -1 }), 400);
    assert.equal((await addBatch(m._id, { manufacturingDate: dateIn(-60), manufacturer: 'Lot Maker' })).status, 201);
  });

  it('sales take the earliest-expiring batch first (FEFO) and invoices record that batch and price', async () => {
    const m = await newMed();
    await addBatch(m._id, { batchNumber: 'LATE', expiryDate: dateIn(900), mrp: 120, sellingPrice: 110, initialQuantity: 10 });
    await addBatch(m._id, { batchNumber: 'EARLY', expiryDate: dateIn(100), mrp: 100, sellingPrice: 90, initialQuantity: 3 });
    const inv = (await sell(T.client, m._id, 5)).data;
    assert.deepEqual(inv.items.map((i) => [i.batchNo, i.quantity, i.price]), [['EARLY', 3, 90], ['LATE', 2, 110]]);
    const batches = (await detail(m._id)).batches;
    assert.deepEqual(batches.map((b) => [b.batchNumber, b.availableQuantity]), [['EARLY', 0], ['LATE', 8]]);
  });

  it('historical information is preserved: old invoices keep their snapshot when a batch price changes', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { sellingPrice: 90, initialQuantity: 10 })).data;
    const inv = (await sell(T.client, m._id, 1)).data;
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { sellingPrice: 95 })).status, 200);
    const again = (await T.client.get(`/invoices/${inv._id}`)).data;
    assert.equal(again.items[0].price, 90);
    assert.equal(again.items[0].name, m.medicineName);
    assert.equal(again.items[0].batchNo, b.batchNumber);
  });

  it('identity fields can never be changed after receipt', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { batchNumber: 'FIXED', initialQuantity: 10 })).data;
    // the API ignores them…
    await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { sellingPrice: 80, batchNumber: 'CHANGED', expiryDate: '2099-01-01', initialQuantity: 999, availableQuantity: 999 });
    // …and so does the model, even if code tries
    await h.tenant.runWithTenant(T.org._id, () => M.Batch.updateOne({ _id: b._id }, { $set: { batchNumber: 'X', initialQuantity: 1, expiryDate: new Date('2099-01-01'), medicineId: new h.mongoose.Types.ObjectId() } }));
    const after = (await detail(m._id)).batches[0];
    assert.equal(after.batchNumber, 'FIXED');
    assert.equal(after.initialQuantity, 10);
    assert.equal(after.availableQuantity, 10, 'quantity is only ever changed through the ledger');
    assert.equal(after.sellingPrice, 80, 'but a price edit is allowed');
    assert.equal(after.expiryDate.slice(0, 10), b.expiryDate.slice(0, 10));
  });

  it('batches are never physically deleted: there is no delete endpoint, and only an empty batch can be archived', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 4 })).data;
    assert.equal((await T.client.del(`/medicines/${m._id}/batches/${b._id}`)).status, 404, 'no such route');
    const refused = await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { status: 'archived' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'BATCH_NOT_EMPTY');
    assert.equal((await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -4, type: 'WRITE_OFF', reason: 'Damaged in storage' })).status, 201);
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { status: 'archived' })).status, 200);
    const kept = (await detail(m._id)).batches;
    assert.equal(kept.length, 1, 'the archived batch is still on record');
    assert.equal(kept[0].status, 'archived');
    const adj = await T.client.post('/stock/adjustments', { batchId: b._id, quantity: 1, reason: 'Should be refused' });
    assert.equal(adj.status, 409);
    assert.equal(adj.body.code, 'BATCH_ARCHIVED');
  });

  it('batch edits are audited with the old and new values', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { sellingPrice: 90, mrp: 100 })).data;
    await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { sellingPrice: 85 });
    const log = (await T.client.get('/activity?limit=100')).data.items.find((e) => e.action === 'BATCH_UPDATE' && String(e.entityId) === b._id);
    assert.ok(log, 'a BATCH_UPDATE audit entry exists');
    assert.deepEqual(log.meta, { before: { sellingPrice: 90 }, after: { sellingPrice: 85 } });
  });

  it('rejects invalid batch edits (price above MRP, reserved above on-hand)', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { mrp: 100, sellingPrice: 90, initialQuantity: 5 })).data;
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { sellingPrice: 150 })).status, 400);
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { reservedQuantity: 6 })).status, 400);
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, {})).status, 400, 'nothing to update');
  });
});

describe('Expired and unavailable stock is never sellable', () => {
  it('expired stock: shown in the batch list but excluded from availability, POS, sales and the stock chart', async () => {
    const m = await newMed();
    await seedBatch(T.org, m._id, { batchNumber: 'OLD', expiryDate: new Date(Date.now() - 3 * day), qty: 50 });
    const batch = (await detail(m._id)).batches[0];
    assert.equal(batch.isExpired, true);
    assert.equal(batch.availableQuantity, 50, 'the units physically exist');
    assert.equal(batch.sellableQuantity, 0, 'but none are sellable');

    const listed = (await T.client.get(`/medicines?search=${encodeURIComponent(m.medicineName)}`)).data.items[0];
    assert.equal(listed.availableStock, 0);
    assert.ok(!(await T.client.get('/pos/products')).data.some((p) => p._id === m._id && p.availableStock > 0));
    const s = await sell(T.client, m._id, 1);
    assert.equal(s.status, 409);
    assert.match(s.body.message, /Insufficient stock/);
    assert.ok(!(await T.client.get('/dashboard/stock-levels?limit=20')).data.items.some((i) => i.medicineId === m._id));
    assert.equal(await stockOf(m._id), 50, 'nothing was taken');
  });

  it('a sale skips expired stock and uses the valid batch', async () => {
    const m = await newMed();
    await seedBatch(T.org, m._id, { batchNumber: 'EXPIRED', expiryDate: new Date(Date.now() - day), qty: 10 });
    await addBatch(m._id, { batchNumber: 'VALID', initialQuantity: 10 });
    const inv = (await sell(T.client, m._id, 4)).data;
    assert.deepEqual(inv.items.map((i) => i.batchNo), ['VALID']);
  });

  it('quarantined, recalled and archived batches are not sellable; reactivating restores them', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    for (const status of ['quarantined', 'recalled']) {
      assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { status })).status, 200);
      assert.equal((await sell(T.client, m._id, 1)).status, 409, status);
      assert.equal((await T.client.get(`/medicines?search=${encodeURIComponent(m.medicineName)}`)).data.items[0].availableStock, 0);
    }
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { status: 'active' })).status, 200);
    assert.equal((await sell(T.client, m._id, 1)).status, 201);
  });

  it('reserved units are on hand but not sellable', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    assert.equal((await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { reservedQuantity: 7 })).status, 200);
    assert.equal((await T.client.get(`/medicines?search=${encodeURIComponent(m.medicineName)}`)).data.items[0].availableStock, 3);
    assert.equal((await sell(T.client, m._id, 4)).status, 409, 'only 3 are unreserved');
    assert.equal((await sell(T.client, m._id, 3)).status, 201);
    const after = (await detail(m._id)).batches[0];
    assert.equal(after.availableQuantity, 7);
    assert.equal(after.reservedQuantity, 7);
  });
});

describe('Stock never goes negative', () => {
  it('selling more than is available is refused and changes nothing', async () => {
    const m = await newMed();
    await addBatch(m._id, { initialQuantity: 5 });
    assert.equal((await sell(T.client, m._id, 6)).status, 409);
    assert.equal(await stockOf(m._id), 5);
  });

  it('a multi-item sale is all-or-nothing: if one line fails, nothing is deducted and no ledger entry is written', async () => {
    const a = await newMed();
    const b = await newMed();
    const ba = (await addBatch(a._id, { initialQuantity: 10 })).data;
    await addBatch(b._id, { initialQuantity: 2 });
    const r = await T.client.post('/invoices', { items: [{ medicineId: a._id, quantity: 5 }, { medicineId: b._id, quantity: 99 }] });
    assert.equal(r.status, 409);
    assert.equal(await stockOf(a._id), 10, 'the first line was rolled back');
    const ledger = (await T.client.get(`/stock/movements?batchId=${ba._id}`)).data.items;
    assert.equal(ledger.length, 1, 'only the original receipt is in the ledger');
  });

  it('simultaneous sales can never oversell: 5 units, 10 buyers at once -> exactly 5 succeed', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 5 })).data;
    const results = await Promise.all(Array.from({ length: 10 }, () => sell(T.client, m._id, 1)));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 5, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
    assert.equal(await stockOf(m._id), 0);
    const ledger = (await T.client.get(`/stock/movements?batchId=${b._id}&limit=100`)).data.items;
    assert.equal(ledger.reduce((s, e) => s + e.quantity, 0), 0, 'the ledger adds up to the empty batch');
    assert.ok(ledger.every((e) => e.balanceAfter >= 0));
  });

  it('simultaneous adjustments can never overdraw a batch', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    const results = await Promise.all(Array.from({ length: 6 }, () => T.client.post('/stock/adjustments', { batchId: b._id, quantity: -3, reason: 'Concurrent stock take' })));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 3, JSON.stringify(results.map((r) => r.status)));
    assert.equal(await stockOf(m._id), 1);
  });

  it('adjustments cannot remove more than is on hand, or dip into reserved units', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    const tooMuch = await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -11, reason: 'Too many' });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body.code, 'INSUFFICIENT_STOCK');
    await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { reservedQuantity: 6 });
    assert.equal((await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -5, reason: 'Into reserved' })).status, 409);
    assert.equal((await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -4, reason: 'Exactly the unreserved' })).status, 201);
    assert.equal(await stockOf(m._id), 6);
  });

  it('the model itself refuses negative or inconsistent quantities', async () => {
    const m = await newMed();
    const make = (over) =>
      h.tenant.runWithTenant(T.org._id, () => M.Batch.create({ medicineId: m._id, batchNumber: uniq('MB'), expiryDate: new Date(Date.now() + 99 * day), mrp: 10, sellingPrice: 9, initialQuantity: 5, availableQuantity: 5, ...over }));
    await assert.rejects(() => make({ availableQuantity: -1 }), { name: 'ValidationError' });
    await assert.rejects(() => make({ reservedQuantity: 6 }), { name: 'ValidationError' });
    await assert.rejects(() => make({ sellingPrice: 11 }), { name: 'ValidationError' });
    await assert.rejects(() => make({ availableQuantity: 2.5 }), { name: 'ValidationError' });
    await assert.rejects(() => make({ status: 'lost' }), { name: 'ValidationError' });
  });
});

describe('The stock ledger', () => {
  it('records every stock change with the running balance: receipt, sales and adjustments', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 20 })).data;
    await sell(T.client, m._id, 5);
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: 3, reason: 'Found during stock take' });
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -2, type: 'WRITE_OFF', reason: 'Broken strips' });
    const items = (await T.client.get(`/stock/movements?batchId=${b._id}&limit=50`)).data.items.reverse(); // oldest first
    assert.deepEqual(items.map((e) => [e.type, e.quantity, e.balanceAfter]), [['PURCHASE', 20, 20], ['SALE', -5, 15], ['ADJUSTMENT', 3, 18], ['WRITE_OFF', -2, 16]]);
    assert.equal(items[2].reason, 'Found during stock take');
    assert.equal(items[0].medicineName, m.medicineName);
    assert.equal(items[0].batchNumber, b.batchNumber);
    assert.equal(await stockOf(m._id), 16);
  });

  it('can be filtered and paged', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    for (let i = 0; i < 3; i++) await T.client.post('/stock/adjustments', { batchId: b._id, quantity: 1, reason: `Adjust ${i}` });
    assert.equal((await T.client.get(`/stock/movements?batchId=${b._id}&type=ADJUSTMENT`)).data.total, 3);
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=2&page=2`)).data.items.length, 2);
    assert.equal((await T.client.get('/stock/movements?type=NOPE')).status, 400);
  });

  it('is append-only: updates, deletes and replacements are refused at the model level', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 5 })).data;
    const entry = await h.tenant.runWithTenant(T.org._id, () => M.StockMovement.findOne({ batchId: b._id }));
    const inTenant = (fn) => h.tenant.runWithTenant(T.org._id, fn);
    const refused = { name: 'LedgerImmutableError' };
    await assert.rejects(() => inTenant(() => M.StockMovement.updateOne({ _id: entry._id }, { $set: { quantity: 999 } })), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.updateMany({}, { $set: { reason: 'x' } })), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.findOneAndUpdate({ _id: entry._id }, { quantity: 1 })), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.replaceOne({ _id: entry._id }, { quantity: 1 })), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.deleteOne({ _id: entry._id })), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.deleteMany({})), refused);
    await assert.rejects(() => inTenant(() => M.StockMovement.findOneAndDelete({ _id: entry._id })), refused);
    entry.quantity = 999;
    await assert.rejects(() => inTenant(() => entry.save()), refused);
    await assert.rejects(() => inTenant(() => entry.deleteOne()), refused);
    const still = await inTenant(() => M.StockMovement.findById(entry._id).lean());
    assert.equal(still.quantity, 5, 'the entry is untouched');
  });

  it('has no API to edit or delete entries', async () => {
    const some = (await T.client.get('/stock/movements?limit=1')).data.items[0];
    for (const call of [() => T.client.put(`/stock/movements/${some._id}`, { quantity: 1 }), () => T.client.patch(`/stock/movements/${some._id}`, { quantity: 1 }), () => T.client.del(`/stock/movements/${some._id}`)]) {
      assert.equal((await call()).status, 404);
    }
  });

  it('rejects meaningless entries (zero or fractional quantity)', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, {})).data;
    const make = (quantity) => h.tenant.runWithTenant(T.org._id, () => M.StockMovement.create({ medicineId: m._id, batchId: b._id, type: 'ADJUSTMENT', quantity }));
    await assert.rejects(() => make(0), { name: 'ValidationError' });
    await assert.rejects(() => make(1.5), { name: 'ValidationError' });
  });

  it('reconciliation proves the ledger adds up to every batch — and catches tampering', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    await sell(T.client, m._id, 3);
    const clean = (await T.client.get('/stock/reconciliation')).data;
    assert.equal(clean.consistent, true, JSON.stringify(clean.discrepancies));
    assert.ok(clean.batchesChecked > 0);

    // someone edits the quantity directly in the database, bypassing the ledger
    await h.tenant.runWithTenant(T.org._id, () => M.Batch.updateOne({ _id: b._id }, { $set: { availableQuantity: 50 } }));
    const dirty = (await T.client.get('/stock/reconciliation')).data;
    assert.equal(dirty.consistent, false);
    const found = dirty.discrepancies.find((d) => d.batchId === b._id);
    assert.deepEqual([found.availableQuantity, found.ledgerBalance, found.difference], [50, 7, 43]);
    await h.tenant.runWithTenant(T.org._id, () => M.Batch.updateOne({ _id: b._id }, { $set: { availableQuantity: 7 } }));
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('an idempotent replay adds no ledger entries', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    const key = uniq('idem-key');
    await sell(T.client, m._id, 2, { idempotencyKey: key });
    await sell(T.client, m._id, 2, { idempotencyKey: key });
    assert.equal((await T.client.get(`/stock/movements?batchId=${b._id}`)).data.total, 2, 'receipt + one sale');
  });
});

describe('Stock adjustments', () => {
  it('require a reason; a write-off must remove stock; unknown or foreign batches are 404', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    const post = (body, client = T.client) => client.post('/stock/adjustments', body);
    assert.equal((await post({ batchId: b._id, quantity: 1 })).status, 400, 'reason required');
    assert.equal((await post({ batchId: b._id, quantity: 1, reason: 'ab' })).status, 400, 'reason too short');
    assert.equal((await post({ batchId: b._id, quantity: 0, reason: 'Nothing' })).status, 400);
    assert.equal((await post({ batchId: b._id, quantity: 1.5, reason: 'Fraction' })).status, 400);
    assert.equal((await post({ batchId: b._id, quantity: 2, type: 'WRITE_OFF', reason: 'Not a removal' })).status, 400);
    assert.equal((await post({ batchId: String(new h.mongoose.Types.ObjectId()), quantity: 1, reason: 'Ghost' })).status, 404);
    assert.equal((await post({ batchId: b._id, quantity: 1, reason: 'Other org tries' }, other.client)).status, 404);
    assert.equal(await stockOf(m._id), 10);
  });

  it('an expired batch can be written off', async () => {
    const m = await newMed();
    const b = await seedBatch(T.org, m._id, { batchNumber: 'DEAD', expiryDate: new Date(Date.now() - 10 * day), qty: 8 });
    const r = await T.client.post('/stock/adjustments', { batchId: String(b._id), quantity: -8, type: 'WRITE_OFF', reason: 'Expired — destroyed' });
    assert.equal(r.status, 201);
    assert.equal(r.data.balanceAfter, 0);
  });

  it('are audited with before/after quantities', async () => {
    const m = await newMed();
    const b = (await addBatch(m._id, { initialQuantity: 10 })).data;
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -4, reason: 'Stock take correction' });
    const log = (await T.client.get('/activity?limit=100')).data.items.find((e) => e.action === 'STOCK_ADJUST' && String(e.entityId) === b._id);
    assert.ok(log);
    assert.deepEqual(log.meta, { quantity: -4, reason: 'Stock take correction', before: 10, after: 6 });
  });

  it('need the right permission', async () => {
    const staff = h.client();
    await h.makeUser(T.org, { role: 'STAFF', email: uniq('staff') + '@example.test' }).then((u) => staff.login(u.email));
    const m = await newMed();
    const b = (await addBatch(m._id, {})).data;
    assert.equal((await staff.post('/stock/adjustments', { batchId: b._id, quantity: 1, reason: 'Not allowed' })).status, 403);
    assert.equal((await staff.get('/stock/movements')).status, 200, 'but staff can read the ledger');
    assert.equal((await staff.get('/stock/reconciliation')).status, 403);
  });
});

describe('Medicine stock is calculated from valid batch balances', () => {
  it('available stock = unreserved units in active, unexpired batches only', async () => {
    const m = await newMed(T.client, { reorderLevel: 100 });
    await addBatch(m._id, { batchNumber: 'A', initialQuantity: 10 }); // 10 sellable
    const b = (await addBatch(m._id, { batchNumber: 'B', initialQuantity: 20 })).data; // 20, of which 5 reserved
    await T.client.patch(`/medicines/${m._id}/batches/${b._id}`, { reservedQuantity: 5 });
    const q = (await addBatch(m._id, { batchNumber: 'Q', initialQuantity: 7 })).data; // quarantined
    await T.client.patch(`/medicines/${m._id}/batches/${q._id}`, { status: 'quarantined' });
    await seedBatch(T.org, m._id, { batchNumber: 'X', expiryDate: new Date(Date.now() - day), qty: 100 }); // expired
    const listed = (await T.client.get(`/medicines?search=${encodeURIComponent(m.medicineName)}`)).data.items[0];
    assert.equal(listed.availableStock, 25); // 10 + (20 - 5)
    assert.equal(await stockOf(m._id), 137, 'while the units physically on hand are 10+20+7+100');
  });

  it('there is no stock total stored on the medicine itself', async () => {
    assert.ok(!M.Medicine.schema.path('stock') && !M.Medicine.schema.path('availableStock') && !M.Medicine.schema.path('quantity'));
  });

  it('low-stock status follows the calculated stock', async () => {
    const m = await newMed(T.client, { reorderLevel: 10 });
    const b = (await addBatch(m._id, { initialQuantity: 9 })).data;
    const status = async (stock) => (await T.client.get(`/medicines?stock=${stock}&search=${encodeURIComponent(m.medicineName)}`)).data.total;
    assert.equal(await status('low'), 1);
    await T.client.post('/stock/adjustments', { batchId: b._id, quantity: 1, reason: 'Back to the reorder level' });
    assert.equal(await status('low'), 0, 'stock equal to the reorder level is not low');
    assert.equal(await status('in'), 1);
  });
});

describe('Compounds and attributes', () => {
  it('compounds: create, list, update, unique per organization (any case), delete only when unused', async () => {
    const name = uniq('Cmp');
    const c = await T.client.post('/compounds', { compoundName: name, composition: 'Ingredient A 10 mg', description: 'Test' });
    assert.equal(c.status, 201);
    assert.equal(c.data.status, 'active');
    assert.equal((await T.client.post('/compounds', { compoundName: name.toUpperCase() })).status, 409);
    assert.equal((await other.client.post('/compounds', { compoundName: name })).status, 201, 'another organization may reuse the name');
    assert.equal((await T.client.put(`/compounds/${c.data._id}`, { composition: 'Ingredient A 20 mg' })).data.composition, 'Ingredient A 20 mg');
    assert.equal((await T.client.put(`/compounds/${c.data._id}`, { status: 'inactive' })).data.status, 'inactive');

    const used = await newMed(T.client, { compoundId: c.data._id });
    const refused = await T.client.del(`/compounds/${c.data._id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'IN_USE');
    const free = (await T.client.post('/compounds', { compoundName: uniq('Free') })).data;
    assert.equal((await T.client.del(`/compounds/${free._id}`)).status, 200);
    assert.ok(used);
  });

  it('attributes: typed lists with unique values; the type is fixed; categories in use cannot be deleted', async () => {
    const forms = await T.client.post('/attributes', { attributeName: 'Dosage form', attributeType: 'dosage_form', values: ['Tablet', 'Capsule', 'Syrup'] });
    assert.equal(forms.status, 201);
    assert.equal((await T.client.post('/attributes', { attributeName: 'dosage FORM', attributeType: 'dosage_form' })).status, 409);
    assert.equal((await T.client.post('/attributes', { attributeName: 'Bad', attributeType: 'custom', values: ['a', 'A'] })).status, 400, 'values must be unique');
    assert.equal((await T.client.post('/attributes', { attributeName: 'Bad', attributeType: 'nonsense' })).status, 400);
    for (const type of ['strength', 'unit', 'category']) assert.equal((await T.client.post('/attributes', { attributeName: uniq(type), attributeType: type })).status, 201, type);

    const upd = await T.client.put(`/attributes/${forms.data._id}`, { values: ['Tablet', 'Capsule', 'Syrup', 'Injection'], attributeType: 'unit' });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.attributeType, 'dosage_form', 'the type cannot be changed');
    assert.equal(upd.data.values.length, 4);

    const cat = (await T.client.post('/attributes', { attributeName: uniq('UsedCat'), attributeType: 'category' })).data;
    await newMed(T.client, { categoryId: cat._id });
    assert.equal((await T.client.del(`/attributes/${cat._id}`)).body.code, 'IN_USE');
    const spare = (await T.client.post('/attributes', { attributeName: uniq('Spare'), attributeType: 'unit' })).data;
    assert.equal((await T.client.del(`/attributes/${spare._id}`)).status, 200);
  });

  it('dosage-form and unit lists feed the form suggestions (/medicines/facets)', async () => {
    const t = await h.makeTenant('Facets Org');
    await t.client.post('/attributes', { attributeName: 'Dosage form', attributeType: 'dosage_form', values: ['Tablet', 'Gel'] });
    await newMed(t.client, { dosageForm: 'Lozenge', unit: 'Strip', categoryName: 'Throat' });
    const f = (await t.client.get('/medicines/facets')).data;
    assert.deepEqual(f.dosageForms, ['Gel', 'Lozenge', 'Tablet']);
    assert.deepEqual(f.units, ['Strip']);
    assert.deepEqual(f.categories.map((c) => c.name), ['Throat']);
  });

  it('are tenant-isolated and permission-protected', async () => {
    const t = await h.makeTenant('Cat Iso A');
    const u = await h.makeTenant('Cat Iso B');
    const c = (await t.client.post('/compounds', { compoundName: 'Alpha only' })).data;
    const a = (await t.client.post('/attributes', { attributeName: 'Alpha cat', attributeType: 'category' })).data;
    assert.equal((await u.client.get('/compounds')).data.items.length, 0);
    assert.equal((await u.client.get('/attributes')).data.items.length, 0);
    assert.equal((await u.client.put(`/compounds/${c._id}`, { status: 'inactive' })).status, 404);
    assert.equal((await u.client.put(`/attributes/${a._id}`, { status: 'inactive' })).status, 404);
    assert.equal((await u.client.del(`/compounds/${c._id}`)).status, 404);
    assert.equal((await u.client.del(`/attributes/${a._id}`)).status, 404);

    const staff = h.client();
    await h.makeUser(t.org, { role: 'STAFF', email: uniq('s') + '@example.test' }).then((x) => staff.login(x.email));
    assert.equal((await staff.get('/compounds')).status, 200);
    assert.equal((await staff.post('/compounds', { compoundName: 'Nope' })).status, 403);
    assert.equal((await staff.post('/attributes', { attributeName: 'Nope', attributeType: 'unit' })).status, 403);
  });
});

describe('Audit trail', () => {
  it('records catalogue and stock operations', async () => {
    const t = await h.makeTenant('Audit Inventory Org');
    const m = await newMed(t.client, { medicineName: 'Audited Tabs', compoundName: 'Audit compound' });
    const b = (await addBatch(m._id, { initialQuantity: 10 }, t.client)).data;
    await t.client.post('/stock/adjustments', { batchId: b._id, quantity: -1, reason: 'Sample taken' });
    await t.client.put(`/medicines/${m._id}`, { medicineName: 'Audited Tabs', isActive: false });
    const actions = (await t.client.get('/activity?limit=100')).data.items.map((e) => e.action);
    for (const a of ['MEDICINE_CREATE', 'STOCK_ADD', 'STOCK_ADJUST', 'MEDICINE_ARCHIVE']) assert.ok(actions.includes(a), `missing ${a}`);
    const messages = (await t.client.get('/activity?limit=100')).data.items.map((e) => e.message).join(' | ');
    assert.match(messages, /Medicine archived — Audited Tabs/);
  });
});

describe('Indexes', () => {
  it('cover medicine name, barcode, SKU, organization and expiry date', () => {
    const keys = (Model) => Model.schema.indexes().map(([k, o]) => ({ k: JSON.stringify(k), o: o || {} }));
    const med = keys(M.Medicine);
    assert.ok(med.some((i) => i.k === JSON.stringify({ organizationId: 1, medicineName: 1 })), 'medicine name');
    assert.ok(med.some((i) => i.k === JSON.stringify({ organizationId: 1, barcode: 1 }) && i.o.unique), 'barcode (unique)');
    assert.ok(med.some((i) => i.k === JSON.stringify({ organizationId: 1, sku: 1 }) && i.o.unique), 'SKU (unique)');
    const batch = keys(M.Batch);
    assert.ok(batch.some((i) => i.k === JSON.stringify({ organizationId: 1, medicineId: 1, expiryDate: 1 })), 'expiry per medicine (FEFO)');
    assert.ok(batch.some((i) => i.k === JSON.stringify({ organizationId: 1, expiryDate: 1, availableQuantity: 1 })), 'expiry alerts');
    assert.ok(batch.some((i) => i.k === JSON.stringify({ organizationId: 1, medicineId: 1, batchNumber: 1, branchId: 1 }) && i.o.unique), 'batch numbers are unique per medicine and store');
    const ledger = keys(M.StockMovement);
    assert.ok(ledger.some((i) => i.k === JSON.stringify({ organizationId: 1, batchId: 1, createdAt: 1 })));
    for (const Model of [M.Medicine, M.Batch, M.StockMovement, M.Compound, M.Attribute]) {
      assert.ok(Model.schema.indexes().every(([k]) => Object.keys(k)[0] === 'organizationId'), `${Model.modelName}: every index starts with organizationId`);
    }
  });
});

describe('Spec fields exist on the models', () => {
  it('Compound, Attribute and Batch have exactly the specified fields', () => {
    const paths = (Model) => Object.keys(Model.schema.paths);
    for (const f of ['organizationId', 'compoundName', 'composition', 'description', 'status']) assert.ok(paths(M.Compound).includes(f), `Compound.${f}`);
    for (const f of ['organizationId', 'attributeName', 'attributeType', 'values', 'status']) assert.ok(paths(M.Attribute).includes(f), `Attribute.${f}`);
    for (const f of ['organizationId', 'medicineId', 'batchNumber', 'manufacturer', 'manufacturingDate', 'expiryDate', 'purchasePrice', 'sellingPrice', 'mrp', 'initialQuantity', 'availableQuantity', 'reservedQuantity', 'branchId', 'supplierId', 'status']) {
      assert.ok(paths(M.Batch).includes(f), `Batch.${f}`);
    }
    for (const f of ['organizationId', 'medicineName', 'genericName', 'salt', 'manufacturer', 'categoryId', 'dosageForm', 'strength', 'packSize', 'unit', 'hsnCode', 'gstPercentage', 'barcode', 'sku', 'reorderLevel', 'description', 'image', 'isActive', 'createdAt', 'updatedAt']) {
      assert.ok(paths(M.Medicine).includes(f), `Medicine.${f}`);
    }
  });
});
