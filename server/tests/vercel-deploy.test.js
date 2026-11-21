import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { capUpload, PLATFORM_UPLOAD_CAP_BYTES } from '../utils/uploadCap.js';
import { getStorage, localStorage } from '../services/storage/index.js';
import { blobStorage } from '../services/storage/blobStorage.js';
import { runInBackground } from '../utils/background.js';

/**
 * What changes when the app runs on Vercel, and — just as important — what must NOT change anywhere else.
 */

const KEYS = ['VERCEL', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'CRON_SECRET'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

describe('upload cap', () => {
  it('leaves limits alone off Vercel', () => {
    delete process.env.VERCEL;
    assert.equal(capUpload(10 * 1024 * 1024), 10 * 1024 * 1024);
  });
  it('brings every limit under the 4.5 MB request-body ceiling on Vercel, and never raises a smaller one', () => {
    process.env.VERCEL = '1';
    assert.equal(capUpload(10 * 1024 * 1024), PLATFORM_UPLOAD_CAP_BYTES);
    assert.equal(capUpload(2 * 1024 * 1024), 2 * 1024 * 1024);
    assert.ok(PLATFORM_UPLOAD_CAP_BYTES + 64 * 1024 < 4.5 * 1024 * 1024);
  });
});

describe('storage selection', () => {
  it('uses the local disk by default', () => {
    for (const k of ['VERCEL', 'BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN']) delete process.env[k];
    assert.equal(getStorage(), localStorage);
  });
  it('uses Vercel Blob when a store is connected', () => {
    process.env.BLOB_STORE_ID = 'store_test';
    assert.equal(getStorage(), blobStorage);
  });
  it('refuses to fall back to the ephemeral disk on Vercel', () => {
    process.env.VERCEL = '1';
    delete process.env.BLOB_STORE_ID;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    assert.throws(() => getStorage(), /Vercel Blob/);
  });
  it('the blob backend refuses keys that escape the store', async () => {
    await assert.rejects(() => blobStorage.put('../x', Buffer.from('a')), /outside the store/);
    await assert.rejects(() => blobStorage.get('/abs'), /outside the store/);
  });
});

describe('runInBackground', () => {
  it('runs the work after the caller, and swallows its failure', async () => {
    delete process.env.VERCEL;
    const order = [];
    runInBackground(async () => { order.push('work'); throw new Error('boom'); });
    order.push('caller');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, ['caller', 'work']);
  });
});

describe('cron: /api/cron/expiry-alerts', () => {
  let h;
  before(async () => { h = await startHarness(); });
  after(async () => { await h.stop(); });

  it('refuses to run at all when no CRON_SECRET is configured', async () => {
    delete process.env.CRON_SECRET;
    const r = await h.client().get('/cron/expiry-alerts', { headers: { authorization: 'Bearer undefined' } });
    assert.equal(r.status, 503);
  });
  it('rejects a missing or wrong secret', async () => {
    process.env.CRON_SECRET = 'a-long-random-secret-value';
    assert.equal((await h.client().get('/cron/expiry-alerts')).status, 401);
    assert.equal((await h.client().get('/cron/expiry-alerts', { headers: { authorization: 'Bearer nope' } })).status, 401);
  });
  it('runs with the right secret and reports counts only', async () => {
    process.env.CRON_SECRET = 'a-long-random-secret-value';
    const r = await h.client().get('/cron/expiry-alerts', { headers: { authorization: 'Bearer a-long-random-secret-value' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['failed', 'organizations', 'sent', 'skipped']);
  });
});
