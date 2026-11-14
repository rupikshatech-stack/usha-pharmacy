// Credit Management, part 3: an approval actually adds credits. What matters: the balance moves ONLY together with a ledger entry, in one transaction; the same
// request can never add credits twice (not even when two administrators act at once); the ledger records the balance before and after and cannot be edited;
// a rejection adds nothing; everyone sees their own balance and entries only; a decided request is never decided again.
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
const JPG = (tag = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jfif ${++n} ${tag}`)]);
const code = (r) => r.body.code || r.body.error?.code;
const asRole = async (role, org = T.org) => {
  const u = await h.makeUser(org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return { user: u, client: c };
};
/** A fresh pending request from `who`. */
const mk = async (who, amount = '500') =>
  (await who.client.post(`/credits/requests?amount=${encodeURIComponent(amount)}&fileName=pay.jpg`, JPG(amount), { headers: { 'content-type': 'image/jpeg', 'idempotency-key': `bal-${++n}` } })).data;
/** Reading the database directly needs a tenant context (every tenant collection is scoped). */
const inTenant = (fn, org = T.org) => h.tenant.runWithTenant(org._id, fn);
const CT = () => h.models.CreditTransaction;
const balanceOf = (id) => inTenant(async () => Number((await h.models.User.findById(id, 'creditBalance').lean()).creditBalance || 0));
const ledgerOf = (requestId) => inTenant(() => CT().find({ requestId }).lean());
const countFor = (requestId) => inTenant(() => CT().countDocuments({ requestId }));

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usha-credit3-'));
  process.env.UPLOAD_DIR = uploadDir;
  h = await startHarness();
  T = await h.makeTenant('Credit Balance Org');
  other = await h.makeTenant('Credit Balance Other Org');
});
after(async () => {
  await h?.stop();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
});

describe('Approving adds the credits to the requester', () => {
  it('raises the balance, returns the ledger entry, and records the balance before and after', async () => {
    const staff = await asRole('STAFF');
    assert.equal(await balanceOf(staff.user._id), 0, 'a new person starts at zero');
    const first = await mk(staff, '500');
    const a = await T.client.post(`/credits/requests/${first._id}/approve`, { approvedAmount: '500' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual({ credits: a.data.transaction.credits, previousBalance: a.data.transaction.previousBalance, newBalance: a.data.transaction.newBalance }, { credits: 100, previousBalance: 0, newBalance: 100 });
    assert.equal(await balanceOf(staff.user._id), 100, 'the credits are on the requester, not on the administrator');
    assert.equal(await balanceOf(T.user._id), 0);

    // a second approval carries on from the balance the first one left
    const second = await mk(staff, '1000');
    const b = await T.client.post(`/credits/requests/${second._id}/approve`, { approvedAmount: '1000' });
    assert.deepEqual({ p: b.data.transaction.previousBalance, nb: b.data.transaction.newBalance }, { p: 100, nb: 300 });
    assert.equal(await balanceOf(staff.user._id), 300);

    const bal = await staff.client.get('/credits/balance');
    assert.equal(bal.data.balance, 300);
    assert.equal(bal.data.lastTransaction.txnNo, b.data.transaction.txnNo);
  });

  it('writes one ledger entry per approval, with everything the ledger must record', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '2500');
    const done = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '2500', remarks: 'Bank statement checked' });
    const entries = await ledgerOf(r._id);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.match(e.txnNo, /^CT-\d{4}$/, 'a transaction id');
    assert.equal(String(e.userId), String(staff.user._id));
    assert.equal(String(e.requestId), String(r._id));
    assert.equal(e.requestNo, r.requestNo);
    assert.equal(e.type, 'CREDIT_APPROVAL');
    assert.equal(e.credits, 500);
    assert.equal(e.previousBalance, 0);
    assert.equal(e.newBalance, 500);
    assert.match(e.description, /500 credits for ₹2500 approved on CR-/);
    assert.equal(String(e.createdBy), String(T.user._id), 'the administrator who approved it');
    assert.equal(e.createdByName, T.user.name);
    assert.ok(e.createdAt instanceof Date);
    assert.equal(done.data.transaction.txnNo, e.txnNo);
  });

  it('never adds credits twice for the same request: a second approval is refused and the balance stays put', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    assert.equal((await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' })).status, 200);
    const again = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    assert.equal(again.status, 409);
    assert.equal(code(again), 'CREDIT_STATE');
    assert.equal(await balanceOf(staff.user._id), 100, 'still one lot of credits');
    assert.equal(await countFor(r._id), 1);
  });

  it('two administrators approving at the same instant: one wins and the credits are added once', async () => {
    const staff = await asRole('STAFF');
    const admin2 = await asRole('ORG_ADMIN');
    const r = await mk(staff, '1000');
    const [x, y] = await Promise.all([
      T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '1000' }),
      admin2.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '1000' }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], `one succeeds, one is refused (${JSON.stringify([x.body, y.body])})`);
    assert.equal(await balanceOf(staff.user._id), 200, 'the credits were added exactly once');
    assert.equal(await countFor(r._id), 1);
  });

  it('adds nothing on a rejection, and a rejected request cannot then be approved', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    assert.equal((await T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'The screenshot shows a different amount' })).status, 200);
    assert.equal(await balanceOf(staff.user._id), 0);
    assert.equal(await countFor(r._id), 0);
    const later = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    assert.equal(later.status, 409, 'that would need a documented reversal workflow, which does not exist');
    assert.equal(await balanceOf(staff.user._id), 0);
  });

  it('refuses an approval worth no credits and leaves the balance alone', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    const bad = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '4.99' });
    assert.equal(bad.status, 400);
    assert.equal(await balanceOf(staff.user._id), 0);
    assert.equal((await staff.client.get(`/credits/requests/${r._id}`)).data.status, 'pending', 'still awaiting a decision');
  });
});

describe('The credit ledger', () => {
  it('cannot be edited or deleted — it is append-only', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    const e = (await ledgerOf(r._id))[0];
    await inTenant(async () => {
      await assert.rejects(() => CT().updateOne({ _id: e._id }, { $set: { credits: 9999 } }), /cannot be changed or deleted/);
      await assert.rejects(() => CT().deleteOne({ _id: e._id }), /cannot be changed or deleted/);
      const doc = await CT().findById(e._id);
      doc.credits = 1;
      await assert.rejects(() => doc.save(), /cannot be changed or deleted/);
      assert.equal((await CT().findById(e._id).lean()).credits, 100, 'untouched');
    });
  });

  it('shows a person their own entries only, and lets an administrator see them all, narrow by person and search', async () => {
    const a = await asRole('STAFF');
    const b = await asRole('STAFF');
    for (const [who, amount] of [[a, '500'], [a, '1000'], [b, '500']]) {
      const r = await mk(who, amount);
      assert.equal((await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: amount })).status, 200);
    }
    const mine = await a.client.get('/credits/transactions');
    assert.equal(mine.data.items.length, 2);
    assert.ok(mine.data.items.every((t) => String(t.userId) === String(a.user._id)), 'only their own');
    assert.deepEqual(mine.data.items.map((t) => t.credits), [200, 100], 'newest first');
    assert.equal(mine.data.items[0].typeLabel, 'Credits added (request approved)');

    const asked = await a.client.get(`/credits/transactions?scope=all&userId=${b.user._id}`);
    assert.ok(asked.data.items.every((t) => String(t.userId) === String(a.user._id)), 'a member asking for everything still gets only their own');

    const all = await T.client.get('/credits/transactions?scope=all&limit=100');
    assert.ok(all.data.items.length >= 3);
    const justB = await T.client.get(`/credits/transactions?scope=all&userId=${b.user._id}`);
    assert.ok(justB.data.items.length >= 1);
    assert.ok(justB.data.items.every((t) => String(t.userId) === String(b.user._id)));
    const byName = await T.client.get(`/credits/transactions?scope=all&search=${encodeURIComponent(b.user.name)}`);
    assert.ok(byName.data.items.length >= 1);
    assert.ok(byName.data.items.every((t) => t.userName === b.user.name));
    const byTxn = await T.client.get(`/credits/transactions?scope=all&search=${all.data.items[0].txnNo}`);
    assert.equal(byTxn.data.items[0].txnNo, all.data.items[0].txnNo);
  });

  it('keeps organizations apart: the ledger and balances of another organization are invisible', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    const theirs = await other.client.get('/credits/transactions?scope=all&limit=100');
    assert.equal(theirs.data.items.filter((t) => String(t.userId) === String(staff.user._id)).length, 0);
    const peek = await other.client.get(`/credits/balance?userId=${staff.user._id}`);
    assert.equal(peek.status, 404, 'a user of another organization is simply not there');
  });

  it('lets an administrator read someone else’s balance, while a member only ever sees their own', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    const admin = await T.client.get(`/credits/balance?userId=${staff.user._id}`);
    assert.equal(admin.data.balance, 100);
    assert.equal(admin.data.userId, String(staff.user._id));
    const nosy = await asRole('STAFF');
    const mine = await nosy.client.get(`/credits/balance?userId=${staff.user._id}`);
    assert.equal(mine.data.userId, String(nosy.user._id), 'the userId of someone else is ignored');
    assert.equal(mine.data.balance, 0);
  });
});

describe('Telling the requester', () => {
  it('reports the decided requests of the signed-in person, newest first, and nothing of anyone else', async () => {
    const staff = await asRole('STAFF');
    const quiet = await asRole('STAFF');
    const approved = await mk(staff, '500');
    const rejected = await mk(staff, '750');
    const pending = await mk(staff, '300');
    await T.client.post(`/credits/requests/${approved._id}/approve`, { approvedAmount: '500' });
    await T.client.post(`/credits/requests/${rejected._id}/reject`, { remarks: 'Screenshot unreadable' });

    const mine = await staff.client.get('/credits/notifications');
    assert.equal(mine.data.length, 2, 'the pending one is not news');
    assert.equal(mine.data[0].requestNo, rejected.requestNo, 'newest first');
    assert.match(mine.data[0].message, /rejected: Screenshot unreadable/);
    assert.match(mine.data[1].message, /approved: 100 credits added for ₹500/);
    assert.ok(mine.data.every((x) => x.at), 'each carries when it was decided');
    assert.equal(mine.data.filter((x) => x.requestNo === pending.requestNo).length, 0);
    assert.deepEqual((await quiet.client.get('/credits/notifications')).data, [], 'nothing about other people');
  });
});

describe('Who may approve', () => {
  it('needs the administrator permission, and nobody reviews their own request', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    const bySelf = await staff.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '500' });
    assert.equal(bySelf.status, 403);
    const own = await mk(T, '500');
    const mine = await T.client.post(`/credits/requests/${own._id}/approve`, { approvedAmount: '500' });
    assert.equal(mine.status, 403);
    assert.equal(code(mine), 'SELF_REVIEW');
    assert.equal(await balanceOf(T.user._id), 0);
  });

  it('lets an administrator search the queue by requester as well as by request id', async () => {
    const staff = await asRole('STAFF');
    await mk(staff, '500');
    const byUser = await T.client.get(`/credits/requests?scope=all&search=${encodeURIComponent(staff.user.name)}`);
    assert.ok(byUser.data.items.length >= 1);
    assert.ok(byUser.data.items.every((x) => x.userName === staff.user.name));
    const byEmail = await T.client.get(`/credits/requests?scope=all&search=${encodeURIComponent(staff.user.email)}`);
    assert.ok(byEmail.data.items.length >= 1);
    const asMember = await staff.client.get(`/credits/requests?search=${encodeURIComponent(staff.user.name)}`);
    assert.equal(asMember.data.items.length, 0, 'a member searches their own requests by request id, not by name');
  });
});

describe('The audit trail', () => {
  /** The entries this organization recorded for one request (newest last), with the ledger entries that belong to it. */
  const trailFor = (requestId) => inTenant(() => h.models.AuditLog.find({ entityId: requestId }).sort({ createdAt: 1 }).lean());
  const entriesByAction = (rows) => Object.fromEntries(rows.map((a) => [a.action, a]));

  it('records the request, the proof upload, the decision and the credits awarded — each with who, what, when and the values before and after', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '2500');
    const submitted = entriesByAction(await trailFor(r._id));
    assert.ok(submitted.CREDIT_REQUEST_SUBMIT, 'the request was submitted');
    assert.equal(String(submitted.CREDIT_REQUEST_SUBMIT.userId), String(staff.user._id), 'by whom');
    assert.equal(submitted.CREDIT_REQUEST_SUBMIT.userName, staff.user.name);
    assert.ok(submitted.CREDIT_REQUEST_SUBMIT.createdAt instanceof Date, 'when');
    assert.equal(submitted.CREDIT_REQUEST_SUBMIT.meta.amount, 2500);
    assert.equal(submitted.CREDIT_REQUEST_SUBMIT.meta.status, 'pending');

    const proof = submitted.CREDIT_PROOF_UPLOAD;
    assert.ok(proof, 'the payment proof upload is its own entry');
    assert.equal(proof.meta.mimeType, 'image/jpeg');
    assert.equal(proof.meta.fileName, 'pay.jpg');
    assert.ok(proof.meta.size > 0 && proof.meta.sha256, 'what was accepted, and the hash that identifies it');
    assert.equal(JSON.stringify(proof.meta).includes('credit/'), false, 'never where the file is kept');

    const done = await T.client.post(`/credits/requests/${r._id}/approve`, { approvedAmount: '2000', remarks: 'Bank statement checked' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const approved = entriesByAction(await trailFor(r._id)).CREDIT_REQUEST_APPROVE;
    assert.equal(String(approved.userId), String(T.user._id), 'the administrator who decided');
    assert.deepEqual(approved.meta.before, { status: 'pending', approvedAmount: null, approvedCredits: null });
    assert.deepEqual(approved.meta.after, { status: 'approved', approvedAmount: 2000, approvedRate: 5, approvedCredits: 400, remainderAmount: 0 });
    assert.equal(approved.meta.requestedAmount, 2500, 'what was asked for, beside what was approved');
    assert.deepEqual({ p: approved.meta.previousBalance, n: approved.meta.newBalance }, { p: 0, n: 400 });

    // the credits moving is an entry of its own, against the ledger entry, so an adjustment or reversal later lands in the same place
    const awarded = (await inTenant(() => h.models.AuditLog.find({ action: 'CREDIT_AWARDED' }).sort({ createdAt: -1 }).limit(1).lean()))[0];
    assert.equal(awarded.entity, 'CreditTransaction');
    assert.equal(awarded.meta.requestNo, r.requestNo);
    assert.equal(awarded.meta.txnNo, done.data.transaction.txnNo);
    assert.equal(String(awarded.meta.userId), String(staff.user._id), 'whose credits moved');
    assert.deepEqual({ c: awarded.meta.credits, p: awarded.meta.previousBalance, n: awarded.meta.newBalance }, { c: 400, p: 0, n: 400 });
    assert.match(awarded.message, /\+400 credits for .*balance 0 -> 400/);
  });

  it('records a rejection with its reason and that nothing was awarded', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    await T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'The screenshot shows another account' });
    const rejected = entriesByAction(await trailFor(r._id)).CREDIT_REQUEST_REJECT;
    assert.equal(String(rejected.userId), String(T.user._id));
    assert.deepEqual(rejected.meta.before, { status: 'pending' });
    assert.deepEqual(rejected.meta.after, { status: 'rejected' });
    assert.equal(rejected.meta.rejectionReason, 'The screenshot shows another account');
    assert.equal(rejected.meta.creditsAwarded, 0);
  });

  it('cannot be rewritten, and ordinary staff cannot even read it', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    const one = (await trailFor(r._id))[0];
    await inTenant(async () => {
      await assert.rejects(() => h.models.AuditLog.updateOne({ _id: one._id }, { $set: { message: 'nothing happened' } }), /cannot be changed or deleted/);
      await assert.rejects(() => h.models.AuditLog.deleteOne({ _id: one._id }), /cannot be changed or deleted/);
      await assert.rejects(() => h.models.AuditLog.deleteMany({ entityId: r._id }), /cannot be changed or deleted/);
    });
    assert.equal((await trailFor(r._id))[0].message, one.message, 'untouched');
    assert.equal((await staff.client.get('/activity')).status, 403, 'reading the trail needs audit:read');
    assert.equal((await T.client.get('/activity')).status, 200);
  });
});

describe('What the API gives back', () => {
  it('names the submission time and a rejection reason, and never leaks where the proof is kept', async () => {
    const staff = await asRole('STAFF');
    const r = await mk(staff, '500');
    const pending = (await staff.client.get(`/credits/requests/${r._id}`)).data;
    assert.equal(pending.submittedAt, pending.createdAt, 'submittedAt is the same instant, under the documented name');
    assert.equal('rejectionReason' in pending, false, 'nothing to explain while it is pending');
    assert.deepEqual(Object.keys(pending.screenshot).sort(), ['fileName', 'mimeType', 'size'], 'no storage key, no hash');
    assert.equal(JSON.stringify(pending).includes('credit/'), false);

    await T.client.post(`/credits/requests/${r._id}/reject`, { remarks: 'Amount does not match the proof' });
    const after = (await staff.client.get(`/credits/requests/${r._id}`)).data;
    assert.equal(after.rejectionReason, 'Amount does not match the proof');
    assert.equal(after.remarks, 'Amount does not match the proof', 'the admin remarks and the reason are the one field');
  });
});
