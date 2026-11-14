import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILE_BYTES, checkFile, confirmLabel, errorReportCsv, formatBytes, rowTabs, summaryCards, toCsv } from './importFile.js';

const file = (o) => ({ name: 'stock.csv', size: 1000, type: 'text/csv', ...o });

describe('checkFile', () => {
  it('accepts a normal CSV, however the browser labels it', () => {
    assert.equal(checkFile(file()), '');
    assert.equal(checkFile(file({ type: '' })), '');
    assert.equal(checkFile(file({ type: 'application/vnd.ms-excel', name: 'STOCK.CSV' })), '');
  });
  it('rejects other file types', () => {
    assert.match(checkFile(file({ name: 'stock.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), /Only .csv/);
    assert.match(checkFile(file({ name: 'stock.csv.exe' })), /Only .csv/);
    assert.match(checkFile(file({ type: 'image/png' })), /not a CSV/);
  });
  it('rejects empty and oversized files', () => {
    assert.match(checkFile(file({ size: 0 })), /empty/);
    assert.match(checkFile(file({ size: MAX_FILE_BYTES + 1 })), /limit is 2 MB/);
    assert.equal(checkFile(file({ size: MAX_FILE_BYTES })), '');
    assert.match(checkFile(null), /Choose/);
  });
  it('formats sizes', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1048576), '3.0 MB');
  });
});

describe('error report', () => {
  const rows = [
    { row: 2, status: 'valid', medicineName: 'Fine' },
    { row: 3, status: 'invalid', medicineName: 'Bad, "quoted"', errors: [{ field: 'gstPercentage', message: 'GST 150 is above 100' }, { field: 'expiryDate', message: 'not a date' }] },
    { row: 4, status: 'failed', medicineName: '=HYPERLINK("x")', message: 'Rolled back: boom', errors: [] },
    { row: 5, status: 'skipped', medicineName: 'Dup' },
  ];
  it('lists only rows that need attention, with all their problems, and is safe to open in a spreadsheet', () => {
    const csv = errorReportCsv(rows);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 3, 'header + invalid + failed');
    assert.equal(lines[0], 'row,status,medicineName,sku,barcode,batchNumber,problems');
    assert.match(lines[1], /^3,invalid,"Bad, ""quoted"""/);
    assert.match(lines[1], /gstPercentage: GST 150 is above 100 \| expiryDate: not a date/);
    assert.match(lines[2], /^4,failed,"'=HYPERLINK\(""x""\)"/, 'formulas are defused');
    assert.match(lines[2], /Rolled back: boom/);
  });
  it('toCsv leaves numbers alone', () => assert.equal(toCsv([['-5', 'a']]), '-5,a\r\n'));
});

describe('row tabs and summary', () => {
  const rows = [{ status: 'valid' }, { status: 'imported' }, { status: 'invalid' }, { status: 'failed' }, { status: 'skipped' }];
  it('counts rows per tab and filters them', () => {
    const tabs = rowTabs(rows);
    assert.deepEqual(tabs.map((t) => [t.key, t.count]), [['all', 5], ['ok', 2], ['invalid', 2], ['skipped', 1]]);
    assert.equal(rows.filter(tabs[2].match).length, 2);
  });
  it('summary cards before and after the import', () => {
    const s = { total: 10, valid: 6, invalid: 3, skipped: 1, imported: 5, failed: 1 };
    assert.deepEqual(summaryCards(s, false).map((c) => [c.label, c.value]), [['Total rows', 10], ['Valid rows', 6], ['Invalid rows', 3], ['Skipped rows', 1]]);
    assert.deepEqual(summaryCards(s, true).map((c) => c.label), ['Total rows', 'Valid rows', 'Invalid rows', 'Successfully imported', 'Skipped rows', 'Failed (rolled back)']);
    assert.ok(!summaryCards({ ...s, failed: 0 }, true).some((c) => c.key === 'failed'));
  });
  it('words the confirm button by what will happen', () => {
    assert.equal(confirmLabel({ valid: 0, invalid: 3 }), 'Nothing to import');
    assert.equal(confirmLabel({ valid: 1, invalid: 0 }), 'Import 1 valid row');
    assert.equal(confirmLabel({ valid: 8, invalid: 2 }), 'Import 8 valid rows and skip 2 with errors');
  });
});
