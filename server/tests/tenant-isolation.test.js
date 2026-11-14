// HTTP-level proof that Organization A and Organization B cannot see or change each other's data.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { addMedicine, startHarness } from './helpers/harness.js';

let h;
let A; // { org, user, client }
let B;
let aMed; // org A's medicine
let aInvoice; // org A's invoice
let bMed;

before(async () => {
  h = await startHarness();
  A = await h.makeTenant('Alpha Pharma');
  B = await h.makeTenant('Beta Distributors');

  aMed = await addMedicine(A.client, 'Alphacetamol 500', { stock: 20, batchNo: 'ALPHA-1', category: 'AlphaCategory', manufacturer: 'AlphaLabs' });
  const sale = await A.client.post('/invoices', { items: [{ medicineId: aMed._id, quantity: 2 }], customer: { name: 'Alpha Customer', phone: '9999999999' } });
  assert.equal(sale.status, 201, 'org A sale should succeed');
  aInvoice = sale.data;

  bMed = await addMedicine(B.client, 'Betamol 250', { stock: 15, batchNo: 'BETA-1', category: 'BetaCategory', manufacturer: 'BetaLabs' });
});

after(async () => {
  await h?.stop();
});

const names = (r) => r.data.items.map((i) => i.medicineName);

describe('Organization A cannot READ Organization B (and vice versa)', () => {
  it('each organization sees only its own medicines', async () => {
    assert.deepEqual(names(await A.client.get('/medicines')), ['Alphacetamol 500']);
    assert.deepEqual(names(await B.client.get('/medicines')), ['Betamol 250']);
  });

  it("search cannot surface the other organization's records", async () => {
    assert.equal((await B.client.get('/medicines?search=Alphacetamol')).data.total, 0);
    assert.equal((await B.client.get('/medicines?search=ALPHA-1')).data.total, 0, 'batch-number search must not leak');
    assert.equal((await A.client.get('/medicines?search=Betamol')).data.total, 0);
  });

  it("reading the other organization's medicine by id returns 404 (not 403, so existence isn't revealed)", async () => {
    assert.equal((await B.client.get(`/medicines/${aMed._id}`)).status, 404);
    assert.equal((await A.client.get(`/medicines/${bMed._id}`)).status, 404);
    assert.equal((await A.client.get(`/medicines/${aMed._id}`)).status, 200, 'the owner can still read it');
  });

  it("invoices are isolated (list, search and by id)", async () => {
    assert.equal((await B.client.get('/invoices')).data.total, 0);
    assert.equal((await B.client.get('/invoices?search=Alpha')).data.total, 0);
    assert.equal((await B.client.get('/invoices?search=9999999999')).data.total, 0);
    assert.equal((await B.client.get(`/invoices/${aInvoice._id}`)).status, 404);
    assert.equal((await A.client.get(`/invoices/${aInvoice._id}`)).status, 200);
  });

  it('filter facets, POS products, alerts and dashboard do not leak', async () => {
    const facets = (await B.client.get('/medicines/facets')).data;
    assert.deepEqual(facets.categories.map((c) => c.name), ['BetaCategory']);
    assert.deepEqual(facets.manufacturers, ['BetaLabs']);

    assert.deepEqual((await B.client.get('/pos/products')).data.map((p) => p.medicineName), ['Betamol 250']);

    const dash = (await B.client.get('/dashboard/overview')).data;
    assert.equal(dash.totalInvoices, 0);
    assert.equal(dash.totalRevenue, 0);
    assert.equal(dash.medicineCount, 1);
    assert.deepEqual((await B.client.get('/dashboard/stock-levels')).data.items.map((s) => s.name), ['Betamol 250']);

    const dashA = (await A.client.get('/dashboard/overview')).data;
    assert.equal(dashA.totalInvoices, 1);
    assert.equal(dashA.medicineCount, 1);
  });

  it("the activity log only contains the caller's own organization", async () => {
    const aLog = (await A.client.get('/activity?limit=100')).data.items;
    const bLog = (await B.client.get('/activity?limit=100')).data.items;
    assert.ok(aLog.length > 0 && bLog.length > 0);
    assert.ok(aLog.every((e) => String(e.organizationId) === String(A.org._id)));
    assert.ok(bLog.every((e) => String(e.organizationId) === String(B.org._id)));
    assert.ok(!bLog.some((e) => /Alphacetamol|INV-/.test(e.message)), 'B must not see A events');
  });

  it('GET /organization always returns the caller\'s own organization', async () => {
    assert.equal((await A.client.get('/organization')).data.id, String(A.org._id));
    assert.equal((await B.client.get('/organization')).data.id, String(B.org._id));
  });
});

describe('Organization A cannot MODIFY Organization B', () => {
  it("updating the other organization's medicine returns 404 and changes nothing", async () => {
    const r = await B.client.put(`/medicines/${aMed._id}`, { medicineName: 'HIJACKED' });
    assert.equal(r.status, 404);
    const after = (await A.client.get(`/medicines/${aMed._id}`)).data;
    assert.equal(after.medicineName, 'Alphacetamol 500');
    assert.equal(after.batches[0].mrp, 100);
  });

  it("adding a batch to the other organization's medicine is refused and stock is untouched", async () => {
    const r = await B.client.post(`/medicines/${aMed._id}/batches`, { batchNumber: 'EVIL', expiryDate: '2099-01-01', mrp: 1, sellingPrice: 1, initialQuantity: 999 });
    assert.equal(r.status, 404);
    const med = (await A.client.get(`/medicines/${aMed._id}`)).data;
    assert.equal(med.batches.length, 1);
    assert.equal(med.batches.reduce((s, b) => s + b.availableQuantity, 0), 18, '20 stocked minus 2 sold');
  });

  it("selling the other organization's stock is refused and stock is untouched", async () => {
    const r = await B.client.post('/invoices', { items: [{ medicineId: aMed._id, quantity: 1 }] });
    assert.equal(r.status, 404);
    assert.equal((await A.client.get(`/medicines/${aMed._id}`)).data.batches[0].availableQuantity, 18);
    assert.equal((await A.client.get('/invoices')).data.total, 1, 'no phantom invoice appeared for A');
    assert.equal((await B.client.get('/invoices')).data.total, 0);
  });

  it("editing the organization profile only ever changes the caller's own organization", async () => {
    const r = await B.client.put('/organization', {
      name: 'Beta Distributors Pvt Ltd',
      email: 'accounts@beta.example',
      // none of these are editable and must be ignored:
      _id: String(A.org._id),
      id: String(A.org._id),
      organizationId: String(A.org._id),
      slug: 'taken-over',
      status: 'suspended',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, String(B.org._id));
    assert.equal(r.data.name, 'Beta Distributors Pvt Ltd');
    assert.notEqual(r.data.slug, 'taken-over');
    assert.equal(r.data.status, 'active');

    const a = (await A.client.get('/organization')).data;
    assert.equal(a.name, 'Alpha Pharma');
    assert.equal(a.email, '');
  });
});

describe('Organization A cannot DELETE Organization B', () => {
  it("deleting the other organization's medicine returns 404 and the medicine survives with its stock", async () => {
    const r = await B.client.del(`/medicines/${aMed._id}`);
    assert.equal(r.status, 404);
    const med = await A.client.get(`/medicines/${aMed._id}`);
    assert.equal(med.status, 200);
    assert.equal(med.data.batches.length, 1);
  });

  it('a delete in one organization never removes the other organization\'s data', async () => {
    const tmp = (await B.client.post('/medicines', { medicineName: 'Temporary B item' })).data; // no batches, so it may be deleted
    assert.equal((await B.client.del(`/medicines/${tmp._id}`)).status, 200);
    assert.equal((await A.client.get('/medicines')).data.total, 1);
    assert.equal((await B.client.get('/medicines')).data.total, 1);
  });
});

describe('The client cannot choose a tenant', () => {
  it('organizationId in the request body is ignored', async () => {
    const r = await B.client.post('/medicines', { medicineName: 'Planted in B', organizationId: String(A.org._id) });
    assert.equal(r.status, 201);
    assert.equal(String(r.data.organizationId), String(B.org._id));
    assert.equal((await A.client.get('/medicines?search=Planted')).data.total, 0);
  });

  it('organizationId in the query string is ignored', async () => {
    const r = await B.client.get(`/medicines?organizationId=${A.org._id}&limit=100`);
    assert.equal(r.status, 200);
    assert.ok(!names(r).includes('Alphacetamol 500'));
  });

  it('organization headers are ignored', async () => {
    const r = await B.client.get('/medicines?limit=100', { headers: { 'x-organization-id': String(A.org._id), 'x-tenant-id': String(A.org._id), 'x-org': A.org.slug } });
    assert.ok(!names(r).includes('Alphacetamol 500'));
  });

  it('forged organization claims inside a (validly signed) token are ignored', async () => {
    // Even holding the signing secret, an organizationId claim has no effect: the tenant comes from the database.
    const sessionId = (await h.sessions.findSessionByRefreshToken(B.client.jar.get('usha_refresh')))._id;
    const forged = jwt.sign({ sub: String(B.user._id), sid: String(sessionId), organizationId: String(A.org._id), orgId: String(A.org._id) }, process.env.JWT_SECRET, { expiresIn: 60 });
    const res = await fetch(`${h.baseUrl}/medicines?limit=100`, { headers: { authorization: `Bearer ${forged}` } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(!body.data.items.some((m) => m.medicineName === 'Alphacetamol 500'));
  });

  it("a token combining B's user with A's session is rejected", async () => {
    const aSession = await h.sessions.findSessionByRefreshToken(A.client.jar.get('usha_refresh'));
    const mixed = jwt.sign({ sub: String(B.user._id), sid: String(aSession._id) }, process.env.JWT_SECRET, { expiresIn: 60 });
    const res = await fetch(`${h.baseUrl}/medicines`, { headers: { authorization: `Bearer ${mixed}` } });
    assert.equal(res.status, 401);
  });
});

describe('Tenants are independent', () => {
  it('two organizations can use the same medicine name, batch number and get their own invoice numbering', async () => {
    const t1 = await h.makeTenant('Twin One');
    const t2 = await h.makeTenant('Twin Two');
    const m1 = await addMedicine(t1.client, 'Twinol', { batchNo: 'SAME-BATCH' });
    const m2 = await addMedicine(t2.client, 'Twinol', { batchNo: 'SAME-BATCH' });
    assert.notEqual(m1._id, m2._id);
    const s1 = await t1.client.post('/invoices', { items: [{ medicineId: m1._id, quantity: 1 }] });
    const s2 = await t2.client.post('/invoices', { items: [{ medicineId: m2._id, quantity: 1 }] });
    assert.equal(s1.data.invoiceNo, 'INV-00001');
    assert.equal(s2.data.invoiceNo, 'INV-00001', 'invoice numbers are per organization');
  });

  it('concurrent requests from different organizations never see each other\'s data', async () => {
    const jobs = [];
    for (let i = 0; i < 40; i++) {
      const [client, own, other] = i % 2 ? [B.client, 'Betamol 250', 'Alphacetamol 500'] : [A.client, 'Alphacetamol 500', 'Betamol 250'];
      jobs.push(client.get('/medicines?limit=100').then((r) => ({ r, own, other })));
    }
    for (const { r, own, other } of await Promise.all(jobs)) {
      assert.equal(r.status, 200);
      assert.ok(names(r).includes(own));
      assert.ok(!names(r).includes(other), `leaked ${other}`);
    }
  });
});
