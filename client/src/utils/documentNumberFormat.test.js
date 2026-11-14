import test from 'node:test';
import assert from 'node:assert/strict';
import { financialYearLabel, formatDocumentNumber } from './documentNumberFormat.js';

test('reproduces the formats this system prints', () => {
  assert.equal(formatDocumentNumber({ prefix: 'INV', separator: '-', padding: 5 }, 42), 'INV-00042');
  assert.equal(formatDocumentNumber({ prefix: 'ORD', separator: '-', padding: 4 }, 7), 'ORD-0007');
  assert.equal(formatDocumentNumber({ prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true }, 1, { financialYearLabel: '25-26' }), 'SWS/25-26/0001');
});

test('leaves out parts that are not set rather than printing empty separators', () => {
  assert.equal(formatDocumentNumber({ prefix: '', separator: '-', padding: 4 }, 9), '0009');
  assert.equal(formatDocumentNumber({ prefix: 'A', suffix: 'B', separator: '-', padding: 2 }, 9), 'A-09-B');
  assert.equal(formatDocumentNumber({ prefix: 'A', separator: '', padding: 3 }, 9), 'A009');
  assert.equal(formatDocumentNumber({ prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true }, 1), 'SWS/0001', 'no year to print');
});

test('never truncates a number that has outgrown its padding', () => {
  assert.equal(formatDocumentNumber({ prefix: 'INV', separator: '-', padding: 4 }, 123456), 'INV-123456');
});

test('works out the financial year the Indian way', () => {
  assert.equal(financialYearLabel(new Date(2026, 2, 31), 4), '25-26', '31 March is still last year');
  assert.equal(financialYearLabel(new Date(2026, 3, 1), 4), '26-27', '1 April starts the new one');
  assert.equal(financialYearLabel(new Date(2026, 11, 25), 4), '26-27');
  assert.equal(financialYearLabel(new Date(2026, 5, 1), 7), '25-26', 'an organization with a July year start');
});
