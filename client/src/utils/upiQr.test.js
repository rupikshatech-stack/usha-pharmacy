import test from 'node:test';
import assert from 'node:assert/strict';
import { upiQrSvg } from './upiQr.js';
import { upiPaymentUri } from './upi.js';

const URI = 'upi://pay?pa=sws%40okhdfcbank&pn=SWS%20Wholesale&am=1234.50&cu=INR&tn=INV-00042';

test('renders a QR as inline SVG that scales to any paper size', () => {
  const svg = upiQrSvg(URI);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, 'a viewBox, so A4 and thermal both get a sharp code');
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path d="M/, 'the modules themselves');
  assert.match(svg, /<\/svg>$/);
});

test('puts a white quiet zone behind the code, because a tinted background will not scan', () => {
  const svg = upiQrSvg(URI, { margin: 2 });
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
  // The viewBox is the code plus the margin on both sides.
  const box = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  const noMargin = Number(/viewBox="0 0 (\d+)/.exec(upiQrSvg(URI, { margin: 0 }))[1]);
  assert.equal(box, noMargin + 4, 'two modules of quiet zone on each side');
});

test('gives the same code for the same link every time', () => {
  assert.equal(upiQrSvg(URI), upiQrSvg(URI));
});

test('grows to fit a longer link instead of dropping data', () => {
  const small = Number(/viewBox="0 0 (\d+)/.exec(upiQrSvg('upi://pay?pa=a@b&am=1.00'))[1]);
  const large = Number(/viewBox="0 0 (\d+)/.exec(upiQrSvg(`${URI}&extra=${'x'.repeat(400)}`))[1]);
  assert.ok(large > small, `a longer payload needs a denser code (${small} -> ${large})`);
});

test('encodes nothing when there is nothing to encode', () => {
  assert.equal(upiQrSvg(null), null);
  assert.equal(upiQrSvg(''), null);
  assert.equal(upiQrSvg('   '), null);
  assert.equal(upiQrSvg(undefined), null);
});

test('passes straight through from the URI builder, so the template checks one thing', () => {
  // No UPI ID saved: the builder says no, and no QR is drawn.
  assert.equal(upiQrSvg(upiPaymentUri({ amount: 100 })), null);
  // A credit note: money goes the other way.
  assert.equal(upiQrSvg(upiPaymentUri({ upiId: 'a@b', amount: 100, isCreditNote: true })), null);
  // A real invoice: a real code.
  assert.match(upiQrSvg(upiPaymentUri({ upiId: 'a@b', payeeName: 'Shop', amount: 100, note: 'INV-1' })), /^<svg/);
});

test('escapes the accessible title rather than letting it break the markup', () => {
  const svg = upiQrSvg(URI, { title: 'Pay Shah & Sons <Pune>' });
  assert.match(svg, /<title>Pay Shah &amp; Sons &lt;Pune&gt;<\/title>/);
  assert.match(svg, /aria-label="Pay Shah &amp; Sons &lt;Pune&gt;"/);
  assert.ok(!svg.includes('<Pune>'), 'no raw angle brackets reach the document');
});
