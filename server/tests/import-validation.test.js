// Pure parts of the CSV inventory import: CSV reading / writing and per-row validation. No database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv, CsvError } from '../utils/csv.js';
import { COLUMNS, ImportFileError, MAX_ROWS, nameKey, parseDate, readCsv, templateRows, validateRow } from '../services/importValidation.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const row = (o = {}) => ({ medicineName: 'Dolo 650', ...o });
const batchRow = (o = {}) => row({ batchNumber: 'B1', expiryDate: '2027-06-30', mrp: '100', sellingPrice: '90', quantity: '10', ...o });
const fieldsOf = (cells) => validateRow(cells, NOW).errors.map((e) => e.field).sort();
const messageOf = (cells, field) => validateRow(cells, NOW).errors.find((e) => e.field === field)?.message;

describe('CSV reading', () => {
  it('handles quotes, escaped quotes, commas and line breaks inside quotes', () => {
    assert.deepEqual(parseCsv('a,"b,c","say ""hi""","x\ny"\r\n1,2,3,4\n'), [['a', 'b,c', 'say "hi"', 'x\ny'], ['1', '2', '3', '4']]);
  });
  it('accepts CRLF, LF, CR, a BOM and a missing final newline', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseCsv('a\rb'), [['a'], ['b']]);
  });
  it('keeps empty cells', () => assert.deepEqual(parseCsv('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]));
  it('rejects an unclosed quote', () => assert.throws(() => parseCsv('a,"b\nc'), CsvError));
  it('writes CSV that reads back, and defuses spreadsheet formulas', () => {
    const rows = [['name', 'note'], ['A, "B"', 'line\nbreak'], ['=cmd()', '-5']];
    const text = toCsv(rows);
    assert.deepEqual(parseCsv(text).slice(0, 2), rows.slice(0, 2));
    assert.equal(parseCsv(text)[2][0], "'=cmd()");
    assert.equal(parseCsv(text)[2][1], '-5', 'plain negative numbers are left alone');
  });
});

describe('readCsv (file level)', () => {
  const file = (lines) => lines.join('\n');
  it('maps headings case-insensitively and by alias, and reports unknown columns', () => {
    const r = readCsv(file(['Medicine Name,QTY,Expiry,Colour', 'Dolo,5,2027-01-01,red']));
    assert.deepEqual(r.rows[0].cells, { medicineName: 'Dolo', quantity: '5', expiryDate: '2027-01-01' });
    assert.deepEqual(r.ignored, ['Colour']);
    assert.equal(r.rows[0].rowNumber, 2, 'row numbers match a spreadsheet (header is row 1)');
  });
  it('skips blank lines but keeps row numbers', () => {
    const r = readCsv(file(['medicineName', 'A', '', ',', 'B']));
    assert.deepEqual(r.rows.map((x) => [x.rowNumber, x.cells.medicineName]), [[2, 'A'], [5, 'B']]);
  });
  it('rejects files that cannot be imported', () => {
    assert.throws(() => readCsv(''), ImportFileError);
    assert.throws(() => readCsv('   \n'), /empty/);
    assert.throws(() => readCsv('medicineName'), /no data rows/);
    assert.throws(() => readCsv('sku,mrp\nA,1'), /medicineName/);
    assert.throws(() => readCsv('medicineName,Name\nA,B'), /more than once/);
    assert.throws(() => readCsv('medicineName\u0000\nA'), /CSV text file/);
  });
  it(`allows at most ${MAX_ROWS} data rows`, () => {
    const ok = ['medicineName', ...Array.from({ length: MAX_ROWS }, (_, i) => `M${i}`)].join('\n');
    assert.equal(readCsv(ok).rows.length, MAX_ROWS);
    assert.throws(() => readCsv(`${ok}\nOne more`), (e) => e.status === 413);
  });
  it('the sample template reads back and every row validates', () => {
    const rows = templateRows(NOW);
    assert.deepEqual(rows[0], COLUMNS.map((c) => c.key));
    const text = rows.map((r) => r.join(',')).join('\n');
    const parsed = readCsv(text);
    assert.equal(parsed.rows.length, 3);
    for (const r of parsed.rows) assert.deepEqual(validateRow(r.cells, NOW).errors, [], JSON.stringify(r.cells));
  });
});

describe('parseDate', () => {
  it('reads ISO and day-first dates', () => {
    assert.equal(parseDate('2027-06-30').toISOString(), '2027-06-30T00:00:00.000Z');
    assert.equal(parseDate('30/06/2027').toISOString(), '2027-06-30T00:00:00.000Z');
    assert.equal(parseDate('30-6-2027').toISOString(), '2027-06-30T00:00:00.000Z');
    assert.equal(parseDate('30.06.2027').toISOString(), '2027-06-30T00:00:00.000Z');
  });
  it('rejects things that are not real dates', () => {
    for (const bad of ['2027-02-30', '31/04/2027', '2027-13-01', '06/30/2027', 'soon', '2027', '', '2027-6']) assert.equal(parseDate(bad), null, bad);
  });
});

describe('validateRow — medicine fields', () => {
  it('accepts a minimal row and fills defaults', () => {
    const v = validateRow(row(), NOW);
    assert.deepEqual(v.errors, []);
    assert.equal(v.batch, null);
    assert.equal(v.medicine.gstPercentage, 12);
    assert.equal(v.medicine.reorderLevel, 10);
  });
  it('requires a medicine name', () => {
    assert.match(messageOf({ medicineName: '' }, 'medicineName'), /required/);
    assert.match(messageOf({ medicineName: 'x'.repeat(151) }, 'medicineName'), /150/);
  });
  it('detects invalid GST values', () => {
    for (const bad of ['abc', '-5', '101', '150', '12.345', '1e3', '12,5']) assert.ok(fieldsOf(row({ gstPercentage: bad })).includes('gstPercentage'), bad);
    for (const ok of ['0', '5', '12', '18', '28', '12.5', '12%', '100']) assert.ok(!fieldsOf(row({ gstPercentage: ok })).includes('gstPercentage'), ok);
    assert.equal(validateRow(row({ gstPercentage: '18%' }), NOW).medicine.gstPercentage, 18);
    assert.match(messageOf(row({ gstPercentage: '150' }), 'gstPercentage'), /above 100/);
  });
  it('checks HSN, SKU, barcode and reorder level formats', () => {
    assert.ok(fieldsOf(row({ hsnCode: '12' })).includes('hsnCode'));
    assert.ok(fieldsOf(row({ sku: 'has space' })).includes('sku'));
    assert.ok(fieldsOf(row({ sku: 'x' })).includes('sku'));
    assert.ok(fieldsOf(row({ barcode: 'bad$' })).includes('barcode'));
    assert.ok(fieldsOf(row({ reorderLevel: '2.5' })).includes('reorderLevel'));
    assert.ok(fieldsOf(row({ reorderLevel: '-1' })).includes('reorderLevel'));
    assert.deepEqual(fieldsOf(row({ hsnCode: '30049099', sku: 'DOLO-650', barcode: '8901234567890', reorderLevel: '0' })), []);
  });
  it('limits text lengths', () => {
    assert.ok(fieldsOf(row({ manufacturer: 'x'.repeat(121) })).includes('manufacturer'));
    assert.ok(fieldsOf(row({ description: 'x'.repeat(2001) })).includes('description'));
  });
});

describe('validateRow — batch fields', () => {
  it('accepts a complete batch and converts it', () => {
    const v = validateRow(batchRow({ manufacturingDate: '2026-01-15', purchasePrice: '60' }), NOW);
    assert.deepEqual(v.errors, []);
    assert.equal(v.batch.initialQuantity, 10);
    assert.equal(v.batch.mrp, 100);
    assert.equal(v.batch.purchasePrice, 60);
    assert.equal(v.batch.expiryDate.toISOString(), '2027-06-30T00:00:00.000Z');
  });
  it('a row with no batch columns is a medicine-only row; any batch column makes the rest required', () => {
    assert.equal(validateRow(row(), NOW).batch, null);
    const e = fieldsOf(row({ quantity: '5' }));
    assert.deepEqual(e, ['batchNumber', 'expiryDate', 'mrp', 'sellingPrice']);
  });
  it('detects invalid batch dates', () => {
    assert.match(messageOf(batchRow({ expiryDate: '2027-02-30' }), 'expiryDate'), /not a valid date/);
    assert.match(messageOf(batchRow({ expiryDate: 'next year' }), 'expiryDate'), /not a valid date/);
    assert.match(messageOf(batchRow({ expiryDate: '2026-11-07' }), 'expiryDate'), /not in the future/);
    assert.match(messageOf(batchRow({ expiryDate: '2025-01-01' }), 'expiryDate'), /expired stock cannot be imported/);
    assert.equal(messageOf(batchRow({ expiryDate: '2026-11-08' }), 'expiryDate'), undefined);
    assert.match(messageOf(batchRow({ manufacturingDate: '2027-07-01' }), 'manufacturingDate'), /future/);
    assert.match(messageOf(batchRow({ manufacturingDate: 'xx' }), 'manufacturingDate'), /not a valid date/);
  });
  it('a manufacturing date in the past is fine; one after the expiry date is always rejected', () => {
    assert.equal(messageOf(batchRow({ manufacturingDate: '2026-06-01', expiryDate: '2026-12-31' }), 'manufacturingDate'), undefined);
    assert.ok(messageOf(batchRow({ manufacturingDate: '2028-01-01', expiryDate: '2027-12-31' }), 'manufacturingDate'));
  });
  it('checks quantity and prices', () => {
    for (const q of ['0', '-3', '2.5', 'ten', '']) assert.ok(fieldsOf(batchRow({ quantity: q })).includes('quantity'), q);
    assert.ok(fieldsOf(batchRow({ mrp: '-1' })).includes('mrp'));
    assert.ok(fieldsOf(batchRow({ mrp: 'abc' })).includes('mrp'));
    assert.ok(fieldsOf(batchRow({ purchasePrice: 'cheap' })).includes('purchasePrice'));
    assert.match(messageOf(batchRow({ sellingPrice: '120' }), 'sellingPrice'), /above the MRP/);
    assert.deepEqual(fieldsOf(batchRow({ mrp: '₹1,000.50', sellingPrice: '999' })), []);
  });
});

describe('nameKey', () => {
  it('treats case and spacing as the same product but strength / form / maker as different', () => {
    const a = { medicineName: 'Dolo  650', strength: '650 mg', dosageForm: 'Tablet', manufacturer: 'Micro' };
    assert.equal(nameKey(a), nameKey({ ...a, medicineName: 'dolo 650', manufacturer: 'MICRO' }));
    assert.notEqual(nameKey(a), nameKey({ ...a, strength: '500 mg' }));
    assert.notEqual(nameKey(a), nameKey({ ...a, manufacturer: 'Other' }));
  });
});
