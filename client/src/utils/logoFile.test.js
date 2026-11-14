import test from 'node:test';
import assert from 'node:assert/strict';
import { logoProblem } from './logoFile.js';

const file = (over = {}) => ({ name: 'logo.png', type: 'image/png', size: 1024, ...over });

test('accepts the picture formats a logo is actually drawn in', () => {
  assert.equal(logoProblem(file()), '');
  assert.equal(logoProblem(file({ name: 'logo.jpg', type: 'image/jpeg' })), '');
  assert.equal(logoProblem(file({ name: 'logo.webp', type: 'image/webp' })), '');
});

test('refuses an SVG by name, and says what to do instead', () => {
  const problem = logoProblem(file({ name: 'logo.svg', type: 'image/svg+xml' }));
  assert.match(problem, /can carry script/);
  assert.match(problem, /Export it as a PNG/);
  // Even when the browser reports no type at all, the extension gives it away.
  assert.match(logoProblem(file({ name: 'logo.SVG', type: '' })), /can carry script/);
});

test('refuses anything that is not a picture', () => {
  assert.equal(logoProblem(file({ name: 'licence.pdf', type: 'application/pdf' })), 'Use a JPG, PNG or WEBP image');
  assert.equal(logoProblem(file({ name: 'logo.gif', type: 'image/gif' })), 'Use a JPG, PNG or WEBP image');
});

test('refuses an empty file and one that is too large', () => {
  assert.equal(logoProblem(file({ size: 0 })), 'That file is empty');
  assert.equal(logoProblem(file({ size: 3 * 1048576 })), 'Use a file up to 2 MB');
  assert.equal(logoProblem(file({ size: 2 * 1048576 })), '', 'exactly at the limit is still allowed');
});

test('asks for a file when there is none', () => {
  assert.equal(logoProblem(null), 'Choose an image');
  assert.equal(logoProblem(undefined), 'Choose an image');
});
