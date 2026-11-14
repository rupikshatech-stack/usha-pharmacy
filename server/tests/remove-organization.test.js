import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { SAFE_TO_REMOVE, inspect, remove } from '../scripts/lib/removeOrganization.js';
import { ensureSystemRoles } from '../services/roles.service.js';

/**
 * This script deletes a pharmacy. Everything below is about the cases where it must NOT.
 *
 * The happy path gets one test; the refusals get most of them, because the cost of the two directions is not
 * symmetrical. Failing to delete a test organization is an annoyance someone fixes in a minute. Deleting a real
 * one is unrecoverable without a backup, and the person who finds out is a pharmacy whose records are gone.
 */

let h;
let db;
let client;
before(async () => {
  h = await startHarness();
  db = h.mongoose.connection.db;
  client = h.mongoose.connection.getClient();
});
after(async () => {
  await h.stop();
});

const REASON = 'test pharmacy, never traded';

/** An organization exactly as onboarding leaves it: five roles, one administrator, nothing else. */
async function onboarded(name) {
  const t = await h.makeTenant(name);
  await h.tenant.runWithTenant(t.org._id, () => ensureSystemRoles({ orgId: t.org._id }));
  return t;
}

/** Every collection in the database that still holds a row for this organization. */
async function orphansOf(orgId) {
  const left = [];
  for (const { name } of await db.listCollections().toArray()) {
    const n = await db.collection(name).countDocuments({ organizationId: orgId });
    if (n) left.push({ name, n });
  }
  return left;
}

describe('it refuses an organization that has traded', () => {
  /**
   * One per kind of record, because each arrives by a different route and a safe list that drifted could easily
   * cover one and miss another. The point is not the variety of documents; it is that NONE of them is removable.
   */
  const tradingRows = {
    invoices: (orgId, branchId) => ({
      organizationId: orgId,
      invoiceNo: 'INV-09999',
      branchId,
      customer: { name: 'Walk-in' },
      items: [{ medicineId: orgId, name: 'X', quantity: 1, price: 10, amount: 10 }],
      total: 10,
      invoiceDate: new Date(),
    }),
    medicines: (orgId) => ({ organizationId: orgId, medicineName: 'Paracetamol' }),
    batches: (orgId) => ({ organizationId: orgId, batchNumber: 'B1', expiryDate: new Date(futureDate()), quantity: 1 }),
    stockmovements: (orgId) => ({ organizationId: orgId, type: 'purchase', quantity: 1 }),
    suppliers: (orgId) => ({ organizationId: orgId, name: 'ACME' }),
    attributes: (orgId) => ({ organizationId: orgId, attributeName: 'Forms' }),
    compounds: (orgId) => ({ organizationId: orgId, compoundName: 'Paracetamol 650' }),
    orders: (orgId) => ({ organizationId: orgId, orderNo: 'ORD-0001' }),
    salesreturns: (orgId) => ({ organizationId: orgId, returnNo: 'SR-0001' }),
  };

  for (const [collection, row] of Object.entries(tradingRows)) {
    it(`refuses an organization with ${collection}, and deletes nothing`, async () => {
      const { org } = await onboarded(`Traded ${collection} Pharmacy`);
      const branch = await db.collection('branches').findOne({ organizationId: org._id });
      await db.collection(collection).insertOne(row(org._id, branch?._id));

      const before = await orphansOf(org._id);
      const r = await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });

      assert.ok(r.aborted, `${collection} should have blocked the removal`);
      assert.match(r.aborted, new RegExp(collection), 'the refusal names what blocked it');
      assert.ok(!r.applied);

      assert.ok(await db.collection('organizations').findOne({ _id: org._id }), 'the organization is still there');
      assert.deepEqual(await orphansOf(org._id), before, 'and not one row was removed');
    });
  }

  it('names every blocking collection at once, not just the first', async () => {
    const { org } = await onboarded('Many Blockers Pharmacy');
    await db.collection('medicines').insertOne({ organizationId: org._id, medicineName: 'A' });
    await db.collection('suppliers').insertOne({ organizationId: org._id, name: 'B' });

    const r = await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });
    assert.ok(r.aborted);
    assert.match(r.aborted, /medicines/);
    assert.match(r.aborted, /suppliers/);
    assert.equal(r.blockedBy.length, 2);
  });

  it('refuses a collection it has never heard of, rather than guessing', async () => {
    // Stands in for a collection added to the system after this script was written.
    const { org } = await onboarded('Future Collection Pharmacy');
    await db.collection('somethingnewentirely').insertOne({ organizationId: org._id, hello: true });

    const r = await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });
    assert.ok(r.aborted, 'an unknown collection must stop the removal');
    assert.match(r.aborted, /somethingnewentirely/);
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }));
    await db.collection('somethingnewentirely').drop().catch(() => {});
  });

  it('a dry run on a traded organization refuses too, without touching anything', async () => {
    const { org } = await onboarded('Dry Traded Pharmacy');
    await db.collection('invoices').insertOne({ organizationId: org._id, invoiceNo: 'INV-1', total: 1 });
    const r = await remove(db, client, { orgId: org._id, dryRun: true });
    assert.ok(r.aborted);
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }));
  });
});

describe('it refuses without a reason', () => {
  it('an apply with no reason deletes nothing', async () => {
    const { org } = await onboarded('No Reason Pharmacy');
    const r = await remove(db, client, { orgId: org._id, dryRun: false });
    assert.ok(r.aborted);
    assert.match(r.aborted, /needs a reason/i);
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }), 'the organization is untouched');
  });

  it('a blank or whitespace reason is no reason at all', async () => {
    const { org } = await onboarded('Blank Reason Pharmacy');
    for (const reason of ['', '   ', '\n']) {
      const r = await remove(db, client, { orgId: org._id, reason, dryRun: false });
      assert.ok(r.aborted, `"${JSON.stringify(reason)}" should not count as a reason`);
    }
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }));
  });

  it('a dry run needs no reason, because it changes nothing', async () => {
    const { org } = await onboarded('Dry No Reason Pharmacy');
    const r = await remove(db, client, { orgId: org._id, dryRun: true });
    assert.ok(!r.aborted);
    assert.equal(r.applied, false);
  });
});

describe('the race between the dry run and the apply', () => {
  /**
   * The realistic sequence: an operator dry-runs, sees an empty pharmacy, and applies a minute later — but in that
   * minute the pharmacy made its first sale. The check inside the transaction is what stands between that sale and
   * being erased on the strength of a stale reading.
   */
  it('aborts the whole transaction when a trading row appears after the dry run', async () => {
    const { org } = await onboarded('Race Pharmacy');

    const dry = await remove(db, client, { orgId: org._id, dryRun: true });
    assert.ok(!dry.aborted, 'at dry-run time it was safe to remove');
    assert.equal(dry.unexpected.length, 0);

    // The sale that lands between the two commands.
    await db.collection('invoices').insertOne({ organizationId: org._id, invoiceNo: 'INV-RACE', total: 500 });

    const r = await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });
    assert.ok(r.aborted, 'the apply must not trust the earlier reading');
    assert.match(r.aborted, /invoices/);
    assert.ok(!r.applied);

    // Nothing partial: the organization, its users and its roles are all still there.
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }), 'the organization survived');
    assert.equal(await db.collection('users').countDocuments({ organizationId: org._id }), 1, 'its administrator survived');
    assert.equal(await db.collection('roles').countDocuments({ organizationId: org._id }), 5, 'its roles survived');
    assert.equal(await db.collection('invoices').countDocuments({ organizationId: org._id }), 1, 'and so did the invoice');
    assert.equal(await db.collection('auditlogs').countDocuments({ action: 'ORGANIZATION_REMOVED', entityId: org._id }), 0, 'no removal was recorded');
  });
});

describe('removing an organization that never traded', () => {
  it('deletes exactly the right rows and leaves no orphan anywhere', async () => {
    const { org, user } = await onboarded('Clean Removal Pharmacy');
    // A session too, so the sweep has something in every onboarding collection to clear.
    await h.tenant.runWithTenant(org._id, () => h.sessions.createSession(user, { rememberMe: false }));
    const before = await inspect(db, org._id);
    assert.equal(before.unexpected.length, 0);
    assert.ok(before.found.length >= 3, 'there is something to delete');

    const r = await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });
    assert.ok(r.applied, `removal failed: ${r.aborted}`);
    assert.equal(r.deleted.organizations, 1);

    // What the dry run said it would delete is what it deleted.
    for (const f of before.found) {
      assert.equal(r.deleted[f.name], f.n, `${f.name}: expected ${f.n} deleted, got ${r.deleted[f.name]}`);
    }

    // The assertion that matters: EVERY collection, not a list of the ones we remembered.
    assert.deepEqual(await orphansOf(org._id), [], 'a row somewhere still points at an organization that is gone');
    assert.equal(await db.collection('organizations').countDocuments({ _id: org._id }), 0, 'the organization itself is gone');

    // And gone for real, not hidden: the name and the email are usable again.
    assert.equal(await db.collection('users').countDocuments({ email: user.email }), 0);
    assert.equal(await db.collection('organizations').countDocuments({ slug: org.slug }), 0);
  });

  it('touches no other organization', async () => {
    const doomed = await onboarded('Doomed Pharmacy');
    const neighbour = await onboarded('Neighbour Pharmacy');
    const before = await inspect(db, neighbour.org._id);

    const r = await remove(db, client, { orgId: doomed.org._id, reason: REASON, dryRun: false });
    assert.ok(r.applied);

    const after = await inspect(db, neighbour.org._id);
    assert.deepEqual(after.found, before.found, "the neighbour's rows are untouched");
    assert.ok(await db.collection('organizations').findOne({ _id: neighbour.org._id }));
  });

  it('a dry run deletes nothing at all', async () => {
    const { org } = await onboarded('Dry Clean Pharmacy');
    const before = await orphansOf(org._id);
    const r = await remove(db, client, { orgId: org._id, dryRun: true });
    assert.equal(r.applied, false);
    assert.deepEqual(await orphansOf(org._id), before, 'a dry run must write nothing');
    assert.ok(await db.collection('organizations').findOne({ _id: org._id }));
  });

  it('refuses an id that is not an organization', async () => {
    const r = await remove(db, client, { orgId: new h.mongoose.Types.ObjectId(), reason: REASON, dryRun: false });
    assert.ok(r.aborted);
    assert.match(r.aborted, /No organization/);
  });
});

describe('the record of the removal', () => {
  it('survives the deletion, and carries the reason at platform level', async () => {
    const { org } = await onboarded('Recorded Pharmacy');
    const reason = 'onboarded by mistake during a demo';
    const r = await remove(db, client, { orgId: org._id, reason, dryRun: false });
    assert.ok(r.applied);

    const row = await db.collection('auditlogs').findOne({ action: 'ORGANIZATION_REMOVED', entityId: org._id });
    assert.ok(row, 'the removal is on record');
    assert.equal(row.isPlatform, true, 'at platform level');
    assert.equal(row.organizationId, undefined, 'with no organization — the one it describes no longer exists');
    assert.match(row.message, new RegExp(reason), 'and it says why');
    assert.equal(row.meta.name, org.name);
    assert.equal(row.meta.slug, org.slug);
    assert.deepEqual(row.meta.deleted, r.deleted, 'including exactly what was removed');
  });

  it('the record is not swept away by the deletion it describes', async () => {
    // It carries no organizationId precisely so the deleteMany that clears the audit log cannot take it with it.
    const { org } = await onboarded('Survivor Pharmacy');
    await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });

    assert.equal(await db.collection('auditlogs').countDocuments({ organizationId: org._id }), 0, "the pharmacy's own audit rows are gone");
    assert.equal(await db.collection('auditlogs').countDocuments({ action: 'ORGANIZATION_REMOVED', entityId: org._id }), 1, 'but the record of its removal remains');
  });

  it('no record is written when the removal is refused', async () => {
    const { org } = await onboarded('No Record Pharmacy');
    await db.collection('medicines').insertOne({ organizationId: org._id, medicineName: 'Blocker' });
    await remove(db, client, { orgId: org._id, reason: REASON, dryRun: false });
    assert.equal(await db.collection('auditlogs').countDocuments({ action: 'ORGANIZATION_REMOVED', entityId: org._id }), 0);
  });
});

describe('the safe list', () => {
  it('covers exactly what onboarding creates, and nothing more', async () => {
    const { org, user } = await onboarded('Shape Pharmacy');
    await h.tenant.runWithTenant(org._id, () => h.sessions.createSession(user, { rememberMe: false }));

    const { found } = await inspect(db, org._id);
    for (const f of found) {
      assert.ok(SAFE_TO_REMOVE.includes(f.name), `onboarding creates ${f.name}, which the safe list does not cover`);
    }
    // If this fails, onboarding changed and the safe list needs revisiting — which is the point of asserting it.
    assert.ok(found.some((f) => f.name === 'roles'), 'roles are part of onboarding');
    assert.ok(found.some((f) => f.name === 'users'), 'so is the administrator');
  });
});
