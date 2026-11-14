// Acceptance walk-through of the whole inventory story, through the public API only, the way the app uses it:
// create -> edit -> receive stock -> sell -> adjust -> low-stock alert -> expiry -> archive -> restore, plus pagination,
// search, and a CSV import whose summary is checked against the database.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { COLUMNS } from '../services/importValidation.js';
import { toCsv } from '../utils/csv.js';

let h;
let T;
let n = 0;
const DAY = 86400000;
const name = (p) => `${p} ${++n}`;
const code = (p) => `${p}-${++n}`; // SKUs and batch numbers may not contain spaces

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Acceptance Org');
});

after(async () => {
  await h?.stop();
});

const stockOf = async (id) => (await T.client.get(`/inventory/${id}`)).data;
const lowStock = async () => (await T.client.get('/dashboard/alerts')).data;
const expiredBatch = (medicineId, batchNumber, qty) =>
  h.tenant.runWithTenant(T.org._id, async () => {
    const b = await h.models.Batch.create({ medicineId, batchNumber, expiryDate: new Date(Date.now() - 2 * DAY), mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty });
    await h.models.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty, reason: 'Batch received' });
    return b;
  });

describe('Inventory lifecycle', () => {
  let med;
  let batch;
  const title = name('Lifecycle Tab');

  it('creates a medicine', async () => {
    const r = await T.client.post('/inventory', { medicineName: title, genericName: 'Testamol', manufacturer: 'ACME', categoryName: 'Tablets', sku: code('LIFE'), reorderLevel: 20, gstPercentage: 12 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    med = r.data;
    const got = await stockOf(med._id);
    assert.equal(got.medicineName, title);
    assert.equal(got.categoryName, 'Tablets');
    assert.deepEqual([got.totalStock, got.availableStock, got.stockStatus], [0, 0, 'out_of_stock'], 'a new medicine has no stock until a batch is received');
  });

  it('edits the medicine', async () => {
    const r = await T.client.put(`/inventory/${med._id}`, { medicineName: title, genericName: 'Testamol Forte', manufacturer: 'ACME', reorderLevel: 20, strength: '500 mg' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = await stockOf(med._id);
    assert.equal(got.genericName, 'Testamol Forte');
    assert.equal(got.strength, '500 mg');
  });

  it('adds a batch: stock appears and the medicine goes in stock', async () => {
    const r = await T.client.post('/batches', { medicineId: med._id, batchNumber: 'LC-1', expiryDate: futureDate(2), mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: 100 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    batch = r.data;
    const got = await stockOf(med._id);
    assert.deepEqual([got.totalStock, got.availableStock, got.stockStatus], [100, 100, 'in_stock']);
  });

  it('a sale reduces stock; an adjustment updates it; the ledger always reconciles', async () => {
    const sale = await T.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 30 }], idempotencyKey: 'acceptance-sale-0001' });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal((await stockOf(med._id)).availableStock, 70);

    const adj = await T.client.post('/stock/adjustments', { batchId: batch._id, quantity: -5, reason: 'Stock take: five missing' });
    assert.equal(adj.status, 201, JSON.stringify(adj.body));
    assert.equal((await stockOf(med._id)).availableStock, 65);
    const up = await T.client.post('/stock/adjustments', { batchId: batch._id, quantity: 3, reason: 'Found three in the back room' });
    assert.equal(up.status, 201);
    assert.equal((await stockOf(med._id)).availableStock, 68);

    assert.equal((await T.client.post('/stock/adjustments', { batchId: batch._id, quantity: -9999, reason: 'Too many' })).status, 409, 'stock can never go negative');
    assert.equal((await stockOf(med._id)).availableStock, 68);
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('low-stock alerts: raised only when sellable stock falls below the reorder level', async () => {
    assert.ok(!(await lowStock()).lowStockItems.some((i) => i.name === title), '68 on hand, reorder level 20: no alert');
    await T.client.post('/stock/adjustments', { batchId: batch._id, quantity: -50, reason: 'Damaged: fifty units' });
    const at18 = (await lowStock()).lowStockItems.find((i) => i.name === title);
    assert.ok(at18, '18 < 20: alert');
    assert.equal(at18.qty, 18);
    assert.equal((await stockOf(med._id)).stockStatus, 'low_stock');

    await T.client.post('/stock/adjustments', { batchId: batch._id, quantity: 2, reason: 'Recount: two more' });
    assert.ok(!(await lowStock()).lowStockItems.some((i) => i.name === title), 'exactly at the reorder level (20) is not "below" it');
  });

  it('expired stock is excluded from saleable stock and can never be sold', async () => {
    const m = (await T.client.post('/inventory', { medicineName: name('Expiry Tab'), reorderLevel: 10 })).data;
    await expiredBatch(m._id, 'EXP-1', 40);
    const good = (await T.client.post('/batches', { medicineId: m._id, batchNumber: 'GOOD-1', expiryDate: futureDate(1), mrp: 10, sellingPrice: 9, initialQuantity: 6 })).data;
    const got = await stockOf(m._id);
    assert.deepEqual([got.totalStock, got.availableStock, got.expiredStock], [46, 6, 40], '40 expired units are on the shelf but not sellable');
    assert.equal(got.stockStatus, 'low_stock', '6 sellable < reorder level 10: the expired units do not count');

    const tooMany = await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 7 }], idempotencyKey: 'acceptance-exp-0001' });
    assert.ok(tooMany.status >= 400 && tooMany.status < 500, 'cannot sell 7 when only 6 are unexpired');
    assert.equal((await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 6 }], idempotencyKey: 'acceptance-exp-0002' })).status, 201);
    const after = await stockOf(m._id);
    assert.deepEqual([after.availableStock, after.expiredStock], [0, 40]);
    assert.equal(after.stockStatus, 'expired');
    assert.equal((await T.client.get(`/batches/${good._id}`)).data.availableQuantity, 0);
    assert.equal((await T.client.get('/batches?search=EXP-1')).data.items[0].availableQuantity, 40, 'the expired batch was never touched');

    const alerts = await lowStock();
    assert.ok(alerts.expiringBatches.some((b) => b.batchNumber === 'EXP-1' && b.expired), 'it shows as expired in the alerts');
    const pos = (await T.client.get(`/pos/products?q=${encodeURIComponent(m.medicineName)}`)).data;
    const item = (pos.items || pos).find((x) => x.medicineName === m.medicineName);
    assert.ok(!item || (item.availableStock ?? item.stock ?? 0) === 0);
  });

  it('archives the medicine (history kept, hidden from sale and the default list) and restores it', async () => {
    const r = await T.client.del(`/inventory/${med._id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.archived, true, 'it has history, so it is archived, not deleted');
    assert.equal((await T.client.get(`/inventory?search=${encodeURIComponent(title)}`)).data.total, 0, 'hidden from the default list');
    assert.equal((await T.client.get(`/inventory?search=${encodeURIComponent(title)}&archived=only`)).data.total, 1);
    const pos = (await T.client.get(`/pos/products?q=${encodeURIComponent(title)}`)).data;
    assert.equal((pos.items || pos).filter((x) => x.medicineName === title).length, 0, 'not offered at the Selling Point');
    assert.equal((await T.client.post('/batches', { medicineId: med._id, batchNumber: 'LC-2', expiryDate: futureDate(2), mrp: 10, sellingPrice: 9, initialQuantity: 1 })).status, 409, 'no stock can be received while archived');
    assert.equal((await T.client.get('/batches?search=LC-1&archived=include')).data.total, 1, 'its batches and history are still there');

    assert.equal((await T.client.post(`/inventory/${med._id}/restore`)).status, 200);
    assert.equal((await T.client.get(`/inventory?search=${encodeURIComponent(title)}`)).data.total, 1);
  });
});

describe('Pagination and search', () => {
  before(async () => {
    for (let i = 1; i <= 25; i++) await T.client.post('/inventory', { medicineName: `Pager ${String(i).padStart(2, '0')}`, sku: `PAGER-${String(i).padStart(2, '0')}`, genericName: i % 5 === 0 ? 'Fivefold' : 'Other' });
  });

  it('pages through every record exactly once', async () => {
    const seen = [];
    let pages = 0;
    for (let p = 1; ; p++) {
      const r = await T.client.get(`/inventory?search=Pager&limit=10&page=${p}&sortBy=medicineName`);
      assert.equal(r.status, 200);
      if (p === 1) {
        pages = r.data.pages;
        assert.equal(r.data.total, 25);
        assert.equal(r.data.limit, 10);
      }
      seen.push(...r.data.items.map((m) => m.medicineName));
      if (p >= pages) break;
    }
    assert.equal(pages, 3);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25, 'no record repeats across pages');
    assert.deepEqual(seen, [...seen].sort(), 'and they stay in order');
    assert.equal((await T.client.get('/inventory?search=Pager&limit=10&page=99')).data.items.length, 0, 'a page past the end is empty, not an error');
    assert.equal((await T.client.get('/inventory?page=0')).status, 400);
    assert.equal((await T.client.get('/inventory?limit=1000')).status, 400, 'page size is capped');
  });

  it('searches by name, SKU, generic name and partial text (any case)', async () => {
    assert.equal((await T.client.get('/inventory?search=pager 07')).data.total, 1);
    assert.equal((await T.client.get('/inventory?search=PAGER-12')).data.total, 1);
    assert.equal((await T.client.get('/inventory?search=fivefold')).data.total, 5);
    assert.equal((await T.client.get('/inventory?search=pag')).data.total, 25);
    assert.equal((await T.client.get('/inventory?search=zzz-nothing')).data.total, 0);
  });
});

describe('CSV import', () => {
  const HEAD = COLUMNS.map((c) => c.key);
  const csv = (rows) => toCsv([HEAD, ...rows.map((r) => HEAD.map((k) => r[k] ?? ''))]);
  const upload = (text) => T.client.post('/import/inventory/preview?fileName=acceptance.csv', text, { headers: { 'content-type': 'text/csv' } });
  const b = (o = {}) => ({ batchNumber: code('IB'), expiryDate: '2031-01-31', mrp: '50', sellingPrice: '45', quantity: '10', ...o });

  it('valid, invalid, duplicate-SKU and bad-expiry rows are reported accurately and the summary matches the database', async () => {
    const sku = code('CSVSKU');
    const file = csv([
      { medicineName: name('Csv Good'), sku, ...b() },                      // 2 valid
      { medicineName: name('Csv Dup SKU'), sku, ...b() },                   // 3 duplicate SKU (different medicine, same file)
      { medicineName: name('Csv Bad Expiry'), ...b({ expiryDate: '2031-02-31' }) }, // 4 invalid date
      { medicineName: name('Csv Past Expiry'), ...b({ expiryDate: '2019-01-01' }) }, // 5 expired
      { medicineName: name('Csv Bad GST'), gstPercentage: '400' },          // 6 invalid GST
      { medicineName: name('Csv Plain') },                                  // 7 valid, no batch
    ]);
    const before = (await T.client.get('/inventory?limit=1&archived=include')).data.total;
    const preview = await upload(file);
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual(preview.data.summary, { total: 6, valid: 2, invalid: 4, skipped: 0, imported: 0, failed: 0 });
    const row = (i) => preview.data.rows.find((r) => r.row === i);
    assert.match(row(3).message, /SKU .* also used by a different medicine in row 2/);
    assert.match(row(4).message, /not a valid date/);
    assert.match(row(5).message, /expired stock cannot be imported/);
    assert.match(row(6).message, /above 100/);
    assert.equal((await T.client.get('/inventory?limit=1&archived=include')).data.total, before, 'previewing imports nothing');

    const done = await T.client.post(`/import/inventory/${preview.data._id}/confirm`, { skipInvalid: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const s = done.data.summary;
    assert.deepEqual(s, { total: 6, valid: 2, invalid: 4, skipped: 0, imported: 2, failed: 0 });
    assert.equal(s.imported + s.skipped + s.failed + s.invalid, s.total);
    assert.equal((await T.client.get('/inventory?limit=1&archived=include')).data.total, before + 2, 'exactly the imported rows were added');
  });

  it('rejects files that are not valid CSV', async () => {
    assert.equal((await upload('')).status, 400);
    assert.equal((await upload('sku,mrp\nA,1\n')).status, 400);
    assert.equal((await T.client.post('/import/inventory/preview?fileName=bad.xlsx', 'medicineName\nA\n', { headers: { 'content-type': 'text/csv' } })).status, 415);
  });
});
