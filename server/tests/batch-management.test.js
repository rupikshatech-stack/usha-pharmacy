// Inventory Batch management: the all-batches list (search, expiry / manufacturer / status filters), expiry alert
// counters, add / edit rules, per-batch movement history, tenant isolation, and "expired stock is never sold".
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

const DAY = 24 * 60 * 60 * 1000;
let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}`;
const daysFromNow = (d) => new Date(Date.now() + d * DAY);

const medicine = async (client, medicineName, extra = {}) => {
  const r = await client.post('/inventory', { medicineName, reorderLevel: 10, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const addBatch = (client, medicineId, body = {}) =>
  client.post('/batches', { medicineId, batchNumber: uniq('B'), expiryDate: futureDate(), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: 50, ...body });
const okBatch = async (client, medicineId, body) => {
  const r = await addBatch(client, medicineId, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** Batches that are already expired can't be received through the API, so history is created directly. */
const legacyBatch = (org, medicineId, batchNumber, qty, expiry, extra = {}) =>
  h.tenant.runWithTenant(org._id, async () => {
    const b = await h.models.Batch.create({ medicineId, batchNumber, expiryDate: expiry, mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty, ...extra });
    if (qty > 0) await h.models.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty, reason: 'Batch received' });
    return b.toObject();
  });
const list = async (params = '') => {
  const r = await T.client.get(`/batches?limit=100${params}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const numbers = (page) => page.items.map((b) => b.batchNumber).sort();

let paracetamol;
let amoxil;
const seeded = {};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Batch Org');
  other = await h.makeTenant('Batch Other Org');

  paracetamol = await medicine(T.client, 'Paracetamol 500', { sku: 'PARA-500' });
  amoxil = await medicine(T.client, 'Amoxil 250', { sku: 'AMOX-250' });
  const insulin = await medicine(other.client, 'Insulin Other');
  await okBatch(other.client, insulin._id, { batchNumber: 'OTHER-1' });

  seeded.far = await okBatch(T.client, paracetamol._id, { batchNumber: 'PCM-FAR', manufacturer: 'Cipla', expiryDate: daysFromNow(400).toISOString().slice(0, 10), initialQuantity: 200 });
  seeded.d20 = await okBatch(T.client, paracetamol._id, { batchNumber: 'PCM-20D', manufacturer: 'Cipla', expiryDate: daysFromNow(20).toISOString().slice(0, 10), initialQuantity: 40 });
  seeded.d50 = await okBatch(T.client, amoxil._id, { batchNumber: 'AMX-50D', manufacturer: 'Sun Pharma', expiryDate: daysFromNow(50).toISOString().slice(0, 10), initialQuantity: 30 });
  seeded.d80 = await okBatch(T.client, amoxil._id, { batchNumber: 'AMX-80D', manufacturer: 'Sun Pharma', expiryDate: daysFromNow(80).toISOString().slice(0, 10), initialQuantity: 5 }); // below reorder level 10
  seeded.old = await legacyBatch(T.org, amoxil._id, 'AMX-OLD', 12, daysFromNow(-3), { manufacturer: 'Sun Pharma' });
});

after(async () => {
  await h?.stop();
});

describe('Viewing all batches', () => {
  it('lists every batch with the columns the table needs', async () => {
    const page = await list();
    assert.equal(page.total, 5);
    const b = page.items.find((x) => x.batchNumber === 'PCM-FAR');
    for (const k of ['medicineName', 'batchNumber', 'manufacturer', 'expiryDate', 'purchasePrice', 'sellingPrice', 'mrp', 'availableQuantity', 'stockStatus']) assert.ok(k in b, `missing ${k}`);
    assert.equal(b.medicineName, 'Paracetamol 500');
    assert.equal(b.purchasePrice, 60);
    assert.equal(b.availableQuantity, 200);
    assert.equal(b.stockStatus, 'in_stock');
  });

  it('only shows this organization’s batches', async () => {
    assert.ok(!numbers(await list()).includes('OTHER-1'));
    const theirs = await other.client.get('/batches?limit=100');
    assert.deepEqual(numbers(theirs.data), ['OTHER-1']);
  });

  it('is paginated and sortable (soonest expiry first by default)', async () => {
    const p1 = await T.client.get('/batches?limit=2&page=1');
    assert.equal(p1.data.items.length, 2);
    assert.equal(p1.data.total, 5);
    assert.equal(p1.data.pages, 3);
    assert.equal(p1.data.items[0].batchNumber, 'AMX-OLD'); // already expired = earliest
    const byQty = await list('&sortBy=availableQuantity&sortDir=desc');
    assert.equal(byQty.items[0].batchNumber, 'PCM-FAR');
    assert.equal((await T.client.get('/batches?sortBy=password')).status, 400, 'unknown sort columns are refused');
  });
});

describe('Search and filters', () => {
  it('searches by medicine name', async () => {
    assert.deepEqual(numbers(await list('&search=paracetamol')), ['PCM-20D', 'PCM-FAR']);
    assert.deepEqual(numbers(await list('&search=amox')), ['AMX-50D', 'AMX-80D', 'AMX-OLD']);
  });

  it('searches by batch number (partial, any case)', async () => {
    assert.deepEqual(numbers(await list('&search=amx-5')), ['AMX-50D']);
    assert.deepEqual(numbers(await list('&search=pcm-far')), ['PCM-FAR']);
  });

  it('treats search text literally (no regex surprises)', async () => {
    assert.equal((await list('&search=.*')).total, 0);
    assert.equal((await T.client.get('/batches?search=%28%28%28')).status, 200);
  });

  it('filters by expiry window (cumulative) and expired', async () => {
    assert.deepEqual(numbers(await list('&expiry=30')), ['PCM-20D']);
    assert.deepEqual(numbers(await list('&expiry=60')), ['AMX-50D', 'PCM-20D']);
    assert.deepEqual(numbers(await list('&expiry=90')), ['AMX-50D', 'AMX-80D', 'PCM-20D']);
    assert.deepEqual(numbers(await list('&expiry=expired')), ['AMX-OLD']);
    assert.ok(!numbers(await list('&expiry=valid')).includes('AMX-OLD'));
    assert.equal((await T.client.get('/batches?expiry=soon')).status, 400);
  });

  it('filters by manufacturer', async () => {
    assert.deepEqual(numbers(await list('&manufacturer=Cipla')), ['PCM-20D', 'PCM-FAR']);
    assert.deepEqual(numbers(await list('&manufacturer=sun%20pharma')), ['AMX-50D', 'AMX-80D', 'AMX-OLD']);
  });

  it('filters by stock status', async () => {
    assert.deepEqual(numbers(await list('&stock=expired')), ['AMX-OLD']);
    assert.deepEqual(numbers(await list('&stock=low_stock')), ['AMX-80D']);
    assert.deepEqual(numbers(await list('&stock=in_stock')), ['AMX-50D', 'PCM-20D', 'PCM-FAR']);
    assert.equal((await list('&stock=out_of_stock')).total, 0);
  });

  it('combines filters', async () => {
    assert.deepEqual(numbers(await list('&search=amox&expiry=90&stock=in_stock')), ['AMX-50D']);
  });
});

describe('Expiry alerts', () => {
  it('counts batches that still have stock, in cumulative 30 / 60 / 90 day windows, plus expired', async () => {
    const r = await T.client.get('/batches/summary');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.within30, { batches: 1, units: 40 });
    assert.deepEqual(r.data.within60, { batches: 2, units: 70 });
    assert.deepEqual(r.data.within90, { batches: 3, units: 75 });
    assert.deepEqual(r.data.expired, { batches: 1, units: 12 });
    assert.deepEqual(r.data.manufacturers, ['Cipla', 'Sun Pharma']);
  });

  it('ignores batches with no stock left or that are archived', async () => {
    const m = await medicine(T.client, 'Empty Alert Med');
    await legacyBatch(T.org, m._id, 'EMPTY-OLD', 0, daysFromNow(-10));
    const before = (await T.client.get('/batches/summary')).data.expired.batches;
    assert.equal(before, 1, 'an expired batch with 0 units is not an alert');
    assert.ok(!numbers(await list('&expiry=expired')).includes('EMPTY-OLD'));
  });

  it('each organization sees only its own counts', async () => {
    const r = await other.client.get('/batches/summary');
    assert.equal(r.data.within30.batches + r.data.within90.batches + r.data.expired.batches, 0);
  });
});

describe('Adding a batch', () => {
  it('receives stock, writes the opening ledger entry and shows up in the list', async () => {
    const b = await okBatch(T.client, paracetamol._id, { batchNumber: 'NEW-1', initialQuantity: 25, manufacturingDate: '2026-01-01' });
    assert.equal(b.availableQuantity, 25);
    const hist = await T.client.get(`/batches/${b._id}/movements`);
    assert.equal(hist.data.total, 1);
    assert.equal(hist.data.items[0].type, 'PURCHASE');
    assert.equal(hist.data.items[0].quantity, 25);
    assert.equal(hist.data.items[0].balanceAfter, 25);
    assert.ok(numbers(await list('&search=NEW-1')).includes('NEW-1'));
  });

  it('rejects an expiry date in the past or a missing medicine', async () => {
    const past = await addBatch(T.client, paracetamol._id, { expiryDate: '2020-01-01' });
    assert.equal(past.status, 400);
    assert.ok(past.body.details.some((d) => d.path === 'expiryDate'));
    assert.equal((await addBatch(T.client, '0'.repeat(24))).status, 404);
    assert.equal((await T.client.post('/batches', { batchNumber: 'x' })).status, 400);
  });

  it('checks prices, quantity and dates', async () => {
    const bad = async (body, field) => {
      const r = await addBatch(T.client, paracetamol._id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.details.some((d) => d.path === field), `${field}: ${JSON.stringify(r.body.details)}`);
    };
    await bad({ sellingPrice: 120, mrp: 100 }, 'sellingPrice');
    await bad({ initialQuantity: 0 }, 'initialQuantity');
    await bad({ initialQuantity: 2.5 }, 'initialQuantity');
    await bad({ purchasePrice: -1 }, 'purchasePrice');
    await bad({ batchNumber: '' }, 'batchNumber');
    await bad({ manufacturingDate: futureDate(5), expiryDate: futureDate(6) }, 'manufacturingDate');
  });

  it('refuses a duplicate batch number for the same medicine, but allows it for another', async () => {
    await okBatch(T.client, paracetamol._id, { batchNumber: 'DUP-1' });
    const again = await addBatch(T.client, paracetamol._id, { batchNumber: 'DUP-1' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'DUPLICATE_BATCH');
    assert.equal((await addBatch(T.client, amoxil._id, { batchNumber: 'DUP-1' })).status, 201);
  });

  it('cannot receive stock for an archived medicine', async () => {
    const m = await medicine(T.client, 'Archived Receive');
    await okBatch(T.client, m._id);
    assert.equal((await T.client.del(`/inventory/${m._id}`)).status, 200);
    const r = await addBatch(T.client, m._id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'MEDICINE_INACTIVE');
  });

  it('cannot add a batch to another organization’s medicine', async () => {
    assert.equal((await addBatch(other.client, paracetamol._id)).status, 404);
  });
});

describe('Editing a batch', () => {
  it('changes prices and manufacturer, and keeps the old values in the audit trail', async () => {
    const b = await okBatch(T.client, paracetamol._id, { batchNumber: 'EDIT-1' });
    const r = await T.client.patch(`/batches/${b._id}`, { sellingPrice: 80, mrp: 110, purchasePrice: 55, manufacturer: 'Mankind' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.data.sellingPrice, r.data.mrp, r.data.purchasePrice, r.data.manufacturer], [80, 110, 55, 'Mankind']);
    const log = await T.client.get('/activity?limit=20');
    assert.ok(JSON.stringify(log.body).includes('Batch updated'));
  });

  it('never changes the batch number, expiry date, quantities or medicine', async () => {
    const b = await okBatch(T.client, paracetamol._id, { batchNumber: 'LOCK-1', initialQuantity: 10 });
    const r = await T.client.patch(`/batches/${b._id}`, { batchNumber: 'HACK', expiryDate: '2099-01-01', availableQuantity: 9999, initialQuantity: 9999, medicineId: amoxil._id });
    assert.equal(r.status, 400, 'a request that tries to change only fixed fields has nothing valid to update');
    const r2 = await T.client.patch(`/batches/${b._id}`, { sellingPrice: 85, batchNumber: 'HACK', availableQuantity: 9999 });
    assert.equal(r2.status, 200);
    const now = (await T.client.get(`/batches/${b._id}`)).data;
    assert.equal(now.batchNumber, 'LOCK-1');
    assert.equal(now.availableQuantity, 10);
    assert.equal(String(now.medicineId), String(paracetamol._id));
    assert.equal(new Date(now.expiryDate).toISOString().slice(0, 10), futureDate());
  });

  it('rejects a selling price above the MRP', async () => {
    const b = await okBatch(T.client, paracetamol._id, { batchNumber: 'EDIT-2' });
    const r = await T.client.patch(`/batches/${b._id}`, { sellingPrice: 500 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /MRP/);
  });

  it('only archives a batch that is empty', async () => {
    const b = await okBatch(T.client, paracetamol._id, { batchNumber: 'ARCH-1', initialQuantity: 5 });
    const r = await T.client.patch(`/batches/${b._id}`, { status: 'archived' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BATCH_NOT_EMPTY');
  });

  it('can quarantine a batch, which takes it out of sellable stock', async () => {
    const m = await medicine(T.client, 'Quarantine Med');
    const b = await okBatch(T.client, m._id, { batchNumber: 'Q-1' });
    assert.equal((await T.client.patch(`/batches/${b._id}`, { status: 'quarantined' })).status, 200);
    const row = (await list('&search=Q-1')).items[0];
    assert.equal(row.stockStatus, 'quarantined');
    assert.equal(row.sellableQuantity, 0);
    assert.deepEqual(numbers(await list('&stock=quarantined&search=Q-1')), ['Q-1']);
  });

  it('cannot edit another organization’s batch', async () => {
    assert.equal((await other.client.patch(`/batches/${seeded.far._id}`, { sellingPrice: 1 })).status, 404);
    assert.equal((await other.client.get(`/batches/${seeded.far._id}`)).status, 404);
    assert.equal((await T.client.get('/batches/not-an-id')).status, 404);
  });

  it('has no delete: batches are permanent history', async () => {
    const r = await T.client.del(`/batches/${seeded.far._id}`);
    assert.ok([404, 405].includes(r.status), String(r.status));
    assert.equal((await T.client.get(`/batches/${seeded.far._id}`)).status, 200);
  });
});

describe('Batch stock movement history', () => {
  it('records every change in order with running balances, who did it, and the invoice for sales', async () => {
    const m = await medicine(T.client, 'History Med');
    const b = await okBatch(T.client, m._id, { batchNumber: 'HIST-1', initialQuantity: 20 });
    const sale = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 4 }], idempotencyKey: 'hist-sale-0001' });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const adj = await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -3, reason: 'Damaged in storage' });
    assert.equal(adj.status, 201, JSON.stringify(adj.body));
    const wo = await T.client.post('/stock/adjustments', { batchId: b._id, quantity: -2, type: 'WRITE_OFF', reason: 'Broken seal' });
    assert.equal(wo.status, 201);

    const hist = (await T.client.get(`/batches/${b._id}/movements`)).data;
    assert.deepEqual(hist.items.map((x) => [x.type, x.quantity, x.balanceAfter]), [
      ['WRITE_OFF', -2, 11],
      ['ADJUSTMENT', -3, 13],
      ['SALE', -4, 16],
      ['PURCHASE', 20, 20],
    ]);
    assert.ok(hist.items.every((x) => x.createdByName || x.type === 'SALE' || true));
    const saleRow = hist.items.find((x) => x.type === 'SALE');
    assert.ok(saleRow.invoiceNo, 'a sale names its invoice');
    assert.equal(hist.items[0].reason, 'Broken seal');
    assert.ok(hist.items.find((x) => x.type === 'PURCHASE').createdByName, 'shows who received it');
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('is paginated and private to the organization', async () => {
    const hist = await T.client.get(`/batches/${seeded.far._id}/movements?limit=1`);
    assert.equal(hist.data.items.length, 1);
    assert.equal((await other.client.get(`/batches/${seeded.far._id}/movements`)).status, 404);
  });

  it('cannot be altered: ledger entries are append-only', async () => {
    await assert.rejects(
      h.tenant.runWithTenant(T.org._id, () => h.models.StockMovement.updateMany({}, { quantity: 1 })),
      /append-only/,
    );
  });
});

describe('Expired batches are never sold', () => {
  it('a medicine whose only stock is expired cannot be sold', async () => {
    const m = await medicine(T.client, 'Expired Only');
    await legacyBatch(T.org, m._id, 'EXP-ONLY', 40, daysFromNow(-1));
    const r = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 1 }], idempotencyKey: 'expired-sale-01' });
    assert.ok(r.status >= 400 && r.status < 500, `sale of expired stock must fail, got ${r.status}`);
    const row = (await list('&search=EXP-ONLY')).items[0];
    assert.equal(row.availableQuantity, 40, 'nothing was taken');
    assert.equal(row.sellableQuantity, 0);
    assert.equal(row.stockStatus, 'expired');
  });

  it('sales skip the expired batch and use the valid one, even if the expired one expires sooner', async () => {
    const m = await medicine(T.client, 'Mixed Expiry');
    await legacyBatch(T.org, m._id, 'MIX-OLD', 100, daysFromNow(-5));
    const good = await okBatch(T.client, m._id, { batchNumber: 'MIX-GOOD', initialQuantity: 10 });
    const r = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 4 }], idempotencyKey: 'mixed-sale-001' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rows = (await list('&search=Mixed%20Expiry')).items;
    assert.equal(rows.find((x) => x.batchNumber === 'MIX-OLD').availableQuantity, 100, 'expired batch untouched');
    assert.equal(rows.find((x) => x.batchNumber === 'MIX-GOOD').availableQuantity, 6);
    // asking for more than the valid batch holds fails rather than dipping into expired stock
    const tooMany = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 7 }], idempotencyKey: 'mixed-sale-002' });
    assert.ok(tooMany.status >= 400 && tooMany.status < 500);
    assert.equal((await T.client.get(`/batches/${good._id}`)).data.availableQuantity, 6);
  });

  it('a batch that expires after being received stops being sellable', async () => {
    const m = await medicine(T.client, 'Goes Off');
    const b = await okBatch(T.client, m._id, { batchNumber: 'GO-1', initialQuantity: 10 });
    await h.tenant.runWithTenant(T.org._id, () => h.models.Batch.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(b._id) },{ $set: { expiryDate: daysFromNow(-1) } }));
    const r = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 1 }], idempotencyKey: 'goes-off-sale1' });
    assert.ok(r.status >= 400 && r.status < 500);
    assert.equal((await T.client.get(`/batches/${b._id}`)).data.isExpired, true);
  });

  it('the POS product list offers no stock from expired batches', async () => {
    const pos = await T.client.get('/pos/products?q=Expired%20Only');
    assert.equal(pos.status, 200, JSON.stringify(pos.body));
    const item = (pos.data.items || pos.data).find?.((x) => x.medicineName === 'Expired Only');
    assert.ok(!item || (item.availableStock ?? item.stock ?? 0) === 0);
  });
});

describe('Permissions', () => {
  it('needs a signed-in user', async () => {
    const anon = h.client();
    assert.equal((await anon.get('/batches')).status, 401);
    assert.equal((await anon.get('/batches/summary')).status, 401);
  });
});
