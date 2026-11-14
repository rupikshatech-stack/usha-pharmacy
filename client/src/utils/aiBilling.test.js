import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankLine, blankReview, fileProblem, fileSize, lineStatus, productFrom, reviewFromDraft, reviewTotals, reviewedSnapshot, toDraftOrderPayload, validateReview } from './aiBilling.js';

const cand = (id, name, extra = {}) => ({ medicineId: id, name, unit: 'Strip', sku: '', gstPercent: 12, score: 1, ...extra });
const draft = () => ({
  invoiceNo: 'SP/771', invoiceDate: '2026-11-05', confidence: 0.9,
  supplier: { name: 'Sun Pharma', gstin: '27ABCDE1234F1Z5', match: { status: 'exact', by: 'gstin', supplierId: 's1', candidates: [] } },
  items: [
    { name: 'Dolo 650', quantity: 100, freeQuantity: 0, rate: 25, discountPercent: 0, gstPercent: 12, confidence: 0.98, issues: [], match: { status: 'exact', medicineId: 'm1', candidates: [cand('m1', 'Dolo 650')] } },
    { name: 'Crocin Advnce', quantity: 20, freeQuantity: 0, rate: 30, discountPercent: 0, gstPercent: 12, confidence: 0.9, issues: ['Not an exact match'], match: { status: 'possible', medicineId: null, candidates: [cand('m2', 'Crocin Advance', { score: 0.9 })] } },
    { name: 'Mystery Tonic', quantity: 5, freeQuantity: 0, rate: 99.5, discountPercent: 0, gstPercent: 5, confidence: 0.6, issues: ['Low confidence (60%)'], match: { status: 'none', medicineId: null, candidates: [] } },
  ],
  totals: { grandTotal: 3544.4, stated: { grandTotal: 3544.4 } },
});

describe('the file', () => {
  it('accepts PDF, PNG and JPEG up to 10 MB and says why anything else cannot be read', () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg']) assert.equal(fileProblem({ type, size: 1000 }), '');
    assert.match(fileProblem({ type: 'text/csv', size: 10 }), /Only PDF, PNG and JPEG/);
    assert.match(fileProblem({ type: 'image/gif', size: 10 }), /Only PDF/);
    assert.match(fileProblem({ type: 'application/pdf', size: 0 }), /empty/);
    assert.match(fileProblem({ type: 'application/pdf', size: 11 * 1048576 }), /larger than 10 MB/);
    assert.equal(fileProblem(null), '');
    assert.deepEqual([fileSize(500), fileSize(2048), fileSize(3 * 1048576)], ['1 KB', '2 KB', '3.0 MB']);
  });
});

describe('the review state from a read invoice', () => {
  it('chooses only exact matches; everything else waits for the user', () => {
    const r = reviewFromDraft(draft());
    assert.equal(r.supplierId, 's1', 'the supplier matched exactly (by GST number)');
    assert.deepEqual(r.lines.map((l) => l.product?._id ?? null), ['m1', null, null], 'a near match and no match are NOT chosen');
    assert.deepEqual(r.lines.map(lineStatus), ['ready', 'needs-product', 'needs-product']);
    assert.deepEqual([r.lines[0].quantity, r.lines[0].rate, r.lines[0].gstPercent], ['100', '25', '12']);
    assert.equal(r.statedTotal, 3544.4);
    assert.equal(r.source, 'ai');
  });
  it('does not choose a supplier that only nearly matches', () => {
    const d = draft();
    d.supplier.match = { status: 'possible', by: null, supplierId: null, candidates: [{ supplierId: 's2', name: 'Sun Pharma Distributer' }] };
    assert.equal(reviewFromDraft(d).supplierId, '');
  });
  it('a manual review starts empty with one blank line', () => {
    const r = blankReview();
    assert.equal(r.source, 'manual');
    assert.equal(r.lines.length, 1);
    assert.equal(lineStatus(r.lines[0]), 'needs-product');
  });
});

describe('validation: nothing is saved unverified', () => {
  const ready = () => {
    const r = reviewFromDraft(draft());
    r.lines[1].product = productFrom(cand('m2', 'Crocin Advance'));
    r.lines[2].product = productFrom(cand('m3', 'Mystery Tonic'));
    return r;
  };
  it('a fully checked review is valid', () => {
    assert.deepEqual(validateReview(ready(), { confirmed: true }), {});
  });
  it('needs the user’s confirmation, a supplier and a product on every line', () => {
    assert.match(validateReview(ready()).confirmed, /checked these details/);
    const r = ready();
    r.supplierId = '';
    assert.match(validateReview(r, { confirmed: true }).supplierId, /never picked for you/);
    const u = reviewFromDraft(draft());
    const e = validateReview(u, { confirmed: true });
    assert.match(e[`line.${u.lines[1].key}.product`], /Choose the product/);
    assert.match(e[`line.${u.lines[2].key}.product`], /Choose the product/);
  });
  it('checks every number, and refuses the same product twice', () => {
    const r = ready();
    r.lines[0].quantity = '0';
    r.lines[1].rate = '';
    r.lines[2].gstPercent = '200';
    const e = validateReview(r, { confirmed: true });
    assert.match(e[`line.${r.lines[0].key}.quantity`], /at least 1/);
    assert.match(e[`line.${r.lines[1].key}.rate`], /Enter the rate/);
    assert.match(e[`line.${r.lines[2].key}.gstPercent`], /0 to 100/);
    const d = ready();
    d.lines[1].product = productFrom(cand('m1', 'Dolo 650'));
    assert.match(validateReview(d, { confirmed: true })[`line.${d.lines[1].key}.product`], /on the invoice twice/);
    const x = ready();
    x.lines[0].rate = '-3';
    assert.ok(validateReview(x, { confirmed: true })[`line.${x.lines[0].key}.rate`]);
  });
  it('needs at least one line', () => {
    const r = ready();
    r.lines = [];
    assert.match(validateReview(r, { confirmed: true }).lines, /at least one product/);
  });
});

describe('totals, compared with the invoice', () => {
  it('works out the total from the lines that are ready and compares it with the invoice', () => {
    const r = reviewFromDraft(draft());
    r.lines[1].product = productFrom(cand('m2', 'Crocin Advance'));
    r.lines[2].product = productFrom(cand('m3', 'Mystery Tonic'));
    const t = reviewTotals(r);
    assert.equal(t.readyLines, 3);
    assert.deepEqual([t.subtotal, t.grandTotal], [3597.5, 3994.38], '100 × 25 + 20 × 30 + 5 × 99.50, plus GST of 300 + 72 + 24.88');
    assert.equal(t.matchesInvoice, false, 'it differs from the 3544.40 the invoice states, so the user is told');
    assert.equal(t.difference, 449.98);
  });
  it('lines that are not ready are left out, not guessed', () => {
    const t = reviewTotals(reviewFromDraft(draft()));
    assert.equal(t.readyLines, 1);
    assert.equal(t.grandTotal, 2800);
  });
  it('says so when the invoice gave no total', () => {
    const r = reviewFromDraft({ ...draft(), totals: {} });
    assert.equal(reviewTotals(r).matchesInvoice, null);
  });
});

describe('the order that is created', () => {
  it('is a draft built from the checked lines, with a note saying where it came from and who checked it', () => {
    const r = reviewFromDraft(draft());
    r.lines[1].product = productFrom(cand('m2', 'Crocin Advance'));
    r.lines[2].product = productFrom(cand('m3', 'Mystery Tonic'));
    const p = toDraftOrderPayload(r, { branchId: 'b1', userName: 'Asha Verma', status: 'draft', idempotencyKey: 'key-12345678' });
    assert.deepEqual([p.supplierId, p.branchId, p.orderDate, p.referenceNo, p.status], ['s1', 'b1', '2026-11-05', 'SP/771', 'draft']);
    assert.equal(p.notes, 'Supplier invoice SP/771 read from the uploaded invoice and checked by Asha Verma.');
    assert.deepEqual(p.items[1], { medicineId: 'm2', quantity: 20, freeQuantity: 0, rate: 30, discountPercent: 0, gstPercent: 12 });
    assert.deepEqual(p.payment, { terms: 'credit', advance: 0 });
    const manual = { ...reviewFromDraft(draft()), source: 'manual', invoiceDate: '', lines: [r.lines[0]] };
    const m = toDraftOrderPayload(manual, { userName: 'Asha', status: 'draft', today: '2026-11-08' });
    assert.match(m.notes, /entered from the invoice by Asha/);
    assert.equal(m.orderDate, '2026-11-08', 'today when the invoice has no date');
  });
});

describe('the new invoice fields: batch, dates, MRP, additional charges', () => {
  const full = () => {
    const d = draft();
    d.items[0] = { ...d.items[0], manufacturer: 'Micro Labs', batchNumber: 'DL-4412', manufacturingDate: '2026-08-01', expiryDate: '2028-07-31', mrp: 32 };
    d.totals.stated = { grandTotal: 3544.4, cgst: 10, sgst: 10, igst: 0, additionalCharges: 50 };
    const r = reviewFromDraft(d);
    r.lines[1].product = productFrom(cand('m2', 'Crocin Advance'));
    r.lines[2].product = productFrom(cand('m3', 'Mystery Tonic'));
    return r;
  };
  it('carries them into the review', () => {
    const r = full();
    assert.deepEqual([r.lines[0].manufacturer, r.lines[0].batchNumber, r.lines[0].manufacturingDate, r.lines[0].expiryDate, r.lines[0].mrp], ['Micro Labs', 'DL-4412', '2026-08-01', '2028-07-31', '32']);
    assert.equal(r.additionalCharges, 50);
    assert.equal(r.stated.cgst, 10);
  });
  it('checks dates and prices without ever making them up', () => {
    const today = '2026-11-08';
    const r = full();
    assert.deepEqual(validateReview(r, { confirmed: true, today }), {});
    const k = (f) => `line.${r.lines[0].key}.${f}`;
    r.lines[0].expiryDate = '2026-11-08';
    assert.match(validateReview(r, { confirmed: true, today })[k('expiryDate')], /Already expired/);
    r.lines[0].expiryDate = '2026-02-30';
    assert.match(validateReview(r, { confirmed: true, today })[k('expiryDate')], /not a real date/);
    r.lines[0].expiryDate = '2028-07-31';
    r.lines[0].manufacturingDate = '2029-01-01';
    assert.match(validateReview(r, { confirmed: true, today })[k('manufacturingDate')], /future/);
    r.lines[0].manufacturingDate = '2026-08-01';
    r.lines[0].mrp = '-1';
    assert.ok(validateReview(r, { confirmed: true, today })[k('mrp')]);
    r.lines[0].mrp = '';
    assert.deepEqual(validateReview(r, { confirmed: true, today }), {}, 'batch, dates and MRP are optional on an order: they are captured when goods arrive');
  });
  it('the invoice’s additional charges count towards the total it is compared with', () => {
    const r = full();
    const withCharges = reviewTotals(r).grandTotal;
    r.additionalCharges = null;
    assert.equal(Math.round((withCharges - reviewTotals(r).grandTotal) * 100) / 100, 50);
  });
  it('the draft order carries the charges, and the snapshot keeps what an order cannot hold', () => {
    const r = full();
    const p = toDraftOrderPayload(r, { userName: 'Asha', status: 'draft', idempotencyKey: 'key-12345678' });
    assert.deepEqual(p.charges, { other: 50 });
    assert.ok(!('batchNumber' in p.items[0]), 'the order itself does not take batch details');
    const snap = reviewedSnapshot(r);
    assert.deepEqual([snap.lines[0].batchNumber, snap.lines[0].expiryDate, snap.lines[0].mrp, snap.lines[0].productId], ['DL-4412', '2028-07-31', 32, 'm1']);
    assert.equal(snap.supplier.supplierId, 's1');
    assert.equal(snap.stated.cgst, 10);
  });
});

describe('lines', () => {
  it('a blank line has nothing chosen, and each line has its own key', () => {
    const a = blankLine();
    const b = blankLine();
    assert.notEqual(a.key, b.key);
    assert.equal(a.product, null);
  });
});
