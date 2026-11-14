import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { seedSystemRoles, holdersOfUsersManage } from '../scripts/lib/rolesMigration.js';
import { CATALOGUE_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, effectivePermissions } from '../config/permissions.js';
import { keyFromName } from '../services/roles.service.js';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

/** An organization with its system roles seeded, plus a signed-in administrator. */
async function tenantWithRoles(name) {
  const t = await h.makeTenant(name);
  await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
  return t;
}

// Role is tenant-scoped, so reading it straight from the model in a test needs a tenant context, exactly as the
// application does. These helpers keep that out of the way of what each test is actually saying.
const asOrg = (org, fn) => h.tenant.runWithTenant(org._id, fn);
const roleRow = (org, where) => asOrg(org, () => h.models.Role.findOne({ organizationId: org._id, ...where }).lean());
const roleRows = (org) => asOrg(org, () => h.models.Role.find({ organizationId: org._id }).sort({ key: 1 }).lean());
const roleById = (org, id) => asOrg(org, () => h.models.Role.findById(id).lean());
const roleCount = (org, where = {}) => asOrg(org, () => h.models.Role.countDocuments({ organizationId: org._id, ...where }));

describe('the permission catalogue', () => {
  it('covers every permission exactly once, and invents none', () => {
    assert.deepEqual([...CATALOGUE_PERMISSIONS].sort(), [...PERMISSIONS].sort(), 'the catalogue and PERMISSIONS must be the same set');
    assert.equal(new Set(CATALOGUE_PERMISSIONS).size, CATALOGUE_PERMISSIONS.length, 'no permission may appear in two groups');
  });

  it('every system role grants only permissions that exist', () => {
    for (const { key } of SYSTEM_ROLES) {
      for (const p of ROLE_PERMISSIONS[key] || []) assert.ok(PERMISSIONS.includes(p), `${key} grants "${p}", which is not a permission`);
    }
  });
});

describe('the migration', () => {
  it('seeds the five built-in roles with exactly the permissions the code granted before', async () => {
    const { org } = await tenantWithRoles('Seeded Pharmacy');
    const rows = await roleRows(org);
    assert.equal(rows.length, 5);
    for (const { key, name } of SYSTEM_ROLES) {
      const row = rows.find((r) => r.key === key);
      assert.ok(row, `${key} was not seeded`);
      assert.equal(row.name, name);
      assert.equal(row.isSystem, true);
      assert.deepEqual([...row.permissions].sort(), [...(ROLE_PERMISSIONS[key] || [])].sort(), `${key}'s seeded permissions must match the built-in defaults exactly`);
    }
  });

  it('does not seed SUPER_ADMIN, which belongs to no organization', async () => {
    const { org } = await tenantWithRoles('No Super Pharmacy');
    assert.equal(await roleCount(org, { key: 'SUPER_ADMIN' }), 0);
  });

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const { org } = await tenantWithRoles('Twice Pharmacy');
    const before = await roleRows(org);

    const second = await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
    assert.equal(second.perOrg.find((o) => String(o._id) === String(org._id)).created.length, 0, 'the second run must create nothing');

    const after = await roleRows(org);
    assert.deepEqual(after.map((r) => [r.key, r.permissions, r.updatedAt]), before.map((r) => [r.key, r.permissions, r.updatedAt]), 'nothing may be rewritten');
  });

  it('never puts back a permission an organization deliberately removed', async () => {
    const { org, client } = await tenantWithRoles('Chosen Pharmacy');
    const staff = await roleRow(org, { key: 'STAFF' });
    await client.patch(`/roles/${staff._id}`, { permissions: [] });

    await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
    const after = await roleById(org, staff._id);
    assert.deepEqual(after.permissions, [], 'the migration must not restore what somebody chose to take away');
  });

  it('a dry run writes nothing', async () => {
    const org = await h.makeOrg('Dry Pharmacy');
    const r = await seedSystemRoles(h.mongoose.connection.db, { dryRun: true });
    assert.ok(r.created >= 5);
    assert.equal(await roleCount(org), 0, 'a dry run must leave the database untouched');
  });

  it('reports a user whose role key it does not recognise, and does not touch them', async () => {
    const org = await h.makeOrg('Odd Pharmacy');
    const stray = await h.makeUser(org, { role: 'WAREHOUSE_LEAD' });
    const r = await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
    const listed = r.unknownRoles.find((u) => String(u._id) === String(stray._id));
    assert.ok(listed, 'the stray role must be listed for review');
    assert.equal(listed.role, 'WAREHOUSE_LEAD');
    const after = await h.models.User.findById(stray._id).lean();
    assert.equal(after.role, 'WAREHOUSE_LEAD', 'the migration must not repair a role it cannot understand');
  });
});

describe('a newly created organization', () => {
  /**
   * The gap this closes: before, only a MIGRATED database had role rows. An organization created afterwards had
   * none, so its administrator signed in happily on the built-in fallback and then opened an empty Roles screen.
   */
  it('is born with the five built-in roles, without the migration ever running', async () => {
    const org = await h.makeOrg('Newborn Pharmacy');
    const { ensureSystemRoles } = await import('../services/roles.service.js');
    await h.tenant.runWithTenant(org._id, () => ensureSystemRoles({ orgId: org._id }));

    const rows = await roleRows(org);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.isSystem));
    for (const { key } of SYSTEM_ROLES) {
      assert.deepEqual([...rows.find((r) => r.key === key).permissions].sort(), [...(ROLE_PERMISSIONS[key] || [])].sort());
    }
  });

  it('creating them twice creates nothing the second time', async () => {
    const org = await h.makeOrg('Twice Born Pharmacy');
    const { ensureSystemRoles } = await import('../services/roles.service.js');
    const first = await h.tenant.runWithTenant(org._id, () => ensureSystemRoles({ orgId: org._id }));
    const second = await h.tenant.runWithTenant(org._id, () => ensureSystemRoles({ orgId: org._id }));
    assert.equal(first.created.length, 5);
    assert.deepEqual(second.created, []);
    assert.equal(await roleCount(org), 5);
  });
});

describe('GET /roles', () => {
  it('lists the system roles with canEdit, canDelete and a user count', async () => {
    const { client } = await tenantWithRoles('Listing Pharmacy');
    const r = await client.get('/roles');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 5);

    const admin = r.data.items.find((x) => x.key === 'ORG_ADMIN');
    assert.equal(admin.isSystem, true);
    assert.equal(admin.canEdit, true, 'a built-in role\'s permissions are editable');
    assert.equal(admin.canDelete, false, 'a built-in role may never be deleted');
    assert.equal(admin.cannotDeleteReason, 'Built-in roles cannot be deleted.');
    assert.equal(admin.userCount, 1, 'the signed-in administrator holds it');

    const staff = r.data.items.find((x) => x.key === 'STAFF');
    assert.equal(staff.userCount, 0);
    assert.equal(staff.canDelete, false, 'still a built-in, even with nobody in it');
  });

  it('carries the permission catalogue, so the client holds no copy of it', async () => {
    const { client } = await tenantWithRoles('Catalogue Pharmacy');
    const r = await client.get('/roles');
    const flat = r.data.catalogue.flatMap((g) => g.permissions.map((p) => p.key));
    assert.deepEqual([...flat].sort(), [...PERMISSIONS].sort());
    assert.ok(r.data.catalogue.every((g) => g.label && g.permissions.every((p) => p.label && p.description)), 'every permission needs a label and a description');
  });

  it('says in as many words that branch scope is not enforced yet', async () => {
    const { client } = await tenantWithRoles('Scope Pharmacy');
    const r = await client.get('/roles');
    assert.match(r.data.scopeNote, /does not yet restrict data access/i);
  });

  it('is refused to somebody without users:manage', async () => {
    const { org } = await tenantWithRoles('Closed Pharmacy');
    const staff = await h.makeUser(org, { role: 'STAFF' });
    const c = h.client();
    await c.login(staff.email);
    const r = await c.get('/roles');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
  });
});

describe('creating a role', () => {
  it('derives the key from the name and stores permissions in catalogue order', async () => {
    const { client } = await tenantWithRoles('Create Pharmacy');
    const r = await client.post('/roles', { name: 'Finance Lead', description: 'Looks after the money', permissions: ['settings:read', 'billing:create', 'reports:read'] });
    assert.equal(r.status, 201);
    assert.equal(r.data.key, 'FINANCE_LEAD');
    assert.equal(r.data.isSystem, false);
    assert.equal(r.data.canDelete, true, 'a custom role nobody holds can be deleted');
    assert.deepEqual(r.data.permissions, ['billing:create', 'reports:read', 'settings:read'], 'stored in catalogue order, so two identical roles read identically');
  });

  it('refuses an unknown permission by name, and saves nothing', async () => {
    const { org, client } = await tenantWithRoles('Unknown Pharmacy');
    const before = await roleCount(org);
    const r = await client.post('/roles', { name: 'Ghost', permissions: ['inventory:read', 'medicines:teleport'] });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /medicines:teleport/, 'the refusal must name the offending permission');
    assert.equal(await roleCount(org), before, 'nothing may be created');
  });

  it('refuses a duplicate name, case-insensitively', async () => {
    const { client } = await tenantWithRoles('Duplicate Pharmacy');
    await client.post('/roles', { name: 'Night Shift', permissions: [] });
    const r = await client.post('/roles', { name: 'night shift', permissions: [] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'ROLE_EXISTS');
  });

  it('refuses a key sent by the client', async () => {
    const { client } = await tenantWithRoles('Keyed Pharmacy');
    const r = await client.post('/roles', { name: 'Sneaky', key: 'ORG_ADMIN', permissions: [] });
    assert.equal(r.status, 400);
  });

  it('keyFromName avoids collisions rather than overwriting', () => {
    assert.equal(keyFromName('Finance Lead'), 'FINANCE_LEAD');
    assert.equal(keyFromName('Finance Lead', new Set(['FINANCE_LEAD'])), 'FINANCE_LEAD_2');
    assert.equal(keyFromName('2nd Shift'), 'ROLE_2ND_SHIFT', 'a key must start with a letter');
    assert.equal(keyFromName('!!!'), 'ROLE', 'a name of pure punctuation still yields a usable key');
  });
});

describe('the four guards', () => {
  it('ROLE_SYSTEM: a built-in role cannot be renamed or deleted, but its permissions can change', async () => {
    const { org, client } = await tenantWithRoles('Builtin Pharmacy');
    const staff = await roleRow(org, { key: 'STAFF' });

    const renamed = await client.patch(`/roles/${staff._id}`, { name: 'Shop Floor' });
    assert.equal(renamed.status, 409);
    assert.equal(renamed.body.code, 'ROLE_SYSTEM');

    const deleted = await client.del(`/roles/${staff._id}`);
    assert.equal(deleted.status, 409);
    assert.equal(deleted.body.code, 'ROLE_SYSTEM');

    const edited = await client.patch(`/roles/${staff._id}`, { permissions: ['inventory:read', 'billing:read'] });
    assert.equal(edited.status, 200, 'what a built-in may DO is editable');
    assert.deepEqual(edited.data.permissions, ['inventory:read', 'billing:read'], 'catalogue order, not the order they were sent in');
  });

  it('ROLE_IN_USE: a role somebody holds cannot be deleted, and the message says how many', async () => {
    const { org, client } = await tenantWithRoles('InUse Pharmacy');
    const created = await client.post('/roles', { name: 'Night Porter', permissions: ['inventory:read'] });
    await h.makeUser(org, { role: created.data.key });
    await h.makeUser(org, { role: created.data.key });

    const r = await client.del(`/roles/${created.data.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'ROLE_IN_USE');
    assert.match(r.body.message, /2 users still hold/);
    assert.ok(await roleById(org, created.data.id), 'the role must still be there');
  });

  it('ROLE_IN_USE: the list marks it undeletable before anyone clicks', async () => {
    const { org, client } = await tenantWithRoles('Marked Pharmacy');
    const created = await client.post('/roles', { name: 'Locum', permissions: [] });
    await h.makeUser(org, { role: created.data.key });

    const list = await client.get('/roles?search=Locum');
    const row = list.data.items[0];
    assert.equal(row.canDelete, false);
    assert.equal(row.userCount, 1);
    assert.match(row.cannotDeleteReason, /1 user holds this role/);
  });

  it('ROLE_LAST_ADMIN: users:manage cannot be taken off the last role that grants it', async () => {
    const { org, client } = await tenantWithRoles('Lockout Pharmacy');
    const admin = await roleRow(org, { key: 'ORG_ADMIN' });

    const without = admin.permissions.filter((p) => p !== 'users:manage');
    const r = await client.patch(`/roles/${admin._id}`, { permissions: without });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'ROLE_LAST_ADMIN');
    assert.match(r.body.message, /nobody who can manage users and roles/);

    const after = await roleById(org, admin._id);
    assert.ok(after.permissions.includes('users:manage'), 'nothing may have been written');
  });

  it('ROLE_LAST_ADMIN: the same edit is allowed once somebody else holds it', async () => {
    const { org, client } = await tenantWithRoles('Second Admin Pharmacy');
    const second = await client.post('/roles', { name: 'Co Admin', permissions: ['users:manage'] });
    await h.makeUser(org, { role: second.data.key });

    const admin = await roleRow(org, { key: 'ORG_ADMIN' });
    const r = await client.patch(`/roles/${admin._id}`, { permissions: admin.permissions.filter((p) => p !== 'users:manage') });
    assert.equal(r.status, 200, 'with a second administrator in place, this is safe');
  });

  it('ROLE_LAST_ADMIN: an inactive administrator does not count as cover', async () => {
    const { org, client } = await tenantWithRoles('Inactive Cover Pharmacy');
    const second = await client.post('/roles', { name: 'Dormant Admin', permissions: ['users:manage'] });
    await h.makeUser(org, { role: second.data.key, isActive: false });

    const admin = await roleRow(org, { key: 'ORG_ADMIN' });
    const r = await client.patch(`/roles/${admin._id}`, { permissions: admin.permissions.filter((p) => p !== 'users:manage') });
    assert.equal(r.status, 409, 'somebody who cannot sign in cannot rescue the organization');
    assert.equal(r.body.code, 'ROLE_LAST_ADMIN');
  });

  it('ROLE_PERMISSION_UNKNOWN: an unknown permission on an edit changes nothing', async () => {
    const { org, client } = await tenantWithRoles('Edit Unknown Pharmacy');
    const staff = await roleRow(org, { key: 'STAFF' });
    const r = await client.patch(`/roles/${staff._id}`, { permissions: ['inventory:read', 'invoices:shred'] });
    assert.equal(r.status, 400);
    const after = await roleById(org, staff._id);
    assert.deepEqual(after.permissions, staff.permissions, 'the existing permissions must be untouched');
  });
});

describe('a live role edit', () => {
  /**
   * The question this module turns on: if an administrator changes what a role may do WHILE somebody holding it is
   * signed in, when does it take effect? It must be their very next request. Permissions are never carried in the
   * access token - `authenticate` re-reads the user and the role row on every request - so there is no window in
   * which a revoked permission still works, and no need to force anybody to sign in again.
   */
  it('takes effect on the holder\'s next request, not at their next sign-in', async () => {
    const { org, client: admin } = await tenantWithRoles('Live Edit Pharmacy');

    const role = await admin.post('/roles', { name: 'Stock Watcher', permissions: ['inventory:read', 'reports:read'] });
    const watcher = await h.makeUser(org, { role: role.data.key });
    const theirs = h.client();
    await theirs.login(watcher.email);

    // Mid-session, and working.
    const before = await theirs.get('/analytics/sales');
    assert.notEqual(before.status, 403, 'they can read reports to begin with');

    // Someone else takes reports away while they are still signed in.
    const edit = await admin.patch(`/roles/${role.data.id}`, { permissions: ['inventory:read'] });
    assert.equal(edit.status, 200);

    // The very next request on the SAME session, with the SAME token, is refused.
    const after = await theirs.get('/analytics/sales');
    assert.equal(after.status, 403, 'the change must bite immediately, without a new sign-in');
    assert.equal(after.body.code, 'FORBIDDEN');

    // And what they kept still works.
    const kept = await theirs.get('/medicines');
    assert.notEqual(kept.status, 403, 'only the removed permission is gone');
  });

  it('grants work the same way round: a permission added mid-session works at once', async () => {
    const { org, client: admin } = await tenantWithRoles('Live Grant Pharmacy');
    const role = await admin.post('/roles', { name: 'Trainee', permissions: ['inventory:read'] });
    const trainee = await h.makeUser(org, { role: role.data.key });
    const theirs = h.client();
    await theirs.login(trainee.email);

    assert.equal((await theirs.get('/analytics/sales')).status, 403);
    await admin.patch(`/roles/${role.data.id}`, { permissions: ['inventory:read', 'reports:read'] });
    assert.notEqual((await theirs.get('/analytics/sales')).status, 403, 'no sign-out required to gain a permission either');
  });

  it('an organization with no role rows behaves exactly as it did before roles existed', async () => {
    // No seedSystemRoles call here on purpose: this is a database that never ran the migration.
    const { org } = await h.makeTenant('Unmigrated Pharmacy');
    const staff = await h.makeUser(org, { role: 'BILLING_STAFF' });
    const c = h.client();
    await c.login(staff.email);

    assert.notEqual((await c.get('/medicines')).status, 403, 'the built-in defaults still apply');
    assert.equal((await c.get('/roles')).status, 403, 'and still deny what they always denied');
    assert.deepEqual(effectivePermissions({ role: 'BILLING_STAFF', permissions: [] }).sort(), effectivePermissions({ role: 'BILLING_STAFF', permissions: [], rolePermissions: undefined }).sort());
  });
});

describe('holdersOfUsersManage', () => {
  const roles = [
    { key: 'ORG_ADMIN', permissions: ['users:manage', 'billing:read'] },
    { key: 'STAFF', permissions: ['inventory:read'] },
  ];
  const users = [
    { _id: 'a', role: 'ORG_ADMIN', isActive: true, permissions: [] },
    { _id: 'b', role: 'STAFF', isActive: true, permissions: [] },
  ];

  it('counts an active holder', () => {
    assert.deepEqual(holdersOfUsersManage({ users, roles }).map((u) => u._id), ['a']);
  });

  it('sees through a pending role edit', () => {
    assert.equal(holdersOfUsersManage({ users, roles, change: { roleKey: 'ORG_ADMIN', permissions: ['billing:read'] } }).length, 0);
  });

  it('sees through a pending move to another role', () => {
    assert.equal(holdersOfUsersManage({ users, roles, change: { userId: 'a', role: 'STAFF' } }).length, 0);
  });

  it('sees through a pending deactivation', () => {
    assert.equal(holdersOfUsersManage({ users, roles, change: { userId: 'a', isActive: false } }).length, 0);
  });

  it('counts a personal grant that does not come from the role', () => {
    const withExtra = [...users.slice(1), { _id: 'c', role: 'STAFF', isActive: true, permissions: ['users:manage'] }];
    assert.deepEqual(holdersOfUsersManage({ users: withExtra, roles }).map((u) => u._id), ['c']);
  });
});
