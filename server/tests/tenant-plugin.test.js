// Model-level proof that the tenant plugin forces every query/write onto the current organization,
// and fails closed when no tenant is known.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let A;
let B;
let M; // models
let T; // tenant helpers
let aMed;
let bMed;
const withA = (fn) => T.runWithTenant(A._id, fn);

const med = (orgId, name) => ({ organizationId: orgId, medicineName: name });

before(async () => {
  h = await startHarness();
  M = h.models;
  T = h.tenant;
  A = await h.makeOrg('Plugin Org A');
  B = await h.makeOrg('Plugin Org B');
  // Seed both tenants. Inside each tenant's own context, exactly as the app does it.
  aMed = await T.runWithTenant(A._id, () => M.Medicine.create(med(A._id, 'A-Med')));
  await T.runWithTenant(A._id, () => M.Medicine.create(med(A._id, 'A-Med-2')));
  bMed = await T.runWithTenant(B._id, () => M.Medicine.create(med(B._id, 'B-Med')));
  await T.runWithTenant(B._id, () => M.Batch.create({ organizationId: B._id, medicineId: bMed._id, batchNumber: 'B1', expiryDate: new Date('2099-01-01'), mrp: 1, sellingPrice: 1, initialQuantity: 5, availableQuantity: 5 }));
  await h.makeUser(A, { email: 'a-user@example.test' });
  await h.makeUser(B, { email: 'b-user@example.test' });
});

after(async () => {
  await h?.stop();
});

const rawCount = (Model, filter = {}) => T.unscoped(() => Model.countDocuments(filter));

describe('fails closed without a tenant context', () => {
  it('every business model rejects reads when no tenant is set', async () => {
    const strictModels = ['Medicine', 'Batch', 'Invoice', 'StockMovement', 'AuditLog', 'Counter'];
    for (const name of strictModels) {
      await assert.rejects(() => M[name].find(), { name: 'TenantScopeError' }, `${name}.find() must not run without a tenant`);
      await assert.rejects(() => M[name].countDocuments(), { name: 'TenantScopeError' }, `${name}.countDocuments()`);
      await assert.rejects(() => M[name].aggregate([{ $match: {} }]), { name: 'TenantScopeError' }, `${name}.aggregate()`);
      await assert.rejects(() => M[name].deleteMany({}), { name: 'TenantScopeError' }, `${name}.deleteMany() must never run unscoped`);
    }
  });

  it('every model that has an organizationId field is protected (nothing was forgotten)', async () => {
    const identity = new Set(['User', 'Session']); // scoped whenever a tenant is active (see "identity collections")
    const withOrg = h.mongoose.modelNames().filter((n) => h.mongoose.model(n).schema.path('organizationId'));
    assert.ok(withOrg.length >= 8, `expected tenant-owned models, found ${withOrg}`);
    // A future model that gets an organizationId but forgets the plugin fails this test.
    for (const name of withOrg.filter((n) => !identity.has(n))) {
      await assert.rejects(() => h.mongoose.model(name).find(), { name: 'TenantScopeError' }, `${name} has organizationId but is not tenant-protected`);
    }
    for (const name of identity) {
      // inside a tenant, even identity models must be forced onto it
      const Model = h.mongoose.model(name);
      await assert.rejects(() => withA(() => Model.find({ organizationId: B._id })), { name: 'TenantScopeError' }, `${name} must refuse cross-tenant filters`);
    }
  });

  it('unscoped() is the explicit, visible escape hatch', async () => {
    assert.equal(await rawCount(M.Medicine), 3);
  });
});

describe('reads are forced into the current tenant', () => {
  it('find() returns only the current tenant\'s documents', async () => {
    const docs = await withA(() => M.Medicine.find());
    assert.deepEqual(docs.map((d) => d.medicineName).sort(), ['A-Med', 'A-Med-2']);
  });

  it('findById() of another tenant\'s document returns null', async () => {
    assert.equal(await withA(() => M.Medicine.findById(bMed._id)), null);
    assert.ok(await withA(() => M.Medicine.findById(aMed._id)));
  });

  it('asking for another tenant\'s organizationId explicitly throws (loud, not silent)', async () => {
    await assert.rejects(() => withA(() => M.Medicine.find({ organizationId: B._id })), { name: 'TenantScopeError' });
    await assert.rejects(() => withA(() => M.Medicine.findOne({ organizationId: String(B._id), medicineName: 'B-Med' })), { name: 'TenantScopeError' });
  });

  it('countDocuments() and distinct() are scoped', async () => {
    assert.equal(await withA(() => M.Medicine.countDocuments()), 2);
    assert.deepEqual((await withA(() => M.Medicine.distinct('medicineName'))).sort(), ['A-Med', 'A-Med-2']);
  });

  it('aggregate() is scoped even when the pipeline forgets to filter', async () => {
    const [r] = await withA(() => M.Medicine.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]));
    assert.equal(r.n, 2);
    const batches = await withA(() => M.Batch.aggregate([{ $group: { _id: null, qty: { $sum: '$availableQuantity' } } }]));
    assert.equal(batches.length, 0, "A has no batches; B's 5 units must not be counted");
  });

  it('aggregate() with $facet (as used by the inventory list) stays scoped', async () => {
    const [r] = await withA(() => M.Medicine.aggregate([{ $facet: { all: [{ $match: {} }], n: [{ $count: 'n' }] } }]));
    assert.equal(r.n[0].n, 2);
  });
});

describe('writes are forced into the current tenant', () => {
  it('updateOne() on another tenant\'s document matches nothing and changes nothing', async () => {
    const r = await withA(() => M.Medicine.updateOne({ _id: bMed._id }, { $set: { medicineName: 'HACKED' } }));
    assert.equal(r.matchedCount, 0);
    assert.equal((await T.unscoped(() => M.Medicine.findById(bMed._id))).medicineName, 'B-Med');
  });

  it('updateMany() only touches the current tenant', async () => {
    await withA(() => M.Medicine.updateMany({}, { $set: { description: 'touched-by-A' } }));
    assert.equal(await rawCount(M.Medicine, { description: 'touched-by-A' }), 2);
    assert.equal((await T.unscoped(() => M.Medicine.findById(bMed._id))).description, '');
  });

  it('findOneAndUpdate() cannot cross tenants', async () => {
    assert.equal(await withA(() => M.Medicine.findOneAndUpdate({ _id: bMed._id }, { $set: { medicineName: 'X' } }, { new: true })), null);
  });

  it('organizationId can never be changed by an update', async () => {
    await assert.rejects(() => withA(() => M.Medicine.updateOne({ _id: aMed._id }, { $set: { organizationId: B._id } })), { name: 'TenantScopeError' });
    await assert.rejects(() => withA(() => M.Medicine.updateOne({ _id: aMed._id }, { organizationId: B._id })), { name: 'TenantScopeError' });
    assert.equal(String((await T.unscoped(() => M.Medicine.findById(aMed._id))).organizationId), String(A._id));
  });

  it('deleteOne() / deleteMany() / findOneAndDelete() cannot remove another tenant\'s documents', async () => {
    const before = await rawCount(M.Medicine, { organizationId: B._id });
    assert.equal((await withA(() => M.Medicine.deleteOne({ _id: bMed._id }))).deletedCount, 0);
    await withA(() => M.Medicine.deleteMany({ medicineName: 'B-Med' }));
    assert.equal(await withA(() => M.Medicine.findOneAndDelete({ _id: bMed._id })), null);
    await withA(() => M.Batch.deleteMany({}));
    assert.equal(await rawCount(M.Medicine, { organizationId: B._id }), before);
    assert.equal(await rawCount(M.Batch, { organizationId: B._id }), 1, "B's batch survives A's deleteMany({})");
  });

  it('a delete with an empty filter only deletes the current tenant\'s documents', async () => {
    const tmpA = await T.runWithTenant(A._id, () => M.Medicine.create(med(A._id, 'to-delete')));
    await withA(() => M.Medicine.deleteMany({ medicineName: 'to-delete' }));
    assert.equal(await T.unscoped(() => M.Medicine.findById(tmpA._id)), null);
    assert.equal(await rawCount(M.Medicine, { organizationId: B._id }), 1);
  });

  it('new documents are assigned to the current tenant automatically', async () => {
    const d = await withA(() => M.Medicine.create({ medicineName: 'auto-owned' }));
    assert.equal(String(d.organizationId), String(A._id));
  });

  it('creating a document for another tenant is refused', async () => {
    await assert.rejects(() => withA(() => M.Medicine.create({ organizationId: B._id, medicineName: 'planted' })), { name: 'TenantScopeError' });
    assert.equal(await rawCount(M.Medicine, { medicineName: 'planted' }), 0);
  });

  it('re-pointing an existing document at another tenant via save() is refused', async () => {
    const d = await withA(() => M.Medicine.findOne({ medicineName: 'A-Med' }));
    d.organizationId = B._id;
    await assert.rejects(() => withA(() => d.save()), { name: 'TenantScopeError' });
  });

  it('counters are per tenant', async () => {
    const a1 = await withA(() => M.nextSeq(A._id, 'invoice'));
    const a2 = await withA(() => M.nextSeq(A._id, 'invoice'));
    const b1 = await T.runWithTenant(B._id, () => M.nextSeq(B._id, 'invoice'));
    assert.deepEqual([a1, a2, b1], [1, 2, 1]);
  });
});

describe('identity collections', () => {
  it('can be searched by email before a tenant is known (sign-in)', async () => {
    assert.ok(await M.User.findOne({ email: 'a-user@example.test' }));
  });

  it('are scoped as soon as a tenant is active', async () => {
    const users = await withA(() => M.User.find());
    assert.deepEqual(users.map((u) => u.email), ['a-user@example.test']);
    assert.equal(await withA(() => M.User.findOne({ email: 'b-user@example.test' })), null);
  });
});

describe('schema design', () => {
  it('every tenant-owned collection has compound indexes that start with organizationId', () => {
    const tenantModels = ['User', 'Session', 'Medicine', 'Batch', 'Invoice', 'StockMovement', 'AuditLog', 'Counter'];
    for (const name of tenantModels) {
      const idx = h.mongoose.model(name).schema.indexes();
      const compoundOnOrg = idx.filter(([keys]) => Object.keys(keys)[0] === 'organizationId' && Object.keys(keys).length > 1);
      assert.ok(compoundOnOrg.length > 0, `${name} needs a compound index starting with organizationId`);
    }
  });

  it('uniqueness is per tenant: unique business keys include organizationId', () => {
    const uniqueKeys = (name) => h.mongoose.model(name).schema.indexes().filter(([, o]) => o?.unique).map(([k]) => Object.keys(k));
    for (const name of ['Batch', 'Invoice', 'Counter']) {
      for (const keys of uniqueKeys(name)) assert.equal(keys[0], 'organizationId', `${name} unique index ${keys} must be per-tenant`);
    }
  });

  it('organizations have unique slugs', async () => {
    await assert.rejects(() => M.Organization.create({ name: 'Dup', slug: A.slug }), { code: 11000 });
  });

  // The role check is in TWO halves, on purpose, and this file holds only the first.
  //
  // `role` used to be `enum: ROLES`, so the model rejected any word that was not one of the five built-ins. It cannot
  // be an enum any more: an organization defines its own roles now, and a custom role's key ("NIGHT_PHARMACIST") is
  // by definition a well-formed word the enum has never heard of. The model still rejects a key that is MALFORMED —
  // that is what is asserted below. Whether a well-formed key names a role this organization actually HAS is checked
  // in users.service.js (400 ROLE_NOT_FOUND) and proved in tests/users-admin.test.js, through the real create and
  // update endpoints. Please do not "fix" this file by putting the enum back: it would make custom roles unassignable.
  it('the User model enforces the SHAPE of a role key and organization membership', async () => {
    for (const role of ['9bad key', 'has spaces', '_LEADING', 'hy-phen', '']) {
      await assert.rejects(
        () => M.User.create({ organizationId: A._id, name: 'x', email: `bad-${role.replace(/\W/g, '')}@example.test`, passwordHash: 'x', role }),
        { name: 'ValidationError' },
        `"${role}" is not a usable role key and must be refused at the model`,
      );
    }
    // A key typed in lower case is NORMALISED rather than refused — the shape is what matters, not the shift key.
    const lower = await M.User.create({ organizationId: A._id, name: 'x', email: 'lower-role@example.test', passwordHash: 'x', role: 'night_shift' });
    assert.equal(lower.role, 'NIGHT_SHIFT');

    await assert.rejects(() => M.User.create({ name: 'x', email: 'no-org@example.test', passwordHash: 'x', role: 'ORG_ADMIN' }), { name: 'ValidationError' });
    // SUPER_ADMIN is platform-level and has no organization.
    const sa = await M.User.create({ name: 'Platform', email: 'platform@example.test', passwordHash: 'x', role: 'SUPER_ADMIN' });
    assert.equal(sa.organizationId, undefined);
  });
});
