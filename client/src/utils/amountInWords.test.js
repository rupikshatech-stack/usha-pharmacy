import test from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, numberToWords } from './amountInWords.js';

test('counts the Indian way — lakh and crore, not million', () => {
  assert.equal(numberToWords(100000), 'One Lakh');
  assert.equal(numberToWords(1000000), 'Ten Lakh');
  assert.equal(numberToWords(10000000), 'One Crore');
  assert.equal(numberToWords(123456), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six');
  assert.equal(numberToWords(10203040), 'One Crore Two Lakh Three Thousand Forty');
});

test('handles the awkward small numbers', () => {
  assert.equal(numberToWords(0), 'Zero');
  assert.equal(numberToWords(7), 'Seven');
  assert.equal(numberToWords(13), 'Thirteen');
  assert.equal(numberToWords(20), 'Twenty');
  assert.equal(numberToWords(99), 'Ninety Nine');
  assert.equal(numberToWords(100), 'One Hundred');
  assert.equal(numberToWords(101), 'One Hundred One');
});

test('writes the line an invoice prints', () => {
  assert.equal(amountInWords(1234.56), 'One Thousand Two Hundred Thirty Four Rupees and Fifty Six Paise Only');
  assert.equal(amountInWords(500), 'Five Hundred Rupees Only');
  assert.equal(amountInWords(1), 'One Rupee Only');
});

test('never loses the paise, because a signature covers the words', () => {
  assert.equal(amountInWords(99.5), 'Ninety Nine Rupees and Fifty Paise Only');
  assert.equal(amountInWords(0.01), 'Zero Rupees and One Paisa Only');
  assert.equal(amountInWords(0.75), 'Zero Rupees and Seventy Five Paise Only');
});

test('rounds to the paisa rather than inventing a fraction of one', () => {
  assert.equal(amountInWords(99.999), 'One Hundred Rupees Only');
  assert.equal(amountInWords(10.005), 'Ten Rupees and One Paisa Only');
});

test('says zero and negative plainly', () => {
  assert.equal(amountInWords(0), 'Zero Rupees Only');
  assert.equal(amountInWords(-50.25), 'Minus Fifty Rupees and Twenty Five Paise Only');
});

test('gives nothing for something that is not an amount', () => {
  assert.equal(amountInWords('abc'), '');
  assert.equal(amountInWords(null), 'Zero Rupees Only');
  assert.equal(amountInWords(undefined), '');
});
