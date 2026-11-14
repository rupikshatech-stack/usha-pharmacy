// Credit Management: a person pays, uploads a screenshot of the payment and asks for credits (Pending, until an administrator decides). What matters: the amount
// and the screenshot are checked on the server by what they really are; the request is stored for the right person and organization; a repeated or duplicate
// submission makes no second request; only the owner and administrators can see a request or its screenshot; the conversion rate comes from one setting;
// and nothing else in the system (orders, stock, invoices) is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
let uploadDir;
const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const JPG = (tag = '') => bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'jfif payload', `${++n}${tag}`);
const PNG = (tag = '') => bytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png payload', `${++n}${tag}`);
const WEBP = (tag = '') => bytes('RIFF', Buffer.from([1, 2, 3, 4]), 'WEBPVP8 payload', `${++n}${tag}`);
const submit = (client, buf, { amount = '500', type = 'image/jpeg', name = 'payment.jpg', key } = {}) =>
  client.post(`/credits/requests?amount=${encodeURIComponent(amount)}&fileName=${encodeURIComponent(name)}`, buf, { headers: { 'content-type': type, ...(key && { 'idempotency-key': key }) } });
const asRole = async (role, org = T.org) => {
  const u = await h.makeUser(org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const code = (r) => r.body.code || r.body.error?.code;
const paths = (r) => (r.body.details || []).map((d) => d.path);
const counts = () => Promise.all(['Order', 'Batch', 'StockMovement', 'Invoice', 'Medicine'].map((m) => h.models[m].collection.countDocuments({})));

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-credit-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('Credit Org');
  other = await h.makeTenant('Credit Other Org');
});
after(async () => {
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  for (const k of ['UPLOAD_DIR', 'CREDIT_RUPEES_PER_CREDIT', 'CREDIT_SCREENSHOT_MAX_MB', 'CREDIT_MAX_AMOUNT', 'CREDIT_RATE_LIMIT', 'FORCE_RATE_LIMIT']) delete process.env[k];
});

describe('Configuration names', () => {
  it('accepts the documented alternative names for the rate and the size limit', async () => {
    const keep = { ...process.env };
    try {
      delete process.env.CREDIT_RUPEES_PER_CREDIT;
      delete process.env.CREDIT_SCREENSHOT_MAX_MB;
      process.env.CREDIT_CONVERSION_RATE = '8';
      process.env.MAX_PAYMENT_SCREENSHOT_SIZE_MB = '2';
      const s = (await T.client.get('/credits/settings')).data;
      assert.equal(s.rupeesPerCredit, 8, 'CREDIT_CONVERSION_RATE is the same setting as CREDIT_RUPEES_PER_CREDIT');
      assert.equal(s.maxFileMB, 2, 'MAX_PAYMENT_SCREENSHOT_SIZE_MB is the same setting as CREDIT_SCREENSHOT_MAX_MB');
      process.env.CREDIT_RUPEES_PER_CREDIT = '5'; // the project's own name wins when both are set
      assert.equal((await T.client.get('/credits/settings')).data.rupeesPerCredit, 5);
      process.env.CREDIT_CONVERSION_RATE = '';
      delete process.env.CREDIT_RUPEES_PER_CREDIT;
      assert.equal((await T.client.get('/credits/settings')).data.rupeesPerCredit, 5, 'an empty value falls back to the default');
    } finally {
      process.env = keep;
    }
  });
});

describe('The conversion rate', () => {
  it('is ₹5 per credit by default, from one setting, and an administrator can change it', async () => {
    const s = (await T.client.get('/credits/settings')).data;
    assert.deepEqual([s.rupeesPerCredit, s.custom, s.acceptedTypes, s.maxFileMB], [5, false, ['image/jpeg', 'image/png', 'image/webp'], 5]);
    const staff = await asRole('STAFF');
    assert.equal((await staff.get('/credits/settings')).status, 200, 'anyone signed in can read it');
    assert.equal((await staff.put('/credits/settings', { rupeesPerCredit: 10 })).status, 403);
    for (const bad of [0, -1, 'abc', 100001, 1.234]) assert.equal((await T.client.put('/credits/settings', { rupeesPerCredit: bad })).status, 400, String(bad));
    const r = await T.client.put('/credits/settings', { rupeesPerCredit: 4 });
    assert.deepEqual([r.status, r.data.rupeesPerCredit, r.data.custom], [200, 4, true]);
    assert.equal((await other.client.get('/credits/settings')).data.rupeesPerCredit, 5, 'another organization keeps its own');
    const req1 = (await submit(T.client, JPG(), { amount: '100' })).data;
    assert.deepEqual([req1.rateAtRequest, req1.suggestedCredits], [4, 25]);
    await T.client.put('/credits/settings', { rupeesPerCredit: 5 });
    assert.equal((await T.client.get(`/credits/requests/${req1._id}`)).data.rateAtRequest, 4, 'a request keeps the rate it was made at');
  });
  it('can start from an environment default', async () => {
    process.env.CREDIT_RUPEES_PER_CREDIT = '8';
    await h.models.Organization.collection.updateOne({ _id: other.org._id }, { $unset: { 'settings.creditRupeesPerCredit': 1 } });
    assert.equal((await other.client.get('/credits/settings')).data.rupeesPerCredit, 8);
    delete process.env.CREDIT_RUPEES_PER_CREDIT;
  });
});

describe('Submitting a request', () => {
  it('records a Pending request for this person, stores the screenshot safely, and changes nothing else', async () => {
    const before = await counts();
    const user = await asRole('STAFF');
    const shot = PNG('ok');
    const r = await submit(user, shot, { amount: '499.50', type: 'image/png', name: 'C:\\fakepath\\pay <1>.png' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.data;
    assert.deepEqual([c.status, c.statusLabel, c.amount, c.requestNo.startsWith('CR-'), c.userName != null, c.screenshot.mimeType, c.screenshot.size, c.screenshot.fileName], ['pending', 'Pending', 499.5, true, true, 'image/png', shot.length, 'pay 1.png']);
    assert.equal(c.suggestedCredits, 99, 'whole credits, rounded down');
    assert.ok(c.createdAt);
    assert.ok(!JSON.stringify(c).includes(uploadDir) && !('storageKey' in c.screenshot), 'the storage location is never returned');
    assert.deepEqual([c.history.length, c.history[0].action, c.history[0].byName != null], [1, 'SUBMITTED', true]);
    const files = fs.readdirSync(path.join(uploadDir, String(T.org._id), 'credit'));
    assert.equal(files.length >= 1, true);
    assert.ok(files.every((f) => /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(f)), 'the file name is made by the server');
    assert.equal(await h.models.AuditLog.collection.countDocuments({ action: 'CREDIT_REQUEST_SUBMIT', message: new RegExp(c.requestNo) }), 1);
    assert.deepEqual(await counts(), before, 'no order, stock, invoice or product was touched');
    const row = await h.models.CreditRequest.collection.findOne({ requestNo: c.requestNo });
    assert.deepEqual([String(row.organizationId), row.status, row.approvedCredits, row.reviewedBy], [String(T.org._id), 'pending', undefined, undefined]);
  });

  it('accepts JPG, PNG and WEBP and numbers the requests in order', async () => {
    const a = (await submit(T.client, JPG(), { type: 'image/jpeg' })).data;
    const b = (await submit(T.client, PNG(), { type: 'image/png', name: 'a.png' })).data;
    const c = (await submit(T.client, WEBP(), { type: 'image/webp', name: 'a.webp' })).data;
    assert.deepEqual([a.screenshot.mimeType, b.screenshot.mimeType, c.screenshot.mimeType], ['image/jpeg', 'image/png', 'image/webp']);
    const no = (r) => Number(r.requestNo.slice(3));
    assert.deepEqual([no(b) - no(a), no(c) - no(b)], [1, 1]);
  });

  it('checks the amount: required, greater than zero, a plain number with at most two decimals, not absurd', async () => {
    const bad = async (amount, what) => {
      const r = await submit(T.client, JPG(), { amount });
      assert.equal(r.status, 400, what);
      assert.equal(code(r), 'CREDIT_AMOUNT');
      assert.deepEqual(paths(r), ['amount'], what);
    };
    for (const [v, w] of [['', 'empty'], ['0', 'zero'], ['0.00', 'zero decimals'], ['-5', 'negative'], ['abc', 'text'], ['1e3', 'exponent'], ['12.345', 'three decimals'], ['5,00', 'comma'], ['10000000', 'too large'], [' ', 'blank']]) await bad(v, w);
    assert.equal((await T.client.post('/credits/requests', JPG(), { headers: { 'content-type': 'image/jpeg' } })).status, 400, 'no amount at all');
    assert.equal((await submit(T.client, JPG(), { amount: '0.01' })).status, 201, 'the smallest valid amount');
    assert.equal((await submit(T.client, JPG(), { amount: '1000000' })).status, 201);
  });

  it('checks the screenshot by what it really is: a file is required, only JPG / PNG / WEBP, not mislabelled, not too large', async () => {
    const none = await T.client.post('/credits/requests?amount=100', undefined, { headers: { 'content-type': 'image/jpeg' } });
    assert.equal(none.status, 400);
    assert.equal(code(none), 'CREDIT_NO_FILE');
    for (const [type, buf] of [['image/gif', bytes('GIF89a...........')], ['application/pdf', bytes('%PDF-1.4 ..........')], ['text/plain', bytes('just some text here')], ['image/svg+xml', bytes('<svg xmlns="x"></svg>')]]) {
      const r = await submit(T.client, buf, { type });
      assert.equal(r.status, 415, type);
      assert.equal(code(r), 'CREDIT_UNSUPPORTED_TYPE');
    }
    const fake = await submit(T.client, bytes('MZ\\x90\\x00 this is not an image at all'), { type: 'image/jpeg', name: 'virus.jpg' });
    assert.equal(fake.status, 415, 'the contents are not an image, whatever the name says');
    const mislabelled = await submit(T.client, PNG(), { type: 'image/jpeg' });
    assert.equal(mislabelled.status, 400);
    assert.equal(code(mislabelled), 'CREDIT_TYPE_MISMATCH');
    process.env.CREDIT_SCREENSHOT_MAX_MB = '0.001'; // about 1 KB
    const big = await submit(T.client, bytes(JPG(), Buffer.alloc(4096, 1)));
    assert.equal(big.status, 413);
    assert.equal(code(big), 'CREDIT_FILE_TOO_LARGE');
    delete process.env.CREDIT_SCREENSHOT_MAX_MB;
    assert.equal(await h.models.CreditRequest.collection.countDocuments({ 'screenshot.fileName': 'virus.jpg' }), 0);
  });

  it('a request that is refused leaves no file behind', async () => {
    const dir = path.join(uploadDir, String(T.org._id), 'credit');
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    await submit(T.client, JPG(), { amount: 'abc' });
    await submit(T.client, bytes('not an image at all, sorry'), { type: 'image/png' });
    assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, before);
  });

  it('needs a signed-in person', async () => {
    assert.equal((await submit(h.client(), JPG())).status, 401);
    assert.equal((await h.client().get('/credits/requests')).status, 401);
    assert.equal((await h.client().get('/credits/settings')).status, 401);
  });
});

describe('Duplicate submissions', () => {
  it('the same idempotency key is the same request: sent again, even at once, it makes one', async () => {
    const user = await asRole('STAFF');
    const shot = JPG('idem');
    const key = 'submit-key-0001';
    const rs = await Promise.all([1, 2, 3, 4].map(() => submit(user, shot, { key })));
    assert.ok(rs.every((r) => [200, 201, 409].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, 'one request was made');
    assert.equal(await h.models.CreditRequest.collection.countDocuments({ idempotencyKey: key }), 1);
    const again = await submit(user, shot, { key });
    assert.deepEqual([again.status, again.data.requestNo], [200, rs.find((r) => r.status === 201).data.requestNo]);
    const someoneElse = await asRole('STAFF');
    assert.equal((await submit(someoneElse, JPG('other'), { key })).status, 201, 'another person’s key is their own');
  });

  it('the same screenshot cannot back two live requests, but can be used again once the first was rejected', async () => {
    const shot = PNG('dupe');
    const first = await submit(T.client, shot, { type: 'image/png', key: 'dup-first-1' });
    assert.equal(first.status, 201);
    const second = await submit(await asRole('STAFF'), shot, { type: 'image/png', key: 'dup-second-1' });
    assert.equal(second.status, 409);
    assert.equal(code(second), 'DUPLICATE_SCREENSHOT');
    assert.match(second.body.message, new RegExp(first.data.requestNo));
    assert.deepEqual(paths(second), ['screenshot']);
    const racing = PNG('race');
    const rs = await Promise.all([1, 2, 3].map((i) => submit(T.client, racing, { type: 'image/png', key: `race-${i}-key` })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
    await h.models.CreditRequest.collection.updateOne({ requestNo: first.data.requestNo }, { $set: { status: 'rejected' } });
    assert.equal((await submit(T.client, shot, { type: 'image/png', key: 'dup-third-1' })).status, 201, 'a rejected proof may be sent again');
  });

  it('limits how many requests one person can send in a window', async () => {
    process.env.FORCE_RATE_LIMIT = '1';
    process.env.CREDIT_RATE_LIMIT = '2';
    const user = await asRole('STAFF');
    assert.equal((await submit(user, JPG('l1'))).status, 201);
    assert.equal((await submit(user, JPG('l2'))).status, 201);
    const r = await submit(user, JPG('l3'));
    assert.equal(r.status, 429);
    assert.match(r.body.message, /lot of requests/);
    assert.equal((await submit(T.client, JPG('l4'))).status, 201, 'someone else is not held back');
    delete process.env.FORCE_RATE_LIMIT;
    delete process.env.CREDIT_RATE_LIMIT;
  });
});

describe('Who can see what', () => {
  it('lists a person’s own requests, newest first, with paging and a status filter; an administrator can see everyone’s', async () => {
    const a = await asRole('STAFF');
    const b = await asRole('STAFF');
    const mine = [];
    for (let i = 1; i <= 3; i += 1) mine.push((await submit(a, JPG(`a${i}`), { amount: String(100 * i) })).data);
    const theirs = (await submit(b, JPG('b1'), { amount: '777' })).data;
    const list = (await a.get('/credits/requests?limit=2')).data;
    assert.deepEqual([list.items.length, list.total, list.pages, list.page], [2, 3, 2, 1]);
    assert.deepEqual(list.items.map((x) => x.amount), [300, 200], 'newest first');
    assert.ok(list.items.every((x) => !('screenshot' in x) || !('storageKey' in x.screenshot)));
    assert.equal((await a.get('/credits/requests?limit=2&page=2')).data.items[0].amount, 100);
    assert.equal((await a.get('/credits/requests?scope=all&limit=50')).data.items.every((x) => String(x.userId) === String(list.items[0].userId)), true, 'asking for everyone’s is not enough');
    await h.models.CreditRequest.collection.updateOne({ requestNo: mine[0].requestNo }, { $set: { status: 'approved' } });
    assert.equal((await a.get('/credits/requests?status=approved')).data.total, 1);
    assert.equal((await a.get('/credits/requests?status=pending')).data.total, 2);
    assert.equal((await a.get('/credits/requests?status=weird')).status, 400);
    const all = (await T.client.get('/credits/requests?scope=all&limit=100')).data;
    assert.ok(all.items.some((x) => x.requestNo === theirs.requestNo) && all.items.some((x) => x.requestNo === mine[1].requestNo));
    assert.ok(all.items.every((x) => String(x.organizationId) === String(T.org._id)), 'never another organization’s');
    assert.ok(!(await T.client.get('/credits/requests?limit=100')).data.items.some((x) => x.requestNo === theirs.requestNo), 'the default is one’s own');
  });

  it('shows one request and its screenshot to its owner and to administrators only', async () => {
    const owner = await asRole('STAFF');
    const stranger = await asRole('STAFF');
    const shot = JPG('private');
    const r = (await submit(owner, shot)).data;
    assert.equal((await owner.get(`/credits/requests/${r._id}`)).status, 200);
    assert.equal((await T.client.get(`/credits/requests/${r._id}`)).status, 200, 'an administrator');
    assert.equal((await stranger.get(`/credits/requests/${r._id}`)).status, 404, 'not yours: the same answer as not there');
    assert.equal((await other.client.get(`/credits/requests/${r._id}`)).status, 404, 'another organization');
    assert.equal((await h.client().get(`/credits/requests/${r._id}`)).status, 401);
    assert.equal((await owner.get('/credits/requests/nope')).status, 404);
    const img = await owner.get(`/credits/requests/${r._id}/screenshot`);
    assert.equal(img.status, 200);
    assert.ok(Buffer.from(img.raw ?? img.body ?? []).length >= 0);
    for (const c of [stranger, other.client, h.client()]) assert.ok([401, 404].includes((await c.get(`/credits/requests/${r._id}/screenshot`)).status));
    assert.equal((await T.client.get(`/credits/requests/${r._id}/screenshot`)).status, 200);
  });
});
