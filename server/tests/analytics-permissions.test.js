// Permissions and isolation across the WHOLE analytics surface, in one place.
//
// Each report has its own tests for what it says; this file asks the two questions that have to hold for every one of
// them at once, and that are easy to break by adding a route and forgetting the guard:
//
//   1. Can somebody without `reports:read` reach it? (They must not — on the server, not by hiding a menu item.)
//   2. Does it answer for the signed-in organization only?
//
// The list of endpoints is read FROM THE ROUTER, so a new analytics route added later is covered the moment it
// exists: this test fails until it is either guarded or deliberately listed below.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import analyticsRouter from '../routes/analytics.routes.js';
import { parseCsv } from '../utils/csv.js';
import { startHarness } from './helpers/harness.js';

let h;
let admin;
let outsider;
let reader;

/** Paths whose parameters make them impossible to call blind; they are covered by their own module's tests. */
const PARAMETERISED = /:/;

/** Every GET the analytics router exposes, with a value for each path parameter. */
function analyticsGets() {
  return analyticsRouter.stack
    .filter((layer) => layer.route?.path && layer.route.methods?.get)
    .map((layer) => layer.route.path)
    .filter((p) => !PARAMETERISED.test(p));
}

before(async () => {
  h = await startHarness();
  admin = await h.makeTenant('Permissions Org');
  outsider = await h.makeTenant('Permissions Other Org');

  // Somebody who may use the system but may not read reports. STAFF has inventory:read and settings:read only.
  const user = await h.makeUser(admin.org, { role: 'STAFF' });
  const client = h.client();
  const signedIn = await client.login(user.email);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  reader = { user, client };
});
after(async () => {
  await h?.stop();
});

describe('Every analytics endpoint', () => {
  it('is actually a list of endpoints, so this test cannot pass by finding none', () => {
    const paths = analyticsGets();
    assert.ok(paths.length >= 15, `expected the analytics router to expose many GETs, found ${paths.length}`);
    // The reports this module is built from, so a rename cannot silently drop one out of this sweep.
    for (const expected of ['/overview', '/insights', '/transactions', '/sales', '/purchases', '/profitability', '/inventory', '/gst', '/customers', '/suppliers', '/branches']) {
      assert.ok(paths.includes(expected), `${expected} is missing from the analytics router`);
    }
  });

  it('refuses somebody without reports:read, on the server', async () => {
    for (const path of analyticsGets()) {
      const r = await reader.client.get(`/analytics${path}`);
      assert.equal(r.status, 403, `${path} let a user without reports:read through (${r.status})`);
    }
  });

  it('refuses somebody who is not signed in at all', async () => {
    const anonymous = h.client();
    for (const path of analyticsGets()) {
      const r = await anonymous.get(`/analytics${path}`);
      assert.equal(r.status, 401, `${path} answered an unauthenticated request (${r.status})`);
    }
  });

  it('answers for the signed-in organization, and refuses another organization\'s store', async () => {
    const theirStore = (await outsider.client.get('/branches')).data[0];
    for (const path of analyticsGets()) {
      const mine = await admin.client.get(`/analytics${path}`);
      assert.equal(mine.status, 200, `${path} failed for its own organization: ${JSON.stringify(mine.body)}`);

      if (theirStore) {
        const theirs = await admin.client.get(`/analytics${path}?branchId=${theirStore._id}`);
        // A store of another organization is not a store this person may report on. Either it is refused outright or
        // it is scoped to nothing — what must never happen is another organization's figures coming back.
        assert.ok([200, 403].includes(theirs.status), `${path} returned ${theirs.status} for another organization's store`);
        if (theirs.status === 200) {
          const body = JSON.stringify(theirs.data);
          assert.ok(!body.includes('Permissions Other Org'), `${path} leaked the other organization into the answer`);
        }
      }
    }
  });
});

describe('Customer contact details', () => {
  it('are withheld from somebody who may read reports but not the invoices they come from', async () => {
    const user = await h.makeUser(admin.org, { role: 'STAFF', permissions: ['reports:read'] });
    const client = h.client();
    assert.equal((await client.login(user.email)).status, 200);

    const r = await client.get('/analytics/customers');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.permissions.contacts, false);
    assert.equal(r.data.items.every((i) => i.phone === null && i.gstin === null), true);
    assert.match(r.data.notes.contacts, /do not have permission/);

    const file = await client.get('/analytics/customers/export');
    assert.equal(file.status, 200, JSON.stringify(file.body));
    // The heading explains what a customer is ("Phone number recorded on the invoice"), so the check that matters is
    // that the COLUMN does not exist — there is no cell for a phone number to be written into.
    const header = parseCsv(file.data.csv).find((row) => row[0] === 'Customer' && row.length > 3);
    assert.ok(header, 'the file has a column header row');
    assert.equal(header.includes('Phone'), false, 'there is no phone column at all for this person');
    assert.equal(header.includes('GSTIN'), false);
    assert.equal(parseCsv(file.data.csv).find((r) => r[0] === 'Contact details')[1], 'Withheld — you do not have permission to see them');
  });

  it('are included for somebody who can already open those invoices', async () => {
    const r = await admin.client.get('/analytics/customers');
    assert.equal(r.data.permissions.contacts, true);
    assert.equal(r.data.notes.contacts, null);
    const file = await admin.client.get('/analytics/customers/export');
    const header = parseCsv(file.data.csv).find((row) => row[0] === 'Customer' && row.length > 3);
    assert.equal(header.includes('Phone'), true);
    assert.equal(header.includes('GSTIN'), true);
  });
});
