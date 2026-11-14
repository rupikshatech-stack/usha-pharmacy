import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceLabel, fieldCount, fieldGroups, isLowConfidence, pageViews, scanState, tableRows, tableToText, warningsForPage } from './ocrView.js';

const cell = (text, extra = {}) => ({ text, colSpan: 1, rowSpan: 1, confidence: 0.9, ...extra });

describe('confidence', () => {
  it('shows a whole percent, or nothing when unknown', () => {
    assert.equal(confidenceLabel(0.926), '93%');
    assert.equal(confidenceLabel(null), '');
    assert.equal(confidenceLabel(undefined), '');
  });
  it('only a known low value is low', () => {
    assert.equal(isLowConfidence(0.5), true);
    assert.equal(isLowConfidence(0.7), false);
    assert.equal(isLowConfidence(null), false);
  });
});

describe('detected fields', () => {
  const fields = {
    supplierName: { value: 'Sun Pharma', normalized: 'Sun Pharma', confidence: 0.9, pageNumber: 1 },
    invoiceDate: { value: '05/11/2026', normalized: '2026-11-05', confidence: 0.8, pageNumber: 1 },
    dueDate: null,
  };
  it('lists every known field in groups; what was not found says so and is never filled in', () => {
    const g = fieldGroups(fields);
    assert.deepEqual(
      g.map((x) => x.title),
      ['Supplier', 'Invoice', 'Totals'],
    );
    const rows = Object.fromEntries(g.flatMap((x) => x.rows).map((r) => [r.key, r]));
    assert.deepEqual([rows.supplierName.found, rows.supplierName.value], [true, 'Sun Pharma']);
    assert.equal(rows.supplierName.normalized, null, 'the same text twice is shown once');
    assert.equal(rows.invoiceDate.normalized, '2026-11-05');
    assert.deepEqual([rows.dueDate.found, rows.dueDate.value], [false, null]);
    assert.deepEqual([rows.grandTotal.found, rows.grandTotal.value], [false, null]);
  });
  it('copes with no fields at all', () => {
    assert.deepEqual(fieldCount(undefined), { found: 0, total: 14 });
    assert.deepEqual(fieldCount(fields), { found: 2, total: 14 });
    assert.ok(fieldGroups(null).every((g) => g.rows.every((r) => !r.found)));
  });
});

describe('tables', () => {
  const table = {
    headerRows: [[cell('Item'), cell('Qty'), cell('Rate')]],
    bodyRows: [
      [cell('Dolo'), cell('10')],
      [cell('Crocin'), cell('5'), cell('30')],
    ],
    columnCount: 3,
  };
  it('draws header rows first and pads a short row so the grid stays square', () => {
    const rows = tableRows(table);
    assert.deepEqual(
      rows.map((r) => r.header),
      [true, false, false],
    );
    assert.deepEqual(
      rows.map((r) => r.cells.length),
      [3, 3, 3],
    );
    assert.equal(rows[1].cells[2].padding, true);
    assert.equal(rows[1].cells[2].text, '');
  });
  it('counts column spans toward the width', () => {
    const spanned = { headerRows: [[cell('Totals', { colSpan: 3 })]], bodyRows: [[cell('a'), cell('b'), cell('c')]], columnCount: 3 };
    assert.deepEqual(
      tableRows(spanned).map((r) => r.cells.length),
      [1, 3],
    );
  });
  it('copies as tab-separated text', () => {
    assert.equal(tableToText(table), 'Item\tQty\tRate\nDolo\t10\t\nCrocin\t5\t30');
  });
  it('an empty or missing table is nothing, not an error', () => {
    assert.deepEqual(tableRows(undefined), []);
    assert.equal(tableToText({ headerRows: [], bodyRows: [] }), '');
  });
});

describe('pages', () => {
  const ocr = {
    pages: [
      { pageNumber: 1, text: 'a\nb', lines: [{ text: 'a' }, { text: 'b' }] },
      { pageNumber: 2, text: 'c', lines: [] },
    ],
    tables: [{ pageNumber: 2 }, { pageNumber: 2 }],
  };
  it('attaches each page’s tables and summarises it', () => {
    const v = pageViews(ocr);
    assert.deepEqual(
      v.map((p) => p.label),
      ['Page 1', 'Page 2'],
    );
    assert.equal(v[0].summary, '2 lines · 0 tables');
    assert.equal(v[1].tables.length, 2);
    assert.equal(v[1].summary, '1 line · 2 tables', 'falls back to the page text when line detail was left out');
  });
  it('finds the warnings of one page and not of page 10', () => {
    const w = ['Page 1 looks blurry', 'Page 10 was rotated', 'Page 1 has image defects'];
    assert.deepEqual(warningsForPage(w, 1), ['Page 1 looks blurry', 'Page 1 has image defects']);
    assert.deepEqual(warningsForPage(w, 10), ['Page 10 was rotated']);
    assert.deepEqual(warningsForPage(undefined, 1), []);
  });
});

describe('scan state', () => {
  it('is always one of Uploaded, Processing, Completed, Failed', () => {
    assert.equal(scanState(undefined), 'uploaded');
    assert.equal(scanState({ status: 'uploaded' }), 'uploaded');
    assert.equal(scanState({ status: 'processing' }), 'processing');
    assert.equal(scanState({ status: 'completed' }), 'completed');
    assert.equal(scanState({ status: 'drafted' }), 'completed');
    assert.equal(scanState({ status: 'failed' }), 'failed');
  });
});
