import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness } from './helpers/harness.js';
import { ACCESS_COOKIE } from '../utils/cookies.js';

/**
 * The Session model carries every signed-in browser in this system, so widening it is the riskiest thing the
 * platform-administrator work touches. These tests come first and they pull in both directions:
 *
 *   it must now be POSSIBLE to have a session with no organization - but only when the caller says `platform`;
 *   and it must still be IMPOSSIBLE to end up with one by accident, or to reach any organization's data with it.
 *
 * The second half matters more than the first. A platform session that could read tenant data would be exactly the
 * backdoor this design exists to avoid, so it is checked against real org-data endpoints rather than against the
 * middleware in isolation.
 */

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

/** A platform administrator: a real User row with no organization at all. */
const makePlatformAdmin = (extra = {}) => h.makeUser(null, { role: 'SUPER_ADMIN', ...extra });

describe('the Session model', () => {
  it('accepts a platform session with no organization', async () => {
    const sa = await makePlatformAdmin();
    const { session } = await h.sessions.createSession(sa, { rememberMe: false, ip: '127.0.0.1', userAgent: 'test', platform: true });

    assert.ok(session._id, 'the session was created');
    assert.equal(session.isPlatform, true);
    assert.equal(session.organizationId, undefined, 'a platform session carries no organization');

    const stored = await h.models.Session.findById(session._id).lean();
    assert.equal(stored.organizationId, undefined, 'and none was written to the database either');
  });

  it('still refuses a session with no organization when `platform` was not asked for', async () => {
    const sa = await makePlatformAdmin();
    await assert.rejects(
      () => h.sessions.createSession(sa, { rememberMe: false, ip: '127.0.0.1', userAgent: 'test' }),
      { name: 'ValidationError' },
      'omitting the organization must fail loudly unless it was deliberate',
    );
  });

  it('still refuses a session written straight to the model without an organization', async () => {
    const sa = await makePlatformAdmin();
    await assert.rejects(
      () => h.models.Session.create({ userId: sa._id, refreshHash: 'x'.repeat(64), expiresAt: new Date(Date.now() + 60000) }),
      { name: 'ValidationError' },
      'the model, not just the service, is what enforces this',
    );
  });

  it('an ordinary session is unchanged: it still carries its organization and is not a platform session', async () => {
    const { org, user } = await h.makeTenant('Ordinary Pharmacy');
    const { session } = await h.tenant.runWithTenant(org._id, () =>
      h.sessions.createSession(user, { rememberMe: false, ip: '127.0.0.1', userAgent: 'test' }),
    );
    assert.equal(String(session.organizationId), String(org._id));
    assert.equal(session.isPlatform, false, 'ordinary sessions are not platform sessions by default');
  });

  it('every organization member still gets a session that requires the organization', async () => {
    // Walks the ordinary roles, so the conditional cannot be loosened for one of them by accident.
    const { org } = await h.makeTenant('Every Role Pharmacy');
    for (const role of ['ORG_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_MANAGER', 'BILLING_STAFF', 'STAFF']) {
      const u = await h.makeUser(org, { role });
      const { session } = await h.tenant.runWithTenant(org._id, () => h.sessions.createSession(u, { rememberMe: false }));
      assert.equal(String(session.organizationId), String(org._id), `${role}'s session lost its organization`);
      assert.equal(session.isPlatform, false, `${role} got a platform session`);
    }
  });
});

describe('a platform administrator cannot reach organization data', () => {
  /** A client holding a REAL platform session cookie, as if they had signed in at /platform. */
  async function platformClient() {
    const sa = await makePlatformAdmin();
    const { accessToken } = await h.sessions.createSession(sa, { rememberMe: false, ip: '127.0.0.1', userAgent: 'test', platform: true });
    const c = h.client();
    c.jar.set(ACCESS_COOKIE, accessToken);
    return { sa, c };
  }

  it('is refused on every tenant endpoint, with a session that is otherwise perfectly valid', async () => {
    // An organization with data in it, so a leak would have something to leak.
    await h.makeTenant('Has Data Pharmacy');
    const { c } = await platformClient();

    const endpoints = [
      '/medicines',
      '/invoices',
      '/dashboard/overview',
      '/dashboard/alerts',
      '/activity',
      '/pos/products',
      '/organization',
      '/settings',
      '/roles',
      '/users',
      '/suppliers',
      '/analytics/sales',
      '/auth/me',
    ];
    for (const path of endpoints) {
      const r = await c.get(path);
      assert.equal(r.status, 403, `GET ${path} must be refused for a platform administrator (got ${r.status})`);
      assert.equal(r.body.code, 'TENANT_FORBIDDEN', `GET ${path} refused with the wrong reason: ${r.body.code}`);
    }
  });

  it('is refused on writes too, not only reads', async () => {
    await h.makeTenant('Write Target Pharmacy');
    const { c } = await platformClient();
    c.csrf = 'anything'; // the tenant guard runs before anything cares about CSRF

    for (const [method, path, body] of [
      ['POST', '/medicines', { medicineName: 'X' }],
      ['POST', '/roles', { name: 'Sneaky', permissions: [] }],
      ['PATCH', '/settings/general', { dateFormat: 'dd MMM yyyy' }],
    ]) {
      const r = await c.request(method, path, { body });
      assert.equal(r.status, 403, `${method} ${path} must be refused (got ${r.status})`);
    }
  });

  it('sees nothing of any organization even when several exist', async () => {
    await h.makeTenant('Org One Pharmacy');
    await h.makeTenant('Org Two Pharmacy');
    const { c } = await platformClient();
    const r = await c.get('/medicines');
    assert.equal(r.status, 403, 'there is no "all organizations" view by accident');
    assert.equal(r.data, undefined, 'and no data came back');
  });
});

describe('the ordinary sign-in path is unchanged', () => {
  it('still refuses a SUPER_ADMIN with 403 NO_ORGANIZATION', async () => {
    const sa = await makePlatformAdmin({ email: `root-${Date.now()}@example.test` });
    const r = await h.client().login(sa.email);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NO_ORGANIZATION', 'the workspace login must keep refusing platform accounts');
  });

  it('still signs an ordinary administrator in exactly as before', async () => {
    const { org } = await h.makeTenant('Normal Login Pharmacy');
    const u = await h.makeUser(org, { role: 'BILLING_STAFF' });
    const c = h.client();
    const r = await c.login(u.email, PASSWORD);
    assert.equal(r.status, 200, 'an ordinary sign-in is untouched');
    assert.ok(r.data.csrfToken);
    assert.notEqual((await c.get('/medicines')).status, 403, 'and the session works on tenant routes');
  });
});

describe('POST /platform/auth/login', () => {
  const PW = 'Str0ng!Passw0rd';

  it('signs a platform administrator in and opens a session with no organization', async () => {
    const sa = await makePlatformAdmin({ email: `pa-${Date.now()}@example.test` });
    const c = h.client();
    const r = await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });

    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'SUPER_ADMIN');
    assert.equal(r.data.user.organizationId, undefined, 'the platform user carries no organization');
    assert.ok(r.data.csrfToken, 'and the usual CSRF token');

    const stored = await h.models.Session.findOne({ userId: sa._id }).lean();
    assert.equal(stored.isPlatform, true);
    assert.equal(stored.organizationId, undefined);
  });

  it('the session it hands out works on /platform and nowhere else', async () => {
    const sa = await makePlatformAdmin({ email: `pa2-${Date.now()}@example.test` });
    await h.makeTenant('Off Limits Pharmacy');
    const c = h.client();
    await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });

    const me = await c.get('/platform/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, sa.email);

    assert.equal((await c.get('/medicines')).status, 403, 'still no organization data');
    assert.equal((await c.get('/auth/me')).status, 403, 'and not the workspace /me either');
  });

  it('refuses an ordinary user with the same 401 a wrong password gives', async () => {
    const { user } = await h.makeTenant('Curious Pharmacy');
    const c = h.client();
    const r = await c.request('POST', '/platform/auth/login', { body: { email: user.email, password: PW }, csrf: false });
    assert.equal(r.status, 401, 'an ORG_ADMIN with the right password learns nothing here');
    assert.equal(r.body.message, 'Invalid email or password');
  });

  it('refuses a wrong password, and an unknown email, identically', async () => {
    const sa = await makePlatformAdmin({ email: `pa3-${Date.now()}@example.test` });
    const c = h.client();
    const wrong = await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: 'Wr0ng!Passw0rd' }, csrf: false });
    const unknown = await c.request('POST', '/platform/auth/login', { body: { email: `nobody-${Date.now()}@example.test`, password: PW }, csrf: false });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, unknown.body.message, 'the two must be indistinguishable');
  });

  it('refuses a deactivated platform account', async () => {
    const sa = await makePlatformAdmin({ email: `pa4-${Date.now()}@example.test`, isActive: false });
    const r = await h.client().request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACCOUNT_DISABLED');
  });

  it('an ordinary workspace session cannot be used on /platform, even for a platform account', async () => {
    // A platform account cannot get a workspace session at all, so this proves the session check from the other
    // side: an ORG_ADMIN's perfectly valid session is refused at the platform door.
    const { client } = await h.makeTenant('Normal Session Pharmacy');
    const r = await client.get('/platform/auth/me');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLATFORM_FORBIDDEN');
  });

  it('logging out ends the platform session', async () => {
    const sa = await makePlatformAdmin({ email: `pa5-${Date.now()}@example.test` });
    const c = h.client();
    const login = await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });
    c.csrf = login.data.csrfToken;
    assert.equal((await c.get('/platform/auth/me')).status, 200);

    assert.equal((await c.request('POST', '/platform/auth/logout', {})).status, 200);
    assert.equal((await c.get('/platform/auth/me')).status, 401, 'the session is gone');
  });

  it('platform routes require a session at all', async () => {
    assert.equal((await h.client().get('/platform/auth/me')).status, 401);
  });
});

describe('platform events are audited, but never inside an organization', () => {
  const PW = 'Str0ng!Passw0rd';

  it('a platform sign-in is recorded as a platform row with no organization', async () => {
    const sa = await makePlatformAdmin({ email: `pa-audit-${Date.now()}@example.test` });
    await h.client().request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });

    const row = await h.tenant.unscoped(() => h.models.AuditLog.findOne({ userId: sa._id, action: 'AUTH_LOGIN' }).lean());
    assert.ok(row, 'the sign-in of the account that can create pharmacies must leave a trace');
    assert.equal(row.isPlatform, true);
    assert.equal(row.organizationId, undefined);
  });

  it('that row never appears in any organization activity log', async () => {
    const sa = await makePlatformAdmin({ email: `pa-audit2-${Date.now()}@example.test` });
    await h.client().request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });

    const { client } = await h.makeTenant('Audit Reader Pharmacy');
    const log = await client.get('/activity?limit=100');
    assert.equal(log.status, 200);
    const items = log.data.items || log.data || [];
    assert.equal(items.filter((a) => a.userName === sa.name).length, 0, 'a pharmacy must not see platform events');
  });

  it('an organization sign-in is still audited into that organization, unchanged', async () => {
    const { org, user } = await h.makeTenant('Still Audited Pharmacy');
    const row = await h.tenant.runWithTenant(org._id, () => h.models.AuditLog.findOne({ userId: user._id, action: 'AUTH_LOGIN' }).lean());
    assert.ok(row, 'the ordinary path still writes its audit row');
    assert.equal(String(row.organizationId), String(org._id));
    assert.ok(!row.isPlatform);
  });

  it('an audit row with no organization and no platform flag is still refused', async () => {
    await assert.rejects(
      () => h.tenant.unscoped(() => h.models.AuditLog.create({ userName: 'x', action: 'TEST', message: 'x' })),
      { name: 'ValidationError' },
      'the flag has to be asked for; a missing organization alone is still a bug',
    );
  });
});

describe('a platform account that must change its password', () => {
  const PW = 'Str0ng!Passw0rd';
  const NEW = 'An0ther!Passw0rd';

  /** Signs in a platform admin who was created with the forced-change flag, as the script will create them. */
  async function pendingAdmin() {
    const sa = await makePlatformAdmin({ email: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`, mustChangePassword: true });
    const c = h.client();
    const login = await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });
    assert.equal(login.status, 200, 'they can still sign in — that is how they reach the password screen');
    assert.equal(login.data.user.mustChangePassword, true, 'and the client is told to send them there');
    c.csrf = login.data.csrfToken;
    return { sa, c };
  }

  it('can sign in, and reach the change-password route', async () => {
    const { c } = await pendingAdmin();
    const r = await c.request('POST', '/platform/auth/change-password', { body: { currentPassword: PW, newPassword: NEW } });
    assert.equal(r.status, 200);
  });

  it('can reach NOTHING else until the password is changed', async () => {
    const { c } = await pendingAdmin();
    for (const path of ['/platform/auth/me', '/platform/organizations']) {
      const r = await c.get(path);
      assert.equal(r.status, 403, `GET ${path} must be refused while a password change is pending (got ${r.status})`);
      assert.equal(r.body.code, 'PASSWORD_CHANGE_REQUIRED');
    }
    assert.equal((await c.post('/platform/organizations', { name: 'Nope', owner: { firstName: 'A', email: 'a@b.test' } })).status, 403, 'and they certainly cannot onboard a pharmacy');
    assert.equal((await c.get('/medicines')).status, 403, 'and certainly no organization data');
  });

  it('after changing it, the rest of the platform area opens up', async () => {
    const { sa, c } = await pendingAdmin();
    assert.equal((await c.get('/platform/auth/me')).status, 403, 'blocked to begin with');

    const changed = await c.request('POST', '/platform/auth/change-password', { body: { currentPassword: PW, newPassword: NEW } });
    assert.equal(changed.status, 200);

    // The change revokes other sessions, so sign in again with the new password, as a person would.
    const c2 = h.client();
    const again = await c2.request('POST', '/platform/auth/login', { body: { email: sa.email, password: NEW }, csrf: false });
    assert.equal(again.status, 200);
    assert.equal(again.data.user.mustChangePassword, false, 'the flag is cleared');
    assert.equal((await c2.get('/platform/auth/me')).status, 200, 'and the platform area is reachable');
    assert.equal((await c2.get('/medicines')).status, 403, 'organization data still is not');
  });

  it('the old password stops working', async () => {
    const { sa, c } = await pendingAdmin();
    await c.request('POST', '/platform/auth/change-password', { body: { currentPassword: PW, newPassword: NEW } });
    const old = await h.client().request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });
    assert.equal(old.status, 401);
  });

  it('the change is audited as a platform row, not into any organization', async () => {
    const { sa, c } = await pendingAdmin();
    await c.request('POST', '/platform/auth/change-password', { body: { currentPassword: PW, newPassword: NEW } });

    const row = await h.tenant.unscoped(() => h.models.AuditLog.findOne({ userId: sa._id, action: 'AUTH_PASSWORD_CHANGED' }).lean());
    assert.ok(row, 'a password change on the platform account is recorded');
    assert.equal(row.isPlatform, true);
    assert.equal(row.organizationId, undefined);
  });

  it('an ORG_ADMIN changing their password is still audited into their organization', async () => {
    const { org, user, client } = await h.makeTenant('Tenant Pwd Pharmacy');
    const r = await client.post('/auth/change-password', { currentPassword: PW, newPassword: NEW });
    assert.equal(r.status, 200, 'the workspace flow is untouched');
    const row = await h.tenant.runWithTenant(org._id, () => h.models.AuditLog.findOne({ userId: user._id, action: 'AUTH_PASSWORD_CHANGED' }).lean());
    assert.ok(row);
    assert.equal(String(row.organizationId), String(org._id));
    assert.ok(!row.isPlatform);
  });
});
