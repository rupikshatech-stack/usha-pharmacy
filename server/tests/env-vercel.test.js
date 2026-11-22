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

const unset = { VERCEL: '', CRON_SECRET: '', BLOB_STORE_ID: '', BLOB_READ_WRITE_TOKEN: '', APP_URL: '', SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '', MAIL_FROM: '' };
const onVercel = { NODE_ENV: 'production', VERCEL: '1', APP_URL: 'https://pharmacy.example.test', ...PLACEHOLDER };

describe('environment: what Vercel must have', () => {
  it('refuses to start on Vercel without CRON_SECRET or a Blob credential, naming both and showing no values', () => {
    const r = loadSchema({ ...unset, ...onVercel, APP_URL: '' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /CRON_SECRET: is required in production on Vercel/);
    assert.match(r.stderr, /APP_URL: is required in production on Vercel/);
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

describe('environment: the address used in emails', () => {
  const ok = { ...unset, ...onVercel, CRON_SECRET: 'placeholder-cron-secret-0123456789', BLOB_STORE_ID: 'store_placeholder' };

  it('is required on Vercel, because the code would otherwise put http://localhost:5173 in real emails', () => {
    const r = loadSchema({ ...ok, APP_URL: '' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /APP_URL: is required in production on Vercel/);
  });

  it('must be https in production on Vercel', () => {
    const r = loadSchema({ ...ok, APP_URL: 'http://pharmacy.example.test' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /APP_URL: must be an https:\/\/ address/);
  });

  it('must be a real address, not just any text', () => {
    const r = loadSchema({ ...ok, APP_URL: 'pharmacy dot example' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /APP_URL: .*full address/);
  });

  it('is accepted when it is an https address', () => {
    assert.equal(loadSchema({ ...ok, APP_URL: 'https://pharmacy.example.test' }).code, 0);
    assert.equal(loadSchema({ ...ok, APP_URL: 'https://pharmacy.example.test/' }).code, 0, 'a trailing slash is trimmed by the code that uses it');
  });
});

describe('environment: outgoing mail', () => {
  const prod = { ...unset, NODE_ENV: 'production', ...PLACEHOLDER };

  it('needs a sender address once a mail server is named, in any production (the fallback is no-reply@localhost)', () => {
    const r = loadSchema({ ...prod, SMTP_HOST: 'smtp.example.test' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /MAIL_FROM: is required in production when SMTP_HOST is set/);
    assert.equal(loadSchema({ ...prod, SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'Pharmacy <orders@example.test>' }).code, 0);
  });

  it('needs nothing when no mail server is configured: the digest is then only logged', () => {
    assert.equal(loadSchema({ ...prod }).code, 0);
  });

  it('rejects a port that is not a port, naming it and never printing a credential', () => {
    const r = loadSchema({ ...prod, SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'a@example.test', SMTP_PORT: '99999', SMTP_PASS: 'placeholder-password-value' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SMTP_PORT/);
    assert.ok(!r.stderr.includes('placeholder-password-value'), 'a credential was printed');
  });

  it('only accepts true or false for SMTP_SECURE', () => {
    const r = loadSchema({ ...prod, SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'a@example.test', SMTP_SECURE: 'yes' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SMTP_SECURE/);
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
