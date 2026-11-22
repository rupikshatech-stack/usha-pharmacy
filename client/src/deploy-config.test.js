import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * vercel.json decides three things the app cannot check for itself while it runs: which paths fall back to the app
 * shell, which security headers the HTML carries, and where the function runs. A typo in any of them breaks the live
 * site while every unit test stays green, so they are pinned here.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(repo, 'client', 'index.html'), 'utf8');
const routesSource = fs.readFileSync(path.join(here, 'routes', 'AppRoutes.jsx'), 'utf8');

// Vercel anchors a rewrite's `source` to the whole path, so test it the same way.
const matchesFallback = (p) => new RegExp(`^${config.rewrites.find((r) => r.destination === '/index.html').source}$`).test(p);
const headerOf = (key) => config.headers[0].headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

describe('the fallback to the app shell', () => {
  it('catches every client-side route, so deep links and reloads still work', () => {
    const paths = [...routesSource.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*').map((p) => p.replace(/:\w+\??/g, 'x'));
    assert.ok(paths.length > 25, `found only ${paths.length} routes - did the route file change shape?`);
    for (const p of [...paths, '/', '/no/such/page']) assert.equal(matchesFallback(p), true, `${p} must reach the app`);
  });

  it('does not catch anything that names a file, so a missing asset is a real 404 rather than HTML', () => {
    for (const p of ['/assets/index-abc123.js', '/assets/PharmacyScene3D-old.js', '/assets/nope.css', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/favicon.svg', '/landing/layers-bg.jpg', '/manifest.webmanifest']) {
      assert.equal(matchesFallback(p), false, `${p} must NOT fall back to the app shell`);
    }
  });

  it('leaves the API to its own rewrite', () => {
    assert.equal(matchesFallback('/api/health'), false);
    assert.equal(matchesFallback('/api/auth/me'), false);
    assert.equal(config.rewrites[0].source, '/api/:path*');
  });
});

describe('security headers on the pages', () => {
  it('sets the four headers, and not on /api (the API sets its own)', () => {
    assert.ok(config.headers.length >= 1);
    assert.equal(new RegExp(`^${config.headers[0].source}$`).test('/api/health'), false);
    assert.equal(new RegExp(`^${config.headers[0].source}$`).test('/'), true);
    assert.equal(new RegExp(`^${config.headers[0].source}$`).test('/login'), true);
    assert.equal(headerOf('X-Content-Type-Options'), 'nosniff');
    assert.equal(headerOf('X-Frame-Options'), 'SAMEORIGIN');
    assert.equal(headerOf('Referrer-Policy'), 'no-referrer');
    assert.ok(headerOf('Content-Security-Policy'));
  });

  it('allows the inline theme script by its hash, and the hash is the one for the script that is really in index.html', () => {
    const inline = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(inline.length, 1, 'exactly one inline script is expected; every other one needs its own hash');
    const hash = `'sha256-${crypto.createHash('sha256').update(inline[0], 'utf8').digest('base64')}'`;
    assert.ok(headerOf('Content-Security-Policy').includes(hash), `the CSP must contain ${hash}. If index.html's theme script changed, put its new hash into vercel.json`);
  });

  it('keeps the policy tight where it can be', () => {
    const csp = headerOf('Content-Security-Policy');
    const directive = (name) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) || '';
    assert.match(directive('default-src'), /^default-src 'self'$/);
    assert.match(directive('frame-ancestors'), /'self'$/);
    assert.match(directive('object-src'), /'none'/);
    assert.doesNotMatch(directive('script-src'), /unsafe-inline|unsafe-eval|\*/, 'scripts must never be allowed inline or from anywhere');
    assert.match(directive('script-src-attr'), /'none'/);
    assert.doesNotMatch(csp, /http:\/\//, 'no plain-http sources');
  });
});

describe('where the function runs', () => {
  it('is a single region, next to the database', () => {
    assert.deepEqual(config.regions, ['bom1'], 'the Atlas cluster is in AWS Mumbai; move this and the cluster together');
  });
});

describe('caching', () => {
  const rule = config.headers.find((h) => h.headers.some((x) => x.key.toLowerCase() === 'cache-control'));
  const matches = (p) => new RegExp(`^${rule.source}$`).test(p);

  it('caches everything under /assets for a year, immutable, because the build puts a content hash in each name', () => {
    assert.ok(rule, 'a Cache-Control rule is expected');
    assert.equal(rule.headers.find((h) => h.key.toLowerCase() === 'cache-control').value, 'public, max-age=31536000, immutable');
    for (const p of ['/assets/index-abc123.js', '/assets/counter-B8uquhyi.avif', '/assets/index-XuJdLBii.css']) assert.equal(matches(p), true, p);
  });

  it('never applies it to anything that is not hashed: the page, the API, or the files copied from /public', () => {
    for (const p of ['/', '/login', '/dashboard', '/api/health', '/favicon.svg', '/logo/logo.jpg', '/icons.svg']) assert.equal(matches(p), false, `${p} must keep revalidating`);
  });

  it('only ever puts hashed files in /assets: nothing from /public is published there', () => {
    const publicDir = path.join(repo, 'client', 'public');
    const top = fs.readdirSync(publicDir);
    assert.equal(top.includes('assets'), false, 'client/public/assets would be served immutable without a hash in its name');
  });

  it('keeps the photographs under src/assets so the build hashes them (a copy in /public would not be)', () => {
    const dir = path.join(repo, 'client', 'src', 'assets', 'landing');
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.avif')) && fs.readdirSync(dir).some((f) => f.endsWith('.webp')));
    assert.equal(fs.existsSync(path.join(repo, 'client', 'public', 'landing')), false);
  });
});

describe('the Node version', () => {
  it('is pinned to one major, so Vercel never moves to a new Node on its own', () => {
    const { engines } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    assert.match(engines.node, /^\d+\.x$/, `engines.node is "${engines.node}"; a range such as ">=20" triggers Vercel's auto-upgrade warning`);
  });
});

describe('the link-preview tags', () => {
  it('carry a description and Open Graph tags whose addresses are filled in at build time', () => {
    for (const needle of ['name="description"', 'property="og:title"', 'property="og:description"', 'property="og:image"', 'property="og:url"', 'name="twitter:card"']) {
      assert.ok(indexHtml.includes(needle), `index.html is missing ${needle}`);
    }
    assert.match(indexHtml, /content="__SITE_URL__\/og-image\.png"/);
    assert.ok(fs.existsSync(path.join(repo, 'client', 'public', 'og-image.png')), 'the preview image is missing');
  });
});
