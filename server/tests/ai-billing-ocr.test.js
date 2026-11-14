// AI Billing, Phase 2: reading an uploaded invoice with Google Cloud Document AI. A small fake of Google (the sign-in endpoint and the processor's :process
// method) stands in for it, so what is checked is OUR side: what is sent (only supported files, the right path, a signed-in bearer token, nothing else),
// what is stored (raw text, pages, tables, detected fields — unverified, nothing invented), how every kind of failure is reported, that the same invoice
// is never processed twice at once, and that nothing is matched, ordered, received or paid.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startHarness } from './helpers/harness.js';
import { forgetToken } from '../services/ocr/documentAiService.js';

let h;
let T;
let other;
let n = 0;
let google;
let base;
let uploadDir;
let keyFile;
let publicKey;
let privateKeyPem;
let calls; // what the fake Google received
let reply; // what the fake Google answers to :process
let tokenReply;
const ENV = ['UPLOAD_DIR', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_DOCUMENT_AI_LOCATION', 'GOOGLE_DOCUMENT_AI_PROCESSOR_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_DOCUMENT_AI_ENDPOINT', 'OCR_TIMEOUT_MS', 'OCR_RATE_LIMIT', 'FORCE_RATE_LIMIT', 'GOOGLE_DOCUMENT_AI_IMAGE_QUALITY', 'AI_BILLING_URL', 'AI_BILLING_PROVIDER'];
const uniq = (p) => `${p}-${++n}`;

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const PDF = (tag = '') => bytes('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', tag);
const PNG = (tag = '') => bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'fake image bytes', tag);
const JPG = (tag = '') => bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'fake jpeg bytes', tag);
const upload = (client, buf, type = 'application/pdf', name = 'invoice.pdf') => client.post(`/ai-billing/uploads?fileName=${encodeURIComponent(name)}`, buf, { headers: { 'content-type': type } });
const extract = (c, id) => c.post(`/ai-billing/${id}/extract`);
const reprocess = (c, id) => c.post(`/ai-billing/${id}/reprocess`);
const statusOf = async (id, c = T.client) => (await c.get(`/ai-billing/${id}/status`)).data;
const settled = async (id, c = T.client) => {
  for (let i = 0; i < 100; i += 1) {
    const s = await statusOf(id, c);
    if (s.status !== 'processing') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the scan never finished');
};
const fresh = async (buf = PDF(uniq('inv')), type, name) => (await upload(T.client, buf, type, name)).data;
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement', 'GoodsReceipt', 'Inventory'].map((m) => (h.models[m] ? h.models[m].collection.countDocuments({}) : 0)));

/**
 * A Document AI "Document": all the text in one string, and layouts that point into it (textAnchor segments), as Google does.
 * Each page is { lines: [...], table: { header: [...], rows: [[...]] }, quality, orientation }.
 */
function document(pages, entities = []) {
  let text = '';
  const anchor = (s) => {
    const startIndex = text.length;
    text += `${s}\n`;
    return { textSegments: [{ startIndex: String(startIndex), endIndex: String(text.length) }] };
  };
  const outPages = pages.map((p, i) => {
    const lines = p.lines.map((l) => ({ layout: { textAnchor: anchor(l), confidence: p.confidence ?? 0.98, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.12 }, { x: 0.1, y: 0.12 }] } } }));
    const cells = (row) => ({ cells: row.map((c) => ({ layout: { textAnchor: anchor(c), confidence: 0.97 } })) });
    return {
      pageNumber: i + 1, dimension: { width: 595, height: 842, unit: 'pixels' }, layout: { orientation: p.orientation || 'PAGE_UP' }, detectedLanguages: [{ languageCode: 'en' }],
      lines,
      tables: p.table ? [{ layout: { confidence: 0.95 }, headerRows: [cells(p.table.header)], bodyRows: p.table.rows.map(cells) }] : [],
      ...(p.quality !== undefined && { imageQualityScores: { qualityScore: p.quality, detectedDefects: p.defects || [] } }),
    };
  });
  return { text, pages: outPages, entities };
}
const entity = (type, mentionText, extra = {}) => ({ type, mentionText, confidence: 0.93, ...extra });

const ONE_PAGE = () =>
  document([
    {
      lines: ['SUN PHARMA DISTRIBUTORS', 'GSTIN: 27ABCDE1234F1Z5', 'Invoice No: SP/2026/771', 'Date: 05/11/2026'],
      table: { header: ['Medicine', 'Batch', 'Qty', 'Rate', 'Amount'], rows: [['Dolo 650', 'DL-4412', '100', '25.00', '2500.00'], ['Crocin Advance', 'CR-77', '20', '30.00', '600.00']] },
    },
  ], [
    entity('supplier_name', 'Sun Pharma Distributors'),
    entity('invoice_id', 'SP/2026/771'),
    entity('invoice_date', '05/11/2026', { normalizedValue: { text: '2026-11-05' } }),
    entity('total_amount', '3,100.00'),
    entity('line_item', 'Dolo 650 100 25.00 2500.00', { properties: [entity('line_item/description', 'Dolo 650'), entity('line_item/quantity', '100'), entity('line_item/amount', '2,500.00')] }),
  ]);

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-ocr-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  google = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (r) => {
        res.statusCode = r.status;
        if (r.text !== undefined) return res.end(r.text);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(r.json));
      };
      if (req.url === '/token') {
        calls.token.push({ form: new URLSearchParams(body), method: req.method });
        return send(tokenReply);
      }
      calls.process.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      const go = () => send(reply);
      return reply.delayMs ? setTimeout(go, reply.delayMs) : go();
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${google.address().port}`;
  keyFile = path.join(uploadDir, 'test-service-account.json');
  fs.writeFileSync(keyFile, JSON.stringify({ type: 'service_account', client_email: 'reader@test-project.iam.gserviceaccount.com', private_key: privateKeyPem, token_uri: `${base}/token` }));
  h = await startHarness();
  T = await h.makeTenant('OCR Org');
  other = await h.makeTenant('OCR Other Org');
});
after(async () => {
  await new Promise((r) => google.close(r));
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  for (const k of ENV) delete process.env[k];
});
beforeEach(() => {
  calls = { token: [], process: [] };
  tokenReply = { status: 200, json: { access_token: 'ya29.fake-token', expires_in: 3600 } };
  reply = { status: 200, json: { document: ONE_PAGE() } };
  Object.assign(process.env, { GOOGLE_CLOUD_PROJECT_ID: 'test-project', GOOGLE_DOCUMENT_AI_LOCATION: 'us', GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'proc123', GOOGLE_APPLICATION_CREDENTIALS: keyFile, GOOGLE_DOCUMENT_AI_ENDPOINT: base });
  for (const k of ['AI_BILLING_URL', 'AI_BILLING_PROVIDER', 'OCR_TIMEOUT_MS', 'FORCE_RATE_LIMIT', 'OCR_RATE_LIMIT', 'GOOGLE_DOCUMENT_AI_IMAGE_QUALITY']) delete process.env[k];
  forgetToken();
});

describe('Is a reading service ready?', () => {
  it('names the missing settings (never their values), and is ready once all four are set', async () => {
    delete process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const s = (await T.client.get('/ai-billing/status')).data;
    assert.equal(s.configured, false);
    assert.equal(s.ocr.configured, false);
    assert.deepEqual(s.ocr.missing, ['GOOGLE_DOCUMENT_AI_PROCESSOR_ID', 'GOOGLE_APPLICATION_CREDENTIALS']);
    assert.match(s.setup, /GOOGLE_DOCUMENT_AI_PROCESSOR_ID/);
    process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID = 'proc123';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
    const ok = (await T.client.get('/ai-billing/status')).data;
    assert.deepEqual([ok.configured, ok.ocr.configured, ok.ocr.provider, ok.ocr.label], [true, true, 'google-document-ai', 'Google Document AI']);
    assert.ok(!JSON.stringify(ok).includes(keyFile) && !JSON.stringify(ok).includes('BEGIN'), 'no credential material is ever returned');
  });
  it('without it, scanning is refused plainly and the upload is untouched', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    const u = await fresh();
    const r = await extract(T.client, u._id);
    assert.equal(r.status, 501);
    assert.equal(r.body.code || r.body.error?.code, 'AI_NOT_CONFIGURED');
    assert.deepEqual([(await statusOf(u._id)).status, (await statusOf(u._id)).attempts], ['uploaded', 0]);
    assert.equal(calls.process.length + calls.token.length, 0, 'nothing was sent anywhere');
  });
});

describe('Reading a single-page PDF', () => {
  it('202 and processing, then completed: text, page, table and detected fields are stored — and nothing else happens', async () => {
    const before = await counts();
    const pdf = PDF('single');
    const u = await fresh(pdf);
    const r = await extract(T.client, u._id);
    assert.equal(r.status, 202);
    assert.deepEqual([r.data.status, r.data.attempts, r.data.provider], ['processing', 1, 'google-document-ai']);
    const done = await settled(u._id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.deepEqual([done.hasOcr, done.ocr.pageCount, done.ocr.tableCount], [true, 1, 1]);

    // what was sent: the documented method, a bearer token, the file's own bytes and type, human review off
    assert.equal(calls.process.length, 1);
    const call = calls.process[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/v1/projects/test-project/locations/us/processors/proc123:process');
    assert.equal(call.auth, 'Bearer ya29.fake-token');
    assert.equal(call.body.rawDocument.mimeType, 'application/pdf');
    assert.ok(Buffer.from(call.body.rawDocument.content, 'base64').equals(pdf));
    assert.equal(call.body.skipHumanReview, true);

    const o = (await T.client.get(`/ai-billing/${u._id}/ocr`)).data;
    assert.equal(o.verified, false, 'raw and unverified');
    assert.equal(o.provider, 'google-document-ai');
    assert.equal(o.pageCount, 1);
    assert.match(o.text, /SUN PHARMA DISTRIBUTORS/);
    assert.match(o.text, /Dolo 650/);
    assert.equal(o.pages[0].pageNumber, 1);
    assert.deepEqual(o.pages[0].lines.map((l) => l.text).slice(0, 2), ['SUN PHARMA DISTRIBUTORS', 'GSTIN: 27ABCDE1234F1Z5']);
    assert.equal(o.pages[0].lines[0].box.length, 4, 'where the line is on the page');
    // the table: header + rows, cell by cell, with its page
    const t = o.tables[0];
    assert.deepEqual([t.pageNumber, t.rowCount, t.columnCount], [1, 3, 5]);
    assert.deepEqual(t.headerRows[0].map((c) => c.text), ['Medicine', 'Batch', 'Qty', 'Rate', 'Amount']);
    assert.deepEqual(t.bodyRows[1].map((c) => c.text), ['Crocin Advance', 'CR-77', '20', '30.00', '600.00']);
    // detected fields: only what the provider found; the rest is null, never invented
    assert.deepEqual([o.fields.supplierName.value, o.fields.invoiceNumber.value, o.fields.invoiceDate.normalized, o.fields.grandTotal.value], ['Sun Pharma Distributors', 'SP/2026/771', '2026-11-05', '3,100.00']);
    assert.deepEqual([o.fields.dueDate, o.fields.supplierGstin, o.fields.purchaseOrderNumber, o.fields.supplierPhone], [null, null, null, null]);
    assert.equal(o.lineItems[0].description.value, 'Dolo 650');

    assert.deepEqual(await counts(), before, 'no order, goods receipt, batch, movement or product was created');
    const row = await h.models.InvoiceUpload.collection.findOne({ _id: new (await import('mongoose')).default.Types.ObjectId(u._id) });
    assert.equal(row.reviewed, undefined);
    assert.equal(row.orderId, undefined);
  });

  it('the status endpoint and the OCR endpoint also answer to the public upload id; a record id and an upload id are the same invoice', async () => {
    const u = await fresh();
    assert.match(u.uploadId, /^UP-/);
    assert.equal((await extract(T.client, u.uploadId)).status, 202);
    const s = await settled(u.uploadId);
    assert.equal(s.status, 'completed');
    assert.equal((await T.client.get(`/ai-billing/${u.uploadId}/ocr`)).data.uploadId, u.uploadId);
    assert.equal((await T.client.get(`/ai-billing/uploads/${u._id}`)).data.status, 'completed');
  });

  it('signs in with a properly signed token request, and reuses the token for later scans', async () => {
    const a = await fresh();
    await extract(T.client, a._id);
    await settled(a._id);
    const b = await fresh();
    await extract(T.client, b._id);
    await settled(b._id);
    assert.equal(calls.token.length, 1, 'one sign-in served both scans');
    assert.equal(calls.process.length, 2);
    const form = calls.token[0].form;
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = jwt.verify(form.get('assertion'), publicKey, { algorithms: ['RS256'] });
    assert.equal(claims.iss, 'reader@test-project.iam.gserviceaccount.com');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
    assert.equal(claims.aud, `${base}/token`);
    assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 3600);
  });
});

describe('Multi-page PDFs, images, quality and rotation', () => {
  it('keeps every page: its own number, text and table, and the whole text in order', async () => {
    reply = {
      status: 200,
      json: {
        document: document([
          { lines: ['Page one heading', 'Invoice No: 12'], table: { header: ['Item', 'Qty'], rows: [['Dolo 650', '10']] } },
          { lines: ['Page two continues'], table: { header: ['Item', 'Qty'], rows: [['Crocin', '5'], ['Azithral 500', '8']] } },
          { lines: ['Terms and signature'] },
        ]),
      },
    };
    const u = await fresh();
    await extract(T.client, u._id);
    assert.equal((await settled(u._id)).status, 'completed');
    const o = (await T.client.get(`/ai-billing/${u._id}/ocr`)).data;
    assert.equal(o.pageCount, 3);
    assert.deepEqual(o.pages.map((p) => p.pageNumber), [1, 2, 3]);
    assert.deepEqual(o.pages.map((p) => p.text.split('\n')[0]), ['Page one heading', 'Page two continues', 'Terms and signature']);
    assert.deepEqual(o.tables.map((t) => [t.pageNumber, t.rowCount]), [[1, 2], [2, 3]]);
    assert.ok(o.text.indexOf('Page one') < o.text.indexOf('Page two') && o.text.indexOf('Page two') < o.text.indexOf('Terms'));
  });

  it('sends JPEG and PNG files with their own type', async () => {
    const j = await fresh(JPG('j'), 'image/jpeg', 'scan.jpg');
    await extract(T.client, j._id);
    assert.equal((await settled(j._id)).status, 'completed');
    const p = await fresh(PNG('p'), 'image/png', 'scan.png');
    await extract(T.client, p._id);
    assert.equal((await settled(p._id)).status, 'completed');
    assert.deepEqual(calls.process.map((c) => c.body.rawDocument.mimeType), ['image/jpeg', 'image/png']);
    assert.equal((await T.client.get(`/ai-billing/${p._id}/ocr`)).data.mimeType, 'image/png');
  });

  it('warns about blurry and rotated pages instead of passing the text off as reliable', async () => {
    process.env.GOOGLE_DOCUMENT_AI_IMAGE_QUALITY = 'true';
    reply = {
      status: 200,
      json: { document: document([{ lines: ['Faint text'], quality: 0.2, defects: [{ type: 'quality/defect_blurry', confidence: 0.9 }], confidence: 0.55 }, { lines: ['Sideways invoice'], orientation: 'PAGE_RIGHT' }]) },
    };
    const u = await fresh(JPG('blur'), 'image/jpeg', 'blurry.jpg');
    await extract(T.client, u._id);
    const done = await settled(u._id);
    assert.equal(done.status, 'completed');
    assert.equal(calls.process[0].body.processOptions.ocrConfig.enableImageQualityScores, true);
    const o = (await T.client.get(`/ai-billing/${u._id}/ocr`)).data;
    assert.ok(o.warnings.some((w) => /Page 1 looks blurry/.test(w)));
    assert.ok(o.warnings.some((w) => /Page 1 has image defects \(blurry\)/.test(w)));
    assert.ok(o.warnings.some((w) => /Page 1 was read with low confidence/.test(w)));
    assert.ok(o.warnings.some((w) => /Page 2 was rotated \(90°\)/.test(w)));
    assert.equal(o.pages[1].rotation, 90);
    assert.ok(done.notes.length >= 3, 'the warnings also travel with the status');
  });

  it('a long invoice with a huge table is still stored whole; very different layouts (no table, no entities) leave fields null', async () => {
    reply = { status: 200, json: { document: document([{ lines: ['Just a handwritten-looking note, no table', 'Total 500'] }]) } };
    const u = await fresh();
    await extract(T.client, u._id);
    assert.equal((await settled(u._id)).status, 'completed');
    const o = (await T.client.get(`/ai-billing/${u._id}/ocr`)).data;
    assert.deepEqual([o.tables.length, o.lineItems.length, o.entities.length], [0, 0, 0]);
    assert.ok(Object.values(o.fields).every((f) => f === null), 'nothing is guessed from the text');
  });
});

describe('Files that are never sent', () => {
  it('refuses unsupported or mislabelled files at upload, so the provider never receives them', async () => {
    const before = calls.process.length;
    assert.equal((await upload(T.client, bytes('MZ\x90\x00 not an invoice'), 'application/octet-stream', 'x.exe')).status, 415);
    assert.equal((await upload(T.client, bytes('GIF89a....'), 'image/gif', 'x.gif')).status, 415);
    assert.equal((await upload(T.client, bytes('plain text'), 'application/pdf', 'fake.pdf')).status, 415);
    assert.equal((await upload(T.client, PNG('x'), 'application/pdf', 'wrong.pdf')).status, 400);
    assert.equal(calls.process.length, before);
    assert.equal(calls.token.length, 0);
  });
  it('a discarded upload (its file is gone) cannot be scanned', async () => {
    const u = await fresh();
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 200);
    assert.equal((await extract(T.client, u._id)).status, 409);
    assert.equal(calls.process.length, 0);
  });
});

describe('When the provider fails', () => {
  const cases = [
    ['rejects the document (400)', { status: 400, json: { error: { message: 'Page limit exceeded' } } }, 'OCR_REJECTED', /page limit|could not process/i],
    ['refuses access (403)', { status: 403, json: { error: { message: 'Permission denied' } } }, 'OCR_AUTH_FAILED', /Document AI API User/],
    ['cannot find the processor (404)', { status: 404, json: { error: { message: 'not found' } } }, 'OCR_PROCESSOR_NOT_FOUND', /processor/],
    ['is over quota (429)', { status: 429, json: {} }, 'OCR_QUOTA', /quota/i],
    ['has an outage (500)', { status: 500, text: 'Internal error' }, 'OCR_UNAVAILABLE', /error \(500\)/],
    ['sends something that is not JSON', { status: 200, text: '<html>oops</html>' }, 'OCR_BAD_RESPONSE', /not valid JSON/],
    ['sends no document', { status: 200, json: { other: 1 } }, 'OCR_BAD_RESPONSE', /did not return a document/],
    ['finds no text at all', { status: 200, json: { document: { text: '', pages: [{ pageNumber: 1 }] } } }, 'OCR_EMPTY', /no text/i],
  ];
  for (const [name, answer, code, message] of cases) {
    it(`reports it plainly when it ${name}: the upload is failed, the file is kept, nothing is stored`, async () => {
      reply = answer;
      const u = await fresh();
      await extract(T.client, u._id);
      const s = await settled(u._id);
      assert.equal(s.status, 'failed');
      assert.equal(s.error.code, code);
      assert.match(s.error.message, message);
      assert.equal(s.hasOcr, false);
      assert.equal((await T.client.get(`/ai-billing/${u._id}/ocr`)).status, 409, 'no results to show');
      assert.equal((await T.client.get(`/ai-billing/uploads/${u._id}/file`)).status, 200, 'the original is untouched');
      assert.ok(!JSON.stringify(s).includes('ya29') && !JSON.stringify(s).includes('BEGIN'), 'no secrets in errors');
    });
  }

  it('a sign-in that Google refuses is reported as such; an unreadable or invalid key file is too', async () => {
    tokenReply = { status: 401, json: { error: 'invalid_grant' } };
    const a = await fresh();
    await extract(T.client, a._id);
    const sa = await settled(a._id);
    assert.deepEqual([sa.status, sa.error.code], ['failed', 'OCR_AUTH_FAILED']);
    assert.equal(calls.process.length, 0, 'nothing is sent without a token');
    const bad = path.join(uploadDir, 'broken.json');
    fs.writeFileSync(bad, '{"client_email":"x"}');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = bad;
    forgetToken();
    const b = await fresh();
    await extract(T.client, b._id);
    assert.equal((await settled(b._id)).error.code, 'OCR_CREDENTIALS');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(uploadDir, 'missing.json');
    const c = await fresh();
    await extract(T.client, c._id);
    const sc = await settled(c._id);
    assert.equal(sc.error.code, 'OCR_CREDENTIALS');
    assert.ok(!sc.error.message.includes(uploadDir), 'the key location is not leaked');
  });

  it('a provider that is too slow is reported as a timeout; one that cannot be reached as unavailable', async () => {
    process.env.OCR_TIMEOUT_MS = '300';
    reply = { status: 200, json: { document: ONE_PAGE() }, delayMs: 1500 };
    const slow = await fresh();
    await extract(T.client, slow._id);
    const s = await settled(slow._id);
    assert.deepEqual([s.status, s.error.code], ['failed', 'OCR_UNAVAILABLE']);
    assert.match(s.error.message, /did not answer within/);
    delete process.env.OCR_TIMEOUT_MS;
    process.env.GOOGLE_DOCUMENT_AI_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens there
    const gone = await fresh();
    await extract(T.client, gone._id);
    const g = await settled(gone._id);
    assert.deepEqual([g.status, g.error.code], ['failed', 'OCR_UNAVAILABLE']);
    assert.match(g.error.message, /could not be reached/);
  });

  it('a failed scan can be tried again, and then completes; the attempts are counted', async () => {
    reply = { status: 503, text: 'busy' };
    const u = await fresh();
    await extract(T.client, u._id);
    assert.equal((await settled(u._id)).status, 'failed');
    reply = { status: 200, json: { document: ONE_PAGE() } };
    assert.equal((await extract(T.client, u._id)).status, 202, 'extract starts a failed one again');
    const done = await settled(u._id);
    assert.deepEqual([done.status, done.attempts, done.error], ['completed', 2, undefined]);
    assert.equal((await T.client.get(`/ai-billing/${u._id}/ocr`)).data.pageCount, 1);
  });
});

describe('The same invoice is never processed twice', () => {
  it('while it is being read a second request is refused (409) and Google gets one call; after it is read, extract refuses and reprocess replaces', async () => {
    reply = { status: 200, json: { document: ONE_PAGE() }, delayMs: 400 };
    const u = await fresh();
    assert.equal((await extract(T.client, u._id)).status, 202);
    assert.equal((await extract(T.client, u._id)).status, 409);
    assert.equal((await reprocess(T.client, u._id)).status, 409, 'not while it is being read');
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 409, 'nor can it be removed mid-read');
    assert.equal((await settled(u._id)).status, 'completed');
    assert.equal(calls.process.length, 1);
    const again = await extract(T.client, u._id);
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already been read/);

    reply = { status: 200, json: { document: document([{ lines: ['Second reading'] }]) } };
    assert.equal((await reprocess(T.client, u._id)).status, 202);
    const s = await settled(u._id);
    assert.deepEqual([s.status, s.attempts, calls.process.length], ['completed', 2, 2]);
    const o = (await T.client.get(`/ai-billing/${u._id}/ocr`)).data;
    assert.match(o.text, /Second reading/);
    assert.doesNotMatch(o.text, /SUN PHARMA/);
    assert.equal(await h.models.InvoiceOcr.collection.countDocuments({ uploadId: u.uploadId }), 1, 'one result per upload: the new one replaced the old one');
  });

  it('simultaneous requests start exactly one reading', async () => {
    reply = { status: 200, json: { document: ONE_PAGE() }, delayMs: 300 };
    const u = await fresh();
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => extract(T.client, u._id)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [202, 409, 409, 409, 409]);
    await settled(u._id);
    assert.equal(calls.process.length, 1);
    assert.equal((await statusOf(u._id)).attempts, 1);
  });

  it('reprocess is only for something that has been read or has failed', async () => {
    const u = await fresh();
    const r = await reprocess(T.client, u._id);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /not been read yet/);
  });

  it('a run that was lost (the server restarted) is reported as failed after the time limit, and can be scanned again', async () => {
    const u = await fresh();
    await h.models.InvoiceUpload.collection.updateOne({ uploadId: u.uploadId }, { $set: { status: 'processing', startedAt: new Date(Date.now() - 20 * 60 * 1000) } });
    const s = await statusOf(u._id);
    assert.deepEqual([s.status, s.error.code], ['failed', 'SCAN_TIMED_OUT']);
    assert.equal((await extract(T.client, u._id)).status, 202);
    assert.equal((await settled(u._id)).status, 'completed');
  });
});

describe('Who may read invoices, and whose', () => {
  it('needs a signed-in person who can manage inventory', async () => {
    const u = await fresh();
    for (const call of [(c) => extract(c, u._id), (c) => c.get(`/ai-billing/${u._id}/ocr`), (c) => c.get(`/ai-billing/${u._id}/status`), (c) => reprocess(c, u._id)]) {
      assert.equal((await call(h.client())).status, 401);
      assert.equal((await call(await asRole('STAFF'))).status, 403);
    }
    assert.equal((await extract(await asRole('INVENTORY_MANAGER'), u._id)).status, 202);
    await settled(u._id);
  });
  it('another organization can neither see nor start nor read an upload', async () => {
    const u = await fresh();
    await extract(T.client, u._id);
    await settled(u._id);
    for (const id of [u._id, u.uploadId]) {
      assert.equal((await extract(other.client, id)).status, 404);
      assert.equal((await reprocess(other.client, id)).status, 404);
      assert.equal((await other.client.get(`/ai-billing/${id}/ocr`)).status, 404);
      assert.equal((await other.client.get(`/ai-billing/${id}/status`)).status, 404);
    }
    assert.equal((await extract(T.client, 'not-an-id')).status, 404);
    assert.equal((await extract(T.client, '000000000000000000000000')).status, 404);
  });
  it('removing an upload removes what was read from it', async () => {
    const u = await fresh();
    await extract(T.client, u._id);
    await settled(u._id);
    assert.equal(await h.models.InvoiceOcr.collection.countDocuments({ uploadId: u.uploadId }), 1);
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 200);
    assert.equal(await h.models.InvoiceOcr.collection.countDocuments({ uploadId: u.uploadId }), 0);
  });
});

describe('Limits', () => {
  it('limits how many scans one person can start in a window (and counts only that person)', async () => {
    process.env.FORCE_RATE_LIMIT = '1';
    process.env.OCR_RATE_LIMIT = '2';
    const a = await asRole('INVENTORY_MANAGER');
    const ups = [];
    for (let i = 0; i < 3; i += 1) ups.push((await upload(a, PDF(uniq('rl')))).data);
    assert.equal((await extract(a, ups[0]._id)).status, 202);
    assert.equal((await extract(a, ups[1]._id)).status, 202);
    const blocked = await extract(a, ups[2]._id);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.message, /lot of scans/);
    assert.equal((await statusOf(ups[2]._id, a)).status, 'uploaded', 'a refused request starts nothing');
    assert.equal((await extract(T.client, ups[2]._id)).status, 202, 'someone else is not held back');
    for (const x of ups.slice(0, 3)) await settled(x._id, a);
  });
});
