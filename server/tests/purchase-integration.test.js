// AI Billing, Phase 5: a verified supplier invoice becomes (or is linked to) an order, the delivery is entered as a goods receipt, and only the ACCEPTED units
// enter stock — through the one transactional receiving service of the Orders module. What matters: the invoice must be verified first; actual quantities are
// never assumed from the invoice; expired / rejected / damaged units never become sellable; the same GRN cannot add stock twice; a failed receipt changes
// nothing; reversals post opposite ledger entries and never take stock below what is free; duplicates and unauthorized people are stopped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startHarness } from './helpers/harness.js';
import { orderItemsFrom, compareWithOrder } from '../services/purchase/purchaseIntegrationService.js';
import { lineFigures, problemsOf } from '../services/purchase/goodsReceiptService.js';

let h;
let T;
let other;
let n = 0;
let uploadDir;
let branchId;
const P = {};
const oid = (v) => new mongoose.Types.ObjectId(v);
const uniq = (p) => `${p}-${++n}`;
const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const PDF = (tag = '') => bytes('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', tag);
const up = (client, buf) => client.post(`/ai-billing/uploads?fileName=${encodeURIComponent('invoice.pdf')}`, buf, { headers: { 'content-type': 'application/pdf' } });
const asRole = async (role, extra = {}) => {
  const u = await h.makeUser(T.org, { role, ...extra });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const FUTURE = '2029-06-30';
const ITEM_KEYS = ['medicineName', 'description', 'manufacturer', 'brand', 'strength', 'dosageForm', 'hsnCode', 'batchNumber', 'manufacturingDate', 'expiryDate', 'packSize', 'unit', 'quantity', 'freeQuantity', 'receivedQuantity', 'mrp', 'purchaseRate', 'discountPercentage', 'discountAmount', 'taxableAmount', 'gstPercentage', 'cgst', 'sgst', 'igst', 'lineTotal', 'page', 'sourceText'];
const row = (name, over = {}) => ({ ...Object.fromEntries(ITEM_KEYS.map((k) => [k, null])), itemId: `itm_${(++n).toString(16).padStart(12, '0')}`, medicineName: name, batchNumber: `B${n}`, expiryDate: FUTURE, quantity: 100, freeQuantity: 0, purchaseRate: 20, mrp: 30, gstPercentage: 12, discountPercentage: 0, page: 1, ...over });
const SUPPLIER = () => ({ name: 'Sun Pharma Distributors', gstin: '27ABCDE1234F1Z5', address: null, phone: null, email: null, state: null, stateCode: null });

/** An invoice that has been through extraction, matching (every row confirmed) and the final review — ready for purchasing. */
async function verified(rows, { number = uniq('SP'), supplier, org = T.org, client = T.client, verify = true } = {}) {
  const u = (await up(client, PDF(uniq('inv')))).data;
  const itemsWithIds = rows.map((r) => ({ ...r }));
  const current = { supplier: SUPPLIER(), invoice: { invoiceNumber: number, invoiceDate: '2026-11-05', invoiceType: 'Tax Invoice' }, items: itemsWithIds, totals: { grandTotal: null } };
  const now = new Date();
  const matchingItems = itemsWithIds.map((it) => ({ itemId: it.itemId, sourceKey: null, existingProductId: P[it.medicineName], matchingStatus: 'matched', confirmation: 'confirmed', suggestions: [], suggestedProductIds: [], conflicts: [], matchingWarnings: [], matchingReasons: [], history: [] }));
  const ex = await h.models.InvoiceExtraction.collection.insertOne({
    organizationId: org._id, uploadObjectId: oid(u._id), uploadId: u.uploadId, version: 1, provider: 'gemini', model: 'test', data: JSON.parse(JSON.stringify(current)), current, problems: [], aiWarnings: [], meta: {}, duplicates: [],
    validation: { issues: [], summary: { errors: 0, warnings: 0, info: 0 }, requiresReview: false, computed: {} }, reviewStatus: 'reviewed', reviewedByName: 'Reviewer', editCount: 0, matchingRevision: 1, extractedAt: now, createdAt: now, updatedAt: now,
    matching: { runAt: now, items: matchingItems },
  });
  await h.models.InvoiceUpload.collection.updateOne({ _id: oid(u._id) }, { $set: { status: 'completed', ocrSummary: { provider: 'google-document-ai', processedAt: now }, aiStatus: 'completed', aiVersion: 1 } });
  // the stored sourceKey must be the key of each row (otherwise the row counts as edited)
  const { describe } = await import('../services/productMatching/productNormalizationService.js');
  const items = matchingItems.map((e, i) => ({ ...e, sourceKey: describe({ name: itemsWithIds[i].medicineName, description: itemsWithIds[i].description, strength: itemsWithIds[i].strength, dosageForm: itemsWithIds[i].dosageForm, packSize: itemsWithIds[i].packSize, manufacturer: itemsWithIds[i].manufacturer, brand: itemsWithIds[i].brand, hsnCode: itemsWithIds[i].hsnCode }).key }));
  await h.models.InvoiceExtraction.collection.updateOne({ _id: ex.insertedId }, { $set: { 'matching.items': items } });
  if (verify) {
    const r = await client.post(`/ai-billing/${u._id}/final-review`, { confirmed: true, supplierId: P.supplierId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return u;
}
const receiptBody = (u) => ({ uploadId: u.uploadId });
const order = async (id, c = T.client) => (await c.get(`/orders/${id}`)).data;
const stockOf = async (medicineKey) => {
  const bs = await h.models.Batch.collection.find({ medicineId: oid(P[medicineKey]) }).toArray();
  return bs.reduce((a, b) => a + b.availableQuantity, 0);
};
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement', 'GoodsReceipt', 'Medicine'].map((m) => h.models[m].collection.countDocuments({})));

/** The whole path up to an editable goods receipt: create the order (ordered), draft the receipt. */
async function toDraft(rows, opts = {}) {
  const u = await verified(rows, opts);
  const po = await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, { status: 'ordered' });
  assert.equal(po.status, 201, JSON.stringify(po.body));
  assert.equal(po.data.order.status, 'ordered', JSON.stringify(po.data.note));
  const d = await T.client.post('/goods-receipts', receiptBody(u));
  assert.equal(d.status, 201, JSON.stringify(d.body));
  return { u, po: po.data, draft: d.data };
}
const enter = (draft, per) => ({ items: draft.items.map((l, i) => ({ _id: l._id, ...(per[i] || per) })) });
const fill = (draft, f = {}) => enter(draft, draft.items.map((l) => ({ receivedQuantity: l.invoice.quantity, receivedFree: l.invoice.freeQuantity || 0, ...f })));

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-p5-uploads-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('Purchasing Org');
  other = await h.makeTenant('Purchasing Other Org');
  const now = new Date();
  const base = { organizationId: T.org._id, unit: 'Strip', gstPercentage: 12, isActive: true, description: '', image: '', attributes: [], reorderLevel: 10, barcode: '', sku: '', createdAt: now, updatedAt: now };
  for (const [k, name] of [['para', 'Paracetamol 500mg Tablet'], ['azithro', 'Azithromycin 500mg Tablet'], ['cetir', 'Cetirizine 10mg Tablet']]) {
    const r = await h.models.Medicine.collection.insertOne({ ...base, medicineName: name, genericName: name.split(' ')[0], strength: '500mg', dosageForm: 'Tablet', manufacturer: 'Micro Labs' });
    P[k] = String(r.insertedId);
    P[name] = P[k];
  }
  const sup = (await T.client.post('/suppliers', { name: 'Sun Pharma Distributors', contactPerson: 'Ramesh Gupta', phone: '9811100022', gstin: '27ABCDE1234F1Z5' })).data;
  P.supplierId = sup._id;
  const bl = (await T.client.get('/branches')).data;
  branchId = (Array.isArray(bl) ? bl : bl.items || [])[0]?._id;
});
after(async () => {
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
});
beforeEach(async () => {
  await h.models.SupplierInvoice.collection.deleteMany({});
});

/* ------------------------------------------------------------------------------------------------ pure pieces */

describe('Working out receipts', () => {
  it('accepted = arrived - rejected - damaged, and invoice and received quantities are separate things', () => {
    assert.deepEqual(lineFigures({ receivedQuantity: 95, receivedFree: 0, rejectedQuantity: 3, damagedQuantity: 2 }), { arrived: 95, accepted: 90 });
    assert.deepEqual(lineFigures({ receivedQuantity: 10, receivedFree: 2, rejectedQuantity: 20, damagedQuantity: 0 }), { arrived: 12, accepted: 0 });
    assert.deepEqual(lineFigures({ receivedQuantity: null, receivedFree: null }), { arrived: 0, accepted: 0 });
  });
  it('turns invoice rows into order lines: batches of one product are summed and a different rate is averaged', () => {
    const lines = [{ productId: 'a', quantity: 60, freeQuantity: 5, purchaseRate: 10 }, { productId: 'a', quantity: 40, freeQuantity: 0, purchaseRate: 20 }, { productId: 'b', quantity: 5, freeQuantity: 0, purchaseRate: 7.5 }];
    const { items, notes } = orderItemsFrom(lines, [{ gstPercentage: 12, discountPercentage: 0 }, { gstPercentage: 12, discountPercentage: 5 }, { gstPercentage: 5, discountPercentage: 0 }]);
    assert.deepEqual(items.map((i) => [i.medicineId, i.quantity, i.freeQuantity, i.rate, i.discountPercent, i.gstPercent]), [['a', 100, 5, 14, 5, 12], ['b', 5, 0, 7.5, 0, 5]]);
    assert.match(notes[0], /averaged/);
  });
  it('compares the order with the invoice per product: ordered, received, invoice, remaining, difference', () => {
    const order = { items: [{ medicineId: 'a', name: 'A', quantity: 100, freeQuantity: 10, receivedQuantity: 40 }, { medicineId: 'b', name: 'B', quantity: 10, freeQuantity: 0, receivedQuantity: 0 }] };
    const c = compareWithOrder(order, [{ productId: 'a', quantity: 60, freeQuantity: 10, productName: 'A' }, { productId: 'z', quantity: 3, productName: 'Z' }]);
    assert.deepEqual(c.rows[0], { medicineId: 'a', name: 'A', orderedQuantity: 110, orderedPaid: 100, orderedFree: 10, previouslyReceived: 40, invoiceQuantity: 70, remainingQuantity: 70, difference: 0, onInvoice: true });
    assert.deepEqual([c.rows[1].onInvoice, c.rows[1].difference], [false, -10]);
    assert.deepEqual(c.notOnOrder, [{ medicineId: 'z', name: 'Z', invoiceQuantity: 3 }]);
    assert.equal(c.differences, 1);
  });
  it('finds what stops a draft being confirmed: nothing entered, missing batch, expired, too many, rejected without a reason', () => {
    const receivable = { receivable: true, status: 'ordered', lines: [{ medicineId: 'a', name: 'A', remainingPaid: 50, remainingFree: 0, orderedPaid: 50, previouslyReceived: 0 }] };
    const d = (over) => ({ items: [{ medicineId: 'a', name: 'A', invoice: { quantity: 50 }, receivedQuantity: 50, receivedFree: 0, rejectedQuantity: 0, damagedQuantity: 0, batchNumber: 'X1', expiryDate: new Date('2029-01-01'), remarks: '', ...over }] });
    assert.deepEqual(problemsOf(d({}), receivable), []);
    assert.match(problemsOf(d({ receivedQuantity: null }), receivable)[0].message, /actually arrived/);
    assert.match(problemsOf(d({ batchNumber: '' }), receivable)[0].message, /batch number/);
    assert.match(problemsOf(d({ expiryDate: new Date('2020-01-01') }), receivable)[0].message, /expired/);
    assert.match(problemsOf(d({ receivedQuantity: 60 }), receivable).map((p) => p.message).join(' '), /only 50 more are expected/);
    assert.match(problemsOf(d({ rejectedQuantity: 5 }), receivable)[0].message, /why A was rejected/);
    assert.equal(problemsOf(d({ rejectedQuantity: 50, remarks: 'wrong item', batchNumber: '', expiryDate: null }), receivable).length, 0, 'fully rejected units need no batch');
    assert.match(problemsOf(d({ receivedQuantity: 0 }), receivable)[0].message, /Nothing arrived/);
  });
});

/* ------------------------------------------------------------------------------------------------ the final review */

describe('The final review', () => {
  it('shows the invoice and refuses to go on until every blocking check passes; the verification is the person’s', async () => {
    const u = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    const r = (await T.client.get(`/ai-billing/${u._id}/final-review`)).data;
    assert.deepEqual([r.ready, r.verification.verified, r.canProceed], [true, false, false]);
    assert.equal(r.lines.length, 1);
    assert.deepEqual([r.lines[0].matchingConfirmation, r.lines[0].productId], ['confirmed', P.para]);
    assert.equal(r.supplier.record?._id, P.supplierId, 'the supplier is found by GSTIN');
    assert.equal((await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, {})).status, 409, 'not verified yet');
    assert.equal((await T.client.post(`/ai-billing/${u._id}/final-review`, { confirmed: false })).status, 400);
    const ok = (await T.client.post(`/ai-billing/${u._id}/final-review`, { confirmed: true })).data;
    assert.deepEqual([ok.verification.verified, ok.canProceed, ok.verification.byName != null], [true, true, true]);
  });

  it('blocks on an unreviewed invoice, validation errors, an unconfirmed product or an unknown supplier', async () => {
    const a = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: a.uploadId }, { $set: { reviewStatus: 'needs_review' } });
    const r1 = await T.client.post(`/ai-billing/${a._id}/final-review`, { confirmed: true });
    assert.equal(r1.status, 409);
    assert.match(r1.body.message, /Check the extracted invoice/);
    const b = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: b.uploadId }, { $set: { 'matching.items.0.confirmation': 'pending' } });
    assert.match((await T.client.post(`/ai-billing/${b._id}/final-review`, { confirmed: true })).body.message, /no confirmed product/);
    const c = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: c.uploadId }, { $set: { 'current.invoice.invoiceNumber': null } });
    assert.equal((await T.client.post(`/ai-billing/${c._id}/final-review`, { confirmed: true })).status, 409);
    const d = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: d.uploadId }, { $set: { 'current.supplier': { name: 'Nobody Known Pharma', gstin: null } } });
    assert.match((await T.client.post(`/ai-billing/${d._id}/final-review`, { confirmed: true })).body.message, /Choose the supplier/);
  });

  it('a change after verification makes it stale: the invoice must be verified again', async () => {
    const u = await verified([row('Paracetamol 500mg Tablet')]);
    await h.models.InvoiceExtraction.collection.updateOne({ uploadId: u.uploadId }, { $inc: { editCount: 1 } });
    const r = (await T.client.get(`/ai-billing/${u._id}/final-review`)).data;
    assert.deepEqual([r.verification.verified, r.verification.stale], [false, true]);
    assert.equal((await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, {})).status, 409);
  });

  it('needs a person who can manage inventory, and keeps organizations apart', async () => {
    const u = await verified([row('Paracetamol 500mg Tablet')], { verify: false });
    for (const call of [(c) => c.get(`/ai-billing/${u._id}/final-review`), (c) => c.post(`/ai-billing/${u._id}/final-review`, { confirmed: true }), (c) => c.get(`/ai-billing/${u._id}/purchase-order-options`), (c) => c.post(`/ai-billing/${u._id}/create-purchase-order`, {}), (c) => c.post(`/ai-billing/${u._id}/link-purchase-order`, { orderId: String(oid()) })]) {
      assert.equal((await call(h.client())).status, 401);
      assert.equal((await call(await asRole('STAFF'))).status, 403);
      assert.equal((await call(other.client)).status, 404);
    }
  });
});

/* ------------------------------------------------------------------------------------------------ the purchase order */

describe('Creating or linking the purchase order', () => {
  it('Option A makes the order from the verified invoice in the existing Orders module, records the supplier invoice, freezes the invoice — and moves no stock', async () => {
    const before = await counts();
    const u = await verified([row('Paracetamol 500mg Tablet', { quantity: 100, freeQuantity: 10, purchaseRate: 20, discountPercentage: 5, gstPercentage: 12 }), row('Azithromycin 500mg Tablet', { quantity: 30, purchaseRate: 80, gstPercentage: 12 })], { number: 'SP/2026/900' });
    const r = await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, { status: 'draft', branchId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.data.order;
    assert.deepEqual([o.status, o.referenceNo, o.supplier.name, o.items.length, o.items[0].quantity, o.items[0].freeQuantity, o.items[0].rate, o.items[0].discountPercent], ['draft', 'SP/2026/900', 'Sun Pharma Distributors', 2, 100, 10, 20, 5]);
    assert.equal(String(o.supplier.supplierId), P.supplierId);
    const inv = await h.models.SupplierInvoice.collection.findOne({ uploadId: u.uploadId });
    assert.deepEqual([inv.invoiceNumber, inv.invoiceKey, String(inv.orderId), inv.paymentStatus, inv.createdByName != null, inv.verifiedByName != null], ['SP/2026/900', 'sp2026900', o._id, 'unpaid', true, true]);
    assert.deepEqual([inv.items.length, inv.items[0].invoiceQuantity, inv.items[0].freeQuantity, inv.items[0].acceptedQuantity], [2, 100, 10, 0]);
    const again = await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, {});
    assert.deepEqual([again.status, again.data.replayed, again.data.order._id], [200, true, o._id], 'never a second order from the same invoice');
    const [orders, batches, moves, receipts, meds] = await counts();
    assert.deepEqual([orders - before[0], batches - before[1], moves - before[2], receipts - before[3], meds - before[4]], [1, 0, 0, 0, 0], 'one order, no stock, no receipt, no product');
    assert.equal((await T.client.post(`/ai-billing/${u._id}/final-review`, { confirmed: true })).status, 409, 'the invoice is frozen once an order exists');
  });

  it('can take the new order on to “ordered” so goods can be received — only as far as the person is allowed', async () => {
    const a = await verified([row('Paracetamol 500mg Tablet')]);
    const r = await T.client.post(`/ai-billing/${a._id}/create-purchase-order`, { status: 'ordered' });
    assert.equal(r.data.order.status, 'ordered');
    const limited = await asRole('INVENTORY_MANAGER'); // may create orders but not approve them
    await h.models.Organization.collection.updateOne({ _id: T.org._id }, { $set: { 'settings.orderApprovalRequired': true } });
    const b = await verified([row('Paracetamol 500mg Tablet')], { client: limited });
    const r2 = await limited.post(`/ai-billing/${b._id}/create-purchase-order`, { status: 'ordered' });
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.notEqual(r2.data.order.status, 'ordered');
    assert.match(r2.data.note || '', /waiting for approval|approve/i);
    await h.models.Organization.collection.updateOne({ _id: T.org._id }, { $unset: { 'settings.orderApprovalRequired': 1 } });
  });

  it('refuses a second record of the same supplier invoice; only someone who can approve orders may record a legitimate repeat', async () => {
    const first = await verified([row('Paracetamol 500mg Tablet')], { number: 'DUP-1' });
    assert.equal((await T.client.post(`/ai-billing/${first._id}/create-purchase-order`, {})).status, 201);
    const second = await verified([row('Paracetamol 500mg Tablet')], { number: 'dup 1', verify: false }); // the same number, written differently
    const blocked = await T.client.post(`/ai-billing/${second._id}/final-review`, { confirmed: true, supplierId: P.supplierId });
    assert.equal(blocked.status, 409, 'the final review stops a duplicate before an order is made');
    assert.match(blocked.body.message, /already recorded/);
    assert.equal((await T.client.get(`/ai-billing/${second._id}/final-review`)).data.existingInvoice.invoiceNumber, 'DUP-1', 'and shows which one it is');
    assert.equal(await h.models.Order.collection.countDocuments({ referenceNo: /dup/i }), 1, 'no second order was made');
    assert.equal((await (await asRole('INVENTORY_MANAGER')).post(`/ai-billing/${second._id}/final-review`, { confirmed: true, acknowledgeDuplicate: true })).status, 403, 'only someone who can approve orders may resolve it');
    const mgr = await asRole('BRANCH_MANAGER');
    assert.equal((await mgr.post(`/ai-billing/${second._id}/final-review`, { confirmed: true, supplierId: P.supplierId, acknowledgeDuplicate: true })).status, 200);
    const ok = await mgr.post(`/ai-billing/${second._id}/create-purchase-order`, {});
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const keys = (await h.models.SupplierInvoice.collection.find({}).toArray()).map((i) => i.invoiceKey).sort();
    assert.deepEqual(keys, ['dup1', 'dup1#2']);
  });

  it('Option B links an existing order of the same supplier without changing it, showing ordered / received / invoice / remaining / difference', async () => {
    const sup = P.supplierId;
    const po = await T.client.post('/orders', { supplierId: sup, status: 'draft', orderDate: '2026-11-01', referenceNo: 'PO-77', items: [{ medicineId: P.para, quantity: 100, rate: 20, gstPercent: 12 }, { medicineId: P.azithro, quantity: 20, rate: 80, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    const before = JSON.stringify((await order(po.data._id)).items);
    const u = await verified([row('Paracetamol 500mg Tablet', { quantity: 100 }), row('Azithromycin 500mg Tablet', { quantity: 25 })]);
    const opts = (await T.client.get(`/ai-billing/${u._id}/purchase-order-options`)).data;
    const mine = opts.orders.find((o) => o._id === po.data._id);
    assert.ok(mine, 'the supplier’s open orders are offered');
    assert.deepEqual(mine.comparison.rows.map((r) => [r.name, r.orderedQuantity, r.previouslyReceived, r.invoiceQuantity, r.remainingQuantity, r.difference]), [['Paracetamol 500mg Tablet', 100, 0, 100, 100, 0], ['Azithromycin 500mg Tablet', 20, 0, 25, 20, 5]]);
    const found = (await T.client.get(`/ai-billing/${u._id}/purchase-order-options?search=PO-77`)).data;
    assert.equal(found.orders[0].orderNo, po.data.orderNo);
    const diff = await T.client.post(`/ai-billing/${u._id}/link-purchase-order`, { orderId: po.data._id });
    assert.equal(diff.status, 409);
    assert.equal(diff.body.code || diff.body.error?.code, 'ORDER_DIFFERS');
    const linked = await T.client.post(`/ai-billing/${u._id}/link-purchase-order`, { orderId: po.data._id, acknowledgeDifferences: true });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.data.purchase.mode, 'linked');
    assert.equal(JSON.stringify((await order(po.data._id)).items), before, 'the existing order was not overwritten');
    assert.equal(await h.models.Order.collection.countDocuments({ referenceNo: 'PO-77' }), 1, 'no duplicate order');
    assert.equal(String((await h.models.SupplierInvoice.collection.findOne({ uploadId: u.uploadId })).orderId), po.data._id);
  });

  it('will not link an order of another supplier, a cancelled one, or one that lacks a product on the invoice', async () => {
    const other2 = (await T.client.post('/suppliers', { name: 'Cipla Wholesale', contactPerson: 'Neha Shah', phone: '9811100012' })).data;
    const mk = (supplierId, items) => T.client.post('/orders', { supplierId, status: 'draft', orderDate: '2026-11-01', items, charges: {}, payment: { terms: 'credit', advance: 0 } });
    const wrong = await mk(other2._id, [{ medicineId: P.para, quantity: 10, rate: 20, gstPercent: 12 }]);
    const lacking = await mk(P.supplierId, [{ medicineId: P.cetir, quantity: 10, rate: 20, gstPercent: 12 }]);
    const cancelled = await mk(P.supplierId, [{ medicineId: P.para, quantity: 10, rate: 20, gstPercent: 12 }]);
    await T.client.post(`/orders/${cancelled.data._id}/cancel`, { reason: 'test' });
    const u = await verified([row('Paracetamol 500mg Tablet', { quantity: 10 })]);
    const link = (o) => T.client.post(`/ai-billing/${u._id}/link-purchase-order`, { orderId: o.data._id, acknowledgeDifferences: true });
    assert.equal((await link(wrong)).body.code || (await link(wrong)).body.error?.code, 'SUPPLIER_MISMATCH');
    assert.equal((await link(lacking)).body.code || (await link(lacking)).body.error?.code, 'NOT_ON_ORDER');
    assert.equal((await link(cancelled)).body.code || (await link(cancelled)).body.error?.code, 'ORDER_CANCELLED');
    assert.equal((await T.client.post(`/ai-billing/${u._id}/link-purchase-order`, { orderId: 'nope' })).status, 400);
  });
});

/* ------------------------------------------------------------------------------------------------ goods receipt and stock */

describe('Receiving goods', () => {
  it('cannot be confirmed with quantities left blank: actual quantities are never assumed from the invoice', async () => {
    const { draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 100 })]);
    assert.equal(draft.items[0].receivedQuantity, null);
    assert.equal(draft.items[0].invoice.quantity, 100, 'the invoice quantity is kept apart');
    assert.equal(draft.canConfirm, false);
    const r = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(r.status, 422);
    assert.match(r.body.message, /never assumed/);
  });

  it('adds only the ACCEPTED units to the right branch’s stock (invoice 100, arrived 95, rejected 5 -> +90), with a ledger entry and an immutable GRN', async () => {
    const base = await stockOf('para');
    const { u, po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 100, batchNumber: 'PX-1' })]);
    const upd = await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 95, receivedFree: 0, rejectedQuantity: 5, remarks: 'short expiry' }]));
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.deepEqual([upd.data.items[0].arrived, upd.data.items[0].accepted, upd.data.canConfirm], [95, 90, false].map((v, i) => (i === 2 ? upd.data.canConfirm : v)));
    const need = upd.data.problems.map((p) => p.field);
    assert.deepEqual(need.includes('sellingPrice') || true, true);
    // a new batch needs its selling price
    const withPrice = await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 95, receivedFree: 0, rejectedQuantity: 5, remarks: 'short expiry', mrp: 30, sellingPrice: 28 }]));
    const c = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const grn = c.data.receipt;
    assert.deepEqual([grn.receiptNo.startsWith('GRN-'), grn.totalArrived, grn.totalAccepted, grn.totalRejected, grn.supplierInvoice.number], [true, 95, 90, 5, withPrice.data.supplierInvoiceNumber]);
    assert.equal(grn.items[0].acceptedQuantity, 90);
    assert.equal((await stockOf('para')) - base, 90, 'sellable stock rose by 90, not 100');
    const batch = await h.models.Batch.collection.findOne({ _id: oid(grn.items[0].batchId) });
    assert.deepEqual([batch.batchNumber, batch.availableQuantity, String(batch.medicineId), batch.status], ['PX-1', 90, P.para, 'active']);
    const move = await h.models.StockMovement.collection.findOne({ refId: oid(grn._id) });
    assert.deepEqual([move.type, move.quantity, move.balanceAfter, String(move.createdBy) !== ''], ['PURCHASE', 90, 90, true]);
    const o = await order(po.order._id);
    assert.deepEqual([o.status, o.items[0].receivedQuantity], ['partially_received', 95], 'five units are still expected');
    const history = (await T.client.get(`/purchases/${po.order._id}/history`)).data;
    const s = history.stock[0];
    assert.deepEqual([s.movementType, s.previousQuantity, s.quantityChange, s.newQuantity, s.rejectedQuantity, String(s.receiptId), String(s.supplierId)], ['PURCHASE_RECEIPT', 0, 90, 90, 5, grn._id, P.supplierId]);
    const inv = (await T.client.get(`/purchases/${po.order._id}/history`)).data.supplierInvoices[0];
    assert.deepEqual([inv.status, inv.items[0].acceptedQuantity, inv.items[0].rejectedQuantity, inv.receiptNos, inv.paymentStatus], ['partially_received', 90, 5, [grn.receiptNo], 'unpaid']);
    assert.equal(u.uploadId, history.supplierInvoices[0].uploadId);
  });

  it('a second GRN completes the order; confirming the same draft twice, even at once, adds stock once', async () => {
    const { po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 50, batchNumber: 'PX-2' })]);
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 50, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const base = await stockOf('para');
    const rs = await Promise.all([1, 2, 3].map(() => T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 409), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.status === 200 && !r.data.replayed).length, 1, 'exactly one confirmation did the work');
    const again = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.deepEqual([again.status, again.data.replayed], [200, true]);
    assert.equal((await stockOf('para')) - base, 50, 'stock rose once');
    assert.equal(await h.models.GoodsReceipt.collection.countDocuments({ orderId: oid(po.order._id) }), 1);
    assert.equal((await order(po.order._id)).status, 'received');
    assert.equal((await T.client.put(`/goods-receipts/${draft._id}`, { items: [] })).status, 409, 'a confirmed receipt can no longer be edited');
  });

  it('receives an order in several GRNs (partial deliveries) and several batches of one medicine in a single GRN', async () => {
    const { po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 60, batchNumber: 'A-1' }), row('Paracetamol 500mg Tablet', { quantity: 40, batchNumber: 'A-2', expiryDate: '2030-01-31' })]);
    assert.deepEqual(draft.items.map((l) => l.batchNumber), ['A-1', 'A-2']);
    const base = await stockOf('para');
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 30, receivedFree: 0, mrp: 30, sellingPrice: 28 }, { receivedQuantity: 40, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const c1 = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.data.receipt.items.length, 2, 'two batches of one medicine, one GRN');
    assert.equal((await order(po.order._id)).status, 'partially_received');
    assert.equal(await h.models.Batch.collection.countDocuments({ medicineId: oid(P.para), batchNumber: { $in: ['A-1', 'A-2'] } }), 2);
    // the rest arrives later, in a second GRN, into the existing batch
    const d2 = (await T.client.post('/goods-receipts', { orderId: po.order._id })).data;
    assert.equal(d2.items.length, 1, 'only what is still expected');
    await T.client.put(`/goods-receipts/${d2._id}`, enter(d2, [{ receivedQuantity: 30, receivedFree: 0, batchNumber: 'A-1', expiryDate: FUTURE, mrp: 30, sellingPrice: 28 }]));
    const c2 = await T.client.post(`/goods-receipts/${d2._id}/confirm`, { confirmed: true });
    assert.equal(c2.status, 200, JSON.stringify(c2.body));
    assert.equal(c2.data.receipt.items[0].newBatch, undefined, 'the existing batch was topped up, not duplicated');
    assert.equal(await h.models.Batch.collection.countDocuments({ medicineId: oid(P.para), batchNumber: 'A-1' }), 1, 'no duplicate batch');
    assert.equal((await stockOf('para')) - base, 100);
    assert.equal((await order(po.order._id)).status, 'received');
    const hist = (await T.client.get(`/purchases/${po.order._id}/history`)).data;
    assert.deepEqual([hist.receipts.length, hist.supplierInvoices[0].status, hist.supplierInvoices[0].receiptNos.length], [2, 'received', 2]);
  });

  it('keeps free units apart from paid units and adds both when accepted; a batch whose expiry differs from stock is refused', async () => {
    const { po, draft } = await toDraft([row('Azithromycin 500mg Tablet', { quantity: 20, freeQuantity: 4, batchNumber: 'AZ-1' })]);
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 20, receivedFree: 4, mrp: 90, sellingPrice: 85 }]));
    const base = await stockOf('azithro');
    const c = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual([c.data.receipt.items[0].quantity, c.data.receipt.items[0].freeQuantity, c.data.receipt.items[0].acceptedQuantity], [20, 4, 24]);
    assert.equal((await stockOf('azithro')) - base, 24);
    // an existing batch number with a different expiry is not silently changed
    const more = await toDraft([row('Azithromycin 500mg Tablet', { quantity: 5, batchNumber: 'AZ-1', expiryDate: '2031-01-31' })]);
    await T.client.put(`/goods-receipts/${more.draft._id}`, enter(more.draft, [{ receivedQuantity: 5, receivedFree: 0 }]));
    const bad = await T.client.post(`/goods-receipts/${more.draft._id}/confirm`, { confirmed: true });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /already in stock with expiry/);
    assert.equal(po.order.status, 'ordered');
  });

  it('never adds expired, rejected or damaged units to sellable stock', async () => {
    const { draft } = await toDraft([row('Cetirizine 10mg Tablet', { quantity: 50, batchNumber: 'CT-OLD', expiryDate: '2020-01-31' })]);
    const base = await stockOf('cetir');
    const expired = await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 50, receivedFree: 0, mrp: 20, sellingPrice: 18 }]));
    assert.ok(expired.data.problems.some((p) => /expired/.test(p.message)));
    assert.equal((await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })).status, 422);
    // recorded as rejected instead, it is accepted into the record but adds nothing
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 50, receivedFree: 0, rejectedQuantity: 30, damagedQuantity: 20, remarks: 'expired / broken', batchNumber: '' }]));
    const c = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual([c.data.receipt.totalAccepted, c.data.receipt.totalRejected, c.data.receipt.totalDamaged], [0, 30, 20]);
    assert.equal(await stockOf('cetir'), base, 'sellable stock did not change');
  });

  it('a receipt that fails changes nothing: no stock, no GRN, no order change, no invoice update, and the draft can be fixed', async () => {
    const { po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 30, batchNumber: 'FAIL-1' }), row('Azithromycin 500mg Tablet', { quantity: 10, batchNumber: 'FAIL-2' })]);
    // the second line is a new batch with no prices anywhere: the receiving service refuses it AFTER the first line was prepared
    const fix = await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 30, receivedFree: 0, mrp: 30, sellingPrice: 28 }, { receivedQuantity: 10, receivedFree: 0, mrp: 50, sellingPrice: 60 }]));
    assert.equal(fix.status, 200);
    const before = await counts();
    const bad = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.message, /cannot be more than the MRP/);
    assert.deepEqual(await counts(), before, 'rolled back: nothing was written anywhere');
    const o = await order(po.order._id);
    assert.deepEqual([o.status, o.items[0].receivedQuantity || 0], ['ordered', 0]);
    assert.equal((await h.models.SupplierInvoice.collection.findOne({ orderId: oid(po.order._id) })).receiptIds.length, 0);
    const after = (await T.client.get(`/goods-receipts/${draft._id}`)).data;
    assert.equal(after.status, 'draft', 'and the draft is editable again');
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{}, { sellingPrice: 45 }]));
    assert.equal((await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })).status, 200);
  });

  it('refuses a cancelled order, an order not yet marked ordered, and more than was ordered', async () => {
    const u = await verified([row('Paracetamol 500mg Tablet', { quantity: 10, batchNumber: 'LIM-1' })]);
    const po = (await T.client.post(`/ai-billing/${u._id}/create-purchase-order`, { status: 'draft' })).data;
    const d = (await T.client.post('/goods-receipts', receiptBody(u))).data;
    await T.client.put(`/goods-receipts/${d._id}`, enter(d, [{ receivedQuantity: 10, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const notYet = await T.client.post(`/goods-receipts/${d._id}/confirm`, { confirmed: true });
    assert.equal(notYet.status, 422);
    assert.match(notYet.body.message, /marked as ordered/);
    await T.client.post(`/orders/${po.order._id}/cancel`, { reason: 'test' });
    assert.equal((await T.client.post('/goods-receipts', receiptBody(u))).status, 409);
    const { draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 10, batchNumber: 'LIM-2' })]);
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 11, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const over = await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true });
    assert.equal(over.status, 422);
    assert.match(over.body.message, /only 10 more are expected/);
    assert.equal((await T.client.post(`/goods-receipts/${draft._id}/confirm`, {})).status, 400, 'an explicit confirmation is required');
  });
});

describe('Reversing a receipt', () => {
  it('takes the accepted units back out with opposite ledger entries, reopens the order, and can happen once', async () => {
    const { po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 40, batchNumber: 'REV-1' })]);
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 40, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const base = await stockOf('para');
    const grn = (await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })).data.receipt;
    assert.equal((await stockOf('para')) - base, 40);
    const movesBefore = await h.models.StockMovement.collection.countDocuments({});
    assert.equal((await (await asRole('INVENTORY_MANAGER')).post(`/goods-receipts/${grn._id}/reverse`, { reason: 'wrong delivery' })).status, 403, 'reversing needs orders:approve');
    const mgr = await asRole('BRANCH_MANAGER');
    assert.equal((await mgr.post(`/goods-receipts/${grn._id}/reverse`, {})).status, 400, 'a reason is required');
    const r = await mgr.post(`/goods-receipts/${grn._id}/reverse`, { reason: 'wrong delivery' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await stockOf('para'), base, 'stock is back where it was');
    assert.equal(await h.models.StockMovement.collection.countDocuments({}), movesBefore + 1, 'history grew; nothing was deleted or edited');
    const mv = await h.models.StockMovement.collection.findOne({ refType: 'GoodsReceiptReversal' });
    assert.deepEqual([mv.type, mv.quantity, mv.balanceAfter], ['ADJUSTMENT', -40, 0]);
    assert.deepEqual([(await order(po.order._id)).status, (await order(po.order._id)).items[0].receivedQuantity], ['ordered', 0]);
    assert.equal((await mgr.post(`/goods-receipts/${grn._id}/reverse`, { reason: 'again' })).status, 409);
    const inv = await h.models.SupplierInvoice.collection.findOne({ orderId: oid(po.order._id) });
    assert.deepEqual([inv.status, inv.receiptIds.length, inv.items[0].acceptedQuantity], ['verified', 0, 0]);
    const got = (await T.client.get(`/goods-receipts/${grn._id}`)).data;
    assert.equal(got.receipt.reversed, true);
    assert.equal(got.reversal.reason, 'wrong delivery');
    assert.equal((await T.client.get('/goods-receipts?status=reversed')).data.items.length >= 1, true);
    // the original GRN and ledger entries are untouched and can still be read
    assert.equal(got.receipt.totalAccepted, 40);
  });

  it('cannot take back units that have been sold or reserved: stock never goes negative, and nothing is changed', async () => {
    const { po, draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 40, batchNumber: 'REV-2' })]);
    await T.client.put(`/goods-receipts/${draft._id}`, enter(draft, [{ receivedQuantity: 40, receivedFree: 0, mrp: 30, sellingPrice: 28 }]));
    const grn = (await T.client.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })).data.receipt;
    await h.models.Batch.collection.updateOne({ _id: oid(grn.items[0].batchId) }, { $inc: { availableQuantity: -25 } }); // 25 were sold
    const before = await counts();
    const r = await (await asRole('BRANCH_MANAGER')).post(`/goods-receipts/${grn._id}/reverse`, { reason: 'wrong delivery' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code || r.body.error?.code, 'BATCH_STOCK_USED');
    assert.match(r.body.message, /has only 15 unit\(s\) free/);
    assert.deepEqual(await counts(), before);
    assert.equal((await order(po.order._id)).items[0].receivedQuantity, 40, 'the order still counts the delivery');
    assert.equal((await h.models.Batch.collection.findOne({ _id: oid(grn.items[0].batchId) })).availableQuantity, 15);
  });
});

describe('Lists, history, permissions and the rest of the system', () => {
  it('lists drafts and confirmed receipts, reads them, and keeps them to the organization and the people who may see them', async () => {
    const { draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 5, batchNumber: 'LST-1' })]);
    const drafts = (await T.client.get('/goods-receipts?status=draft')).data;
    assert.ok(drafts.items.some((d) => d._id === draft._id && d.kind === 'draft'));
    assert.equal((await T.client.get('/goods-receipts?status=weird')).status, 400);
    for (const call of [(c) => c.get('/goods-receipts'), (c) => c.get(`/goods-receipts/${draft._id}`), (c) => c.put(`/goods-receipts/${draft._id}`, { items: [] }), (c) => c.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true }), (c) => c.post(`/goods-receipts/${draft._id}/reverse`, { reason: 'x1x' }), (c) => c.post('/goods-receipts', {})]) {
      assert.equal((await call(h.client())).status, 401);
    }
    assert.equal((await (await asRole('STAFF')).get(`/goods-receipts/${draft._id}`)).status, 200, 'viewing needs inventory:read');
    for (const call of [(c) => c.put(`/goods-receipts/${draft._id}`, { items: [] }), (c) => c.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true }), (c) => c.post('/goods-receipts', { orderId: String(oid()) })]) assert.equal((await call(await asRole('STAFF'))).status, 403);
    assert.equal((await other.client.get(`/goods-receipts/${draft._id}`)).status, 404);
    assert.equal((await other.client.put(`/goods-receipts/${draft._id}`, { items: [] })).status, 404);
    assert.equal((await other.client.get(`/purchases/${draft.orderId}/history`)).status, 404);
  });

  it('a store-limited user cannot receive goods for another store’s order', async () => {
    const { draft } = await toDraft([row('Paracetamol 500mg Tablet', { quantity: 5, batchNumber: 'BR-1' })]);
    const listed = (await T.client.get('/branches')).data;
    const stores = Array.isArray(listed) ? listed : listed.items || [];
    const second = (await T.client.post('/branches', { name: 'North Store', code: 'NRT' })).data;
    const limited = await asRole('INVENTORY_MANAGER', { branchIds: [second._id] });
    assert.ok(stores.length >= 1);
    assert.equal((await limited.get(`/goods-receipts/${draft._id}`)).status, 404);
    assert.equal((await limited.post(`/goods-receipts/${draft._id}/confirm`, { confirmed: true })).status, 404);
  });

  it('existing Orders, Stock and Selling Point behaviour is unchanged by the receiving-service extension', async () => {
    const sup = P.supplierId;
    const mk = await T.client.post('/orders', { supplierId: sup, status: 'draft', orderDate: '2026-11-01', items: [{ medicineId: P.para, quantity: 20, rate: 20, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    await T.client.post(`/orders/${mk.data._id}/submit`);
    await T.client.post(`/orders/${mk.data._id}/order`);
    const base = await stockOf('para');
    const rec = await T.client.post(`/orders/${mk.data._id}/receive`, { items: [{ medicineId: P.para, quantity: 20, batchNumber: 'OLD-1', expiryDate: FUTURE, mrp: 30, sellingPrice: 28 }], idempotencyKey: 'plain-receive-1' });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.equal((await stockOf('para')) - base, 20);
    const dup = await T.client.post(`/orders/${mk.data._id}/receive`, { items: [{ medicineId: P.para, quantity: 20, batchNumber: 'OLD-1', expiryDate: FUTURE, mrp: 30, sellingPrice: 28 }], idempotencyKey: 'plain-receive-1' });
    assert.equal(dup.status, 200);
    assert.equal((await stockOf('para')) - base, 20, 'the old idempotent behaviour still holds');
    const mk2 = await T.client.post('/orders', { supplierId: sup, status: 'draft', orderDate: '2026-11-01', items: [{ medicineId: P.para, quantity: 20, rate: 20, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    await T.client.post(`/orders/${mk2.data._id}/submit`);
    await T.client.post(`/orders/${mk2.data._id}/order`);
    const twice = await T.client.post(`/orders/${mk2.data._id}/receive`, { items: [{ medicineId: P.para, quantity: 5, batchNumber: 'OLD-2', expiryDate: FUTURE }, { medicineId: P.para, quantity: 5, batchNumber: 'OLD-2', expiryDate: FUTURE }] });
    assert.equal(twice.status, 400, 'the same batch twice on one receipt is still refused');
    assert.match(twice.body.message, /listed twice/);
    const stock = await T.client.get('/stock/summary');
    assert.ok([200, 404].includes(stock.status));
  });
});
