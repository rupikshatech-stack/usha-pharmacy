import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criticalConflicts, productLine, remaining, rowActions, scoreText, summaryCards, withConfirmedProducts } from './productMatching.js';
import { fromForm, toForm, toReviewDraft } from './extraction.js';

const product = { _id: 'p1', name: 'Paracetamol 500mg Tablet', strength: '500mg', dosageForm: 'Tablet', unit: 'Strip', sku: 'P-1', manufacturer: 'Micro Labs', gstPercentage: 12 };
const row = (over = {}) => ({ itemId: 'itm_1', suggestions: [], notMatchedYet: false, stale: false, status: 'matched', confirmation: 'pending', product: null, ...over });

describe('summary cards', () => {
  it('shows the four counts from the server, and copes with nothing', () => {
    const c = summaryCards({ total: 12, matched: 7, needsReview: 3, unmatched: 2, confirmed: 5 });
    assert.deepEqual(
      c.map((x) => [x.label, x.value]),
      [
        ['Total Invoice Items', 12],
        ['Matched Products', 7],
        ['Needs Review', 3],
        ['Unmatched Products', 2],
      ],
    );
    assert.equal(c[0].hint, '5 confirmed');
    assert.deepEqual(
      summaryCards(undefined).map((x) => x.value),
      [0, 0, 0, 0],
    );
    assert.equal(remaining({ total: 12, confirmed: 5 }), 7);
    assert.equal(remaining({ total: 2, confirmed: 5 }), 0);
    assert.equal(remaining({ total: 12, confirmed: 5, markedUnmatched: 2 }), 5, 'rows marked as having no product are decided too');
  });
});

describe('row actions', () => {
  it('offers Select Product with nothing chosen, Change Match with something, and Confirm only for a chosen, current row', () => {
    assert.deepEqual([rowActions(row()).selectLabel, rowActions(row()).confirm], ['Select Product', false]);
    const chosen = rowActions(row({ product }));
    assert.deepEqual([chosen.selectLabel, chosen.confirm, chosen.markUnmatched], ['Change Match', true, true]);
    assert.equal(rowActions(row({ product, confirmation: 'confirmed' })).confirm, false);
    assert.equal(rowActions(row({ product, stale: true })).confirm, false, 'an edited row must be matched again first');
    assert.equal(rowActions(row({ product, notMatchedYet: true })).confirm, false);
    assert.equal(rowActions(row({ confirmation: 'unmatched' })).markUnmatched, false);
  });
  it('finds the conflicts that block automatic matching', () => {
    assert.equal(criticalConflicts([{ level: 'warning' }, { level: 'critical', code: 'STRENGTH_DIFFERS' }]).length, 1);
    assert.deepEqual(criticalConflicts(undefined), []);
  });
});

describe('text', () => {
  it('shows a score as a plain percentage and a product on one line', () => {
    assert.equal(scoreText(0.936), '94%');
    assert.equal(scoreText(null), '—');
    assert.equal(productLine(product), 'Paracetamol 500mg Tablet · 500mg · Tablet');
    assert.equal(productLine(null), '');
  });
});

describe('the draft review', () => {
  const current = {
    supplier: { name: 'Sun' },
    invoice: { invoiceNumber: 'S1', invoiceDate: '2026-11-05' },
    totals: {},
    items: [
      { itemId: 'itm_a', medicineName: 'PCM 500 TAB', batchNumber: 'B1', expiryDate: '2028-01-31', quantity: 10, purchaseRate: 20 },
      { itemId: 'itm_b', medicineName: 'Other', quantity: 1 },
    ],
  };
  it('gets a product only for rows a person confirmed; everything else is left to choose', () => {
    const draft = toReviewDraft(current, []);
    const withP = withConfirmedProducts(draft, {
      items: [
        { itemId: 'itm_a', confirmation: 'confirmed', product },
        { itemId: 'itm_b', confirmation: 'pending', product },
      ],
    });
    assert.equal(withP.items[0].match.status, 'exact');
    assert.equal(withP.items[0].match.candidates[0].medicineId, 'p1');
    assert.equal(withP.items[0].match.candidates[0].gstPercent, 12);
    assert.equal(withP.items[1].match.status, 'none', 'a suggestion is not a decision');
    assert.equal(withConfirmedProducts(draft, null), draft);
  });
  it('keeps the row’s stable id when the invoice is edited and sent back', () => {
    const f = toForm(current);
    assert.equal(f.items[0].itemId, 'itm_a');
    assert.equal(fromForm(f).items[0].itemId, 'itm_a');
    f.items.push({ ...f.items[0], itemId: '' });
    assert.equal(fromForm(f).items[2].itemId, null, 'a new row has none until the server gives it one');
  });
});
