import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RELOAD_WINDOW_MS, canReloadOnce, failedChunkUrl, installChunkReload } from './chunkReload.js';

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

describe('replacing a stored 404 before the reload', () => {
  const ORIGIN = 'https://pharmacy.example';
  const failure = (url) => ({ payload: new Error(`Failed to fetch dynamically imported module: ${url}`), preventDefault() {} });

  it('reads the failed address from the error, and only when it is on this site', () => {
    assert.equal(failedChunkUrl(failure(`${ORIGIN}/assets/PharmacyScene3D-abc.js`), ORIGIN), `${ORIGIN}/assets/PharmacyScene3D-abc.js`);
    assert.equal(failedChunkUrl(failure('https://elsewhere.example/assets/x.js'), ORIGIN), null);
    assert.equal(failedChunkUrl({ payload: new Error('boom') }, ORIGIN), null);
    assert.equal(failedChunkUrl({}, ORIGIN), null);
  });

  it('fetches it with cache: reload first, and only then reloads, even if that fetch fails', async () => {
    for (const fetchResult of [() => Promise.resolve({ status: 200 }), () => Promise.reject(new Error('offline'))]) {
      const order = [];
      const listeners = {};
      const win = {
        sessionStorage: memory(),
        location: { origin: ORIGIN, reload: () => order.push('reload') },
        fetch: (url, init) => { order.push(`fetch ${url} ${init.cache}`); return fetchResult(); },
        addEventListener: (name, fn) => { listeners[name] = fn; },
      };
      installChunkReload(win);
      listeners['vite:preloadError'](failure(`${ORIGIN}/assets/a-1.js`));
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(order, [`fetch ${ORIGIN}/assets/a-1.js reload`, 'reload']);
    }
  });
});
