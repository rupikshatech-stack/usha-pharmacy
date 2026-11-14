// CSV inventory import, end to end: file checks, server-side validation, duplicate detection, the confirm step,
// per-medicine transactions with row-level reporting, no duplicate batches, history, and organization isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../utils/csv.js';
import { COLUMNS } from '../services/importValidation.js';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}`;

const HEAD = COLUMNS.map((c) => c.key);
const line = (o = {}) => HEAD.map((k) => o[k] ?? '');
const csv = (rows) => toCsv([HEAD, ...rows.map(line)]);
const batch = (o = {}) => ({ batchNumber: uniq('B'), expiryDate: '2030-06-30', mrp: '100', sellingPrice: '90', purchasePrice: '60', quantity: '10', ...o });

const send = (client, text, fileName = 'inventory.csv', headers = { 'content-type': 'text/csv' }) =>
  client.post(`/import/inventory/preview?fileName=${encodeURIComponent(fileName)}`, text, { headers });
const preview = async (rows, client = T.client) => {
  const r = await send(client, csv(rows));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const confirm = (id, body = { skipInvalid: true }, client = T.client) => client.post(`/import/inventory/${id}/confirm`, body);
const statuses = (job) => job.rows.map((r) => r.status);
const byRow = (job, row) => job.rows.find((r) => r.row === row);
const medicineCount = async (client = T.client) => (await client.get('/inventory?archived=include&limit=1')).data.total;
const batchTotal = async (client = T.client) => (await client.get('/batches?limit=1&archived=include')).data.total;

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Import Org');
  other = await h.makeTenant('Import Other Org');
});

after(async () => {
  await h?.stop();
});

describe('Template and file checks', () => {
  it('serves a sample template that imports cleanly', async () => {
    const t = await T.client.get('/import/inventory/template');
    assert.equal(t.status, 200);
    assert.match(t.data.fileName, /\.csv$/);
    assert.ok(t.data.csv.startsWith('medicineName,'));
    const r = await send(T.client, t.data.csv);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.data.summary.total, r.data.summary.valid, r.data.summary.invalid], [3, 3, 0]);
  });

  it('rejects files that are not CSV, too big, empty or malformed', async () => {
    const good = csv([{ medicineName: 'X' }]);
    const bad = async (res, status, code) => {
      assert.equal(res.status, status, JSON.stringify(res.body));
      if (code) assert.equal(res.body.code, code);
    };
    await bad(await send(T.client, good, 'data.xlsx'), 415, 'IMPORT_FILE_TYPE');
    await bad(await send(T.client, good, 'data.csv.exe'), 415, 'IMPORT_FILE_TYPE');
    assert.ok([400, 415].includes((await send(T.client, good, 'data.csv', { 'content-type': 'application/json' })).status), 'JSON is not accepted as a CSV upload');
    await bad(await send(T.client, ''), 400, 'IMPORT_FILE');
    await bad(await send(T.client, 'medicineName\n'), 400, 'IMPORT_FILE');
    await bad(await send(T.client, 'sku,mrp\nA,1\n'), 400, 'IMPORT_FILE');
    await bad(await send(T.client, 'medicineName\n"unclosed\n'), 400, 'IMPORT_FILE');
    await bad(await send(T.client, `medicineName\n${'x'.repeat(2.2 * 1024 * 1024)}\n`), 413);
    const rows = Array.from({ length: 2001 }, (_, i) => `M${i}`).join('\n');
    await bad(await send(T.client, `medicineName\n${rows}\n`), 413);
    assert.equal((await T.client.post('/import/inventory/preview', good, { headers: { 'content-type': 'text/csv' } })).status, 400, 'the file name is required');
  });

  it('keeps the existing JSON limit for every other route', async () => {
    const r = await T.client.post('/inventory', { medicineName: 'x'.repeat(200000) });
    assert.ok(r.status === 413 || r.status === 400);
  });

  it('requires a signed-in user with write permission', async () => {
    assert.equal((await send(h.client(), csv([{ medicineName: 'X' }]))).status, 401);
    const viewer = await h.makeUser(T.org, { role: 'BILLING_STAFF' });
    const c = h.client();
    await c.login(viewer.email);
    assert.equal((await send(c, csv([{ medicineName: 'X' }]))).status, 403);
    assert.equal((await c.get('/import/inventory/template')).status, 403);
  });
});

describe('Preview validates everything and writes nothing', () => {
  it('reports row-level errors for mandatory fields, GST, dates, prices and quantity', async () => {
    const before = [await medicineCount(), await batchTotal()];
    const job = await preview([
      { medicineName: '', manufacturer: 'ACME' },                       // row 2: name missing
      { medicineName: uniq('Bad GST'), gstPercentage: '150' },          // row 3
      { medicineName: uniq('Bad GST 2'), gstPercentage: 'abc' },        // row 4
      { medicineName: uniq('Bad date'), ...batch({ expiryDate: '2030-02-30' }) },   // row 5
      { medicineName: uniq('Expired'), ...batch({ expiryDate: '2020-01-01' }) },    // row 6
      { medicineName: uniq('Bad mfg'), ...batch({ manufacturingDate: '2999-01-01' }) }, // row 7
      { medicineName: uniq('Price'), ...batch({ sellingPrice: '500' }) },           // row 8
      { medicineName: uniq('Qty'), ...batch({ quantity: '0' }) },                   // row 9
      { medicineName: uniq('Partial'), quantity: '5' },                             // row 10: batch columns but no batch number
      { medicineName: uniq('Fine'), ...batch() },                                   // row 11: valid
    ]);
    assert.deepEqual(job.summary, { total: 10, valid: 1, invalid: 9, skipped: 0, imported: 0, failed: 0 });
    const field = (row) => byRow(job, row).errors.map((e) => e.field);
    assert.deepEqual(field(2), ['medicineName']);
    assert.deepEqual(field(3), ['gstPercentage']);
    assert.deepEqual(field(4), ['gstPercentage']);
    assert.deepEqual(field(5), ['expiryDate']);
    assert.deepEqual(field(6), ['expiryDate']);
    assert.deepEqual(field(7), ['manufacturingDate']);
    assert.deepEqual(field(8), ['sellingPrice']);
    assert.deepEqual(field(9), ['quantity']);
    assert.deepEqual(field(10).sort(), ['batchNumber', 'expiryDate', 'mrp', 'sellingPrice']);
    assert.equal(byRow(job, 11).status, 'valid');
    assert.match(byRow(job, 3).message, /above 100/);
    assert.equal(job.status, 'previewed');
    assert.equal(job.parsedRows, undefined, 'the cleaned file contents are never sent back');
    assert.deepEqual([await medicineCount(), await batchTotal()], before, 'a preview writes nothing to the inventory');
  });

  it('warns about unknown columns and ignores them', async () => {
    const r = await send(T.client, ['Medicine Name,Colour', 'Warned Med,red', ''].join('\r\n'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.data.warnings.some((w) => /Colour/.test(w)));
    assert.equal(r.data.summary.valid, 1);
  });

  it('detects duplicate SKUs, barcodes and batches inside the file', async () => {
    const sku = uniq('SKU');
    const job = await preview([
      { medicineName: 'Alpha Med', sku, barcode: uniq('BC'), ...batch({ batchNumber: 'A1' }) },        // 2: ok
      { medicineName: 'Alpha Med', sku, ...batch({ batchNumber: 'A2' }) },                              // 3: same medicine, 2nd batch: ok
      { medicineName: 'Beta Med', sku, ...batch() },                                                    // 4: same SKU, different medicine
      { medicineName: 'Alpha Med', sku, ...batch({ batchNumber: 'A1' }) },                              // 5: same batch twice
      { medicineName: 'Gamma Med', barcode: 'SHARED-BC' },                                           // 6
      { medicineName: 'Delta Med', barcode: 'SHARED-BC' },                                              // 7: same barcode, different medicine
      { medicineName: 'Alpha Med', sku: uniq('OTHER-SKU'), ...batch() },                                // 8: same medicine, second SKU
    ]);
    assert.equal(byRow(job, 2).status, 'valid');
    assert.equal(byRow(job, 3).status, 'valid');
    assert.match(byRow(job, 4).message, /SKU .* also used by a different medicine in row 2/);
    assert.deepEqual(byRow(job, 4).errors.map((e) => e.field), ['sku']);
    assert.match(byRow(job, 5).message, /Duplicate batch: row 2/);
    assert.equal(byRow(job, 6).status, 'valid');
    assert.match(byRow(job, 7).message, /Barcode SHARED-BC is also used by a different medicine in row 6/);
    assert.match(byRow(job, 8).message, /only one SKU/);
  });

  it('detects SKUs, barcodes and batches that already exist in the inventory', async () => {
    const created = await T.client.post('/inventory', { medicineName: 'Existing Med', sku: 'EXIST-1', barcode: 'EXIST-BC', batch: { batchNumber: 'E1', expiryDate: '2030-01-01', mrp: 10, sellingPrice: 9, initialQuantity: 5 } });
    assert.equal(created.status, 201);
    // a medicine with history is archived (not deleted) when removed
    const archived = (await T.client.post('/inventory', { medicineName: 'Archived Med', sku: 'ARCH-1', batch: { batchNumber: 'X', expiryDate: '2030-01-01', mrp: 10, sellingPrice: 9, initialQuantity: 1 } })).data;
    assert.equal((await T.client.del(`/inventory/${archived._id}`)).data.archived, true);
    const other2 = (await T.client.post('/inventory', { medicineName: 'Second Existing', barcode: 'EXIST-BC-2' })).data;
    assert.ok(other2._id);

    const job = await preview([
      { medicineName: 'Existing Med', sku: 'exist-1', ...batch({ batchNumber: 'NEW-B' }) },            // 2: existing medicine, new batch (SKU matched case-insensitively)
      { medicineName: 'Existing Med', sku: 'EXIST-1', ...batch({ batchNumber: 'E1' }) },               // 3: batch exists -> skipped
      { medicineName: 'Existing Med', sku: 'EXIST-1' },                                                // 4: medicine exists, no batch -> skipped
    ]);
    assert.equal(byRow(job, 2).status, 'valid');
    assert.equal(byRow(job, 2).action, 'add_batch');
    assert.equal(byRow(job, 3).status, 'skipped');
    assert.match(byRow(job, 3).message, /Batch E1 already exists/);
    assert.equal(byRow(job, 4).status, 'skipped');
    assert.deepEqual(job.summary, { total: 3, valid: 1, invalid: 0, skipped: 2, imported: 0, failed: 0 });

    const clashes = await preview([
      { medicineName: 'Different Name', sku: 'EXIST-1', ...batch() },                                  // 2: SKU belongs to another medicine
      { medicineName: 'Third Med', barcode: 'EXIST-BC', ...batch() },                                  // 3: barcode belongs to another medicine
      { medicineName: 'Fourth Med', sku: 'EXIST-1', barcode: 'EXIST-BC-2', ...batch() },               // 4: SKU and barcode of two different medicines
      { medicineName: 'Archived Med', sku: 'ARCH-1', ...batch() },                                     // 5: archived
    ]);
    assert.match(byRow(clashes, 2).message, /SKU EXIST-1 already belongs to the existing medicine "Existing Med"/);
    assert.match(byRow(clashes, 3).message, /Barcode EXIST-BC already belongs to the existing medicine "Existing Med"/);
    assert.equal(byRow(clashes, 4).status, 'invalid');
    assert.equal(byRow(clashes, 5).status, 'invalid');
    assert.match(byRow(clashes, 5).message, /archived/);
    assert.deepEqual(clashes.summary, { total: 4, valid: 0, invalid: 4, skipped: 0, imported: 0, failed: 0 });
  });

  it('rejects a medicine whose SKU and barcode belong to two different existing medicines', async () => {
    const job = await preview([{ medicineName: 'Existing Med', sku: 'EXIST-1', barcode: 'EXIST-BC-2', ...batch() }]);
    assert.equal(byRow(job, 2).status, 'invalid');
    assert.match(byRow(job, 2).message, /SKU EXIST-1 belongs to "Existing Med" but barcode EXIST-BC-2 belongs to "Second Existing"/);
  });

  it('matches an existing medicine by name when no SKU or barcode is given', async () => {
    await T.client.post('/inventory', { medicineName: 'Plain Named', strength: '5 mg', dosageForm: 'Tablet' });
    const job = await preview([
      { medicineName: 'plain  named', strength: '5 mg', dosageForm: 'tablet', ...batch() }, // same product
      { medicineName: 'Plain Named', strength: '10 mg', dosageForm: 'Tablet', ...batch() }, // different strength = new medicine
    ]);
    assert.equal(byRow(job, 2).action, 'add_batch');
    assert.equal(byRow(job, 3).action, 'create_medicine_with_batch');
  });
});

describe('Confirming the import', () => {
  it('imports valid rows, reports every row, and the counts add up', async () => {
    const name = uniq('Importable');
    const job = await preview([
      { medicineName: name, category: 'Imported Cat', salt: 'Imported Salt 100 mg', manufacturer: 'ACME', sku: uniq('IMP'), gstPercentage: '5', reorderLevel: '25', ...batch({ batchNumber: 'I-1', quantity: '40' }) },
      { medicineName: name, manufacturer: 'ACME', ...batch({ batchNumber: 'I-2', quantity: '60', expiryDate: '31/12/2031' }) },
      { medicineName: uniq('No Batch Med') },
      { medicineName: '', manufacturer: 'ACME' },
      { medicineName: uniq('Bad'), gstPercentage: 'x' },
    ]);
    assert.deepEqual(job.summary, { total: 5, valid: 3, invalid: 2, skipped: 0, imported: 0, failed: 0 });
    const meds0 = await medicineCount();
    const batches0 = await batchTotal();

    const done = await confirm(job._id);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const j = done.data;
    assert.equal(j.status, 'completed_with_errors');
    assert.deepEqual(j.summary, { total: 5, valid: 3, invalid: 2, skipped: 0, imported: 3, failed: 0 });
    assert.equal(j.summary.imported + j.summary.skipped + j.summary.failed + j.summary.invalid, j.summary.total, 'every row is accounted for');
    assert.deepEqual(statuses(j), ['imported', 'imported', 'imported', 'invalid', 'invalid']);
    assert.equal(j.medicinesCreated, 2);
    assert.equal(j.batchesCreated, 2);
    assert.ok(j.completedAt);
    assert.equal(j.parsedRows, undefined);

    assert.equal(await medicineCount(), meds0 + 2);
    assert.equal(await batchTotal(), batches0 + 2);
    const imported = (await T.client.get(`/inventory?search=${encodeURIComponent(name)}`)).data.items[0];
    assert.equal(imported.categoryName, 'Imported Cat');
    assert.equal(imported.compoundName, 'Imported Salt 100 mg');
    assert.equal(imported.gstPercentage, 5);
    assert.equal(imported.reorderLevel, 25);
    assert.equal(imported.totalStock, 100, 'two batches: 40 + 60');
    assert.equal(imported.batchCount, 2);
    const b2 = (await T.client.get(`/batches?search=I-2`)).data.items[0];
    assert.equal(new Date(b2.expiryDate).toISOString().slice(0, 10), '2031-12-31', 'day-first dates are read correctly');
  });

  it('writes the opening ledger entries and keeps the books reconciled', async () => {
    const job = await preview([{ medicineName: uniq('Ledgered'), ...batch({ batchNumber: 'L-1', quantity: '12' }) }]);
    await confirm(job._id);
    const b = (await T.client.get('/batches?search=L-1')).data.items[0];
    const hist = (await T.client.get(`/batches/${b._id}/movements`)).data;
    assert.equal(hist.total, 1);
    assert.deepEqual([hist.items[0].type, hist.items[0].quantity, hist.items[0].balanceAfter], ['PURCHASE', 12, 12]);
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('refuses to import while rows are invalid unless the user chooses to skip them', async () => {
    const job = await preview([{ medicineName: uniq('Good'), ...batch() }, { medicineName: '', manufacturer: 'ACME' }]);
    const meds0 = await medicineCount();
    const r = await confirm(job._id, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'IMPORT_HAS_INVALID');
    assert.equal(await medicineCount(), meds0, 'nothing was imported');
    const still = (await T.client.get(`/import/inventory/${job._id}`)).data;
    assert.equal(still.status, 'previewed', 'the preview can still be confirmed');
    assert.equal((await confirm(job._id, { skipInvalid: true })).status, 200);
    assert.equal(await medicineCount(), meds0 + 1);
  });

  it('a clean file completes with status "completed"', async () => {
    const job = await preview([{ medicineName: uniq('Clean'), ...batch() }]);
    const r = await confirm(job._id, {});
    assert.equal(r.data.status, 'completed');
    assert.deepEqual(r.data.summary, { total: 1, valid: 1, invalid: 0, skipped: 0, imported: 1, failed: 0 });
  });

  it('can be confirmed only once — also when two requests race', async () => {
    const name = uniq('Race');
    const job = await preview([{ medicineName: name, ...batch({ batchNumber: 'R-1' }) }]);
    const [a, b] = await Promise.all([confirm(job._id), confirm(job._id)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await confirm(job._id)).body.code, 'IMPORT_NOT_PENDING');
    const found = (await T.client.get(`/batches?search=${encodeURIComponent(name)}`)).data;
    assert.equal(found.total, 1, 'no duplicate batch');
  });

  it('importing the same file again creates no duplicates: everything is skipped', async () => {
    const text = csv([
      { medicineName: 'Rerun Med', sku: 'RERUN-1', ...batch({ batchNumber: 'RR-1' }) },
      { medicineName: 'Rerun Med', sku: 'RERUN-1', ...batch({ batchNumber: 'RR-2' }) },
      { medicineName: 'Rerun Plain' },
    ]);
    const first = (await send(T.client, text)).data;
    assert.equal((await confirm(first._id)).data.summary.imported, 3);
    const meds = await medicineCount();
    const batches = await batchTotal();

    const second = (await send(T.client, text)).data;
    assert.ok(second.warnings.some((w) => /already imported/.test(w)));
    assert.deepEqual(second.summary, { total: 3, valid: 0, invalid: 0, skipped: 3, imported: 0, failed: 0 });
    const done = (await confirm(second._id)).data;
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.summary, { total: 3, valid: 0, invalid: 0, skipped: 3, imported: 0, failed: 0 });
    assert.equal(await medicineCount(), meds);
    assert.equal(await batchTotal(), batches);
  });

  it('re-validates at confirm time: data that changed after the preview is not trusted', async () => {
    const sku = uniq('LATE');
    const job = await preview([{ medicineName: 'Late Med', sku, ...batch({ batchNumber: 'LATE-1' }) }]);
    assert.equal(byRow(job, 2).action, 'create_medicine_with_batch');
    // someone creates a different medicine with that SKU before the import is confirmed
    assert.equal((await T.client.post('/inventory', { medicineName: 'Squatter', sku })).status, 201);
    const done = (await confirm(job._id)).data;
    assert.equal(done.status, 'completed_with_errors');
    assert.equal(done.rows[0].status, 'invalid');
    assert.match(done.rows[0].message, /already belongs to the existing medicine "Squatter"/);
    assert.equal(done.summary.imported, 0);
    assert.equal((await T.client.get('/inventory?search=Late%20Med')).data.total, 0);
  });

  it('rolls back a medicine that fails — alone — and reports exactly which rows failed', async () => {
    const goodSku = uniq('OKM');
    const badName = uniq('Doomed');
    const job = await preview([
      { medicineName: uniq('First Good'), ...batch({ batchNumber: 'G-1' }) },
      { medicineName: badName, ...batch({ batchNumber: 'D-1' }) },
      { medicineName: badName, ...batch({ batchNumber: 'FAIL-ME' }) },
      { medicineName: 'Last Good', sku: goodSku, ...batch({ batchNumber: 'G-2' }) },
    ]);
    const meds0 = await medicineCount();
    const original = h.models.Batch.create;
    h.models.Batch.create = function patched(docs, ...rest) {
      if (Array.isArray(docs) && docs[0]?.batchNumber === 'FAIL-ME') return Promise.reject(new Error('simulated disk failure'));
      return original.call(this, docs, ...rest);
    };
    let done;
    try {
      done = (await confirm(job._id)).data;
    } finally {
      h.models.Batch.create = original;
    }
    assert.deepEqual(statuses(done), ['imported', 'failed', 'failed', 'imported']);
    assert.match(byRow(done, 3).message, /Rolled back: simulated disk failure/);
    assert.equal(done.status, 'completed_with_errors');
    assert.deepEqual(done.summary, { total: 4, valid: 4, invalid: 0, skipped: 0, imported: 2, failed: 2 });
    assert.equal(await medicineCount(), meds0 + 2, 'the doomed medicine was not left behind');
    assert.equal((await T.client.get(`/inventory?search=${badName}`)).data.total, 0);
    assert.equal((await T.client.get('/batches?search=D-1')).data.total, 0, 'its first batch was rolled back too');
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('records the import in the activity log', async () => {
    const log = JSON.stringify((await T.client.get('/activity?limit=100')).body);
    assert.match(log, /CSV import inventory\.csv/);
    assert.match(log, /Imported from CSV/);
  });
});

describe('Import history', () => {
  it('lists imports newest first with their summaries, and shows row details', async () => {
    const list = (await T.client.get('/import/inventory/history?limit=50')).data;
    assert.ok(list.total >= 5);
    assert.ok(list.items.every((j) => j.fileName && j.summary && j.status && !('rows' in j) && !('parsedRows' in j)));
    const times = list.items.map((j) => +new Date(j.createdAt));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    assert.ok(list.items[0].createdBy?.name, 'shows who ran it');

    const completed = list.items.find((j) => j.status === 'completed_with_errors');
    const detail = (await T.client.get(`/import/inventory/${completed._id}`)).data;
    assert.equal(detail.rows.length, detail.summary.total);
    assert.ok(detail.rows.every((r) => ['imported', 'skipped', 'invalid', 'failed'].includes(r.status)), 'a finished import has no undecided rows');
  });

  it('a previewed import can be cancelled and then no longer confirmed', async () => {
    const job = await preview([{ medicineName: uniq('Cancelled'), ...batch() }]);
    assert.equal((await T.client.post(`/import/inventory/${job._id}/cancel`)).data.status, 'cancelled');
    assert.equal((await confirm(job._id)).status, 409);
    assert.equal((await T.client.post(`/import/inventory/${job._id}/cancel`)).status, 409);
  });

  it('a preview older than 24 hours cannot be confirmed', async () => {
    const job = await preview([{ medicineName: uniq('Stale'), ...batch() }]);
    await h.models.ImportJob.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(job._id) }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const r = await confirm(job._id);
    assert.equal(r.status, 410);
    assert.equal(r.body.code, 'IMPORT_EXPIRED');
  });

  it('unknown or malformed ids are 404', async () => {
    assert.equal((await T.client.get('/import/inventory/not-an-id')).status, 404);
    assert.equal((await T.client.get(`/import/inventory/${'0'.repeat(24)}`)).status, 404);
    assert.equal((await confirm('not-an-id')).status, 404);
  });
});

describe('Organization isolation', () => {
  it('another organization can’t see, confirm or cancel my import', async () => {
    const job = await preview([{ medicineName: uniq('Mine'), ...batch() }]);
    assert.equal((await other.client.get(`/import/inventory/${job._id}`)).status, 404);
    assert.equal((await confirm(job._id, { skipInvalid: true }, other.client)).status, 404);
    assert.equal((await other.client.post(`/import/inventory/${job._id}/cancel`)).status, 404);
    const theirs = (await other.client.get('/import/inventory/history?limit=50')).data.items.map((j) => j._id);
    assert.ok(!theirs.includes(job._id));
    assert.equal((await confirm(job._id)).status, 200, 'and it still works for its owner');
  });

  it('the same SKU, barcode and batch number in another organization is not a duplicate', async () => {
    const rows = [{ medicineName: 'Shared Name', sku: 'SHARED-SKU', barcode: 'SHARED-BARCODE', ...batch({ batchNumber: 'SH-1' }) }];
    const mine = await preview(rows);
    assert.equal(mine.summary.valid, 1);
    await confirm(mine._id);
    const theirs = await preview(rows, other.client);
    assert.equal(theirs.summary.valid, 1, 'their inventory is empty, so nothing clashes');
    assert.equal((await confirm(theirs._id, {}, other.client)).data.summary.imported, 1);
  });

  it('imports land only in the organization that ran them', async () => {
    const name = uniq('Private');
    const job = await preview([{ medicineName: name, ...batch({ batchNumber: 'PRIV-1' }) }]);
    await confirm(job._id);
    assert.equal((await T.client.get(`/inventory?search=${name}`)).data.total, 1);
    assert.equal((await other.client.get(`/inventory?search=${name}`)).data.total, 0);
    assert.equal((await other.client.get('/batches?search=PRIV-1')).data.total, 0);
  });
});
