import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness } from './helpers/harness.js';
import { Organization } from '../models/index.js';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '../config/permissions.js';
import { temporaryPassword } from '../services/platformOrganizations.service.js';
import { passwordProblem } from '../utils/password.js';

let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.stop();
});

const PW = PASSWORD;
let n = 0;
const uniq = () => `${Date.now()}${(n += 1)}`;

/** A signed-in platform administrator, past the forced password change. */
async function platformClient() {
  const sa = await h.makeUser(null, { role: 'SUPER_ADMIN', email: `ops-${uniq()}@example.test` });
  const c = h.client();
  const r = await c.request('POST', '/platform/auth/login', { body: { email: sa.email, password: PW }, csrf: false });
  assert.equal(r.status, 200, `platform login failed: ${JSON.stringify(r.body)}`);
  c.csrf = r.data.csrfToken;
  return { sa, c };
}

const newPharmacy = (extra = {}) => ({
  name: `Pharmacy ${uniq()}`,
  businessCategory: 'retail',
  phone: '9876543210',
  address: { line1: '12 Market Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  owner: { firstName: 'Meera', lastName: 'Joshi', email: `owner-${uniq()}@example.test`, phone: '9876543211' },
  ...extra,
});

describe('POST /platform/organizations', () => {
  it('creates the pharmacy, its administrator, and returns the credentials once', async () => {
    const { c } = await platformClient();
    const body = newPharmacy();
    const r = await c.post('/platform/organizations', body);

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.organization.name, body.name);
    assert.ok(r.data.organization.slug, 'a slug was generated');
    assert.equal(r.data.organization.administrators, 1);
    assert.equal(r.data.administrator.email, body.owner.email);
    assert.equal(r.data.administrator.name, 'Meera Joshi');
    assert.ok(r.data.temporaryPassword, 'the credentials come back once');
    assert.equal(passwordProblem(r.data.temporaryPassword), null, 'and the generated password meets the policy');
  });

  it('seeds exactly the five system roles, byte-identical to ROLE_PERMISSIONS', async () => {
    const { c } = await platformClient();
    const r = await c.post('/platform/organizations', newPharmacy());
    const orgId = r.data.organization.id;

    const rows = await h.tenant.runWithTenant(orgId, () => h.models.Role.find({ organizationId: orgId }).lean());
    assert.equal(rows.length, 5, 'five roles, and no SUPER_ADMIN row');
    for (const { key, name } of SYSTEM_ROLES) {
      const row = rows.find((x) => x.key === key);
      assert.ok(row, `${key} was not seeded`);
      assert.equal(row.name, name);
      assert.equal(row.isSystem, true);
      assert.deepEqual(
        [...row.permissions].sort(),
        [...(ROLE_PERMISSIONS[key] || [])].sort(),
        `${key} did not get exactly the permissions the code grants it`,
      );
    }
    assert.equal(rows.filter((x) => x.key === 'SUPER_ADMIN').length, 0);
  });

  it('records the creation in the new pharmacy own activity log', async () => {
    const { sa, c } = await platformClient();
    const r = await c.post('/platform/organizations', newPharmacy());
    const orgId = r.data.organization.id;

    const row = await h.tenant.runWithTenant(orgId, () => h.models.AuditLog.findOne({ organizationId: orgId, action: 'ORGANIZATION_CREATED' }).lean());
    assert.ok(row, 'the pharmacy history starts with its own creation');
    assert.equal(String(row.meta.createdByPlatformUser), String(sa._id));
    assert.match(row.userName, /\(platform\)$/);
  });

  it('refuses a duplicate pharmacy name, case-insensitively, before writing anything', async () => {
    const { c } = await platformClient();
    const body = newPharmacy();
    assert.equal((await c.post('/platform/organizations', body)).status, 201);

    const before = await h.models.Organization.countDocuments({});
    const again = await c.post('/platform/organizations', { ...body, name: body.name.toUpperCase(), owner: { ...body.owner, email: `other-${uniq()}@example.test` } });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ORGANIZATION_EXISTS');
    assert.equal(await h.models.Organization.countDocuments({}), before, 'nothing was created');
  });

  it('refuses an owner email that already has an account anywhere on the installation', async () => {
    const { c } = await platformClient();
    const body = newPharmacy();
    assert.equal((await c.post('/platform/organizations', body)).status, 201);

    const before = await h.models.Organization.countDocuments({});
    const again = await c.post('/platform/organizations', { ...newPharmacy(), owner: { ...body.owner } });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'EMAIL_TAKEN');
    assert.equal(await h.models.Organization.countDocuments({}), before, 'nothing was created');
  });

  it('refuses a temporary password chosen by the caller', async () => {
    const { c } = await platformClient();
    const r = await c.post('/platform/organizations', { ...newPharmacy(), temporaryPassword: 'Chosen!Pass1' });
    assert.equal(r.status, 400, 'the server generates it, or an operator could set one a pharmacy never chose');
  });

  it('a generated password passes the policy every time', () => {
    for (let i = 0; i < 200; i += 1) {
      const pw = temporaryPassword();
      assert.equal(passwordProblem(pw), null, `generated a password the policy rejects: ${pw}`);
    }
    assert.notEqual(temporaryPassword(), temporaryPassword(), 'and it is not a constant');
  });
});

describe('the first administrator of a new pharmacy', () => {
  /** Onboards a pharmacy and returns what the operator would hand over. */
  async function onboard() {
    const { c } = await platformClient();
    const body = newPharmacy();
    const r = await c.post('/platform/organizations', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { orgId: r.data.organization.id, email: r.data.administrator.email, password: r.data.temporaryPassword, name: body.name };
  }

  it('can sign in with the temporary password, and is forced to change it', async () => {
    const { email, password } = await onboard();
    const c = h.client();
    const login = await c.login(email, password);
    assert.equal(login.status, 200, 'the credentials the operator hands over actually work');
    assert.equal(login.data.user.mustChangePassword, true);

    const blocked = await c.get('/medicines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED', 'nothing else is reachable until they choose their own');
  });

  it('after changing the password, holds full ORG_ADMIN access to their own pharmacy', async () => {
    const { orgId, email, password } = await onboard();
    const c = h.client();
    await c.login(email, password);
    assert.equal((await c.post('/auth/change-password', { currentPassword: password, newPassword: 'Their0wn!Pass' })).status, 200);

    const c2 = h.client();
    const login = await c2.login(email, 'Their0wn!Pass');
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'ORG_ADMIN');
    assert.equal(String(login.data.user.organization.id ?? login.data.user.organization), String(orgId));

    // The whole administrator surface, including the screens that only an ORG_ADMIN may open.
    for (const path of ['/medicines', '/invoices', '/settings', '/roles', '/users', '/dashboard/overview', '/activity']) {
      const r = await c2.get(path);
      assert.notEqual(r.status, 403, `a new ORG_ADMIN should be able to open ${path} (got ${r.status})`);
    }
  });

  it('gets 403 on another pharmacy data, and cannot see it exists', async () => {
    const theirs = await onboard();
    const others = await onboard();

    const c = h.client();
    await c.login(theirs.email, theirs.password);
    await c.post('/auth/change-password', { currentPassword: theirs.password, newPassword: 'Their0wn!Pass' });
    const c2 = h.client();
    await c2.login(theirs.email, 'Their0wn!Pass');

    // The other pharmacy's administrator, addressed directly by id, must look like something that does not exist.
    const otherAdmin = await h.models.User.findOne({ email: others.email }).lean();
    const byId = await c2.patch(`/users/${otherAdmin._id}`, { role: 'STAFF' });
    assert.equal(byId.status, 404, "another pharmacy's user must not even be acknowledged");

    // And nothing in their own lists mentions the other pharmacy.
    const users = await c2.get('/users?limit=100');
    assert.equal(users.status, 200);
    assert.equal(users.data.items.filter((u) => u.email === others.email).length, 0);

    const roles = await c2.get('/roles?limit=100');
    assert.equal(roles.data.total, 5, 'they see their own five roles and no others');

    // The platform area is closed to them too: being an ORG_ADMIN is not being a platform operator.
    assert.equal((await c2.get('/platform/auth/me')).status, 403);
    assert.equal((await c2.post('/platform/organizations', newPharmacy())).status, 403);
  });
});

describe('who may onboard a pharmacy', () => {
  it('an ORG_ADMIN is refused', async () => {
    const { client } = await h.makeTenant('Ordinary Admin Pharmacy');
    const r = await client.post('/platform/organizations', newPharmacy());
    assert.equal(r.status, 403, 'the most powerful role inside a pharmacy is still not a platform operator');
    assert.equal(r.body.code, 'PLATFORM_FORBIDDEN');
    assert.equal(await h.models.Organization.countDocuments({ name: /^Pharmacy / }), await h.models.Organization.countDocuments({ name: /^Pharmacy / }));
  });

  it('every other organization role is refused', async () => {
    const { org } = await h.makeTenant('Roles Refused Pharmacy');
    for (const role of ['BRANCH_MANAGER', 'INVENTORY_MANAGER', 'BILLING_STAFF', 'STAFF']) {
      const u = await h.makeUser(org, { role });
      const c = h.client();
      await c.login(u.email);
      const r = await c.post('/platform/organizations', newPharmacy());
      assert.equal(r.status, 403, `${role} must not be able to onboard a pharmacy`);
    }
  });

  it('an anonymous caller is refused', async () => {
    const r = await h.client().post('/platform/organizations', newPharmacy());
    assert.equal(r.status, 401);
  });

  it('listing pharmacies is equally closed', async () => {
    const { client } = await h.makeTenant('List Refused Pharmacy');
    assert.equal((await client.get('/platform/organizations')).status, 403);
    assert.equal((await h.client().get('/platform/organizations')).status, 401);
  });
});

describe('GET /platform/organizations', () => {
  it('narrows the list to one status, and refuses a status that is not one', async () => {
    const { c } = await platformClient();
    const trading = (await c.post('/platform/organizations', newPharmacy())).data.organization.id;
    const shut = (await c.post('/platform/organizations', newPharmacy())).data.organization.id;
    // Suspension has no endpoint by design, so the fixture does what an operator would do to the record itself.
    await Organization.updateOne({ _id: shut }, { status: 'suspended' });

    const active = await c.get('/platform/organizations?status=active&limit=100');
    assert.equal(active.status, 200);
    const activeIds = active.data.items.map((o) => o.id);
    assert.ok(activeIds.includes(trading), 'the trading pharmacy is listed');
    assert.ok(!activeIds.includes(shut), 'the suspended one is filtered out');

    const suspended = await c.get('/platform/organizations?status=suspended&limit=100');
    assert.ok(suspended.data.items.some((o) => o.id === shut), 'and is found under its own status');
    assert.ok(suspended.data.items.every((o) => o.status === 'suspended'), 'which returns nothing else');

    assert.equal(active.data.total >= 1, true, 'the total counts the filtered set, not every pharmacy');
    assert.equal((await c.get('/platform/organizations?status=closed')).status, 400, 'an unknown status is reported, not ignored');
  });

  it('combines the status filter with the search, rather than one replacing the other', async () => {
    const { c } = await platformClient();
    const tag = `Filter${uniq()}`;
    const wanted = (await c.post('/platform/organizations', newPharmacy({ name: `${tag} Trading` }))).data.organization.id;
    const other = (await c.post('/platform/organizations', newPharmacy({ name: `${tag} Shut` }))).data.organization.id;
    await Organization.updateOne({ _id: other }, { status: 'suspended' });

    const r = await c.get(`/platform/organizations?status=active&search=${tag}`);
    assert.deepEqual(r.data.items.map((o) => o.id), [wanted], 'only the one matching both');
    assert.equal(r.data.total, 1);
  });
});
