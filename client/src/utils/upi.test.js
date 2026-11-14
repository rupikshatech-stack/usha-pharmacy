import test from 'node:test';
import assert from 'node:assert/strict';
import { upiPaymentUri } from './upi.js';

const base = { upiId: 'sws@okhdfcbank', payeeName: 'SWS Wholesale', amount: 1234.5, note: 'INV-00042' };

test('builds a UPI link with the amount the invoice is actually for', () => {
  const uri = upiPaymentUri(base);
  assert.equal(uri, 'upi://pay?pa=sws%40okhdfcbank&pn=SWS%20Wholesale&am=1234.50&cu=INR&tn=INV-00042');
});

test('writes the amount with two decimals, because that is what a payment app parses', () => {
  assert.match(upiPaymentUri({ ...base, amount: 1234.5 }), /am=1234\.50&/);
  assert.match(upiPaymentUri({ ...base, amount: 100 }), /am=100\.00&/);
  assert.match(upiPaymentUri({ ...base, amount: 0.5 }), /am=0\.50&/);
  // A fraction of a paisa cannot be paid; it is rounded to the money that can.
  assert.match(upiPaymentUri({ ...base, amount: 99.999 }), /am=100\.00&/);
});

test('encodes every value, so a name with punctuation cannot change the amount', () => {
  const uri = upiPaymentUri({ ...base, payeeName: 'Shah & Sons, Pune', note: 'INV/25-26/0001' });
  assert.match(uri, /pn=Shah%20%26%20Sons%2C%20Pune/);
  assert.match(uri, /tn=INV%2F25-26%2F0001/);
  // Exactly five parameters: the ampersand in the name did not start a sixth.
  assert.equal(uri.split('&').length, 5);
});

test('prints no QR at all when there is nothing to pay into', () => {
  assert.equal(upiPaymentUri({ ...base, upiId: '' }), null);
  assert.equal(upiPaymentUri({ ...base, upiId: '   ' }), null);
  assert.equal(upiPaymentUri({ ...base, upiId: undefined }), null);
  assert.equal(upiPaymentUri({}), null);
});

test('prints no QR when the organization has turned it off', () => {
  assert.equal(upiPaymentUri({ ...base, enabled: false }), null);
});

test('prints no QR for a credit note, where the money goes the other way', () => {
  assert.equal(upiPaymentUri({ ...base, isCreditNote: true }), null);
});

test('prints no QR for an amount nobody can pay', () => {
  assert.equal(upiPaymentUri({ ...base, amount: 0 }), null);
  assert.equal(upiPaymentUri({ ...base, amount: -50 }), null);
  assert.equal(upiPaymentUri({ ...base, amount: null }), null);
  assert.equal(upiPaymentUri({ ...base, amount: 'abc' }), null);
});

test('leaves out a parameter it has no value for rather than sending an empty one', () => {
  const uri = upiPaymentUri({ upiId: 'sws@okhdfcbank', amount: 10 });
  assert.equal(uri, 'upi://pay?pa=sws%40okhdfcbank&am=10.00&cu=INR');
  assert.ok(!uri.includes('pn='));
  assert.ok(!uri.includes('tn='));
});
