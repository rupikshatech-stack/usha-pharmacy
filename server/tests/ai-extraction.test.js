// AI Billing, Phase 3: turning the OCR result of an uploaded invoice into a structured invoice with a language model. A small fake of Gemini / OpenAI
// answers; the OCR result is seeded. What matters is OUR side: what is sent (OCR text and tables only, the key in a header, never in the URL or a
// response), that the answer is checked strictly and never trusted, that missing values stay null, that the backend re-calculates the money and shows
// every difference without changing the extracted figures, that duplicates are caught, that failures are reported, that everything is versioned, and that
// nothing is matched, ordered, received or marked verified by the AI.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startHarness } from './helpers/harness.js';
import { coerce, geminiSchema, normalizeExtraction, openAiSchema } from '../services/aiExtraction/invoiceExtractionSchema.js';
import { validateExtraction } from '../services/aiExtraction/invoiceValidationService.js';
import { buildMeta, traceIssues } from '../services/aiExtraction/sourceTracking.js';
import { buildPrompt } from '../services/aiExtraction/aiInvoiceExtractionService.js';

let h;
let T;
let other;
let n = 0;
let ai;
let aiBase;
let uploadDir;
let calls;
let reply;
const ENV = ['UPLOAD_DIR', 'AI_EXTRACTION_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_ENDPOINT', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_ENDPOINT', 'AI_EXTRACTION_TIMEOUT_MS', 'GOOGLE_CLOUD_PROJECT_ID', 'AI_BILLING_URL'];
const SECRET = 'AIza-SECRET-KEY-do-not-leak';
const uniq = (p) => `${p}-${++n}`;

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const PDF = (tag = '') => bytes('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', tag);
const up = (client, buf) => client.post(`/ai-billing/uploads?fileName=${encodeURIComponent('invoice.pdf')}`, buf, { headers: { 'content-type': 'application/pdf' } });
const aiExtract = (c, id) => c.post(`/ai-billing/${id}/ai-extract`);
const reAi = (c, id) => c.post(`/ai-billing/${id}/reprocess-ai`);
const stat = async (id, c = T.client) => (await c.get(`/ai-billing/${id}/extraction-status`)).data;
const got = async (id, c = T.client, q = '') => (await c.get(`/ai-billing/${id}/extracted${q}`)).data;
const settled = async (id, c = T.client) => {
  for (let i = 0; i < 100; i += 1) {
    const s = await stat(id, c);
    if (s.aiStatus !== 'processing') return s;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('the extraction never finished');
};
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement', 'GoodsReceipt'].map((m) => h.models[m].collection.countDocuments({})));

/* ------------------------------------------------------------------------------------------------ fixtures */

const cell = (text, confidence = 0.97) => ({ text, rowSpan: 1, colSpan: 1, confidence });
const HEAD = ['Product', 'HSN', 'Batch', 'Exp', 'Qty', 'Free', 'MRP', 'Rate', 'Disc%', 'Taxable', 'GST%', 'CGST', 'SGST', 'Amount'];
const ROW1 = ['Dolo 650 Tab', '3004', 'DL4412', '08/28', '100', '10', '32.00', '25.00', '0', '2500.00', '12', '150.00', '150.00', '2800.00'];
const ROW2 = ['Crocin Advance', '3004', 'CR77', '03/28', '20', '0', '35.00', '30.00', '10', '540.00', '12', '32.40', '32.40', '604.80'];
const line = (text, confidence = 0.98) => ({ text, confidence, box: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.12], [0.1, 0.12]] });

/** An OCR result as the OCR stage stores it. `rows` are table rows; `conf` sets the cell confidence. */
function ocrFixture({ rows = [ROW1, ROW2], conf = 0.97, extraLines = [], pages = 1, secondPageRows = null } = {}) {
  const lines = ['SUN PHARMA DISTRIBUTORS', 'GSTIN: 27ABCDE1234F1Z5', 'Invoice No: SP/2026/771', 'Date: 05/11/2026', ...extraLines, 'Subtotal 3100.00', 'Total Discount 60.00', 'Taxable 3040.00', 'CGST 182.40', 'SGST 182.40', 'Round off 0.00', 'Grand Total 3404.80'];
  const tableOf = (rs, page, index) => ({ pageNumber: page, index, headerRows: [HEAD.map((t) => cell(t, conf))], bodyRows: rs.map((r) => r.map((t) => cell(t, conf))), rowCount: rs.length + 1, columnCount: HEAD.length, confidence: 0.95 });
  const tables = [tableOf(rows, 1, 0), ...(secondPageRows ? [tableOf(secondPageRows, 2, 0)] : [])];
  const pageText = (ls, rs) => [...ls, HEAD.join(' '), ...rs.map((r) => r.join(' '))].join('\n');
  const outPages = [{ pageNumber: 1, text: pageText(lines, rows), lines: lines.map((l) => line(l)), confidence: 0.98 }];
  if (secondPageRows) outPages.push({ pageNumber: 2, text: pageText(['Continued'], secondPageRows), lines: [line('Continued')], confidence: 0.98 });
  return { pageCount: pages > 1 || secondPageRows ? 2 : 1, text: outPages.map((p) => p.text).join('\n'), pages: outPages, tables };
}

const itemOf = (row, over = {}) => ({
  medicineName: row[0], description: null, manufacturer: null, brand: null, strength: null, dosageForm: null, hsnCode: row[1], batchNumber: row[2], manufacturingDate: null, expiryDate: `20${row[3].slice(3)}-${row[3].slice(0, 2)}`,
  packSize: null, unit: null, quantity: Number(row[4]), freeQuantity: Number(row[5]), receivedQuantity: null, mrp: Number(row[6]), purchaseRate: Number(row[7]), discountPercentage: Number(row[8]), discountAmount: null,
  taxableAmount: Number(row[9]), gstPercentage: Number(row[10]), cgst: Number(row[11]), sgst: Number(row[12]), igst: null, lineTotal: Number(row[13]), page: 1, sourceText: row.join(' '), ...over,
});
const answer = (over = {}) => ({
  supplier: { name: 'Sun Pharma Distributors', gstin: '27ABCDE1234F1Z5', address: null, phone: null, email: null, state: null, stateCode: null },
  invoice: { invoiceNumber: 'SP/2026/771', invoiceDate: '2026-11-05', dueDate: null, purchaseOrderNumber: null, deliveryChallanNumber: null, placeOfSupply: null, paymentTerms: null, currency: 'INR', invoiceType: 'Tax Invoice' },
  items: [itemOf(ROW1), itemOf(ROW2)],
  totals: { subtotal: 3100, discount: 60, taxableAmount: 3040, cgst: 182.4, sgst: 182.4, igst: null, otherCharges: null, shippingCharges: null, packagingCharges: null, roundOff: 0, grandTotal: 3404.8, amountInWords: null, amountPaid: null, balanceDue: null },
  warnings: [],
  ...over,
});
const gem = (obj) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }], modelVersion: 'gemini-test-1', usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 123 } } });

/** A stored upload that has finished OCR (as the OCR stage leaves it), with the given OCR result. */
async function withOcr(ocr = ocrFixture(), client = T.client, org = T.org) {
  const u = (await up(client, PDF(uniq('inv')))).data;
  const oid = new mongoose.Types.ObjectId(u._id);
  const processedAt = new Date();
  await h.models.InvoiceOcr.collection.insertOne({
    organizationId: org._id, uploadObjectId: oid, uploadId: u.uploadId, provider: 'google-document-ai', mimeType: 'application/pdf', pageCount: ocr.pageCount, text: ocr.text, pages: ocr.pages, tables: ocr.tables,
    entities: [], fields: {}, lineItems: [], warnings: [], durationMs: 5, processedAt, createdAt: processedAt, updatedAt: processedAt,
  });
  await h.models.InvoiceUpload.collection.updateOne({ _id: oid }, { $set: { status: 'completed', ocrSummary: { provider: 'google-document-ai', pageCount: ocr.pageCount, textLength: ocr.text.length, tableCount: ocr.tables.length, warningCount: 0, durationMs: 5, processedAt } } });
  return u;
}
const extractedOk = async (ocr, over) => {
  reply = gem(answer(over));
  const u = await withOcr(ocr);
  assert.equal((await aiExtract(T.client, u._id)).status, 202);
  const s = await settled(u._id);
  assert.equal(s.aiStatus, 'completed', JSON.stringify(s.error));
  return { u, x: await got(u._id) };
};

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-ai-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  ai = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      const go = () => {
        res.statusCode = reply.status;
        if (reply.text !== undefined) return res.end(reply.text);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(reply.json));
      };
      return reply.delayMs ? setTimeout(go, reply.delayMs) : go();
    });
  });
  await new Promise((r) => ai.listen(0, '127.0.0.1', r));
  aiBase = `http://127.0.0.1:${ai.address().port}`;
  h = await startHarness();
  T = await h.makeTenant('AI Extraction Org');
  other = await h.makeTenant('AI Extraction Other Org');
});
after(async () => {
  await new Promise((r) => ai.close(r));
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  for (const k of ENV) delete process.env[k];
});
beforeEach(async () => {
  // every test starts without earlier readings of the same invoice (they would, rightly, be reported as duplicates of each other)
  await h.models.InvoiceExtraction.collection.deleteMany({});
  await h.models.Order.collection.deleteMany({ referenceNo: /^SP\// });
  calls = [];
  reply = gem(answer());
  for (const k of ENV.slice(1)) delete process.env[k];
  Object.assign(process.env, { AI_EXTRACTION_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET, GEMINI_ENDPOINT: aiBase });
});

/* ------------------------------------------------------------------------------------------------ pure pieces */

describe('Checking the AI’s answer strictly', () => {
  it('turns numeric strings into numbers, drops what is not a number, and says what it dropped', () => {
    const raw = answer();
    raw.items[0].quantity = '1,200';
    raw.items[0].purchaseRate = 'abc';
    raw.items[0].mrp = -5;
    raw.items[0].gstPercentage = 140;
    raw.items[0].expiryDate = '2028-02-30';
    raw.items[0].batchNumber = '  B-1  ';
    raw.items[0].surprise = 'x';
    const { data, problems } = normalizeExtraction(raw);
    const it = data.items[0];
    assert.deepEqual([it.quantity, it.purchaseRate, it.mrp, it.gstPercentage, it.expiryDate, it.batchNumber], [1200, null, null, null, null, 'B-1']);
    assert.ok(!('surprise' in it), 'unknown keys are dropped');
    for (const p of ['items.0.purchaseRate', 'items.0.mrp', 'items.0.gstPercentage', 'items.0.expiryDate']) assert.ok(problems.some((x) => x.path === p), p);
    assert.equal(problems.find((x) => x.path === 'items.0.expiryDate').original, '2028-02-30', 'the original is kept in the report');
  });
  it('reads month-and-year expiry as the last day of the month and says so; real calendar days only', () => {
    assert.deepEqual(coerce('expiry', '2028-02'), { value: '2028-02-29', note: 'only month and year were given ("2028-02"); treated as the last day of the month' });
    assert.equal(coerce('date', '2028-02').value, null, 'a plain date needs a day');
    assert.equal(coerce('date', '2027-02-29').value, null);
    assert.equal(coerce('date', '2028-02-29').value, '2028-02-29');
    assert.equal(coerce('signed', -0.4).value, -0.4, 'a round off may be negative');
  });
  it('refuses an answer that is not an invoice at all', () => {
    assert.throws(() => normalizeExtraction('hello'), { code: 'shape' });
    assert.throws(() => normalizeExtraction({ items: 'none' }), { code: 'shape' });
    assert.deepEqual(normalizeExtraction({ items: [] }).data.items, []);
  });
  it('asks the models for the same fields in both dialects', () => {
    const g = geminiSchema().properties.items.items.properties;
    const o = openAiSchema().properties.items.items;
    assert.equal(g.batchNumber.nullable, true);
    assert.deepEqual(o.properties.batchNumber.type, ['string', 'null']);
    assert.equal(o.additionalProperties, false);
    assert.deepEqual(Object.keys(g).sort(), [...o.required].sort());
    assert.ok(['medicineName', 'freeQuantity', 'receivedQuantity', 'mrp', 'purchaseRate', 'cgst', 'sgst', 'igst', 'lineTotal', 'hsnCode', 'strength', 'dosageForm'].every((k) => k in g));
  });
});

describe('The validation engine', () => {
  const clean = () => normalizeExtraction(answer()).data;
  const codes = (d) => validateExtraction(d, { today: '2026-11-08' }).issues.map((i) => i.code);
  it('finds nothing wrong with a consistent invoice, and re-calculates the same money', () => {
    const v = validateExtraction(clean(), { today: '2026-11-08' });
    assert.deepEqual(v.issues, []);
    assert.equal(v.requiresReview, false);
    assert.deepEqual([v.computed.lines[1].gross, v.computed.lines[1].discount, v.computed.lines[1].taxable, v.computed.lines[1].tax, v.computed.lines[1].total], [600, 60, 540, 64.8, 604.8]);
    assert.equal(v.computed.grandTotal, 3404.8);
  });
  it('shows a wrong grand total with both numbers and the difference — and does not touch the data', () => {
    const d = clean();
    d.totals.grandTotal = 3504.8;
    const before = JSON.stringify(d);
    const v = validateExtraction(d, { today: '2026-11-08' });
    const i = v.issues.find((x) => x.code === 'GRAND_TOTAL_MISMATCH');
    assert.deepEqual([i.severity, i.expected, i.actual, i.difference], ['error', 3404.8, 3504.8, 100]);
    assert.match(i.message, /3,504\.80.*3,404\.80/);
    assert.equal(v.requiresReview, true);
    assert.equal(JSON.stringify(d), before, 'the extracted figures are never silently changed');
  });
  it('checks a line against its own quantity, rate, discount and GST', () => {
    const d = clean();
    d.items[1].taxableAmount = 560;
    d.items[1].lineTotal = 700;
    const c = codes(d);
    assert.ok(c.includes('LINE_TAXABLE_MISMATCH') && c.includes('LINE_TOTAL_MISMATCH'));
    const e = clean();
    e.items[0].discountPercentage = 10;
    e.items[0].discountAmount = 5;
    assert.ok(codes(e).includes('DISCOUNT_MISMATCH'));
    const f = clean();
    f.items[0].purchaseRate = 40;
    assert.ok(codes(f).includes('RATE_ABOVE_MRP'));
  });
  it('flags missing batch and expiry as warnings and never fills them in', () => {
    const d = clean();
    d.items[0].batchNumber = null;
    d.items[0].expiryDate = null;
    const v = validateExtraction(d, { today: '2026-11-08' });
    assert.deepEqual(v.issues.filter((i) => i.path.startsWith('items.0.')).map((i) => [i.code, i.severity]).sort(), [['BATCH_MISSING', 'warning'], ['EXPIRY_MISSING', 'warning']]);
    assert.equal(d.items[0].batchNumber, null);
  });
  it('checks the invoice number, dates, GSTIN, expiry and numbers', () => {
    const d = clean();
    d.invoice.invoiceNumber = null;
    d.invoice.invoiceDate = '2027-01-01';
    d.invoice.dueDate = '2026-01-01';
    d.supplier.gstin = '27ABCDE1234';
    d.items[0].expiryDate = '2026-01-31';
    d.items[1].manufacturingDate = '2029-01-01';
    d.items[1].quantity = 2.5;
    d.items[0].gstPercentage = 13;
    d.items[0].hsnCode = '12';
    const c = codes(d);
    for (const k of ['INVOICE_NUMBER_MISSING', 'INVOICE_DATE_FUTURE', 'DUE_BEFORE_INVOICE', 'GSTIN_INVALID', 'EXPIRED', 'EXPIRY_BEFORE_MFG', 'QUANTITY_FRACTIONAL', 'GST_RATE_UNUSUAL', 'HSN_FORMAT']) assert.ok(c.includes(k), k);
  });
  it('does not call a different but legitimate layout wrong: a line amount before tax, or an invoice-level discount', () => {
    const d = clean();
    d.items[0].lineTotal = 2500; // this supplier prints the amount before tax
    d.totals.discount = 100; // includes an invoice-level discount
    d.totals.grandTotal = 3404.8;
    const v = validateExtraction(d, { today: '2026-11-08' });
    assert.ok(!v.issues.some((i) => i.code === 'LINE_TOTAL_MISMATCH'));
    assert.equal(v.issues.find((i) => i.code === 'DISCOUNT_TOTAL_DIFFERS').severity, 'info');
  });
  it('with an IGST invoice and other charges, the grand total adds them once', () => {
    const d = normalizeExtraction(answer({ totals: { ...answer().totals, cgst: null, sgst: null, igst: 364.8, otherCharges: 50, shippingCharges: 20, roundOff: -0.4, grandTotal: 3474.4 } })).data;
    d.items = d.items.map((i) => ({ ...i, cgst: null, sgst: null, igst: i.cgst + i.sgst }));
    const v = validateExtraction(d, { today: '2026-11-08' });
    assert.ok(!v.issues.some((i) => i.code.includes('MISMATCH')), JSON.stringify(v.issues));
  });
});

describe('Links back to the OCR text', () => {
  it('uses the OCR provider’s own confidence for a value, and flags what is not in the OCR text at all', () => {
    const ocr = ocrFixture({ conf: 0.62 });
    const data = normalizeExtraction(answer()).data;
    data.items[0].batchNumber = 'INVENTED99';
    const { meta, untraced } = buildMeta(ocr, data);
    assert.deepEqual(untraced, []);
    assert.deepEqual([meta['items.1.batchNumber'].level, meta['items.1.batchNumber'].confidence, meta['items.1.batchNumber'].page], ['low', 0.62, 1]);
    assert.deepEqual([meta['items.0.batchNumber'].found, meta['items.0.batchNumber'].level], [false, 'low']);
    assert.equal(meta['items.0.expiryDate'].snippet, '08/28');
    assert.equal(meta['supplier.address'].level, 'missing');
    assert.equal(meta['supplier.gstin'].level, 'high');
    const t = traceIssues(meta, data);
    assert.ok(t.some((i) => i.code === 'NOT_IN_OCR' && i.path === 'items.0.batchNumber'));
    assert.ok(t.some((i) => i.code === 'LOW_CONFIDENCE' && i.path === 'items.1.quantity'));
  });
  it('reports a row it cannot trace, and a level of high / medium for good and middling reads', () => {
    const ocr = ocrFixture();
    const data = normalizeExtraction(answer()).data;
    data.items[1].sourceText = 'a row that is nowhere in this document';
    assert.deepEqual(buildMeta(ocr, data).untraced, [1]);
    assert.equal(buildMeta(ocrFixture({ conf: 0.8 }), normalizeExtraction(answer()).data).meta['items.0.quantity'].level, 'medium');
    assert.equal(buildMeta(ocrFixture({ conf: 0.95 }), normalizeExtraction(answer()).data).meta['items.0.quantity'].level, 'high');
  });
  it('builds the prompt from the OCR only: page text and tables, row by row', () => {
    const p = buildPrompt(ocrFixture());
    assert.match(p.user, /=== PAGE 1 \(text\) ===/);
    assert.match(p.user, /TABLE 1 on page 1/);
    assert.match(p.user, /Dolo 650 Tab \| 3004 \| DL4412 \| 08\/28 \| 100 \| 10/);
    assert.match(p.system, /NEVER invent/);
    assert.match(p.system, /MRP is the retail price/);
    assert.equal(p.truncated, false);
    assert.equal(buildPrompt({ text: 'x'.repeat(200000), pages: [{ pageNumber: 1, text: 'x'.repeat(200000) }], tables: [] }).truncated, true);
  });
});

/* ------------------------------------------------------------------------------------------------ the API */

describe('Is AI extraction ready?', () => {
  it('names the missing setting (never a value), and the status shows it', async () => {
    delete process.env.GEMINI_API_KEY;
    const s = (await T.client.get('/ai-billing/status')).data;
    assert.deepEqual([s.ai.configured, s.ai.provider, s.ai.missing], [false, 'gemini', ['GEMINI_API_KEY']]);
    assert.match(s.ai.setup, /GEMINI_API_KEY/);
    process.env.GEMINI_API_KEY = SECRET;
    const ok = (await T.client.get('/ai-billing/status')).data;
    assert.deepEqual([ok.ai.configured, ok.ai.label, ok.ai.model], [true, 'Google Gemini', 'gemini-2.5-flash']);
    assert.ok(!JSON.stringify(ok).includes(SECRET));
  });
  it('without it, extraction is refused plainly and nothing is sent', async () => {
    delete process.env.GEMINI_API_KEY;
    const u = await withOcr();
    const r = await aiExtract(T.client, u._id);
    assert.equal(r.status, 501);
    assert.equal(r.body.code || r.body.error?.code, 'AI_EXTRACTION_NOT_CONFIGURED');
    assert.equal(calls.length, 0);
    assert.equal((await stat(u._id)).state, 'ocr_completed');
  });
  it('needs the OCR scan first', async () => {
    const u = (await up(T.client, PDF(uniq('noocr')))).data;
    const r = await aiExtract(T.client, u._id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code || r.body.error?.code, 'OCR_NOT_READY');
    assert.equal((await stat(u._id)).state, 'ocr_pending');
    assert.equal(calls.length, 0);
  });
});

describe('Extracting a clear invoice', () => {
  it('202, then a structured invoice that matches the document; unverified; nothing else happens', async () => {
    const before = await counts();
    reply = gem(answer());
    const u = await withOcr();
    const r = await aiExtract(T.client, u._id);
    assert.equal(r.status, 202);
    assert.equal(r.data.state, 'ai_processing');
    assert.equal(r.data.stateLabel, 'AI Processing');
    const s = await settled(u._id);
    assert.deepEqual([s.state, s.stateLabel, s.version, s.provider, s.model, s.humanReviewed, s.attempts], ['ready_for_review', 'Ready for Review', 1, 'gemini', 'gemini-test-1', false, 1]);

    // what was sent: only the OCR, the key in a header and not in the URL
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, '/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(c.headers['x-goog-api-key'], SECRET);
    assert.ok(!c.url.includes(SECRET));
    assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(c.body.generationConfig.temperature, 0);
    assert.ok(c.body.generationConfig.responseSchema.properties.items);
    assert.match(c.body.contents[0].parts[0].text, /Dolo 650 Tab \| 3004 \| DL4412/);
    assert.ok(!JSON.stringify(c.body).includes('JVBER') && !JSON.stringify(c.body).includes('%PDF'), 'the file itself is never sent');

    const x = await got(u._id);
    assert.equal(x.verified, false);
    assert.equal(x.humanReviewed, false);
    assert.deepEqual([x.current.supplier.name, x.current.supplier.gstin, x.current.invoice.invoiceNumber, x.current.invoice.invoiceDate], ['Sun Pharma Distributors', '27ABCDE1234F1Z5', 'SP/2026/771', '2026-11-05']);
    assert.equal(x.current.items.length, 2);
    assert.deepEqual([x.current.items[0].medicineName, x.current.items[0].batchNumber, x.current.items[0].expiryDate, x.current.items[0].quantity, x.current.items[0].freeQuantity, x.current.items[0].mrp, x.current.items[0].purchaseRate], ['Dolo 650 Tab', 'DL4412', '2028-08-31', 100, 10, 32, 25]);
    assert.deepEqual([x.current.totals.grandTotal, x.current.totals.cgst, x.current.totals.sgst], [3404.8, 182.4, 182.4]);
    assert.equal(x.current.supplier.address, null, 'missing stays null');
    assert.equal(x.validation.requiresReview, false);
    assert.equal(x.validation.summary.errors + x.validation.summary.warnings, 0, JSON.stringify(x.validation.issues));
    assert.deepEqual([x.meta['items.0.batchNumber'].level, x.meta['items.0.batchNumber'].page, x.meta['supplier.address'].level], ['high', 1, 'missing']);
    assert.deepEqual(x.original, x.current, 'the AI’s own answer is kept beside the working copy');
    assert.equal(x.original.items[0].sourceText.startsWith('Dolo 650 Tab'), true);
    assert.ok(x.aiWarnings.some((w) => /only month and year were given/.test(w)), 'the month/year expiry is explained');
    assert.deepEqual(await counts(), before, 'no order, receipt, batch or stock movement');
    assert.ok(x.current.items.every((i) => !('productId' in i)), 'no product was matched');
    const row = await h.models.InvoiceUpload.collection.findOne({ _id: new mongoose.Types.ObjectId(u._id) });
    assert.deepEqual([row.orderId, row.reviewed], [undefined, undefined]);
    // the OCR is untouched
    const ocr = await h.models.InvoiceOcr.collection.findOne({ uploadId: u.uploadId });
    assert.equal(ocr.provider, 'google-document-ai');
    assert.match(ocr.text, /SUN PHARMA/);
  });

  it('keeps every row of a multi-row, multi-page invoice separate and records the page', async () => {
    const ROW3 = ['Azithral 500', '3004', 'AZ900', '11/27', '30', '5', '118.00', '90.00', '0', '2700.00', '12', '162.00', '162.00', '3024.00'];
    const ocr = ocrFixture({ rows: [ROW1], secondPageRows: [ROW2, ROW3] });
    const items = [itemOf(ROW1), itemOf(ROW2, { page: 2 }), itemOf(ROW3, { page: 2 })];
    const { x } = await extractedOk(ocr, { items, totals: { ...answer().totals, subtotal: 5800, discount: 60, taxableAmount: 5740, cgst: 344.4, sgst: 344.4, grandTotal: 6428.8 } });
    assert.deepEqual(x.current.items.map((i) => i.medicineName), ['Dolo 650 Tab', 'Crocin Advance', 'Azithral 500']);
    assert.deepEqual(x.current.items.map((i) => i.page), [1, 2, 2]);
    assert.deepEqual([x.meta['items.2.batchNumber'].page, x.meta['items.2.batchNumber'].found], [2, true]);
    assert.deepEqual(x.current.items.map((i) => i.freeQuantity), [10, 0, 5], 'free quantity stays separate from quantity');
    assert.deepEqual(x.current.items.map((i) => i.quantity), [100, 20, 30]);
    assert.equal(x.validation.summary.errors, 0, JSON.stringify(x.validation.issues));
  });
});

describe('Never inventing or hiding anything', () => {
  it('missing batch and expiry stay null and are warned about; an invented batch is flagged as not in the document', async () => {
    const items = [itemOf(ROW1, { batchNumber: null, expiryDate: null }), itemOf(ROW2, { batchNumber: 'ZZ9999' })];
    const { x } = await extractedOk(ocrFixture(), { items });
    assert.deepEqual([x.current.items[0].batchNumber, x.current.items[0].expiryDate], [null, null]);
    const codes = x.validation.issues.map((i) => `${i.code}:${i.path}`);
    assert.ok(codes.includes('BATCH_MISSING:items.0.batchNumber') && codes.includes('EXPIRY_MISSING:items.0.expiryDate'));
    assert.ok(codes.includes('NOT_IN_OCR:items.1.batchNumber'));
    assert.deepEqual([x.meta['items.1.batchNumber'].found, x.meta['items.1.batchNumber'].level], [false, 'low']);
    assert.equal(x.validation.requiresReview, true);
    assert.equal(x.state, 'validation_required');
    assert.equal(x.issueMap['items.1.batchNumber'], 'warning', 'the screen can highlight it');
  });

  it('unclear or handwritten text (low OCR confidence) is marked low and warned about, with the model’s own notes kept', async () => {
    const { x } = await extractedOk(ocrFixture({ conf: 0.55 }), { warnings: ['Batch number on line 2 is handwritten and hard to read'] });
    assert.equal(x.meta['items.1.quantity'].level, 'low');
    assert.equal(x.meta['items.1.quantity'].confidence, 0.55, 'the OCR’s number, not an invented one');
    assert.ok(x.validation.issues.some((i) => i.code === 'LOW_CONFIDENCE'));
    assert.ok(x.aiWarnings.includes('Batch number on line 2 is handwritten and hard to read'));
    assert.equal(x.state, 'validation_required');
  });

  it('incorrect totals are reported with the difference, and the stated figures are kept exactly as read', async () => {
    const { x } = await extractedOk(ocrFixture(), { totals: { ...answer().totals, grandTotal: 3500 } });
    assert.equal(x.current.totals.grandTotal, 3500);
    const i = x.validation.issues.find((v) => v.code === 'GRAND_TOTAL_MISMATCH');
    assert.deepEqual([i.expected, i.actual, i.difference], [3404.8, 3500, 95.2]);
    assert.equal(x.validation.computed.grandTotal, 3404.8);
    assert.equal(x.state, 'validation_required');
    assert.equal(x.reviewStatus, 'needs_review');
    assert.equal(x.humanReviewed, false);
  });

  it('values of the wrong type from the model become null and are reported, never repaired', async () => {
    const items = [itemOf(ROW1, { quantity: 'one hundred', purchaseRate: '25.00', expiryDate: 'August 2028', discountPercentage: -10 }), itemOf(ROW2)];
    const { x } = await extractedOk(ocrFixture(), { items });
    const it = x.current.items[0];
    assert.deepEqual([it.quantity, it.purchaseRate, it.expiryDate, it.discountPercentage], [null, 25, null, null]);
    assert.ok(x.aiWarnings.some((w) => /quantity.*is not a number \(left empty\)/.test(w)));
    assert.ok(x.aiWarnings.some((w) => /expiryDate.*not a date/.test(w)));
    assert.equal(x.problems.find((p) => p.path === 'items.0.quantity').original, 'one hundred');
  });
});

describe('When the AI service fails', () => {
  const cases = [
    ['rejects the request (400)', { status: 400, json: { error: { message: 'bad schema' } } }, 'AI_REJECTED'],
    ['refuses the key (403)', { status: 403, json: { error: { message: `key ${SECRET} invalid` } } }, 'AI_AUTH_FAILED'],
    ['does not know the model (404)', { status: 404, json: {} }, 'AI_MODEL_NOT_FOUND'],
    ['is over quota (429)', { status: 429, json: {} }, 'AI_QUOTA'],
    ['has an outage (500)', { status: 500, text: 'oops' }, 'AI_UNAVAILABLE'],
    ['answers with something that is not JSON', gem('this is not json'), 'AI_BAD_RESPONSE'],
    ['answers with an empty text', gem(''), 'AI_BAD_RESPONSE'],
    ['answers with JSON that is not an invoice', gem({ hello: 'world' }), 'AI_BAD_RESPONSE'],
    ['answers with items that are not a list', gem({ items: 'many' }), 'AI_BAD_RESPONSE'],
    ['is cut off', { status: 200, json: { candidates: [{ content: { parts: [{ text: '{"items":[' }] }, finishReason: 'MAX_TOKENS' }] } }, 'AI_BAD_RESPONSE'],
    ['is blocked', { status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }, 'AI_REFUSED'],
  ];
  for (const [name, answerWith, code] of cases) {
    it(`reports it plainly when it ${name}: failed, nothing stored, OCR untouched, and never the key`, async () => {
      reply = answerWith;
      const u = await withOcr();
      await aiExtract(T.client, u._id);
      const s = await settled(u._id);
      assert.deepEqual([s.state, s.aiStatus, s.error.code], ['failed', 'failed', code]);
      assert.ok(!JSON.stringify(s).includes(SECRET), 'no secret in the error');
      assert.equal((await T.client.get(`/ai-billing/${u._id}/extracted`)).status, 409);
      assert.equal(await h.models.InvoiceExtraction.collection.countDocuments({ uploadId: u.uploadId }), 0);
      assert.equal((await T.client.get(`/ai-billing/${u._id}/ocr`)).status, 200, 'the OCR result is still there');
    });
  }

  it('a model that is too slow is reported as a timeout, and the invoice can be tried again', async () => {
    process.env.AI_EXTRACTION_TIMEOUT_MS = '300';
    reply = { ...gem(answer()), delayMs: 1500 };
    const u = await withOcr();
    await aiExtract(T.client, u._id);
    const s = await settled(u._id);
    assert.deepEqual([s.state, s.error.code], ['failed', 'AI_TIMEOUT']);
    assert.match(s.error.message, /did not answer within/);
    delete process.env.AI_EXTRACTION_TIMEOUT_MS;
    reply = gem(answer());
    assert.equal((await aiExtract(T.client, u._id)).status, 202, 'a failed first attempt can simply be run again');
    const done = await settled(u._id);
    assert.deepEqual([done.state, done.version, done.attempts], ['ready_for_review', 1, 2]);
  });

  it('a model that cannot be reached is unavailable', async () => {
    process.env.GEMINI_ENDPOINT = 'http://127.0.0.1:1';
    const u = await withOcr();
    await aiExtract(T.client, u._id);
    const s = await settled(u._id);
    assert.deepEqual([s.state, s.error.code], ['failed', 'AI_UNAVAILABLE']);
  });
});

describe('OpenAI as the provider', () => {
  it('sends a strict JSON-schema request with the key as a bearer token and reads the answer the same way', async () => {
    Object.assign(process.env, { AI_EXTRACTION_PROVIDER: 'openai', OPENAI_API_KEY: SECRET, OPENAI_ENDPOINT: aiBase, OPENAI_MODEL: 'gpt-test' });
    delete process.env.GEMINI_API_KEY;
    reply = { status: 200, json: { model: 'gpt-test-2025', choices: [{ message: { content: JSON.stringify(answer()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } } };
    const u = await withOcr();
    await aiExtract(T.client, u._id);
    const s = await settled(u._id);
    assert.deepEqual([s.state, s.provider, s.model], ['ready_for_review', 'openai', 'gpt-test-2025']);
    const c = calls[0];
    assert.equal(c.url, '/v1/chat/completions');
    assert.equal(c.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(c.body.response_format.type, 'json_schema');
    assert.equal(c.body.response_format.json_schema.strict, true);
    assert.equal(c.body.temperature, 0);
    assert.match(c.body.messages[1].content, /Dolo 650 Tab/);
    const x = await got(u._id);
    assert.equal(x.current.items.length, 2);
    reply = { status: 200, json: { choices: [{ message: { refusal: 'I cannot help with that' }, finish_reason: 'stop' }] } };
    const v = await withOcr();
    await aiExtract(T.client, v._id);
    assert.equal((await settled(v._id)).error.code, 'AI_REFUSED');
  });
  it('an unknown provider name is called out', async () => {
    process.env.AI_EXTRACTION_PROVIDER = 'magic';
    const s = (await T.client.get('/ai-billing/status')).data;
    assert.equal(s.ai.configured, false);
    assert.match(s.ai.setup, /not a known provider/);
  });
});

describe('Never extracted twice at once, and re-extraction keeps history', () => {
  it('while it runs a second request is refused and the model is called once; after it, extract refuses and re-extract adds a version', async () => {
    reply = { ...gem(answer()), delayMs: 300 };
    const u = await withOcr();
    const rs = await Promise.all([1, 2, 3, 4].map(() => aiExtract(T.client, u._id)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [202, 409, 409, 409]);
    assert.equal((await reAi(T.client, u._id)).status, 409, 'not while it is running');
    await settled(u._id);
    assert.equal(calls.length, 1);
    const again = await aiExtract(T.client, u._id);
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already been extracted/);

    // a person corrects version 1, then the invoice is extracted again
    const v1 = await got(u._id);
    const fixed = { ...v1.current, supplier: { ...v1.current.supplier, address: '12 Market Road, Pune' } };
    assert.equal((await T.client.put(`/ai-billing/${u._id}/extracted`, { data: fixed })).status, 200);
    reply = gem(answer({ invoice: { ...answer().invoice, invoiceNumber: 'SP/2026/772' } }));
    assert.equal((await reAi(T.client, u._id)).status, 202);
    const s = await settled(u._id);
    assert.deepEqual([s.version, s.attempts, calls.length], [2, 2, 2]);
    const v2 = await got(u._id);
    assert.equal(v2.current.invoice.invoiceNumber, 'SP/2026/772');
    assert.equal(v2.current.supplier.address, null, 'the new reading starts from the AI’s answer, not from the old corrections');
    assert.deepEqual(v2.versions.map((v) => v.version), [2, 1]);
    const old = await got(u._id, T.client, '?version=1');
    assert.equal(old.current.supplier.address, '12 Market Road, Pune', 'version 1 and its corrections are kept');
    assert.equal(old.original.supplier.address, null);
    assert.equal(old.latest, false);
    assert.equal(await h.models.InvoiceExtraction.collection.countDocuments({ uploadId: u.uploadId }), 2);
    assert.equal((await T.client.get(`/ai-billing/${u._id}/extracted?version=9`)).status, 409);
  });
  it('re-extract is only for something that was extracted (or failed)', async () => {
    const u = await withOcr();
    const r = await reAi(T.client, u._id);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /not been extracted yet/);
  });
  it('an extraction made before the OCR was read again is reported as stale', async () => {
    const { u } = await extractedOk();
    assert.equal((await stat(u._id)).stale, false);
    await h.models.InvoiceUpload.collection.updateOne({ _id: new mongoose.Types.ObjectId(u._id) }, { $set: { 'ocrSummary.processedAt': new Date(Date.now() + 60000) } });
    assert.equal((await stat(u._id)).stale, true);
    assert.equal((await got(u._id)).stale, true);
  });
  it('a run that was lost (the server restarted) is reported as failed after the time limit', async () => {
    const u = await withOcr();
    await h.models.InvoiceUpload.collection.updateOne({ _id: new mongoose.Types.ObjectId(u._id) }, { $set: { aiStatus: 'processing', aiStartedAt: new Date(Date.now() - 20 * 60 * 1000) } });
    const s = await stat(u._id);
    assert.deepEqual([s.state, s.error.code], ['failed', 'AI_TIMED_OUT']);
    assert.equal((await aiExtract(T.client, u._id)).status, 202);
    assert.equal((await settled(u._id)).state, 'ready_for_review');
  });
});

describe('Correcting, validating and reviewing', () => {
  it('a correction changes the working copy only; the original stays; the edit is marked and the checks run again', async () => {
    const { u, x } = await extractedOk(ocrFixture(), { items: [itemOf(ROW1, { batchNumber: null }), itemOf(ROW2)] });
    assert.ok(x.validation.issues.some((i) => i.code === 'BATCH_MISSING'));
    const data = JSON.parse(JSON.stringify(x.current));
    data.items[0].batchNumber = 'DL4412';
    data.supplier.address = '12 Market Road, Pune';
    const r = await T.client.put(`/ai-billing/${u._id}/extracted`, { data, expectedEditCount: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const y = r.data;
    assert.equal(y.current.items[0].batchNumber, 'DL4412');
    assert.equal(y.original.items[0].batchNumber, null, 'what the AI said is kept');
    assert.deepEqual([y.meta['items.0.batchNumber'].level, y.meta['supplier.address'].level, y.meta['items.1.batchNumber'].level], ['edited', 'edited', 'high']);
    assert.ok(!y.validation.issues.some((i) => i.code === 'BATCH_MISSING'));
    assert.deepEqual([y.editCount, y.editedByName != null, y.state], [1, true, 'ready_for_review']);
    assert.equal((await T.client.put(`/ai-billing/${u._id}/extracted`, { data, expectedEditCount: 0 })).status, 409, 'someone else edited in between');
  });
  it('a value of the wrong type is refused, not quietly dropped', async () => {
    const { u, x } = await extractedOk();
    const data = JSON.parse(JSON.stringify(x.current));
    data.items[0].quantity = 'lots';
    data.totals.grandTotal = 'abc';
    const r = await T.client.put(`/ai-billing/${u._id}/extracted`, { data });
    assert.equal(r.status, 422);
    assert.equal(r.body.code || r.body.error?.code, 'EXTRACTION_INVALID');
    assert.equal((await got(u._id)).editCount, 0, 'nothing was saved');
    assert.equal((await T.client.put(`/ai-billing/${u._id}/extracted`, { data: { items: 'x' } })).status, 400);
  });
  it('lets a person add a missing row or clear a wrong value, and re-validates on request without changing anything', async () => {
    const { u, x } = await extractedOk();
    const data = JSON.parse(JSON.stringify(x.current));
    data.items.push({ ...data.items[1], medicineName: 'Added by hand', batchNumber: 'MANUAL1', sourceText: null });
    data.invoice.dueDate = '2026-12-05';
    const y = (await T.client.put(`/ai-billing/${u._id}/extracted`, { data })).data;
    assert.equal(y.current.items.length, 3);
    assert.equal(y.meta['items.2.medicineName'].level, 'edited');
    assert.ok(y.validation.issues.some((i) => i.code === 'TAXABLE_TOTAL_MISMATCH'), 'the extra row no longer adds up to the invoice totals');
    const before = JSON.stringify((await got(u._id)).current);
    const z = await T.client.post(`/ai-billing/${u._id}/validate`);
    assert.equal(z.status, 200);
    assert.equal(JSON.stringify(z.data.current), before, 'validating never changes the data');
    assert.ok(z.data.validation.summary.errors > 0);
  });
  it('is reviewed only by a person who confirms; errors must be acknowledged; any later change takes the mark away', async () => {
    const { u, x } = await extractedOk(ocrFixture(), { totals: { ...answer().totals, grandTotal: 3500 } });
    const data = x.current;
    assert.equal((await T.client.put(`/ai-billing/${u._id}/extracted`, { data, reviewed: true })).status, 400, 'must confirm');
    const blocked = await T.client.put(`/ai-billing/${u._id}/extracted`, { data, reviewed: true, confirmed: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code || blocked.body.error?.code, 'REVIEW_ERRORS_REMAIN');
    assert.equal((await stat(u._id)).humanReviewed, false);
    const ok = await T.client.put(`/ai-billing/${u._id}/extracted`, { data, reviewed: true, confirmed: true, acknowledgeIssues: true });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.data.state, ok.data.stateLabel, ok.data.humanReviewed, ok.data.reviewedByName != null], ['reviewed', 'Reviewed', true, true]);
    const again = (await T.client.put(`/ai-billing/${u._id}/extracted`, { data: { ...data, invoice: { ...data.invoice, paymentTerms: '30 days' } } })).data;
    assert.deepEqual([again.humanReviewed, again.state], [false, 'validation_required']);
  });
});

describe('Duplicate invoices', () => {
  it('finds the same supplier and invoice number among other readings and among orders, and blocks an accidental second draft', async () => {
    const first = await extractedOk();
    const second = await extractedOk();
    const x = await got(second.u._id);
    assert.deepEqual(x.duplicates.map((d) => [d.type, d.reference]), [['upload', first.u.uploadId]]);
    assert.ok(x.validation.issues.some((i) => i.code === 'DUPLICATE_INVOICE' && i.severity === 'error'));
    assert.equal(x.state, 'validation_required');
    assert.equal((await got(first.u._id)).duplicates.length, 1, 'both sides see each other');
    // a different supplier with the same invoice number is not a duplicate
    reply = gem(answer({ supplier: { ...answer().supplier, name: 'Cipla Wholesale', gstin: '29AAAAA0000A1Z5' } }));
    const third = await withOcr();
    await aiExtract(T.client, third._id);
    await settled(third._id);
    assert.equal((await got(third._id)).duplicates.length, 0);

    // an order already made from this supplier's invoice
    const sup = (await T.client.post('/suppliers', { name: 'Sun Pharma Distributors', contactPerson: 'Ramesh Gupta', phone: '9811100022', gstin: '27ABCDE1234F1Z5' })).data;
    const med = (await T.client.post('/inventory', { medicineName: 'Dolo 650', unit: 'Strip', gstPercentage: 12 })).data;
    const orderBody = (ref) => ({ supplierId: sup._id, referenceNo: ref, orderDate: '2026-11-05', items: [{ medicineId: med._id, quantity: 10, rate: 20, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    const made = await T.client.post(`/ai-billing/uploads/${first.u._id}/draft`, orderBody('SP/2026/771'));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const blocked = await T.client.post(`/ai-billing/uploads/${second.u._id}/draft`, orderBody('SP/2026/771'));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code || blocked.body.error?.code, 'DUPLICATE_INVOICE');
    assert.match(blocked.body.message, /already exists/);
    assert.equal(await h.models.Order.collection.countDocuments({ referenceNo: 'SP/2026/771' }), 1, 'no second record');
    const staff = await asRole('INVENTORY_MANAGER');
    const refused = await staff.post(`/ai-billing/uploads/${second.u._id}/draft`, { ...orderBody('SP/2026/771'), acknowledgeDuplicate: true });
    assert.equal(refused.status, 403, 'only someone who can approve orders may resolve it');
    const mgr = await asRole('BRANCH_MANAGER');
    const allowed = await mgr.post(`/ai-billing/uploads/${second.u._id}/draft`, { ...orderBody('SP/2026/771'), acknowledgeDuplicate: true });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(await h.models.AuditLog.collection.countDocuments({ action: 'AI_INVOICE_DUPLICATE_OVERRIDE' }), 1);
    // a removed upload no longer counts
    assert.equal((await T.client.del(`/ai-billing/uploads/${third._id}`)).status, 200);
  });
});

describe('Who may use it, and whose invoices', () => {
  it('needs a signed-in person who can manage inventory', async () => {
    const { u } = await extractedOk();
    const calls2 = [(c) => aiExtract(c, u._id), (c) => reAi(c, u._id), (c) => c.get(`/ai-billing/${u._id}/extracted`), (c) => c.get(`/ai-billing/${u._id}/extraction-status`), (c) => c.post(`/ai-billing/${u._id}/validate`), (c) => c.put(`/ai-billing/${u._id}/extracted`, { data: {} })];
    for (const call of calls2) {
      assert.equal((await call(h.client())).status, 401);
      assert.equal((await call(await asRole('STAFF'))).status, 403);
    }
  });
  it('another organization can neither see nor start nor change an extraction', async () => {
    const { u } = await extractedOk();
    for (const id of [u._id, u.uploadId]) {
      for (const call of [(c) => aiExtract(c, id), (c) => reAi(c, id), (c) => c.get(`/ai-billing/${id}/extracted`), (c) => c.get(`/ai-billing/${id}/extraction-status`), (c) => c.post(`/ai-billing/${id}/validate`), (c) => c.put(`/ai-billing/${id}/extracted`, { data: {} })]) {
        assert.equal((await call(other.client)).status, 404);
      }
    }
    assert.equal((await got(u.uploadId)).upload.uploadId, u.uploadId, 'the public upload id works too');
  });
  it('removing an upload removes its extractions', async () => {
    const { u } = await extractedOk();
    assert.equal(await h.models.InvoiceExtraction.collection.countDocuments({ uploadId: u.uploadId }), 1);
    assert.equal((await T.client.del(`/ai-billing/uploads/${u._id}`)).status, 200);
    assert.equal(await h.models.InvoiceExtraction.collection.countDocuments({ uploadId: u.uploadId }), 0);
  });
  it('the API key never appears in any response', async () => {
    const { u } = await extractedOk();
    for (const url of [`/ai-billing/status`, `/ai-billing/${u._id}/extraction-status`, `/ai-billing/${u._id}/extracted`, `/ai-billing/${u._id}`]) assert.ok(!JSON.stringify((await T.client.get(url)).body).includes(SECRET), url);
  });
});
