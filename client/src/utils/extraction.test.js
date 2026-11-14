import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blankItem, fieldState, formErrors, fromForm, isDirty, issueCounts, problemWith, toForm, toReviewDraft } from './extraction.js';

const current = {
  supplier: { name: 'Sun Pharma', gstin: '27ABCDE1234F1Z5', address: null, phone: null, email: null, state: null, stateCode: null },
  invoice: {
    invoiceNumber: 'SP/1',
    invoiceDate: '2026-11-05',
    dueDate: null,
    purchaseOrderNumber: null,
    deliveryChallanNumber: null,
    placeOfSupply: null,
    paymentTerms: null,
    currency: 'INR',
    invoiceType: null,
  },
  items: [
    {
      medicineName: 'Dolo 650',
      batchNumber: null,
      expiryDate: '2028-08-31',
      quantity: 100,
      freeQuantity: 0,
      purchaseRate: 25,
      mrp: null,
      gstPercentage: 12,
      sourceText: 'Dolo 650 100 25',
    },
  ],
  totals: { subtotal: 2500, grandTotal: 2800, roundOff: -0.4, discount: null },
};

describe('the form', () => {
  it('shows missing values as empty boxes — never 0 or a default — and brings them back as null', () => {
    const f = toForm(current);
    assert.equal(f.items[0].batchNumber, '');
    assert.equal(f.items[0].freeQuantity, '0', 'a printed zero stays a zero');
    assert.equal(f.items[0].mrp, '');
    const back = fromForm(f);
    assert.deepEqual(
      [back.items[0].batchNumber, back.items[0].mrp, back.items[0].freeQuantity, back.items[0].quantity, back.totals.roundOff, back.supplier.address],
      [null, null, 0, 100, -0.4, null],
    );
  });
  it('is dirty only when something changed', () => {
    const f = toForm(current);
    assert.equal(isDirty(f, toForm(current)), false);
    const g = toForm(current);
    g.items[0].batchNumber = 'X1';
    assert.equal(isDirty(g, f), true);
  });
  it('finds values that cannot be saved, and accepts empty', () => {
    const f = toForm(current);
    f.items[0].quantity = 'lots';
    f.items[0].gstPercentage = '120';
    f.items[0].expiryDate = '2028-02-30';
    f.invoice.invoiceDate = '05/11/2026';
    f.items[0].mrp = '';
    assert.deepEqual(Object.keys(formErrors(f)).sort(), ['invoice.invoiceDate', 'items.0.expiryDate', 'items.0.gstPercentage', 'items.0.quantity']);
    assert.equal(problemWith('expiry', '2028-08'), '');
    assert.equal(problemWith('date', '2028-08'), 'Use a real date as YYYY-MM-DD.');
    assert.equal(problemWith('signed', '-0.4'), '');
    assert.equal(problemWith('number', '-1'), 'Cannot be negative.');
    assert.equal(problemWith('number', '1,250.50'), '');
  });
  it('a blank row has nothing invented in it', () => {
    const b = blankItem();
    assert.ok(Object.values(b).every((v) => v === ''));
    assert.ok(Object.values(fromForm({ ...toForm(current), items: [b] }).items[0]).every((v) => v === null));
  });
});

describe('field state', () => {
  const meta = {
    'items.0.batchNumber': { level: 'missing' },
    'items.0.quantity': { level: 'high', found: true, page: 1, confidence: 0.97, snippet: '100' },
    'items.0.mrp': { level: 'low', found: false },
    'items.0.rate': { level: 'edited' },
  };
  it('highlights errors, warnings, low confidence, missing and edited values; issues win', () => {
    assert.equal(fieldState(meta, {}, 'items.0.batchNumber').tone, 'missing');
    assert.equal(fieldState(meta, {}, 'items.0.quantity').tone, null);
    assert.match(fieldState(meta, {}, 'items.0.quantity').tip, /page 1 with 97% OCR confidence/);
    assert.equal(fieldState(meta, {}, 'items.0.mrp').tone, 'warning');
    assert.match(fieldState(meta, {}, 'items.0.mrp').tip, /Not found in the OCR text/);
    assert.equal(fieldState(meta, {}, 'items.0.rate').tone, 'edited');
    assert.equal(fieldState(meta, { 'items.0.quantity': 'error' }, 'items.0.quantity').tone, 'danger');
  });
  it('counts issues by severity', () => {
    assert.deepEqual(issueCounts([{ severity: 'error' }, { severity: 'warning' }, { severity: 'warning' }, { severity: 'info' }]), { error: 1, warning: 2, info: 1 });
  });
});

describe('hand-off to the review form', () => {
  it('matches nothing, fills nothing in, and carries the stated totals', () => {
    const d = toReviewDraft(current, [
      { severity: 'warning', path: 'items.0.batchNumber', message: 'Line 1 has no batch number.' },
      { severity: 'info', path: 'items.0.x', message: 'fyi' },
    ]);
    assert.equal(d.supplier.match.status, 'none');
    assert.equal(d.items[0].match.status, 'none');
    assert.deepEqual([d.items[0].name, d.items[0].batchNumber, d.items[0].mrp, d.items[0].quantity, d.items[0].rate], ['Dolo 650', '', undefined, 100, 25]);
    assert.deepEqual(d.items[0].issues, ['Line 1 has no batch number.']);
    assert.deepEqual([d.totals.stated.grandTotal, d.totals.stated.additionalCharges], [2800, undefined]);
    assert.equal(d.invoiceNo, 'SP/1');
  });
});
