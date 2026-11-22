import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_WINDOW_MS, canReloadOnce, installChunkReload } from './chunkReload.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

describe('reloading once after a deploy removed a chunk', () => {
  it('allows the first reload, and refuses a second inside the window, so a truly missing file cannot loop', () => {
    const s = memory();
    assert.equal(canReloadOnce(() => s, 1_000_000), true);
    assert.equal(canReloadOnce(() => s, 1_000_000 + 1), false);
    assert.equal(canReloadOnce(() => s, 1_000_000 + RELOAD_WINDOW_MS - 1), false);
  });

  it('allows another reload once the window has passed (a later deploy, a later stale tab)', () => {
    const s = memory();
    assert.equal(canReloadOnce(() => s, 1_000_000), true);
    assert.equal(canReloadOnce(() => s, 1_000_000 + RELOAD_WINDOW_MS + 1), true);
  });

  it('does not reload when it cannot remember that it already did', () => {
    assert.equal(canReloadOnce(() => { throw new Error('storage blocked'); }), false);
    assert.equal(canReloadOnce(() => ({ getItem() { throw new Error('x'); }, setItem() {} })), false);
  });

  it('reloads and swallows the error on the first failure, and leaves the second to surface', () => {
    const listeners = {};
    let reloads = 0;
    const win = {
      sessionStorage: memory(),
      location: { reload: () => { reloads += 1; } },
      addEventListener: (name, fn) => { listeners[name] = fn; },
    };
    installChunkReload(win);
    const first = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners['vite:preloadError'](first);
    assert.equal(first.prevented, true);
    assert.equal(reloads, 1);

    const second = { prevented: false, preventDefault() { this.prevented = true; } };
    listeners['vite:preloadError'](second);
    assert.equal(second.prevented, false, 'the second failure must reach the page as an error, not be hidden');
    assert.equal(reloads, 1, 'and must not reload again');
  });
});
