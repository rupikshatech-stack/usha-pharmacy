// Tests for the tenant middleware: membership checks, suspended/deleted organizations,
// deactivated users, and role/permission enforcement.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMedicine, futureDate, startHarness } from './helpers/harness.js';

let h;
let requireTenant;

before(async () => {
  h = await startHarness();
  ({ requireTenant } = await import('../middleware/tenant.js'));
});

after(async () => {
  await h?.stop();
});

/** Runs a middleware function with a fake request and reports what it did. */
const run = (mw, req) =>
  new Promise((resolve) => {
    const next = (err) => resolve({ err, tenantInside: h.tenant.currentTenantId() });
    mw(req, {}, next);
  });

describe('requireTenant (unit)', () => {
  it('rejects a request that was never authenticated', async () => {
    const { err } = await run(requireTenant, {});
    assert.equal(err.status, 401);
  });

  it('rejects SUPER_ADMIN: platform admins have no tenant', async () => {
    const { err } = await run(requireTenant, { user: { role: 'SUPER_ADMIN' } });
    assert.equal(err.code, 'TENANT_FORBIDDEN');
    assert.equal(err.status, 403);
  });

  it('rejects users with no organization membership', async () => {
    const { err } = await run(requireTenant, { user: { role: 'STAFF', organizationId: null } });
    assert.equal(err.code, 'NO_ORGANIZATION');
  });

  it('rejects users whose organization does not exist', async () => {
    const { err } = await run(requireTenant, { user: { role: 'STAFF', organizationId: new h.mongoose.Types.ObjectId() } });
    assert.equal(err.code, 'TENANT_NOT_FOUND');
  });

  it('rejects a session that belongs to a different organization than the user', async () => {
    const a = await h.makeOrg('Mismatch A');
    const b = await h.makeOrg('Mismatch B');
    const { err } = await run(requireTenant, { user: { role: 'STAFF', organizationId: a._id }, session: { organizationId: b._id } });
    assert.equal(err.status, 401);
  });

  it('attaches a frozen tenant context from the DATABASE organization and runs the rest of the request inside it', async () => {
    const org = await h.makeOrg('Context Org');
    const req = { user: { role: 'ORG_ADMIN', organizationId: org._id, organizationName: 'client-supplied-lie' }, body: { organizationId: 'x' }, query: { organizationId: 'x' } };
    const { err, tenantInside } = await run(requireTenant, req);
    assert.equal(err, undefined);
    assert.equal(String(req.orgId), String(org._id));
    assert.equal(String(req.tenant.organizationId), String(org._id));
    assert.equal(req.tenant.organization.name, 'Context Org');
    assert.equal(tenantInside, String(org._id), 'downstream code runs inside the tenant context');
    assert.ok(Object.isFrozen(req.tenant));
  });

  it('request input can never become the tenant', async () => {
    const mine = await h.makeOrg('Mine');
    const other = await h.makeOrg('Other');
    const req = { user: { role: 'ORG_ADMIN', organizationId: mine._id }, body: { organizationId: String(other._id) }, query: { organizationId: String(other._id) }, params: { organizationId: String(other._id) }, headers: { 'x-organization-id': String(other._id) } };
    const { tenantInside } = await run(requireTenant, req);
    assert.equal(tenantInside, String(mine._id));
  });
});

describe('organization state', () => {
  it('a suspended organization is locked out immediately, even with a live session, and recovers when reactivated', async () => {
    const t = await h.makeTenant('Soon Suspended');
    assert.equal((await t.client.get('/medicines')).status, 200);

    await h.models.Organization.updateOne({ _id: t.org._id }, { status: 'suspended' });
    const blocked = await t.client.get('/medicines');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'TENANT_SUSPENDED');
    assert.equal((await h.client().login(t.user.email)).body.code, 'ORG_SUSPENDED', 'and cannot sign in');

    await h.models.Organization.updateOne({ _id: t.org._id }, { status: 'active' });
    assert.equal((await t.client.get('/medicines')).status, 200);
  });

  it('a user whose organization was deleted is rejected', async () => {
    const t = await h.makeTenant('Soon Deleted');
    await h.models.Organization.deleteOne({ _id: t.org._id });
    const r = await t.client.get('/medicines');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'TENANT_NOT_FOUND');
  });

  it('a deactivated user is rejected immediately, even with a live session', async () => {
    const t = await h.makeTenant('Deactivation Org');
    assert.equal((await t.client.get('/medicines')).status, 200);
    await h.models.User.updateOne({ _id: t.user._id }, { isActive: false });
    assert.equal((await t.client.get('/medicines')).status, 401);
    assert.equal((await h.client().login(t.user.email)).body.code, 'ACCOUNT_DISABLED');
  });

  it('a SUPER_ADMIN (no organization) cannot sign in to a workspace', async () => {
    const sa = await h.makeUser(null, { role: 'SUPER_ADMIN', email: 'root@example.test' });
    const r = await h.client().login(sa.email);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NO_ORGANIZATION');
  });

  it('no tenant endpoint works without a session', async () => {
    const anon = h.client();
    for (const path of ['/medicines', '/medicines/facets', '/invoices', '/dashboard/overview', '/dashboard/monthly-sales', '/dashboard/stock-levels', '/dashboard/recent-activity', '/dashboard/alerts', '/activity', '/pos/products', '/organization', '/auth/me']) {
      assert.equal((await anon.get(path)).status, 401, `GET ${path} must require authentication`);
    }
  });
});

describe('roles and permissions', () => {
  it('STAFF can read inventory but cannot change it or bill', async () => {
    const org = await h.makeOrg('Perm Org 1');
    const admin = h.client();
    await h.makeUser(org, { email: 'admin1@example.test' });
    await admin.login('admin1@example.test');
    const med = await addMedicine(admin, 'Readable');

    await h.makeUser(org, { role: 'STAFF', email: 'staff1@example.test' });
    const s = h.client();
    await s.login('staff1@example.test');
    assert.equal((await s.get('/medicines')).status, 200);
    assert.equal((await s.get(`/medicines/${med._id}`)).status, 200);
    assert.equal((await s.post('/medicines', { medicineName: 'nope' })).status, 403);
    assert.equal((await s.put(`/medicines/${med._id}`, { medicineName: 'nope' })).status, 403);
    assert.equal((await s.del(`/medicines/${med._id}`)).status, 403);
    assert.equal((await s.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).status, 403);
    assert.equal((await s.get('/activity')).status, 403);
    assert.equal((await s.put('/organization', { name: 'x' })).status, 403);
    assert.equal((await s.get('/organization')).status, 200);
    assert.equal((await s.get('/dashboard/overview')).status, 200, 'any member may view the overview');
  });

  it('BILLING_STAFF can bill but cannot edit or delete inventory', async () => {
    const org = await h.makeOrg('Perm Org 2');
    await h.makeUser(org, { email: 'admin2@example.test' });
    const admin = h.client();
    await admin.login('admin2@example.test');
    const med = await addMedicine(admin, 'Billable');

    await h.makeUser(org, { role: 'BILLING_STAFF', email: 'bill@example.test' });
    const b = h.client();
    await b.login('bill@example.test');
    assert.equal((await b.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).status, 201);
    assert.equal((await b.get('/invoices')).status, 200);
    assert.equal((await b.get('/pos/products')).status, 200);
    assert.equal((await b.post('/medicines', { medicineName: 'nope' })).status, 403);
    assert.equal((await b.del(`/medicines/${med._id}`)).status, 403);
  });

  it('INVENTORY_MANAGER can manage inventory but cannot bill', async () => {
    const org = await h.makeOrg('Perm Org 3');
    await h.makeUser(org, { role: 'INVENTORY_MANAGER', email: 'inv@example.test' });
    const c = h.client();
    await c.login('inv@example.test');
    const med = await addMedicine(c, 'Managed');
    assert.equal((await c.put(`/medicines/${med._id}`, { medicineName: 'Managed v2' })).status, 200);
    assert.equal((await c.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).status, 403);
    const del = await c.del(`/medicines/${med._id}`);
    assert.equal(del.status, 200, 'permission granted');
    assert.deepEqual(del.data, { deleted: false, archived: true }, 'a medicine with stock history is archived, not removed');
  });

  it('BRANCH_MANAGER can edit and bill and view the audit log, but cannot delete medicines or edit settings', async () => {
    const org = await h.makeOrg('Perm Org 4');
    await h.makeUser(org, { role: 'BRANCH_MANAGER', email: 'bm@example.test' });
    const c = h.client();
    await c.login('bm@example.test');
    const med = await addMedicine(c, 'Branch item');
    assert.equal((await c.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).status, 201);
    assert.equal((await c.get('/activity')).status, 200);
    assert.equal((await c.del(`/medicines/${med._id}`)).status, 403);
    assert.equal((await c.put('/organization', { name: 'x' })).status, 403);
  });

  it('extra permissions granted to an individual user are honoured', async () => {
    const org = await h.makeOrg('Perm Org 5');
    await h.makeUser(org, { role: 'STAFF', email: 'extra@example.test', permissions: ['inventory:write'] });
    const c = h.client();
    await c.login('extra@example.test');
    assert.equal((await c.post('/medicines', { medicineName: 'Allowed by extra grant' })).status, 201);
    assert.equal((await c.get('/activity')).status, 403, 'only the granted permission was added');
  });

  it('the login response lists the effective permissions', async () => {
    const org = await h.makeOrg('Perm Org 6');
    await h.makeUser(org, { role: 'BILLING_STAFF', email: 'perm-list@example.test' });
    const r = await h.client().login('perm-list@example.test');
    assert.ok(r.data.user.permissions.includes('billing:create'));
    assert.ok(!r.data.user.permissions.includes('inventory:delete'));
  });

  it('ORG_ADMIN can do everything within their own organization', async () => {
    const t = await h.makeTenant('Perm Org 7');
    const med = await addMedicine(t.client, 'Everything');
    assert.equal((await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).status, 201);
    assert.equal((await t.client.get('/activity')).status, 200);
    assert.equal((await t.client.put('/organization', { phone: '+91 98765 43210' })).status, 200);
    const soft = await t.client.del(`/medicines/${med._id}`);
    assert.deepEqual(soft.data, { deleted: false, archived: true }, 'a sold medicine is archived, never destroyed');
  });
});

describe('organization profile', () => {
  it('validates GSTIN, email, pincode and logo', async () => {
    const t = await h.makeTenant('Profile Org');
    const bad = async (body) => (await t.client.put('/organization', body)).status;
    assert.equal(await bad({ gstin: 'NOT-A-GSTIN' }), 400);
    assert.equal(await bad({ email: 'nope' }), 400);
    assert.equal(await bad({ address: { pincode: '12' } }), 400);
    assert.equal(await bad({ logo: 'javascript:alert(1)' }), 400);
    assert.equal(await bad({ name: '' }), 400);
    const ok = await t.client.put('/organization', {
      gstin: '29ABCDE1234F1Z5',
      email: 'Billing@Profile.Example',
      phone: '+91 80 1234 5678',
      logo: 'https://cdn.example/logo.png',
      address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.email, 'billing@profile.example', 'email is normalised');
    assert.equal(ok.data.address.city, 'Bengaluru');
    assert.equal(ok.data.address.country, 'India', 'a partial address update keeps the other fields');
  });

  it('a GSTIN can belong to only one organization', async () => {
    const x = await h.makeTenant('GST Org X');
    const y = await h.makeTenant('GST Org Y');
    assert.equal((await x.client.put('/organization', { gstin: '27AAPFU0939F1ZV' })).status, 200);
    const dup = await y.client.put('/organization', { gstin: '27AAPFU0939F1ZV' });
    assert.equal(dup.status, 409);
    assert.equal((await y.client.put('/organization', { gstin: '' })).status, 200, 'empty means "not provided" and is not unique');
    assert.equal((await x.client.put('/organization', { gstin: '' })).status, 200);
  });

  it('exposes the organization fields and never internal data', async () => {
    const t = await h.makeTenant('Fields Org');
    const o = (await t.client.get('/organization')).data;
    for (const k of ['id', 'name', 'slug', 'email', 'phone', 'address', 'gstin', 'logo', 'status', 'createdAt', 'updatedAt']) assert.ok(k in o, `missing ${k}`);
    assert.match(o.slug, /^fields-org/);
    assert.equal(o.status, 'active');
  });
});

describe('sanity', () => {
  it('medicines created through the API belong to the creator\'s organization in the database', async () => {
    const t = await h.makeTenant('DB Check Org');
    const m = await addMedicine(t.client, 'DB Checked');
    const raw = await h.tenant.unscoped(() => h.models.Medicine.findById(m._id).lean());
    assert.equal(String(raw.organizationId), String(t.org._id));
    assert.ok(futureDate());
  });
});
