import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionHint, isPlatformPath, readSessionHint, shouldAskServer, writeSessionHint } from './sessionHint.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const blocked = () => ({
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
});

describe('when to ask the server who is signed in', () => {
  it('does not ask on the public pages when this browser has never had a session', () => {
    for (const p of ['/', '/login', '/forgot-password']) assert.equal(shouldAskServer(p, false), false, p);
  });

  it('does ask on the public pages when it remembers a session, so a signed-in visitor is forwarded to the dashboard', () => {
    for (const p of ['/', '/login', '/forgot-password']) assert.equal(shouldAskServer(p, true), true, p);
  });

  it('always asks on an application page, with or without the hint: the cookie can exist without it', () => {
    for (const p of ['/dashboard', '/selling-point', '/inventory/batches', '/analytics/sales', '/roles', '/settings', '/change-password']) {
      assert.equal(shouldAskServer(p, false), true, p);
      assert.equal(shouldAskServer(p, true), true, p);
    }
  });

  it('never asks on the platform console, which has its own session', () => {
    for (const hint of [false, true]) {
      assert.equal(shouldAskServer('/platform', hint), false);
      assert.equal(shouldAskServer('/platform/organizations', hint), false);
    }
    assert.equal(isPlatformPath('/platformer'), false, 'a different page that merely starts with the word');
    assert.equal(shouldAskServer('/platformer', false), true);
  });

  it('treats an unknown address as an application page, so the guard can send it to sign-in', () => {
    assert.equal(shouldAskServer('/no/such/page', false), true);
  });
});

describe('the hint', () => {
  it('is absent until written, present after, and gone once cleared', () => {
    const s = memory();
    assert.equal(readSessionHint(s), false);
    writeSessionHint(s);
    assert.equal(readSessionHint(s), true);
    clearSessionHint(s);
    assert.equal(readSessionHint(s), false);
  });

  it('only counts the exact value it writes', () => {
    const s = memory();
    s.setItem('usha:session', 'true');
    assert.equal(readSessionHint(s), false);
  });

  it('behaves as "no hint" when storage is blocked, and never throws', () => {
    const s = blocked();
    assert.equal(readSessionHint(s), false);
    assert.doesNotThrow(() => writeSessionHint(s));
    assert.doesNotThrow(() => clearSessionHint(s));
    assert.equal(readSessionHint(null), false);
  });
});
