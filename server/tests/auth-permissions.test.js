import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness } from './helpers/harness.js';
import { seedSystemRoles } from '../scripts/lib/rolesMigration.js';
import { ROLE_PERMISSIONS } from '../config/permissions.js';

/**
 * What the browser is handed by sign-in and by token refresh must be exactly what /auth/me says, from the first
 * request. It used to be `permissions: []` for any custom role, so a person with a custom role opened a nearly empty
 * app until a page reload made it ask /auth/me.
 */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

const email = () => `p${Date.now()}${Math.random().toString(36).slice(2, 7)}@example.test`;
const sorted = (xs) => [...xs].sort();

async function tenantWithRoles(name) {
  const t = await h.makeTenant(name);
  await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
  return t;
}

/** Creates a user holding `role`, signs them in, and returns what sign-in, refresh and /auth/me each say they may do. */
async function permissionsSeenBy(admin, role) {
  const address = email();
  const made = await admin.client.post('/users', { name: 'Test Person', email: address, password: PASSWORD, role });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const person = h.client();
  const login = await person.login(address);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const me = await person.get('/auth/me');
  const refreshed = await person.post('/auth/refresh', undefined, { csrf: false, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  return { person, login: login.data.user.permissions, me: me.data.user.permissions, refresh: refreshed.data.user.permissions, users: { login: login.data.user, me: me.data.user, refresh: refreshed.data.user } };
}

/** A user as the browser gets it, with the permission list sorted so two of them can be compared field for field. */
const comparable = (u) => ({ ...u, permissions: sorted(u.permissions) });

describe('the permissions a sign-in hands the browser', () => {
  it('are the custom role\'s permissions, the same as /auth/me and a refresh, with no reload needed', async () => {
    const admin = await tenantWithRoles('Custom Role Pharmacy');
    const created = await admin.client.post('/roles', { name: 'Counter Clerk', permissions: ['billing:create', 'inventory:read'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const seen = await permissionsSeenBy(admin, 'COUNTER_CLERK');
    assert.ok(seen.login.includes('billing:create') && seen.login.includes('inventory:read'), `sign-in said ${JSON.stringify(seen.login)}`);
    assert.deepEqual(sorted(seen.login), sorted(seen.me), 'sign-in and /auth/me agree');
    assert.deepEqual(sorted(seen.refresh), sorted(seen.me), 'a token refresh and /auth/me agree');
    assert.ok(!seen.login.includes('users:manage'), 'and it grants nothing the role does not');
  });

  it('are part of the SAME user object /auth/me returns, field for field (name, email, role, flags, organization)', async () => {
    const admin = await tenantWithRoles('Whole User Pharmacy');
    await admin.client.post('/roles', { name: 'Counter Clerk', permissions: ['billing:create'] });
    const seen = await permissionsSeenBy(admin, 'COUNTER_CLERK');
    // Spreading a Mongoose document once made sign-in return a user with no role and no mustChangePassword.
    assert.equal(seen.users.login.role, 'COUNTER_CLERK');
    assert.equal(seen.users.login.mustChangePassword, true, 'an administrator-set password still has to be changed');
    assert.deepEqual(comparable(seen.users.login), comparable(seen.users.me), 'sign-in and /auth/me describe the same user');
    assert.deepEqual(comparable(seen.users.refresh), comparable(seen.users.me), 'and so does a token refresh');
  });

  it('follow an edit to the role: the very next sign-in has the new set, not the old one', async () => {
    const admin = await tenantWithRoles('Edited Role Pharmacy');
    const role = await admin.client.post('/roles', { name: 'Stock Clerk', permissions: ['inventory:read'] });
    assert.equal(role.status, 201);
    const before = await permissionsSeenBy(admin, 'STOCK_CLERK');
    assert.ok(!before.login.includes('inventory:write'));

    const edited = await admin.client.patch(`/roles/${role.data.id || role.data._id}`, { permissions: ['inventory:read', 'inventory:write'] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const after = await permissionsSeenBy(admin, 'STOCK_CLERK');
    assert.ok(after.login.includes('inventory:write'), 'the edit is in the sign-in response');
    assert.deepEqual(sorted(after.login), sorted(after.me));
  });

  it('are the EDITED permissions of a built-in role, not its factory defaults', async () => {
    const admin = await tenantWithRoles('Built-in Edited Pharmacy');
    const rows = await admin.client.get('/roles');
    const billing = rows.data.items.find((r) => r.key === 'BILLING_STAFF');
    assert.ok(billing, 'the built-in Billing Staff role exists');
    const trimmed = billing.permissions.filter((p) => p !== 'returns:refund');
    assert.notDeepEqual(sorted(trimmed), sorted(billing.permissions), 'the test needs something to take away');
    const edited = await admin.client.patch(`/roles/${billing.id || billing._id}`, { permissions: trimmed });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const seen = await permissionsSeenBy(admin, 'BILLING_STAFF');
    assert.ok(!seen.login.includes('returns:refund'), `sign-in still handed out the factory default: ${JSON.stringify(seen.login)}`);
    assert.deepEqual(sorted(seen.login), sorted(seen.me));
    assert.deepEqual(sorted(seen.refresh), sorted(seen.me));
  });

  it('are unchanged for a built-in role nobody has edited', async () => {
    const admin = await tenantWithRoles('Defaults Pharmacy');
    const seen = await permissionsSeenBy(admin, 'BILLING_STAFF');
    for (const p of ROLE_PERMISSIONS.BILLING_STAFF) assert.ok(seen.login.includes(p), `missing ${p}`);
    assert.deepEqual(sorted(seen.login), sorted(seen.me));
  });

  it('fall back to the built-in map when the organization has no role rows at all', async () => {
    const { org, client } = await h.makeTenant('No Role Rows Pharmacy'); // makeTenant does NOT seed roles
    const address = email();
    await h.makeUser(org, { role: 'BILLING_STAFF', email: address });
    const person = h.client();
    const login = await person.login(address);
    assert.equal(login.status, 200);
    assert.deepEqual(sorted(login.data.user.permissions), sorted((await person.get('/auth/me')).data.user.permissions));
    assert.ok(login.data.user.permissions.includes('billing:create'), 'the built-in map still applies');
    assert.ok(client, 'admin client unused beyond setup');
  });
});
