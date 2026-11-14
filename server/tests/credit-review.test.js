// Credit Management, part 2: the credit calculation (1 credit = ₹5, whole credits rounded down, worked out on the server from the APPROVED amount), approving and
// rejecting, and the history filters. What matters: the browser's credits are never trusted; the approved amount, rate and credits are stored separately so
// history stays accurate when the rate changes; a request is decided once; people see only their own requests and proofs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { creditsFor } from '../services/credit.service.js';

let h;
let T;
let other;
let n = 0;
let uploadDir;
const JPG = (tag = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jfif ${++n} ${tag}`)]);
const submit = (client, buf, { amount = '500', key } = {}) =>
  client.post(`/credits/requests?amount=${encodeURIComponent(amount)}&fileName=pay.jpg`, buf, { headers: { 'content-type': 'image/jpeg', ...(key && { 'idempotency-key': key }) } });
const asRole = async (role, org = T.org) => {
  const u = await h.makeUser(org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};
const code = (r) => r.body.code || r.body.error?.code;
const paths = (r) => (r.body.details || []).map((d) => d.path);
const mk = async (client, amount = '500') => (await submit(client, JPG(amount), { amount, key: `rv-${++n}-key-x` })).data;

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-credit2-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('Credit Review Org');
  other = await h.makeTenant('Credit Review Other Org');
});
after(async () => {
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
});

describe('The credit calculation', () => {
  it('is whole credits, rounded down, worked out in paise, with the leftover kept', () => {
    assert.deepEqual([creditsFor(500, 5), creditsFor(1000, 5), creditsFor(2500, 5)], [{ credits: 100, remainder: 0 }, { credits: 200, remainder: 0 }, { credits: 500, remainder: 0 }]);
    assert.deepEqual(creditsFor(499.5, 5), { credits: 99, remainder: 4.5 });
    assert.deepEqual(creditsFor(4.99, 5), { credits: 0, remainder: 4.99 });
    assert.deepEqual(creditsFor(0.3, 0.1), { credits: 3, remainder: 0 }, 'no floating-point surprise: 0.3 / 0.1 is exactly 3');
    assert.deepEqual(creditsFor(100, 4.5), { credits: 22, remainder: 1 });
    assert.deepEqual([creditsFor(0, 5), creditsFor(100, 0), creditsFor(-5, 5)], [{ credits: 0, remainder: 0 }, { credits: 0, remainder: 0 }, { credits: 0, remainder: 0 }]);
  });
});

describe('Approving and rejecting', () => {
  it('works out the credits on the server from the APPROVED amount: ₹500 = 100, ₹1,000 = 200, ₹2,500 = 500', async () => {
    const staff = await asRole('STAFF');
    for (const [requested, approved, credits] of [['500', '500', 100], ['1000', '1000', 200], ['2500', '2500', 500], ['700', '500', 100]]) {
      const r = await mk(staff, requested);
      const done = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: approved, remarks: 'Checked against the bank statement' });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const d = done.data;
      assert.deepEqual([d.status, d.amount, d.approvedAmount, d.approvedCredits, d.approvedRate, d.remainderAmount], ['approved', Number(requested), Number(approved), credits, 5, 0], `₹${approved}`);
      assert.deepEqual([d.reviewedByName != null, d.reviewedAt != null, d.remarks], [true, true, 'Checked against the bank statement']);
      assert.equal(d.history.at(-1).action, 'APPROVED');
    }
  });

  it('ignores credits sent by the browser, and uses the approved amount — not the requested one', async () => {
    const r = await mk(await asRole('STAFF'), '1000');
    const done = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '600', approvedCredits: 99999, credits: 99999, approvedRate: 1, amount: 99999 });
    assert.equal(done.status, 200);
    assert.deepEqual([done.data.approvedCredits, done.data.approvedAmount, done.data.amount, done.data.approvedRate], [120, 600, 1000, 5], 'asked 1000, approved 600: 120 credits, whatever the browser claimed');
    const row = await h.models.CreditRequest.collection.findOne({ requestNo: r.requestNo });
    assert.deepEqual([row.approvedCredits, row.approvedAmount, row.amount], [120, 600, 1000], 'stored separately');
  });

  it('applies the rounding policy and keeps the leftover; an amount below one credit is refused', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '499.50');
    const done = (await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '499.50' })).data;
    assert.deepEqual([done.approvedCredits, done.remainderAmount], [99, 4.5]);
    const small = await mk(staff, '4');
    const refused = await T.client.post(`/credits/requests/${small._id}/approve`, { approvedAmount: '4' });
    assert.equal(refused.status, 400);
    assert.deepEqual(paths(refused), ['approvedAmount']);
    assert.equal((await T.client.get(`/credits/requests/${small._id}`)).data.status, 'pending', 'still pending');
    for (const bad of ['', '0', '-5', 'abc', '12.345', '99999999']) assert.equal((await T.client.post(`/credits/requests/${small._id}/approve`, { approvedAmount: bad })).status, 400, bad);
  });

  it('keeps the rate it was approved at, so a later change of rate does not change history', async () => {
    const r = await mk(await asRole('STAFF'), '1000');
    await T.client.put('/credits/settings', { rupeesPerCredit: 10 });
    const done = (await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '1000' })).data;
    assert.deepEqual([done.approvedRate, done.approvedCredits, done.rateAtRequest], [10, 100, 5], 'approved at the rate in force then; the request still shows the rate it was made at');
    await T.client.put('/credits/settings', { rupeesPerCredit: 2 });
    const again = (await T.client.get(`/credits/requests/${r._id}`)).data;
    assert.deepEqual([again.approvedRate, again.approvedCredits], [10, 100], 'unchanged by the new rate');
    await T.client.put('/credits/settings', { rupeesPerCredit: 5 });
  });

  it('can be rejected with a reason, and nothing is awarded', async () => {
    const r = await mk(await asRole('STAFF'), '300');
    assert.equal((await T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'ab' })).status, 400, 'a reason of at least 3 characters');
    assert.equal((await T.client.post(`/credits/requests/${r._id}/reject`, {})).status, 400);
    const done = await T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'The screenshot does not show this payment' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.data.status, done.data.remarks, done.data.approvedCredits, done.data.approvedAmount, done.data.history.at(-1).action], ['rejected', 'The screenshot does not show this payment', undefined, undefined, 'REJECTED']);
  });

  it('is decided once: a second decision, or two at the same moment, is refused', async () => {
    const r = await mk(await asRole('STAFF'), '500');
    const rs = await Promise.all([T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' }), T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'not valid' }), T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '250' })]);
    assert.equal(rs.filter((x) => x.status === 200).length, 1, JSON.stringify(rs.map((x) => x.status)));
    assert.ok(rs.every((x) => [200, 409].includes(x.status)));
    const again = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    assert.equal(again.status, 409);
    assert.equal(code(again), 'CREDIT_STATE');
    assert.equal(await h.models.AuditLog.collection.countDocuments({ action: { $in: ['CREDIT_REQUEST_APPROVE', 'CREDIT_REQUEST_REJECT'] }, message: new RegExp(r.requestNo) }), 1);
  });

  it('is for administrators only, never for one’s own request, and never across organizations', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    assert.equal((await staff.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' })).status, 403, 'the requester cannot approve it');
    assert.equal((await (await asRole('BRANCH_MANAGER')).post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' })).status, 403);
    assert.equal((await h.client().post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' })).status, 401);
    assert.equal((await other.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' })).status, 404);
    assert.equal((await other.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'nope nope' })).status, 404);
    const admin = await asRole('ORG_ADMIN');
    const mine = await mk(admin, '500');
    const self = await admin.post(`/credits/requests/${mine._id}/approve`, { approvedAmount: '500' });
    assert.equal(self.status, 403);
    assert.equal(code(self), 'SELF_REVIEW');
    assert.equal((await T.client.get(`/credits/requests/${r._id}`)).data.status, 'pending');
  });
});

describe('The history filters and totals', () => {
  it('searches by request id, filters by status and by submitted date range, and pages', async () => {
    const user = await asRole('STAFF');
    const made = [];
    for (let i = 1; i <= 4; i += 1) made.push(await mk(user, String(50 * i)));
    const old = made[0];
    await h.models.CreditRequest.collection.updateOne({ requestNo: old.requestNo }, { $set: { createdAt: new Date('2026-01-15T10:00:00Z') } });
    await h.models.CreditRequest.collection.updateOne({ requestNo: made[1].requestNo }, { $set: { createdAt: new Date('2026-02-20T10:00:00Z'), status: 'rejected' } });
    const get = async (q) => (await user.get(`/credits/requests${q}`)).data;
    assert.equal((await get(`?search=${old.requestNo}`)).total, 1);
    assert.equal((await get(`?search=${encodeURIComponent(old.requestNo.toLowerCase())}`)).items[0].requestNo, old.requestNo, 'not case sensitive');
    assert.equal((await get('?search=.*')).total, 0, 'text, not a pattern');
    assert.equal((await get('?search=CR-')).total, 4);
    assert.deepEqual((await get('?from=2026-01-01&to=2026-01-31')).items.map((x) => x.requestNo), [old.requestNo]);
    assert.deepEqual((await get('?from=2026-02-20&to=2026-02-20')).items.map((x) => x.requestNo), [made[1].requestNo], 'the end date is included');
    assert.equal((await get('?from=2026-03-01')).total, 2, 'from only');
    assert.equal((await get('?to=2026-02-28')).total, 2, 'to only');
    assert.equal((await get('?status=rejected&from=2026-01-01&to=2026-12-31')).total, 1);
    assert.equal((await user.get('/credits/requests?from=2026-03-01&to=2026-01-01')).status, 400, 'a backwards range');
    assert.equal((await user.get('/credits/requests?from=2026-02-30')).status, 400, 'not a real date');
    assert.equal((await get('?limit=100')).total, 4);
    assert.equal((await user.get('/credits/requests?limit=101')).status, 400);
    assert.equal((await get('?limit=2&page=2')).items.length, 2);
  });

  it('shows the approved amount, credits and remarks in the list, and totals from the requests themselves', async () => {
    const user = await asRole('STAFF');
    const a = await mk(user, '1000');
    const b = await mk(user, '250');
    await mk(user, '75');
    await T.client.post(`/credits/requests/${a._id}/approve`, { approvedAmount: '900', remarks: 'Part of it was a refund' });
    await T.client.post(`/credits/requests/${b._id}/reject`, { remarks: 'Unreadable screenshot' });
    const rows = (await user.get('/credits/requests?limit=10')).data.items;
    const ra = rows.find((x) => x.requestNo === a.requestNo);
    assert.deepEqual([ra.amount, ra.approvedAmount, ra.approvedCredits, ra.remarks, ra.status], [1000, 900, 180, 'Part of it was a refund', 'approved']);
    assert.equal(rows.find((x) => x.requestNo === b.requestNo).remarks, 'Unreadable screenshot');
    const s = (await user.get('/credits/summary')).data;
    assert.deepEqual([s.approvedCredits, s.approvedAmount, s.counts], [180, 900, { pending: 1, approved: 1, rejected: 1 }]);
    const someoneElse = await asRole('STAFF');
    assert.deepEqual((await someoneElse.get('/credits/summary')).data.counts, { pending: 0, approved: 0, rejected: 0 }, 'only one’s own');
    assert.ok((await T.client.get('/credits/summary?scope=all')).data.counts.approved >= 1, 'an administrator can total everyone’s');
  });

  it('never shows another person’s requests or payment proofs, even by id', async () => {
    const a = await asRole('STAFF');
    const b = await asRole('STAFF');
    const r = await mk(a, '500');
    assert.equal((await b.get(`/credits/requests/${r._id}`)).status, 404);
    assert.equal((await b.get(`/credits/requests/${r._id}/screenshot`)).status, 404);
    assert.ok(!(await b.get('/credits/requests?scope=all&limit=100')).data.items.some((x) => x.requestNo === r.requestNo));
    assert.equal((await b.get(`/credits/requests?search=${r.requestNo}`)).data.items.length, 0);
  });
});
