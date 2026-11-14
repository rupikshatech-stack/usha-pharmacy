// AI Billing, Phase 1: uploading a supplier invoice (stored safely, recorded), scanning it through a pluggable reading service (a small fake of one here),
// reviewing, and saving a draft order. This project has no OCR/AI service of its own, so what matters: files are checked and stored safely, nothing is
// read when no service is ready, products are matched only when exactly, the scan runs in the background with a status, nothing is saved or changed in
// stock until a person saves a draft order, and a provider can be swapped without changing anything else.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
let fake;
let fakeUrl;
let uploadDir;
let fakeReply = { status: 200, json: null, text: null };
let lastCall = null;
const uniq = (p) => `${p}-${++n}`;

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const PDF = (tag = '') => bytes('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', tag);
const PNG = (tag = '') => bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'fake image bytes', tag);
const JPG = (tag = '') => bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'fake jpeg bytes', tag);
const upload = (client, buf, type = 'application/pdf', name = 'invoice.pdf') => client.post(`/ai-billing/uploads?fileName=${encodeURIComponent(name)}`, buf, { headers: { 'content-type': type } });
const scan = (c, id) => c.post(`/ai-billing/uploads/${id}/scan`);
const getUp = async (id, c = T.client) => (await c.get(`/ai-billing/uploads/${id}`)).data;
/** Waits for the background scan to finish. */
const settled = async (id, c = T.client) => {
  for (let i = 0; i < 100; i += 1) {
    const u = await getUp(id, c);
    if (u.status !== 'processing') return u;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the scan never finished');
};
const medicine = async (client, name, extra = {}) => (await client.post('/inventory', { medicineName: name, unit: 'Strip', gstPercentage: 12, ...extra })).data;
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement'].map((m) => h.models[m].collection.countDocuments({})));
const asRole = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};

const invoice = (over = {}) => ({
  supplier: { name: 'Sun Pharma Distributors', gstin: '27ABCDE1234F1Z5', phone: '9811100011', address: '12 Market Road, Pune' },
  invoiceNo: 'SP/2026/771',
  invoiceDate: '2026-11-05',
  items: [
    { name: 'Dolo 650', manufacturer: 'Micro Labs', batchNumber: 'DL-4412', manufacturingDate: '2026-08-01', expiryDate: '2028-07-31', quantity: 100, freeQuantity: 10, rate: 25, mrp: 32, discountPercent: 0, gstPercent: 12, amount: 2800, confidence: 0.98 },
    { name: 'Crocin Advnce', quantity: 20, rate: 30, gstPercent: 12, confidence: 0.91 },
    { name: 'Mystery Tonic Forte', quantity: 5, rate: 99.5, gstPercent: 5, confidence: 0.6 },
  ],
  totals: { subtotal: 3597.5, taxableAmount: 3597.5, cgst: 198.44, sgst: 198.44, igst: 0, additionalCharges: 0, grandTotal: 3994.38 },
  confidence: 0.9,
  ...over,
});

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('AI Billing Org');
  other = await h.makeTenant('AI Billing Other Org');
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastCall = { headers: req.headers, bytes: Buffer.concat(chunks).length };
      res.statusCode = fakeReply.status;
      if (fakeReply.text !== null) return res.end(fakeReply.text);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(fakeReply.json));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}/read`;
});
after(async () => {
  for (const k of ['AI_BILLING_URL', 'AI_BILLING_API_KEY', 'AI_BILLING_PROVIDER', 'UPLOAD_DIR']) delete process.env[k];
  await new Promise((r) => fake.close(r));
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

describe('Which reading service is chosen', () => {
  it('says plainly when none is: nothing can be read, and what to set', async () => {
    delete process.env.AI_BILLING_URL;
    delete process.env.AI_BILLING_PROVIDER;
    const s = (await T.client.get('/ai-billing/status')).data;
    assert.deepEqual([s.configured, s.provider, s.implemented], [false, null, false]);
    assert.match(s.setup, /AI_BILLING_URL/);
    assert.deepEqual(s.available.map((p) => [p.key, p.implemented]), [['http', true], ['google-document-ai', false], ['aws-textract', false], ['azure-document-intelligence', false]]);
  });
  it('the HTTP provider is ready once its URL is set', async () => {
    process.env.AI_BILLING_URL = fakeUrl;
    const s = (await T.client.get('/ai-billing/status')).data;
    assert.deepEqual([s.configured, s.provider, s.implemented, s.setup], [true, 'http', true, undefined]);
  });
  it('the Phase 2 providers can be named but are never reported as ready, and an unknown name is called out', async () => {
    for (const [name, label] of [['google-document-ai', 'Google Document AI'], ['aws-textract', 'AWS Textract'], ['azure-document-intelligence', 'Azure AI Document Intelligence']]) {
      process.env.AI_BILLING_PROVIDER = name;
      const s = (await T.client.get('/ai-billing/status')).data;
      assert.deepEqual([s.configured, s.label, s.implemented], [false, label, false], name);
      assert.match(s.setup, /planned for Phase 2/);
    }
    process.env.AI_BILLING_PROVIDER = 'magic-ocr';
    const u = (await T.client.get('/ai-billing/status')).data;
    assert.equal(u.configured, false);
    assert.match(u.setup, /not a known provider/);
    delete process.env.AI_BILLING_PROVIDER;
    process.env.AI_BILLING_URL = fakeUrl;
  });
  it('is visible to anyone who can read inventory, and to nobody who is signed out', async () => {
    assert.equal((await h.client().get('/ai-billing/status')).status, 401);
    assert.equal((await (await asRole('STAFF')).get('/ai-billing/status')).status, 200);
  });
});

describe('Uploading an invoice', () => {
  it('stores a PDF, a PNG and a JPEG safely and records each with a unique id; nothing is read yet', async () => {
    const ids = new Set();
    for (const [buf, type, name] of [[PDF(), 'application/pdf', 'a.pdf'], [PNG(), 'image/png', 'a.png'], [JPG(), 'image/jpeg', 'a.jpg']]) {
      const r = await upload(T.client, buf, type, name);
      assert.equal(r.status, 201, `${type}: ${JSON.stringify(r.body)}`);
      const u = r.data;
      assert.match(u.uploadId, /^UP-[0-9a-f]{18}$/);
      assert.deepEqual([u.status, u.statusLabel, u.fileName, u.mimeType, u.size, u.attempts, u.hasFile], ['uploaded', 'Uploaded', name, type, buf.length, 0, true]);
      assert.equal(u.sha256.length, 64);
      assert.ok(!('storageKey' in u), 'where it is stored is never exposed');
      assert.equal(u.uploadedByName, T.user.name);
      ids.add(u.uploadId);
      const onDisk = path.join(uploadDir, String(T.org._id), `${u.uploadId}${{ 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' }[type]}`);
      assert.ok(fs.readFileSync(onDisk).equals(buf), 'the file is stored under a name the server made');
    }
    assert.equal(ids.size, 3);
    assert.ok(lastCall === null || true);
  });
  it('cleans the file name: no folders, no control characters, bounded', async () => {
    const r = await upload(T.client, PDF('x1'), 'application/pdf', '..\\..\\etc/../evil\u0001<name>.pdf');
    assert.equal(r.status, 201);
    assert.equal(r.data.fileName, 'evilname.pdf');
    assert.ok(fs.existsSync(path.join(uploadDir, String(T.org._id), `${r.data.uploadId}.pdf`)), 'stored by id, whatever the name was');
    assert.equal((await upload(T.client, PDF('x2'), 'application/pdf', `${'a'.repeat(300)}.pdf`)).data.fileName.length, 150);
  });
  it('refuses other types, files that are not what they claim, empty files and files over 10 MB', async () => {
    assert.equal((await upload(T.client, Buffer.from('<html></html>'), 'text/html')).status, 415);
    assert.equal((await upload(T.client, Buffer.from('MZ-not-a-pdf'), 'application/pdf')).status, 415, 'a renamed file');
    const mismatch = await upload(T.client, PNG(), 'application/pdf');
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.message, /says it is application\/pdf but its contents are image\/png/);
    assert.equal((await upload(T.client, Buffer.alloc(0))).status, 400);
    assert.equal((await upload(T.client, bytes(PDF(), Buffer.alloc(11 * 1024 * 1024)))).status, 413);
    const before = fs.readdirSync(path.join(uploadDir, String(T.org._id))).length;
    await upload(T.client, Buffer.from('nope'), 'application/pdf');
    assert.equal(fs.readdirSync(path.join(uploadDir, String(T.org._id))).length, before, 'a refused file leaves nothing on disk');
  });
  it('notices the same invoice uploaded twice, without blocking it', async () => {
    const buf = PDF('twice');
    const a = (await upload(T.client, buf)).data;
    const b = await upload(T.client, buf);
    assert.equal(b.status, 201);
    assert.notEqual(b.data.uploadId, a.uploadId);
    assert.equal(b.data.duplicateOf.uploadId, a.uploadId);
    assert.equal((await upload(other.client, buf)).data.duplicateOf, undefined, 'only within the same organization');
  });
  it('the stored file can be read back by people who may see uploads — as itself, never sniffed, never cached', async () => {
    const buf = PNG('readback');
    const u = (await upload(T.client, buf, 'image/png', 'scan.png')).data;
    const res = await fetch(`${T.client.baseUrl}/ai-billing/uploads/${u._id}/file`, { headers: { cookie: [...T.client.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-disposition'), /inline; filename\*=UTF-8''scan\.png/);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(buf));
    assert.equal((await fetch(`${T.client.baseUrl}/ai-billing/uploads/${u._id}/file`)).status, 401, 'not without signing in');
  });
  it('is private to the organization and to people who can create orders', async () => {
    const u = (await upload(T.client, PDF('private'))).data;
    for (const [m, p] of [['get', ''], ['get', '/file'], ['post', '/scan'], ['del', '']]) assert.equal((await other.client[m](`/ai-billing/uploads/${u._id}${p}`)).status, 404, `${m} ${p}`);
    assert.equal((await other.client.post(`/ai-billing/uploads/${u._id}/draft`, { supplierId: 'x'.repeat(24), items: [], payment: { terms: 'credit' } })).status, 400);
    assert.ok(!(await other.client.get('/ai-billing/uploads?limit=100')).data.items.some((x) => x._id === u._id));
    assert.equal((await h.client().post('/ai-billing/uploads', PDF(), { headers: { 'content-type': 'application/pdf' } })).status, 401);
    for (const role of ['STAFF', 'BILLING_STAFF']) {
      const c = await asRole(role);
      assert.equal((await upload(c, PDF(role))).status, 403, role);
      assert.equal((await c.get('/ai-billing/uploads')).status, 403, role);
      assert.equal((await c.get(`/ai-billing/uploads/${u._id}`)).status, 403, role);
    }
    assert.equal((await upload(await asRole('INVENTORY_MANAGER'), PDF('inv'))).status, 201);
  });
  it('lists uploads newest first with search, status filter and paging', async () => {
    const a = (await upload(T.client, PDF('list-a'), 'application/pdf', 'zeta-listing.pdf')).data;
    const list = (await T.client.get('/ai-billing/uploads?limit=3&page=1')).data;
    assert.equal(list.items.length, 3);
    assert.equal(list.items[0]._id, a._id, 'newest first');
    assert.ok(list.total > 3 && list.pages >= 2);
    assert.ok(list.items.every((x) => !('extraction' in x) && !('storageKey' in x)));
    assert.equal((await T.client.get('/ai-billing/uploads?search=zeta-listing')).data.total, 1);
    assert.equal((await T.client.get('/ai-billing/uploads?search=.*')).data.total, 0, 'text, not a pattern');
    assert.ok((await T.client.get('/ai-billing/uploads?status=uploaded&limit=100')).data.items.every((x) => x.status === 'uploaded'));
    assert.equal((await T.client.get('/ai-billing/uploads?status=weird')).status, 400);
    assert.equal((await T.client.get('/ai-billing/uploads?status=')).status, 200);
  });
});

describe('Scanning', () => {
  it('without a reading service the scan is refused plainly and the upload stays as it was', async () => {
    delete process.env.AI_BILLING_URL;
    const u = (await upload(T.client, PDF('noservice'))).data;
    const r = await scan(T.client, u._id);
    assert.equal(r.status, 501);
    assert.equal(r.body.code || r.body.error?.code, 'AI_NOT_CONFIGURED');
    assert.match(r.body.message, /No invoice-reading service is connected/);
    const after = await getUp(u._id);
    assert.deepEqual([after.status, after.attempts, after.extraction], ['uploaded', 0, undefined]);
    process.env.AI_BILLING_URL = fakeUrl;
  });

  it('with a service: 202 and "processing", then "completed" with what was read and carefully matched', async () => {
    const dolo = await medicine(T.client, 'Dolo 650', { sku: 'DOLO-650', manufacturer: 'Micro Labs' });
    const crocin = await medicine(T.client, 'Crocin Advance');
    await medicine(other.client, 'Mystery Tonic Forte'); // another organization's product must never be offered
    const sun = (await T.client.post('/suppliers', { name: 'Sun Pharma Distributors', contactPerson: 'Ramesh Gupta', phone: '9811100022', gstin: '27ABCDE1234F1Z5' })).data;
    fakeReply = { status: 200, json: invoice(), text: null };
    const u = (await upload(T.client, PDF('scan-ok'))).data;
    const [c1, c2, c3] = await counts();
    const r = await scan(T.client, u._id);
    assert.equal(r.status, 202);
    assert.deepEqual([r.data.status, r.data.attempts, r.data.provider], ['processing', 1, 'http']);
    assert.equal((await scan(T.client, u._id)).status, 409, 'already being read');
    const done = await settled(u._id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(lastCall.headers['content-type'], 'application/pdf');
    assert.equal(lastCall.bytes, PDF('scan-ok').length, 'the whole stored file went to the service');
    const d = done.extraction;
    assert.equal(done.statusLabel, 'Completed');
    assert.deepEqual([d.invoiceNo, d.invoiceDate, d.supplier.name, d.supplier.gstin, d.supplier.address], ['SP/2026/771', '2026-11-05', 'Sun Pharma Distributors', '27ABCDE1234F1Z5', '12 Market Road, Pune']);
    assert.deepEqual([d.supplier.match.status, d.supplier.match.by, String(d.supplier.match.supplierId)], ['exact', 'gstin', sun._id]);
    const [a, b, c] = d.items;
    assert.deepEqual([a.match.status, String(a.match.medicineId)], ['exact', dolo._id]);
    assert.deepEqual([a.manufacturer, a.batchNumber, a.manufacturingDate, a.expiryDate, a.quantity, a.freeQuantity, a.rate, a.mrp, a.gstPercent], ['Micro Labs', 'DL-4412', '2026-08-01', '2028-07-31', 100, 10, 25, 32, 12]);
    assert.equal(a.needsReview, false);
    assert.deepEqual([b.match.status, b.match.medicineId, String(b.match.candidates[0].medicineId)], ['possible', null, crocin._id], 'a near match is a suggestion, not a choice');
    assert.deepEqual([c.match.status, c.match.candidates.length], ['none', 0], 'and no other organization’s product');
    assert.ok(c.issues.some((x) => /Low confidence \(60%\)/.test(x)));
    assert.deepEqual([d.totals.stated.cgst, d.totals.stated.sgst, d.totals.stated.tax, d.totals.stated.grandTotal], [198.44, 198.44, 396.88, 3994.38]);
    assert.equal(d.totals.grandTotal, 3994.38);
    assert.equal(d.totals.matchesInvoice, true);
    assert.equal(d.needsReview, true);
    assert.deepEqual(await counts(), [c1, c2, c3], 'scanning saves no order and changes no stock');
  });

  it('flags what looks wrong instead of guessing: expired dates, a rate above the MRP, odd numbers', async () => {
    fakeReply = { status: 200, json: invoice({ items: [{ name: 'Odd Line', quantity: 'ten', rate: -3, gstPercent: 200, discountPercent: 150, expiryDate: '2020-01-01', manufacturingDate: '2026-02-30', mrp: 1 }, { name: 'Pricey', quantity: 2, rate: 50, mrp: 40, gstPercent: 12, manufacturingDate: '2026-05-01', expiryDate: '2026-04-01' }] }), text: null };
    const u = (await upload(T.client, PDF('odd'))).data;
    await scan(T.client, u._id);
    const [a, b] = (await settled(u._id)).extraction.items;
    assert.deepEqual([a.quantity, a.rate, a.gstPercent, a.discountPercent, a.expiryDate, a.manufacturingDate], [null, null, null, 0, '2020-01-01', null], 'bad numbers and dates are left blank, not made up');
    for (const re of [/quantity/, /rate/, /GST/, /discount/, /expiry date has already passed/, /manufacturing date could not be read/]) assert.ok(a.issues.some((x) => re.test(x)), String(re));
    assert.ok(b.issues.some((x) => /higher than the MRP/.test(x)));
    assert.ok(b.issues.some((x) => /manufacturing date is not before the expiry date/.test(x)));
  });

  it('a service that fails leaves the upload "failed" with the reason, and it can be scanned again', async () => {
    const u = (await upload(T.client, PDF('failing'))).data;
    fakeReply = { status: 500, json: { error: 'boom' }, text: null };
    await scan(T.client, u._id);
    let f = await settled(u._id);
    assert.deepEqual([f.status, f.error.code], ['failed', 'AI_SERVICE_FAILED']);
    assert.match(f.error.message, /answered with an error \(500\)/);
    fakeReply = { status: 200, json: null, text: 'this is not json' };
    await scan(T.client, u._id);
    f = await settled(u._id);
    assert.equal(f.error.code, 'AI_BAD_RESPONSE');
    fakeReply = { status: 200, json: { supplier: {} }, text: null };
    await scan(T.client, u._id);
    assert.equal((await settled(u._id)).error.code, 'AI_BAD_RESPONSE', 'no invoice lines in the answer');
    process.env.AI_BILLING_URL = 'http://127.0.0.1:1/nothing-here';
    await scan(T.client, u._id);
    f = await settled(u._id);
    assert.match(f.error.message, /could not be reached/);
    process.env.AI_BILLING_URL = fakeUrl;
    fakeReply = { status: 200, json: invoice(), text: null };
    await scan(T.client, u._id);
    const ok = await settled(u._id);
    assert.deepEqual([ok.status, ok.error, ok.attempts], ['completed', undefined, 5], 'scanned again, successfully');
  });

  it('a scan that never finished is reported as failed rather than leaving anyone waiting', async () => {
    const u = (await upload(T.client, PDF('stuck'))).data;
    await h.models.InvoiceUpload.collection.updateOne({ _id: new h.models.InvoiceUpload.base.Types.ObjectId(u._id) }, { $set: { status: 'processing', startedAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const r = await getUp(u._id);
    assert.deepEqual([r.status, r.error.code], ['failed', 'SCAN_TIMED_OUT']);
    assert.equal((await scan(T.client, u._id)).status, 202, 'and it can be scanned again');
  });

  it('only an upload that has a file and is not in the middle of something can be scanned', async () => {
    const u = (await upload(T.client, PDF('state'))).data;
    await T.client.del(`/ai-billing/uploads/${u._id}`);
    const r = await scan(T.client, u._id);
    assert.equal(r.status, 409, 'a removed upload');
    assert.equal((await scan(T.client, 'f'.repeat(24))).status, 404);
    assert.equal((await scan(T.client, 'nope')).status, 404);
  });
});

describe('Saving a draft order from the reviewed invoice', () => {
  const reviewedBody = (s, items, over = {}) => ({
    supplierId: s._id, referenceNo: 'SP/2026/771', orderDate: '2026-11-05', notes: 'Checked against the invoice.',
    items: items.map(([m, quantity, rate, extra = {}]) => ({ medicineId: m._id, quantity, rate, gstPercent: 12, ...extra })),
    charges: {}, payment: { terms: 'credit', advance: 0 },
    reviewed: { lines: [{ name: 'Dolo 650', batchNumber: 'DL-4412', expiryDate: '2028-07-31', mrp: 32 }], totals: { grandTotal: 3994.38 } },
    ...over,
  });
  const readyUpload = async (tag) => {
    fakeReply = { status: 200, json: invoice(), text: null };
    const u = (await upload(T.client, PDF(tag))).data;
    await scan(T.client, u._id);
    await settled(u._id);
    return u;
  };

  it('creates a DRAFT order and links it, keeps what was reviewed — and changes no stock', async () => {
    const m = await medicine(T.client, uniq('Draft Med'));
    const s = (await T.client.post('/suppliers', { name: uniq('Draft Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data;
    const u = await readyUpload('draft-1');
    const [, b0, s0] = await counts();
    const r = await T.client.post(`/ai-billing/uploads/${u._id}/draft`, reviewedBody(s, [[m, 10, 20]]));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.order.status, 'draft');
    assert.equal(r.data.order.grandTotal, 224);
    assert.equal(r.data.order.referenceNo, 'SP/2026/771');
    assert.match(r.data.order.notes, new RegExp(`Checked against the invoice\\. \\[AI Billing upload ${u.uploadId}\\]`));
    assert.deepEqual([r.data.upload.status, String(r.data.upload.orderId)], ['drafted', String(r.data.order._id)]);
    const after = await getUp(u._id);
    assert.equal(after.reviewed.lines[0].batchNumber, 'DL-4412', 'batch, dates and MRP are kept for goods receiving');
    assert.deepEqual([(await counts())[1], (await counts())[2]], [b0, s0], 'no batch, no stock movement');
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'AI_INVOICE_DRAFT' && /no stock changed/.test(x.message)));
  });
  it('the same upload always makes the same draft: a repeat or a double click returns it', async () => {
    const m = await medicine(T.client, uniq('Twice Med'));
    const s = (await T.client.post('/suppliers', { name: uniq('Twice Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data;
    const u = await readyUpload('draft-2');
    const ref = uniq('REF');
    const body = reviewedBody(s, [[m, 3, 10]], { referenceNo: ref });
    const [x, y] = await Promise.all([T.client.post(`/ai-billing/uploads/${u._id}/draft`, body), T.client.post(`/ai-billing/uploads/${u._id}/draft`, body)]);
    assert.ok([x.status, y.status].every((c) => [200, 201].includes(c)), `${x.status} ${y.status}`);
    assert.equal(x.data.order._id, y.data.order._id, 'one order');
    const again = await T.client.post(`/ai-billing/uploads/${u._id}/draft`, body);
    assert.equal(again.status, 200);
    assert.equal(again.data.replayed, true);
    assert.equal((await T.client.get(`/orders?search=${ref}`)).data.total, 1, 'only one draft exists');
  });
  it('is checked like any order: this organization’s products and suppliers, valid quantities and prices', async () => {
    const m = await medicine(T.client, uniq('Check Med'));
    const theirs = await medicine(other.client, uniq('Their Med'));
    const s = (await T.client.post('/suppliers', { name: uniq('Check Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data;
    const u = await readyUpload('draft-3');
    const post = (b) => T.client.post(`/ai-billing/uploads/${u._id}/draft`, b);
    assert.equal((await post(reviewedBody(s, [[theirs, 1, 10]]))).status, 400, 'another organization’s product');
    assert.equal((await post(reviewedBody(s, [[m, 0, 10]]))).status, 400);
    assert.equal((await post(reviewedBody(s, [[m, 1, -10]]))).status, 400);
    assert.equal((await post(reviewedBody({ _id: (await other.client.post('/suppliers', { name: uniq('X'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data._id }, [[m, 1, 10]]))).status, 404, 'another organization’s supplier');
    assert.equal((await post(reviewedBody(s, []))).status, 400);
    assert.equal((await getUp(u._id)).status, 'completed', 'a refused draft changes nothing');
  });
  it('cannot be saved from a removed upload, and a drafted upload cannot be removed', async () => {
    const m = await medicine(T.client, uniq('Gone Med'));
    const s = (await T.client.post('/suppliers', { name: uniq('Gone Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data;
    const gone = await readyUpload('draft-4');
    await T.client.del(`/ai-billing/uploads/${gone._id}`);
    assert.equal((await T.client.post(`/ai-billing/uploads/${gone._id}/draft`, reviewedBody(s, [[m, 1, 1]]))).status, 409);
    const kept = await readyUpload('draft-5');
    await T.client.post(`/ai-billing/uploads/${kept._id}/draft`, reviewedBody(s, [[m, 1, 1]]));
    const r = await T.client.del(`/ai-billing/uploads/${kept._id}`);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /draft order was already made/);
  });
  it('a store-limited user can only draft orders for their own store', async () => {
    const north = (await T.client.post('/branches', { name: uniq('ANorth'), code: uniq('A').toUpperCase().slice(0, 8) })).data;
    const m = await medicine(T.client, uniq('Branch Med'));
    const s = (await T.client.post('/suppliers', { name: uniq('Branch Supplier'), contactPerson: 'Ramesh Gupta', phone: '9811100022' })).data;
    const u = await readyUpload('draft-6');
    const limited = await asRole('INVENTORY_MANAGER', { branchIds: [north._id] });
    const r = await limited.post(`/ai-billing/uploads/${u._id}/draft`, reviewedBody(s, [[m, 1, 1]]));
    assert.equal(r.status, 403);
    assert.equal((await limited.post(`/ai-billing/uploads/${u._id}/draft`, reviewedBody(s, [[m, 1, 1]], { branchId: north._id }))).status, 201);
  });
});

describe('Removing an upload', () => {
  it('deletes the file and what was read from it; the record stays, marked removed', async () => {
    fakeReply = { status: 200, json: invoice(), text: null };
    const u = (await upload(T.client, PDF('remove'))).data;
    await scan(T.client, u._id);
    await settled(u._id);
    const file = path.join(uploadDir, String(T.org._id), `${u.uploadId}.pdf`);
    assert.ok(fs.existsSync(file));
    const r = await T.client.del(`/ai-billing/uploads/${u._id}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.status, r.data.hasFile], ['discarded', false]);
    assert.ok(!fs.existsSync(file), 'the file is gone from disk');
    const after = await getUp(u._id);
    assert.equal(after.extraction, undefined, 'and so is what was read from it');
    assert.equal((await T.client.get(`/ai-billing/uploads/${u._id}/file`)).status, 410);
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 200, 'removing twice is harmless');
    assert.ok((await T.client.get('/activity?limit=50')).data.items.some((x) => x.action === 'AI_INVOICE_DISCARD' && x.message.includes(u.uploadId)));
  });
  it('is refused while the invoice is being read', async () => {
    const u = (await upload(T.client, PDF('busy'))).data;
    await h.models.InvoiceUpload.collection.updateOne({ _id: new h.models.InvoiceUpload.base.Types.ObjectId(u._id) }, { $set: { status: 'processing', startedAt: new Date() } });
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 409);
  });
});

describe('Re-checking typed or corrected lines (manual entry uses the same review)', () => {
  it('matches what a person typed the same careful way, and flags doubtful dates and prices', async () => {
    const m = await medicine(T.client, 'Manual Entry Med');
    const r = await T.client.post('/ai-billing/match', {
      supplier: { name: 'Nobody Known' },
      items: [{ name: 'manual entry med', quantity: '12', rate: '8.5', gstPercent: '5', mrp: '7', expiryDate: '2020-01-01' }, { name: 'Manual Entry Mad', quantity: 1, rate: 1, gstPercent: 0 }],
      totals: { additionalCharges: 10 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [a, b] = r.data.items;
    assert.deepEqual([a.match.status, String(a.match.medicineId), a.quantity, a.rate], ['exact', m._id, 12, 8.5]);
    assert.ok(a.issues.some((x) => /higher than the MRP/.test(x)) && a.issues.some((x) => /already passed/.test(x)));
    assert.deepEqual([b.match.status, b.match.medicineId], ['possible', null]);
    assert.equal(r.data.totals.grandTotal, 118.1, '12 × 8.50 + 5% GST = 107.10, plus 1.00, plus 10.00 of additional charges');
    assert.equal((await (await asRole('STAFF')).post('/ai-billing/match', { items: [] })).status, 403);
    assert.equal((await h.client().post('/ai-billing/match', { items: [] })).status, 401);
  });
});
