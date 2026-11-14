import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness } from './helpers/harness.js';
import { seedSystemRoles } from '../scripts/lib/rolesMigration.js';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

async function tenantWithRoles(name) {
  const t = await h.makeTenant(name);
  await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
  return t;
}

const asOrg = (org, fn) => h.tenant.runWithTenant(org._id, fn);
const roleRow = (org, key) => asOrg(org, () => h.models.Role.findOne({ organizationId: org._id, key }).lean());

const NEW_USER = { name: 'Priya Nair', password: 'Str0ng!Passw0rd', role: 'BILLING_STAFF' };
const email = () => `u${Date.now()}${Math.random().toString(36).slice(2, 7)}@example.test`;

describe('GET /users', () => {
  it('lists the organization, with role names and the filter options resolved', async () => {
    const { client } = await tenantWithRoles('Users Pharmacy');
    await client.post('/users', { ...NEW_USER, email: email() });

    const r = await client.get('/users');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 2, 'the administrator and the new user');

    const created = r.data.items.find((u) => u.role === 'BILLING_STAFF');
    assert.equal(created.roleName, 'Billing Staff', 'the display name comes from the role row, not the key');
    assert.equal(created.isActive, true);
    assert.equal(created.mustChangePassword, true, 'an administrator-set password must be changed at first sign-in');
    assert.ok(r.data.roles.some((x) => x.key === 'ORG_ADMIN'), 'the role filter options travel with the list');
  });

  it('filters by role and by whether they are active', async () => {
    const { client } = await tenantWithRoles('Filter Pharmacy');
    const made = await client.post('/users', { ...NEW_USER, email: email() });
    await client.post(`/users/${made.data.id}/deactivate`);

    assert.equal((await client.get('/users?role=BILLING_STAFF')).data.total, 1);
    assert.equal((await client.get('/users?active=inactive')).data.total, 1);
    assert.equal((await client.get('/users?active=active')).data.total, 1, 'only the administrator is left active');
    assert.equal((await client.get('/users?search=Priya')).data.total, 1);
  });

  it('tells the screen what it may do, so it never offers a button that would fail', async () => {
    const { client } = await tenantWithRoles('Buttons Pharmacy');
    const r = await client.get('/users');
    const me = r.data.items.find((u) => u.isSelf);
    assert.equal(me.canDeactivate, false, 'you cannot deactivate yourself');
    assert.equal(me.cannotDeactivateReason, 'You cannot deactivate your own account.');
  });

  it('is refused to somebody without users:manage', async () => {
    const { org } = await tenantWithRoles('Private Pharmacy');
    const staff = await h.makeUser(org, { role: 'STAFF' });
    const c = h.client();
    await c.login(staff.email);
    assert.equal((await c.get('/users')).status, 403, 'who works here is not public to every cashier');
  });
});

describe('creating a user', () => {
  it('creates one who can then sign in and is made to change the password', async () => {
    const { client } = await tenantWithRoles('Signin Pharmacy');
    const e = email();
    const r = await client.post('/users', { ...NEW_USER, email: e });
    assert.equal(r.status, 201);

    const theirs = h.client();
    const login = await theirs.login(e, NEW_USER.password);
    assert.equal(login.status, 200, 'the password the administrator set works');
    const blocked = await theirs.get('/medicines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED', 'and nothing else is reachable until they change it');
  });

  it('refuses a weak password, a duplicate email and an unknown role', async () => {
    const { client } = await tenantWithRoles('Refusal Pharmacy');
    const e = email();
    await client.post('/users', { ...NEW_USER, email: e });

    assert.equal((await client.post('/users', { ...NEW_USER, email: email(), password: 'short' })).status, 400);
    const dupe = await client.post('/users', { ...NEW_USER, email: e });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.code, 'EMAIL_TAKEN');
    const ghost = await client.post('/users', { ...NEW_USER, email: email(), role: 'NO_SUCH_ROLE' });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.code, 'ROLE_NOT_FOUND');
  });

  /**
   * The second half of the role check that tests/tenant-plugin.test.js used to make on its own.
   *
   * "MANAGER" is well-formed, so the model cannot refuse it - it looks exactly like the key of a custom role somebody
   * might legitimately have defined. What refuses it is the service, because no role with that key exists HERE; and
   * it must refuse it on the way in and on the way through, not only when creating.
   */
  it('a well-formed role key that names no role in this organization is refused, on create and on update', async () => {
    const { client } = await tenantWithRoles('Unrecognised Key Pharmacy');

    const created = await client.post('/users', { ...NEW_USER, email: email(), role: 'MANAGER' });
    assert.equal(created.status, 400, 'creating with an unrecognised role key must fail');
    assert.equal(created.body.code, 'ROLE_NOT_FOUND');

    const real = await client.post('/users', { ...NEW_USER, email: email() });
    const updated = await client.patch(`/users/${real.data.id}`, { role: 'MANAGER' });
    assert.equal(updated.status, 400, 'moving somebody to an unrecognised role key must fail too');
    assert.equal(updated.body.code, 'ROLE_NOT_FOUND');

    const unchanged = await h.models.User.findById(real.data.id).lean();
    assert.equal(unchanged.role, 'BILLING_STAFF', 'and nothing may have been written');

    // The same key becomes acceptable the moment the organization actually defines that role.
    await client.post('/roles', { name: 'Manager', permissions: ['inventory:read'] });
    const now = await client.patch(`/users/${real.data.id}`, { role: 'MANAGER' });
    assert.equal(now.status, 200, 'a custom role with that key makes it a real role');
    assert.equal(now.data.roleName, 'Manager');
  });

  it('accepts a custom role the organization has just defined', async () => {
    const { client } = await tenantWithRoles('Custom Role Pharmacy');
    const role = await client.post('/roles', { name: 'Night Pharmacist', permissions: ['inventory:read', 'billing:create'] });
    const r = await client.post('/users', { ...NEW_USER, email: email(), role: role.data.key });
    assert.equal(r.status, 201);
    assert.equal(r.data.roleName, 'Night Pharmacist');
  });

  it('refuses per-user extra permissions: access comes from a role', async () => {
    const { client } = await tenantWithRoles('No Extras Pharmacy');
    const r = await client.post('/users', { ...NEW_USER, email: email(), permissions: ['users:manage'] });
    assert.equal(r.status, 400, 'granting a permission off-role would be invisible on the Roles screen');
  });
});

describe('deactivating a user', () => {
  it('keeps the record and everything that refers to it, and ends their session', async () => {
    const { org, client } = await tenantWithRoles('History Pharmacy');
    const e = email();
    const made = await client.post('/users', { ...NEW_USER, email: e });

    const theirs = h.client();
    await theirs.login(e, NEW_USER.password);

    const r = await client.post(`/users/${made.data.id}/deactivate`);
    assert.equal(r.status, 200);
    assert.equal(r.data.isActive, false);

    // The document is still there, in full.
    const still = await h.models.User.findById(made.data.id).lean();
    assert.ok(still, 'a user is never deleted — invoices and audit entries refer to them');
    assert.equal(still.email, e);
    assert.equal(still.isActive, false);

    // Their session is over immediately; they do not keep browsing on the token they already hold.
    const after = await theirs.get('/medicines');
    assert.equal(after.status, 401);

    // And they cannot sign in again.
    const relogin = await h.client().login(e, NEW_USER.password);
    assert.notEqual(relogin.status, 200);

    // The audit entry names what happened.
    const log = await asOrg(org, () => h.models.AuditLog.findOne({ organizationId: org._id, action: 'USER_DEACTIVATED' }).lean());
    assert.ok(log, 'a deactivation is recorded');
  });

  it('there is no delete endpoint at all', async () => {
    const { client } = await tenantWithRoles('No Delete Pharmacy');
    const made = await client.post('/users', { ...NEW_USER, email: email() });
    const r = await client.del(`/users/${made.data.id}`);
    assert.ok(r.status === 404 || r.status === 405, `deleting a user must not be routable (got ${r.status})`);
    assert.ok(await h.models.User.findById(made.data.id).lean(), 'and the user is still there');
  });

  it('refuses to deactivate yourself', async () => {
    const { user, client } = await tenantWithRoles('Self Pharmacy');
    const r = await client.post(`/users/${user._id}/deactivate`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'USER_SELF');
  });

  it('refuses to deactivate the last person who can manage users', async () => {
    const { org, client } = await tenantWithRoles('Last Admin Pharmacy');
    // A second administrator, so the first can be deactivated by them.
    const e = email();
    await client.post('/users', { ...NEW_USER, email: e, role: 'ORG_ADMIN' });
    const second = h.client();
    await second.login(e, NEW_USER.password);
    await second.post('/auth/change-password', { currentPassword: NEW_USER.password, newPassword: PASSWORD });

    const admins = await client.get('/users?role=ORG_ADMIN');
    assert.equal(admins.data.total, 2);

    // Deactivating the first is fine — the second still holds users:manage.
    const first = admins.data.items.find((u) => !u.isSelf);
    const ok = await client.post(`/users/${first.id}/deactivate`);
    assert.equal(ok.status, 200);

    // Now the remaining administrator is the last one. Moving them to STAFF would lock the organization out.
    const me = (await client.get('/users')).data.items.find((u) => u.isSelf);
    const r = await client.patch(`/users/${me.id}`, { role: 'STAFF' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'ROLE_LAST_ADMIN');

    const unchanged = await h.models.User.findById(me.id).lean();
    assert.equal(unchanged.role, 'ORG_ADMIN', 'nothing may have been written');
    assert.ok(await roleRow(org, 'ORG_ADMIN'));
  });
});

describe('editing a user', () => {
  it('changes role and stores, and records what changed', async () => {
    const { org, client } = await tenantWithRoles('Edit User Pharmacy');
    const branch = (await client.get('/branches')).data.items?.[0] || (await client.get('/branches')).data[0];
    const made = await client.post('/users', { ...NEW_USER, email: email() });

    const r = await client.patch(`/users/${made.data.id}`, { role: 'INVENTORY_MANAGER', branchIds: [String(branch.id || branch._id)] });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, 'INVENTORY_MANAGER');
    assert.equal(r.data.branchNames.length, 1);
    assert.notEqual(r.data.branchNames[0], 'Unknown store');

    const log = await asOrg(org, () => h.models.AuditLog.findOne({ organizationId: org._id, action: 'USER_UPDATED' }).lean());
    assert.ok(log.meta.changes.some((c) => c.field === 'role' && c.from === 'BILLING_STAFF' && c.to === 'INVENTORY_MANAGER'));
  });

  it('refuses a store that belongs to another organization', async () => {
    const { client } = await tenantWithRoles('Mine Pharmacy');
    const other = await tenantWithRoles('Theirs Pharmacy');
    const theirBranch = (await other.client.get('/branches')).data.items?.[0] || (await other.client.get('/branches')).data[0];
    const made = await client.post('/users', { ...NEW_USER, email: email() });

    const r = await client.patch(`/users/${made.data.id}`, { branchIds: [String(theirBranch.id || theirBranch._id)] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'BRANCH_NOT_FOUND');
  });

  it('refuses to change an email address or a password here', async () => {
    const { client } = await tenantWithRoles('Immutable Pharmacy');
    const made = await client.post('/users', { ...NEW_USER, email: email() });
    assert.equal((await client.patch(`/users/${made.data.id}`, { email: email() })).status, 400);
    assert.equal((await client.patch(`/users/${made.data.id}`, { password: 'An0ther!Pass' })).status, 400);
  });

  it('a user from another organization is invisible, not merely forbidden', async () => {
    const { client } = await tenantWithRoles('Tenant A Pharmacy');
    const other = await tenantWithRoles('Tenant B Pharmacy');
    const theirs = await other.client.post('/users', { ...NEW_USER, email: email() });

    const r = await client.patch(`/users/${theirs.data.id}`, { role: 'STAFF' });
    assert.equal(r.status, 404, 'another tenant\'s user must look like one that does not exist');
  });
});
