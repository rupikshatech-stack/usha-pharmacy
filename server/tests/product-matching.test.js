// AI Billing, Phase 4: matching the medicines of an AI-extracted invoice with the EXISTING products. What matters: different strengths, dosage forms and
// active ingredients are never matched automatically; manufacturer and pack-size differences are visible and need a person; uncertain matches are never
// confirmed silently; a remembered mapping is reused only for the same supplier description and only after the product passes the checks again; nothing
// creates a product or touches stock, batches or orders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startHarness } from './helpers/harness.js';
import { describe as describeMedicine, parseForm, parsePack, parseStrengths } from '../services/productMatching/productNormalizationService.js';
import { compareAttributes, dice, levenshteinRatio, matchingConfig } from '../services/productMatching/productSimilarityService.js';

let h;
let T;
let other;
let n = 0;
let uploadDir;
const P = {}; // the seeded products by short name
const oid = (v) => new mongoose.Types.ObjectId(v);
const uniq = (p) => `${p}-${++n}`;

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const PDF = (tag = '') => bytes('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', tag);
const up = (client, buf) => client.post(`/ai-billing/uploads?fileName=${encodeURIComponent('invoice.pdf')}`, buf, { headers: { 'content-type': 'application/pdf' } });
const matchAll = (c, id, body = {}) => c.post(`/ai-billing/${id}/match-products`, body);
const matches = async (id, c = T.client, q = '') => (await c.get(`/ai-billing/${id}/product-matches${q}`)).data;
const confirm = (c, id, itemId, body = {}) => c.post(`/ai-billing/${id}/product-matches/${itemId}/confirm`, body);
const pick = (c, id, itemId, body) => c.put(`/ai-billing/${id}/product-matches/${itemId}`, body);
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};

const ITEM_KEYS = ['medicineName', 'description', 'manufacturer', 'brand', 'strength', 'dosageForm', 'hsnCode', 'batchNumber', 'manufacturingDate', 'expiryDate', 'packSize', 'unit', 'quantity', 'freeQuantity', 'receivedQuantity', 'mrp', 'purchaseRate', 'discountPercentage', 'discountAmount', 'taxableAmount', 'gstPercentage', 'cgst', 'sgst', 'igst', 'lineTotal', 'page', 'sourceText'];
const row = (name, over = {}) => ({ ...Object.fromEntries(ITEM_KEYS.map((k) => [k, null])), itemId: `itm_${(++n).toString(16).padStart(12, '0')}`, medicineName: name, batchNumber: `B${n}`, expiryDate: '2028-08-31', quantity: 10, freeQuantity: 0, purchaseRate: 20, mrp: 30, page: 1, ...over });
const SUPPLIER = { name: 'Sun Pharma Distributors', gstin: '27ABCDE1234F1Z5', address: null, phone: null, email: null, state: null, stateCode: null };

/** An uploaded invoice whose AI extraction is already in place (as Phase 3 leaves it), with the given rows. */
async function withRows(rows, { client = T.client, org = T.org, supplier = SUPPLIER } = {}) {
  const u = (await up(client, PDF(uniq('inv')))).data;
  const current = { supplier, invoice: { invoiceNumber: uniq('INV'), invoiceDate: '2026-11-05' }, items: rows, totals: {} };
  const now = new Date();
  await h.models.InvoiceExtraction.collection.insertOne({
    organizationId: org._id, uploadObjectId: oid(u._id), uploadId: u.uploadId, version: 1, provider: 'gemini', model: 'test', data: JSON.parse(JSON.stringify(current)), current, problems: [], aiWarnings: [], meta: {}, duplicates: [],
    validation: { issues: [], summary: { errors: 0, warnings: 0, info: 0 }, requiresReview: false, computed: {} }, reviewStatus: 'ready_for_review', editCount: 0, matchingRevision: 0, extractedAt: now, createdAt: now, updatedAt: now,
  });
  await h.models.InvoiceUpload.collection.updateOne({ _id: oid(u._id) }, { $set: { status: 'completed', aiStatus: 'completed', aiVersion: 1 } });
  return u;
}
const rowOf = (m, name) => m.items.find((r) => r.invoice.name === name);

async function product(org, short, doc) {
  const now = new Date();
  const r = await h.models.Medicine.collection.insertOne({ organizationId: org._id, unit: 'Strip', gstPercentage: 12, isActive: true, description: '', image: '', attributes: [], reorderLevel: 10, barcode: '', sku: '', createdAt: now, updatedAt: now, ...doc });
  if (org === T.org) P[short] = String(r.insertedId);
  return String(r.insertedId);
}
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement', 'GoodsReceipt', 'Medicine'].map((m) => h.models[m].collection.countDocuments({})));

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-pm-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('Matching Org');
  other = await h.makeTenant('Matching Other Org');
  const tab = { dosageForm: 'Tablet', manufacturer: 'Micro Labs Ltd', hsnCode: '3004' };
  await product(T.org, 'para500', { medicineName: 'Paracetamol 500mg Tablet', genericName: 'Paracetamol', strength: '500mg', packSize: '10s', ...tab });
  await product(T.org, 'para650', { medicineName: 'Paracetamol 650mg Tablet', genericName: 'Paracetamol', strength: '650mg', packSize: '15s', ...tab });
  await product(T.org, 'paraSyrup', { medicineName: 'Paracetamol Syrup', genericName: 'Paracetamol', strength: '120mg/5ml', dosageForm: 'Syrup', manufacturer: 'Micro Labs Ltd', packSize: '60ml' });
  await product(T.org, 'dolo', { medicineName: 'Dolo 650', genericName: 'Paracetamol', strength: '650mg', sku: 'DOLO-650', ...tab, packSize: '15s' });
  await product(T.org, 'crocin', { medicineName: 'Crocin Advance', genericName: 'Paracetamol', strength: '500mg', dosageForm: 'Tablet', manufacturer: 'GSK', hsnCode: '3004' });
  await product(T.org, 'amoxCap', { medicineName: 'Amoxicillin 500mg Capsule', genericName: 'Amoxicillin', strength: '500mg', dosageForm: 'Capsule', manufacturer: 'Cipla Ltd', hsnCode: '3004', packSize: '10s' });
  await product(T.org, 'azithro', { medicineName: 'Azithromycin 500mg Tablet', genericName: 'Azithromycin', strength: '500mg', dosageForm: 'Tablet', manufacturer: 'Cipla Ltd', hsnCode: '3004', packSize: '3s' });
  await product(T.org, 'cefixA', { medicineName: 'Cefixime 200mg Tablet', genericName: 'Cefixime', strength: '200mg', dosageForm: 'Tablet', manufacturer: 'Alkem Laboratories', hsnCode: '3004', packSize: '10s' });
  await product(T.org, 'cefixB', { medicineName: 'Cefixime 200mg Tablet', genericName: 'Cefixime', strength: '200mg', dosageForm: 'Tablet', manufacturer: 'Lupin Limited', hsnCode: '3004', packSize: '10s' });
  await product(T.org, 'cetir', { medicineName: 'Cetirizine 10mg Tablet', genericName: 'Cetirizine', strength: '10mg', dosageForm: 'Tablet', manufacturer: 'Sun Pharma', hsnCode: '3004' });
  await product(T.org, 'archived', { medicineName: 'Ibuprofen 400mg Tablet', genericName: 'Ibuprofen', strength: '400mg', dosageForm: 'Tablet', isActive: false });
  await product(other.org, 'x', { medicineName: 'Zzyzx Forte Tablet', dosageForm: 'Tablet', strength: '10mg' });
});
after(async () => {
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
  for (const k of ['PRODUCT_MATCH_AUTO_THRESHOLD', 'PRODUCT_MATCH_REVIEW_THRESHOLD', 'PRODUCT_MATCH_MAX_SUGGESTIONS']) delete process.env[k];
});
beforeEach(async () => {
  await h.models.ProductMapping.collection.deleteMany({});
});

/* ------------------------------------------------------------------------------------------------ pure pieces */

describe('Describing a medicine', () => {
  it('reads strengths, forms and pack sizes, and a bare number is a strength only when it is not a pack', () => {
    assert.deepEqual(parseStrengths('Paracetamol 500 MG'), ['500mg']);
    assert.deepEqual(parseStrengths('Amox 500mg + Clav 125mg'), ['125mg', '500mg']);
    assert.deepEqual(parseStrengths('Calpol 250mg/5ml'), ['250mg/5ml']);
    assert.deepEqual(parseStrengths('Vitamin D3 0.5 g'), ['500mg']);
    assert.equal(parseForm('PCM 500 TAB'), 'tablet');
    assert.equal(parseForm('Amoxy caps'), 'capsule');
    assert.equal(parseForm('Cough Syp'), 'syrup');
    assert.equal(parseForm('Ceftriaxone inj'), 'injection');
    assert.equal(parseForm('Amoxicillin dry syrup'), 'dry_syrup');
    assert.deepEqual([parsePack('10s').count, parsePack('strip of 15').count, parsePack('1x10').count, parsePack('100ml').unit], [10, 15, 10, 'ml']);
    const d = describeMedicine({ name: 'PCM 500 TAB' });
    assert.deepEqual([d.core, d.implied, d.form, d.pack], ['paracetamol', ['500'], 'tablet', null], '“500 TAB” is a strength, not a pack of 500');
    const c = describeMedicine({ name: 'Calpol 250mg/5ml suspension' });
    assert.deepEqual([c.strengths, c.pack], [['250mg/5ml'], null], 'the volume in a strength is not a pack');
  });
  it('compares an abbreviation, a spelling slip and a different strength differently', () => {
    const prod = { ...describeMedicine({ name: 'Paracetamol 500mg Tablet', strength: '500mg', dosageForm: 'Tablet' }) };
    prod.ingredientPool = ['paracetamol'];
    const cmp = (name) => compareAttributes(describeMedicine({ name }), prod);
    assert.equal(cmp('PCM 500 TAB').conflicts.length, 0);
    assert.ok(cmp('Paracetmol 500 MG Tablet').score > 0.9);
    assert.deepEqual(cmp('Paracetamol 650 Tablet').conflicts.map((c) => c.code), ['STRENGTH_DIFFERS']);
    assert.deepEqual(cmp('Paracetamol 500 Syrup').conflicts.map((c) => c.code), ['FORM_DIFFERS']);
    assert.ok(cmp('Ibuprofen 500mg Tablet').conflicts.some((c) => c.code === 'INGREDIENT_DIFFERS' && c.level === 'critical'));
    assert.ok(levenshteinRatio('paracetmol', 'paracetamol') > 0.9 && dice('abc', 'xyz') === 0);
  });
  it('has configurable thresholds', () => {
    assert.deepEqual([matchingConfig({}).auto, matchingConfig({}).review, matchingConfig({}).maxSuggestions], [0.9, 0.55, 5]);
    const c = matchingConfig({ PRODUCT_MATCH_AUTO_THRESHOLD: '0.95', PRODUCT_MATCH_REVIEW_THRESHOLD: '0.99', PRODUCT_MATCH_MAX_SUGGESTIONS: '50' });
    assert.deepEqual([c.auto, c.review, c.maxSuggestions], [0.95, 0.95, 10], 'review can never exceed auto; at most 10 suggestions');
  });
});

/* ------------------------------------------------------------------------------------------------ the API */

describe('Matching the medicines of an invoice', () => {
  it('needs an extracted invoice, and matches nothing before it is asked', async () => {
    const u = (await up(T.client, PDF(uniq('plain')))).data;
    const r = await matchAll(T.client, u._id);
    assert.equal(r.status, 409);
    assert.equal(r.body.code || r.body.error?.code, 'AI_NOT_EXTRACTED');
  });

  it('exact names, abbreviations and spelling slips match the right product; nothing is confirmed, nothing changes', async () => {
    const before = await counts();
    const u = await withRows([
      row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' }),
      row('PCM 500 TAB', { manufacturer: 'MICRO LABS LTD.' }),
      row('Paracetmol 500 MG', { dosageForm: 'Tablet', manufacturer: 'Micro Labs' }),
      row('Dolo 650', { description: 'DOLO-650 strip' }),
      row('Azithromycin 500mg Tablet', { manufacturer: 'Cipla' }),
    ]);
    const r = await matchAll(T.client, u._id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = r.data;
    const byName = (x) => rowOf(m, x);
    assert.deepEqual([byName('Paracetamol 500mg Tablet').status, byName('Paracetamol 500mg Tablet').product._id], ['matched', P.para500]);
    assert.ok(byName('Paracetamol 500mg Tablet').reasons.includes('Exact name match'));
    assert.deepEqual([byName('PCM 500 TAB').status, byName('PCM 500 TAB').product._id], ['matched', P.para500], 'an abbreviation matches the 500 mg tablet, not the 650');
    assert.deepEqual([byName('Paracetmol 500 MG').product._id, byName('Paracetmol 500 MG').status], [P.para500, 'matched']);
    assert.equal(byName('Dolo 650').product._id, P.dolo);
    assert.ok(byName('Dolo 650').reasons.some((x) => /SKU or barcode/.test(x)));
    assert.equal(byName('Azithromycin 500mg Tablet').product._id, P.azithro);
    for (const x of m.items) {
      assert.equal(x.confirmation, 'pending', 'a match is never a confirmation');
      assert.ok(x.suggestions.length <= 5);
      assert.ok(x.suggestions.every((s) => s.product && s.product.name && 'strength' in s.product && 'dosageForm' in s.product && 'packSize' in s.product && 'hsnCode' in s.product && 'sku' in s.product && 'manufacturer' in s.product && s.reasons.length >= 0));
    }
    assert.deepEqual([m.summary.total, m.summary.matched, m.summary.needsReview, m.summary.unmatched, m.summary.confirmed], [5, 5, 0, 0, 0]);
    assert.equal(m.complete, false);
    assert.deepEqual(await counts(), before, 'no product, order, batch, receipt or stock movement was created or changed');
    assert.equal(await h.models.ProductMapping.collection.countDocuments({}), 0, 'a mapping is only made when a person confirms');
  });

  it('a different strength is never matched automatically: it is unmatched, and the closest products are shown with the conflict', async () => {
    const u = await withRows([row('Paracetamol 250mg Tablet'), row('Paracetamol 650mg Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    const a = rowOf(m, 'Paracetamol 250mg Tablet');
    assert.deepEqual([a.status, a.product], ['unmatched', null]);
    assert.ok(a.suggestions.length >= 2 && a.suggestions.every((s) => s.verdict === 'conflict' && s.conflicts.some((c) => c.code === 'STRENGTH_DIFFERS')));
    assert.match(a.warnings.join(' '), /different medicines/);
    assert.equal(rowOf(m, 'Paracetamol 650mg Tablet').product._id, P.para650, 'the right strength is picked, not the 500');
  });

  it('different dosage forms are not interchangeable; the syrup is found only as a syrup', async () => {
    const u = await withRows([row('Paracetamol 500mg Capsule'), row('Paracetamol Syrup 120mg/5ml', { packSize: '60ml', manufacturer: 'Micro Labs' }), row('Amoxicillin 500mg Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    const cap = rowOf(m, 'Paracetamol 500mg Capsule');
    assert.deepEqual([cap.status, cap.product], ['unmatched', null]);
    assert.ok(cap.suggestions.some((s) => s.conflicts.some((c) => c.code === 'FORM_DIFFERS')));
    assert.equal(rowOf(m, 'Paracetamol Syrup 120mg/5ml').product._id, P.paraSyrup);
    const amox = rowOf(m, 'Amoxicillin 500mg Tablet');
    assert.equal(amox.status, 'unmatched', 'the capsule is not the tablet');
  });

  it('a different active ingredient is critical even when the name is similar-looking', async () => {
    const u = await withRows([row('Ibuprofen 500mg Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.equal(m.items[0].status, 'unmatched');
    assert.ok(!JSON.stringify(m.items[0].suggestions).includes(P.archived), 'archived products are not suggested');
  });

  it('a different manufacturer or pack size needs a person, and both differences are visible', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Cipla' }), row('Paracetamol 500mg Tablet 15s', { manufacturer: 'Micro Labs' }), row('Paracetamol 500mg Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    const [a, b, c] = m.items;
    assert.deepEqual([a.status, a.product._id], ['needs_review', P.para500]);
    assert.ok(a.conflicts.some((x) => x.code === 'MANUFACTURER_DIFFERS') && a.warnings.some((w) => /Manufacturer differs/.test(w)));
    assert.deepEqual([b.status, b.conflicts.map((x) => x.code)], ['needs_review', ['PACK_DIFFERS']]);
    assert.match(b.warnings.join(' '), /Pack size differs: invoice 15s, product 10s/);
    assert.equal(c.status, 'matched', 'nothing contradicts it');
  });

  it('several products with the same name need a person unless the manufacturer settles it', async () => {
    const u = await withRows([row('Cefixime 200mg Tablet'), row('Cefixime 200mg Tablet', { manufacturer: 'Lupin' })]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.equal(m.items[0].status, 'needs_review');
    assert.match(m.items[0].warnings.join(' '), /More than one product matches equally well/);
    assert.deepEqual([m.items[1].status, m.items[1].product._id], ['matched', P.cefixB]);
    assert.ok(m.items[0].suggestions.map((s) => s.productId).includes(P.cefixA) && m.items[0].suggestions.map((s) => s.productId).includes(P.cefixB));
  });

  it('missing details are flagged: no strength, no form, no name', async () => {
    const u = await withRows([row('Paracetamol'), row('Azithromycin 500mg'), row(null, { description: null })]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.equal(m.items[0].status, 'needs_review', 'a product with a strength cannot be matched to a line without one');
    assert.ok(m.items[0].warnings.some((w) => /does not state a strength|does not state a dosage form/.test(w)));
    assert.equal(m.items[1].status, 'needs_review');
    assert.ok(m.items[1].warnings.some((w) => /does not state a dosage form/.test(w)));
    assert.deepEqual([m.items[2].status, m.items[2].warnings[0]], ['unmatched', 'The invoice line has no medicine name.']);
  });

  it('a product that does not exist is reported as such, with a plain message and no way to create it from here', async () => {
    const u = await withRows([row('Zzyzx Forte Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.deepEqual([m.items[0].status, m.items[0].suggestions.length], ['unmatched', 0], 'another organization’s product is never offered');
    const s = (await T.client.get(`/ai-billing/${u._id}/product-matches/${m.items[0].itemId}/suggestions`)).data;
    assert.deepEqual([s.none, s.message], [true, 'No matching product found.']);
    assert.match(s.createProductHint, /Inventory/);
    const found = (await T.client.get(`/ai-billing/${u._id}/product-matches/${m.items[0].itemId}/suggestions?search=zzyzx`)).data;
    assert.equal(found.none, true);
    assert.equal(await h.models.Medicine.collection.countDocuments({ organizationId: T.org._id, medicineName: /Zzyzx/ }), 0, 'no product was created');
  });
});

describe('Choosing and confirming a product', () => {
  it('manual search finds products by name, SKU, manufacturer and strength, scored against the row with their conflicts', async () => {
    const u = await withRows([row('Some brand tonic 650')]);
    const m = (await matchAll(T.client, u._id)).data;
    const id = m.items[0].itemId;
    const q = async (s) => (await T.client.get(`/ai-billing/${u._id}/product-matches/${id}/suggestions?search=${encodeURIComponent(s)}`)).data.suggestions.map((x) => x.product.name);
    assert.deepEqual(await q('dolo-650'), ['Dolo 650']);
    assert.ok((await q('micro labs')).includes('Paracetamol 650mg Tablet'));
    assert.deepEqual((await q('cipla 500')).sort(), ['Amoxicillin 500mg Capsule', 'Azithromycin 500mg Tablet']);
    assert.ok(!(await q('ibuprofen')).includes('Ibuprofen 400mg Tablet'), 'archived');
    const scored = (await T.client.get(`/ai-billing/${u._id}/product-matches/${id}/suggestions?search=paracetamol`)).data.suggestions;
    assert.ok(scored.every((s) => 'score' in s && Array.isArray(s.reasons) && Array.isArray(s.conflicts) && s.product._id));
  });

  it('a person can pick a product; a conflicting one needs an explicit acknowledgement, here and again at confirmation', async () => {
    const u = await withRows([row('Paracetamol 250mg Tablet', { manufacturer: 'Micro Labs' })]);
    const m = (await matchAll(T.client, u._id)).data;
    const id = m.items[0].itemId;
    const refused = await pick(T.client, u._id, id, { productId: P.para500 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code || refused.body.error?.code, 'MATCH_CONFLICT');
    assert.match(refused.body.message, /Strength differs/);
    const ok = await pick(T.client, u._id, id, { productId: P.para500, acknowledgeConflicts: true });
    assert.equal(ok.status, 200);
    const r = ok.data.items[0];
    assert.deepEqual([r.status, r.mappingSource, r.confirmation, r.reviewed, r.product._id], ['needs_review', 'manual', 'pending', true, P.para500]);
    assert.equal((await confirm(T.client, u._id, id)).status, 409, 'confirming still needs the acknowledgement');
    const done = await confirm(T.client, u._id, id, { acknowledgeConflicts: true });
    assert.equal(done.status, 200);
    assert.deepEqual([done.data.items[0].confirmation, done.data.items[0].confirmedByName != null], ['confirmed', true]);
    assert.equal((await pick(T.client, u._id, id, { productId: 'nope' })).status, 400);
    assert.equal((await pick(T.client, u._id, id, { productId: P.archived })).status, 404, 'an archived product cannot be chosen');
    assert.equal((await pick(T.client, u._id, id, { productId: String(oid()) })).status, 404);
  });

  it('confirm-all confirms only matches that need no human judgement; suggestions, conflicts and unmatched rows are left alone', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' }), row('Cefixime 200mg Tablet'), row('Paracetamol 250mg Tablet'), row('Zzyzx Forte Tablet'), row('Azithromycin 500mg Tablet', { manufacturer: 'Cipla' })]);
    const m = (await matchAll(T.client, u._id)).data;
    const cef = m.items[1];
    await pick(T.client, u._id, cef.itemId, { productId: P.cefixA }); // a person looked at the ambiguous row and chose
    const all = await T.client.post(`/ai-billing/${u._id}/product-matches/confirm-all`);
    assert.equal(all.status, 200);
    assert.equal(all.data.confirmed, 3, JSON.stringify(all.data.skipped));
    const by = Object.fromEntries(all.data.items.map((r) => [r.invoice.name, r.confirmation]));
    assert.deepEqual([by['Paracetamol 500mg Tablet'], by['Azithromycin 500mg Tablet'], by['Cefixime 200mg Tablet']], ['confirmed', 'confirmed', 'confirmed']);
    assert.deepEqual([by['Paracetamol 250mg Tablet'], by['Zzyzx Forte Tablet']], ['pending', 'pending']);
    assert.equal(all.data.skipped.length, 2);
    assert.equal(all.data.complete, false);
    // a row with only a suggestion that needs review is not confirmed by confirm-all
    const v = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Cipla' })]);
    await matchAll(T.client, v._id);
    const again = (await T.client.post(`/ai-billing/${v._id}/product-matches/confirm-all`)).data;
    assert.deepEqual([again.confirmed, again.skipped[0].reason], [0, 'Needs a person to check it first.']);
  });

  it('marking unmatched is a decision of its own, and every row decided makes the invoice ready for the next phase', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs', batchNumber: 'PX1', expiryDate: '2029-01-31', quantity: 40, freeQuantity: 4, purchaseRate: 21.5, mrp: 33, discountPercentage: 5, gstPercentage: 12, lineTotal: 900 }), row('Zzyzx Forte Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.equal((await T.client.get(`/ai-billing/${u._id}/verified-lines`)).data.complete, false);
    await confirm(T.client, u._id, m.items[0].itemId);
    const r = await T.client.post(`/ai-billing/${u._id}/product-matches/${m.items[1].itemId}/mark-unmatched`, { note: 'new product, to be added' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.items[1].confirmation, r.data.items[1].status, r.data.items[1].product], ['unmatched', 'unmatched', null]);
    const lines = (await T.client.get(`/ai-billing/${u._id}/verified-lines`)).data;
    assert.equal(lines.complete, false, 'a row without a product keeps the invoice from being complete');
    const l = lines.lines[0];
    assert.deepEqual([l.productId, l.matchingConfirmation, l.batchNumber, l.expiryDate, l.quantity, l.freeQuantity, l.purchaseRate, l.mrp, l.discount.percentage, l.gst.percentage, l.lineTotal], [P.para500, 'confirmed', 'PX1', '2029-01-31', 40, 4, 21.5, 33, 5, 12, 900]);
    assert.equal(lines.lines[1].matchingConfirmation, 'unmatched');
    const all = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' })]);
    const m2 = (await matchAll(T.client, all._id)).data;
    await confirm(T.client, all._id, m2.items[0].itemId);
    const done = (await T.client.get(`/ai-billing/${all._id}/verified-lines`)).data;
    assert.deepEqual([done.complete, (await matches(all._id)).readyForPhase5], [true, true]);
  });

  it('a row edited after it was matched is stale: it cannot be confirmed until it is matched again', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' })]);
    const m = (await matchAll(T.client, u._id)).data;
    const id = m.items[0].itemId;
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: u.uploadId }, { $set: { 'current.items.0.medicineName': 'Paracetamol 650mg Tablet' } });
    const s = (await matches(u._id)).items[0];
    assert.deepEqual([s.stale, s.status, s.confirmation], [true, 'needs_review', 'pending']);
    assert.match(s.warnings.join(' '), /edited after it was matched/);
    assert.equal((await confirm(T.client, u._id, id)).status, 409);
    const again = (await matchAll(T.client, u._id)).data;
    assert.deepEqual([again.items[0].stale, again.items[0].product._id], [false, P.para650]);
  });

  it('a row keeps its identity through corrections of the extracted invoice, and a re-match keeps what a person decided', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' }), row('Azithromycin 500mg Tablet', { manufacturer: 'Cipla' })]);
    const m = (await matchAll(T.client, u._id)).data;
    await confirm(T.client, u._id, m.items[0].itemId);
    const again = (await matchAll(T.client, u._id)).data;
    assert.equal(again.items[0].confirmation, 'confirmed', 'confirmed rows are kept');
    const refused = await matchAll(T.client, u._id, { rematch: 'all' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code || refused.body.error?.code, 'MATCH_FORCE_REQUIRED');
    const forced = (await matchAll(T.client, u._id, { rematch: 'all', force: true })).data;
    assert.equal(forced.items[0].confirmation, 'pending');
  });
});

describe('Remembered mappings', () => {
  it('a confirmed match is remembered for the supplier and reused only for the same description, after the product is checked again', async () => {
    const first = await withRows([row('PCM 500 TAB', { manufacturer: 'Micro Labs' })]);
    const m = (await matchAll(T.client, first._id)).data;
    await confirm(T.client, first._id, m.items[0].itemId);
    const map = await h.models.ProductMapping.collection.find({}).toArray();
    assert.equal(map.length, 1);
    assert.deepEqual([String(map[0].medicineId), map[0].originalName, map[0].normalizedName, map[0].source, map[0].supplierKey.length > 0, map[0].confirmedByName != null], [P.para500, 'PCM 500 TAB', 'paracetamol', 'automatic', true, true]);

    const second = await withRows([row('PCM 500 TAB', { manufacturer: 'Cipla' }), row('PCM 650 TAB')]);
    const r = (await matchAll(T.client, second._id)).data;
    const [a, b] = r.items;
    assert.equal(a.mappingSource, 'previously_confirmed');
    assert.equal(a.product._id, P.para500);
    assert.ok(a.reasons[0].startsWith('Previously confirmed for this supplier'));
    assert.equal(a.status, 'needs_review', 'a manufacturer that differs this time still needs a look');
    assert.deepEqual([b.mappingSource, b.product._id], ['automatic', P.para650], 'a different description is never matched by the remembered one');
    assert.equal(a.confirmation, 'pending', 'reuse is not confirmation');
    assert.equal((await h.models.ProductMapping.collection.findOne({})).usageCount, 1);

    // a different supplier does not share it
    const third = await withRows([row('PCM 500 TAB', { manufacturer: 'Micro Labs' })], { supplier: { ...SUPPLIER, name: 'Cipla Wholesale', gstin: '29AAAAA0000A1Z5' } });
    assert.equal((await matchAll(T.client, third._id)).data.items[0].mappingSource, 'automatic');

    // the product changed since: the mapping is no longer valid and is not used
    await h.models.Medicine.collection.updateOne({ _id: oid(P.para500) }, { $set: { strength: '1000mg', medicineName: 'Paracetamol 1000mg Tablet' } });
    const fourth = await withRows([row('PCM 500 TAB', { manufacturer: 'Micro Labs' })]);
    const x = (await matchAll(T.client, fourth._id)).data.items[0];
    assert.notEqual(x.mappingSource, 'previously_confirmed');
    assert.notEqual(x.product?._id, P.para500);
    assert.match(x.warnings.join(' '), /remembered mapping was not used|different medicines/);
    await h.models.Medicine.collection.updateOne({ _id: oid(P.para500) }, { $set: { strength: '500mg', medicineName: 'Paracetamol 500mg Tablet' } });
  });

  it('there is one mapping per supplier description: a different product replaces it and the old one is kept in its history; races make one', async () => {
    const a = await withRows([row('Cetirizine 10mg Tablet', { manufacturer: 'Sun Pharma' })]);
    const b = await withRows([row('Cetirizine 10mg Tablet', { manufacturer: 'Sun Pharma' })]);
    const ma = (await matchAll(T.client, a._id)).data;
    const mb = (await matchAll(T.client, b._id)).data;
    const rs = await Promise.all([confirm(T.client, a._id, ma.items[0].itemId), confirm(T.client, b._id, mb.items[0].itemId)]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200]);
    assert.equal(await h.models.ProductMapping.collection.countDocuments({}), 1, 'one description, one mapping — even when confirmed twice at once');

    const c = await withRows([row('Cetirizine 10mg Tablet', { manufacturer: 'Sun Pharma' })]);
    const mc = (await matchAll(T.client, c._id)).data.items[0];
    assert.equal(mc.mappingSource, 'previously_confirmed');
    await pick(T.client, c._id, mc.itemId, { productId: P.cetir });
    await confirm(T.client, c._id, mc.itemId);
    const d = await withRows([row('Cetirizine 10mg Tablet', { manufacturer: 'Sun Pharma' })]);
    const md = (await matchAll(T.client, d._id)).data.items[0];
    await pick(T.client, d._id, md.itemId, { productId: P.cetir });
    await h.models.Medicine.collection.updateOne({ _id: oid(P.cetir) }, { $set: { updatedAt: new Date() } });
    // choose another product for the same description
    const e = await withRows([row('Cetirizine 10mg Tablet', { manufacturer: 'Sun Pharma' })]);
    const me = (await matchAll(T.client, e._id)).data.items[0];
    const sel = await pick(T.client, e._id, me.itemId, { productId: P.azithro, acknowledgeConflicts: true });
    assert.equal(sel.status, 200);
    assert.equal((await confirm(T.client, e._id, me.itemId, { acknowledgeConflicts: true })).status, 200);
    const maps = await h.models.ProductMapping.collection.find({}).toArray();
    assert.equal(maps.length, 1);
    assert.equal(String(maps[0].medicineId), P.azithro);
    assert.equal(maps[0].history.length, 1, 'the product it used to point to is kept');
  });

  it('a similar-name suggestion that a person did not choose is not remembered', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Cipla' })]);
    const m = (await matchAll(T.client, u._id)).data;
    assert.equal(m.items[0].status, 'needs_review');
    assert.equal((await confirm(T.client, u._id, m.items[0].itemId)).status, 200, 'a person may accept it');
    assert.equal(await h.models.ProductMapping.collection.countDocuments({}), 0, 'but it is not made permanent from similarity alone');
  });
});

describe('Who may use it, and large invoices', () => {
  it('needs a signed-in person who can manage inventory, and keeps organizations apart', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet')]);
    const m = (await matchAll(T.client, u._id)).data;
    const id = m.items[0].itemId;
    const calls = [
      (c) => matchAll(c, u._id), (c) => c.get(`/ai-billing/${u._id}/product-matches`), (c) => c.get(`/ai-billing/${u._id}/product-matches/${id}/suggestions`), (c) => pick(c, u._id, id, { productId: P.para500 }),
      (c) => confirm(c, u._id, id), (c) => c.post(`/ai-billing/${u._id}/product-matches/confirm-all`), (c) => c.post(`/ai-billing/${u._id}/product-matches/${id}/mark-unmatched`, {}), (c) => c.get(`/ai-billing/${u._id}/verified-lines`),
    ];
    for (const call of calls) {
      assert.equal((await call(h.client())).status, 401);
      assert.equal((await call(await asRole('STAFF'))).status, 403);
      assert.equal((await call(other.client)).status, 404);
    }
    assert.equal((await matchAll(await asRole('INVENTORY_MANAGER'), u._id)).status, 200);
  });

  it('matches a large invoice quickly and keeps every row separate', async () => {
    const names = ['Paracetamol 500mg Tablet', 'PCM 650 TAB', 'Azithromycin 500mg Tablet', 'Cetirizine 10mg Tablet', 'Amoxicillin 500mg Capsule', 'Unknown Medicine Forte Tablet', 'Cefixime 200mg Tablet', 'Paracetamol Syrup 120mg/5ml'];
    const rows = Array.from({ length: 300 }, (_, i) => row(names[i % names.length], { batchNumber: `L${i}`, manufacturer: i % 3 === 0 ? 'Micro Labs' : null }));
    const u = await withRows(rows);
    const t0 = Date.now();
    const r = await matchAll(T.client, u._id);
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
    assert.equal(r.data.summary.total, 300);
    assert.equal(r.data.items.length, 300);
    assert.equal(new Set(r.data.items.map((x) => x.itemId)).size, 300);
    assert.deepEqual(r.data.items.slice(0, 3).map((x) => x.invoice.batchNumber), ['L0', 'L1', 'L2'], 'each row keeps its own batch');
    assert.equal(r.data.summary.matched + r.data.summary.needsReview + r.data.summary.unmatched, 300);
    assert.ok(r.data.items.filter((x) => x.invoice.name.startsWith('Unknown')).every((x) => x.status === 'unmatched'));
  });

  it('filters by status and searches by medicine name; the cards count what is shown', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' }), row('Paracetamol 500mg Tablet', { manufacturer: 'Cipla' }), row('Zzyzx Forte Tablet'), row('Azithromycin 500mg Tablet', { manufacturer: 'Cipla' })]);
    await matchAll(T.client, u._id);
    const all = await matches(u._id);
    assert.deepEqual([all.summary.total, all.summary.matched, all.summary.needsReview, all.summary.unmatched], [4, 2, 1, 1]);
    assert.equal((await matches(u._id, T.client, '?status=matched')).items.length, 2);
    assert.equal((await matches(u._id, T.client, '?status=needs_review')).items.length, 1);
    assert.equal((await matches(u._id, T.client, '?status=unmatched')).items[0].invoice.name, 'Zzyzx Forte Tablet');
    assert.deepEqual((await matches(u._id, T.client, '?search=azithro')).items.map((x) => x.invoice.name), ['Azithromycin 500mg Tablet']);
    assert.equal((await matches(u._id, T.client, '?status=matched')).summary.total, 4, 'the cards always describe the whole invoice');
    assert.equal((await T.client.get(`/ai-billing/${u._id}/product-matches?status=weird`)).status, 400);
  });

  it('cannot be changed once a draft order was saved from the invoice', async () => {
    const u = await withRows([row('Paracetamol 500mg Tablet', { manufacturer: 'Micro Labs' })]);
    const m = (await matchAll(T.client, u._id)).data;
    await h.models.InvoiceUpload.collection.updateOne({ _id: oid(u._id) }, { $set: { status: 'drafted' } });
    assert.equal((await confirm(T.client, u._id, m.items[0].itemId)).status, 409);
    assert.equal((await matchAll(T.client, u._id)).status, 409);
    assert.equal((await T.client.get(`/ai-billing/${u._id}/product-matches`)).status, 200, 'but it can still be read');
  });
});
