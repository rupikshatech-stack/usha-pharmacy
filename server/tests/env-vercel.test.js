import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * config/env.js validates the environment at start-up and EXITS the process when it is wrong, so it can only be
 * tested by starting a process. Each case loads the real schema in a child with a hand-built environment.
 *
 * Every value here is a made-up placeholder. The keys under test are always passed explicitly - as '' when "not set"
 * - because dotenv never overrides a variable that already exists, so that keeps a developer's own server/.env from
 * leaking into the result.
 */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLACEHOLDER = {
  MONGODB_URI: 'mongodb+srv://placeholder:placeholder@cluster.invalid/usha_pharmacy',
  JWT_SECRET: 'placeholder-placeholder-placeholder-0123456789',
};

function loadSchema(env) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config/env.js')"], {
    cwd: serverRoot,
    encoding: 'utf8',
    // No inheritance: only what is listed reaches the schema. SystemRoot/PATH keep Node itself working on Windows.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    timeout: 30000,
  });
  return { code: child.status, stderr: child.stderr || '' };
}

const unset = { VERCEL: '', CRON_SECRET: '', BLOB_STORE_ID: '', BLOB_READ_WRITE_TOKEN: '' };
const onVercel = { NODE_ENV: 'production', VERCEL: '1', ...PLACEHOLDER };

describe('environment: what Vercel must have', () => {
  it('refuses to start on Vercel without CRON_SECRET or a Blob credential, naming both and showing no values', () => {
    const r = loadSchema({ ...unset, ...onVercel });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CRON_SECRET: is required in production on Vercel/);
    assert.match(r.stderr, /BLOB_READ_WRITE_TOKEN: or BLOB_STORE_ID is required/);
    assert.ok(!r.stderr.includes(PLACEHOLDER.JWT_SECRET), 'a value was printed');
  });

  it('starts on Vercel with a cron secret and a Blob store id', () => {
    const r = loadSchema({ ...unset, ...onVercel, CRON_SECRET: 'placeholder-cron-secret-0123456789', BLOB_STORE_ID: 'store_placeholder' });
    assert.equal(r.code, 0, r.stderr);
  });

  it('starts on Vercel with the token form of the Blob credential instead', () => {
    const r = loadSchema({ ...unset, ...onVercel, CRON_SECRET: 'placeholder-cron-secret-0123456789', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_PLACEHOLDER_PLACEHOLDER' });
    assert.equal(r.code, 0, r.stderr);
  });

  it('wants a Blob credential even when the cron secret is fine, and vice versa', () => {
    const noBlob = loadSchema({ ...unset, ...onVercel, CRON_SECRET: 'placeholder-cron-secret-0123456789' });
    assert.equal(noBlob.code, 1);
    assert.match(noBlob.stderr, /BLOB_READ_WRITE_TOKEN/);
    assert.doesNotMatch(noBlob.stderr, /CRON_SECRET:/);

    const noCron = loadSchema({ ...unset, ...onVercel, BLOB_STORE_ID: 'store_placeholder' });
    assert.equal(noCron.code, 1);
    assert.match(noCron.stderr, /CRON_SECRET: is required/);
    assert.doesNotMatch(noCron.stderr, /BLOB_READ_WRITE_TOKEN/);
  });

  it('rejects a cron secret too short to be a secret, without printing it', () => {
    const short = 'tiny-secret';
    const r = loadSchema({ ...unset, ...onVercel, CRON_SECRET: short, BLOB_STORE_ID: 'store_placeholder' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CRON_SECRET: must be at least 16 characters/);
    assert.ok(!r.stderr.includes(short), 'the secret was printed');
  });
});

describe('environment: what must NOT be required elsewhere', () => {
  it('lets a production server of your own start with neither (disk uploads, digest run by the scheduler)', () => {
    const r = loadSchema({ ...unset, NODE_ENV: 'production', ...PLACEHOLDER });
    assert.equal(r.code, 0, r.stderr);
  });

  it('lets development start with neither', () => {
    const r = loadSchema({ ...unset, NODE_ENV: 'development' });
    assert.equal(r.code, 0, r.stderr);
  });
});
