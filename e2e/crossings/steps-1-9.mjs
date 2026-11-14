/**
 * ============================================================================================================
 *  REQUIRES A FRESH STACK. Do not run this against the development database, and do not run it twice against
 *  the same stack.
 *
 *  Several steps assert on figures that only hold on a clean database: invoice numbers follow on from the seed
 *  (step 4), the financial-year lock depends on which organizations have invoices yet (step 5), stock arithmetic
 *  is checked against exact before/after quantities (step 13), and the Activity Log is read in full (step 17).
 *  Run it a second time against the same stack and several of those will legitimately disagree - that is the
 *  checks being specific, not a defect.
 *
 *  Use `npm run crossings` in e2e/, which starts a throwaway stack, runs this against it, and stops it again.
 *  That stack keeps its data in a temporary directory deleted on exit, so freshness is guaranteed by
 *  construction rather than by anybody remembering.
 * ============================================================================================================
 */

import assert from 'node:assert/strict';
import { Client, PASSWORD, futureDate, money, must } from './lib.mjs';

/** Steps 1-9: the crossings this session's modules created. */
export default async function run(S) {

  const uniq = () => Math.random().toString(36).slice(2, 7);
  const state = {};


  /* ------------------------------------------------------------------ 1. platform onboarding + isolation */
  await S.step(1, 'Platform onboarding: a new pharmacy, its 5 roles, and cross-tenant isolation', async () => {
    const notes = [];
    const platform = new Client('platform');
    must(await platform.request('POST', '/platform/auth/login', { email: 'platform@e2e.test', password: PASSWORD }), 200, 'platform sign-in');
    platform.csrf = platform.last.body.data.csrfToken;

    const name = `Crossing Pharmacy ${uniq()}`;
    const owner = `owner-${uniq()}@example.test`;
    const created = must(
      await platform.post('/platform/organizations', {
        name,
        businessCategory: 'retail',
        address: { city: 'Pune', state: 'Maharashtra' },
        owner: { firstName: 'Asha', lastName: 'Rao', email: owner },
      }),
      201,
      'onboard a pharmacy',
    );
    state.orgB = { id: created.organization.id, name, email: owner, tempPassword: created.temporaryPassword };
    notes.push(`created "${name}" with admin ${owner}`);

    // The owner signs in with the temporary credentials and is forced to change them.
    const b = new Client('orgB');
    const login = must(await b.login(owner, created.temporaryPassword), 200, 'new admin signs in');
    assert.equal(login.user.mustChangePassword, true, 'the first sign-in must force a password change');
    must(await b.post('/auth/change-password', { currentPassword: created.temporaryPassword, newPassword: PASSWORD }), 200, 'change password');

    const b2 = new Client('orgB');
    must(await b2.login(owner, PASSWORD), 200, 'sign in with the chosen password');
    state.b = b2;

    const roles = must(await b2.get('/roles?limit=50'), 200, 'the new pharmacy roles');
    assert.equal(roles.total, 5, `expected exactly 5 seeded roles, got ${roles.total}`);
    assert.deepEqual(
      roles.items.map((r) => r.key).sort(),
      ['BILLING_STAFF', 'BRANCH_MANAGER', 'INVENTORY_MANAGER', 'ORG_ADMIN', 'STAFF'],
      'the five built-in roles',
    );
    assert.ok(roles.items.every((r) => r.isSystem), 'all five are system roles');
    notes.push(`5 system roles seeded: ${roles.items.map((r) => r.key).join(', ')}`);

    // Org A: the stack's own pharmacy, full of demo data.
    const a = new Client('orgA');
    must(await a.login('admin@e2e.test'), 200, 'org A sign-in');
    state.a = a;
    state.orgA = { name: (await a.get('/auth/me')).data.user.organization?.name || 'E2E Pharmacy' };

    // Isolation: the brand-new pharmacy sees none of org A's data.
    const bMeds = must(await b2.get('/medicines?limit=100'), 200, 'org B medicines');
    const aMeds = must(await a.get('/medicines?limit=100'), 200, 'org A medicines');
    assert.equal(bMeds.total, 0, `a new pharmacy must start empty, saw ${bMeds.total} medicines`);
    assert.ok(aMeds.total > 0, 'org A has demo stock');
    assert.equal(must(await b2.get('/invoices?limit=5'), 200, 'org B invoices').total, 0, 'and no invoices');
    notes.push(`isolation: org B sees 0 medicines / 0 invoices while org A has ${aMeds.total} medicines`);
    return notes;
  });

  /* ------------------------------------------------------------------ 2. roles -> settings access */
  await S.step(2, 'Roles → Settings: settings:read without settings:manage is refused on save', async () => {
    const notes = [];
    const a = state.a;
    // STAFF has settings:read but not settings:manage (config/permissions.js).
    const email = `staff-${uniq()}@example.test`;
    must(await a.post('/users', { name: 'Read Only Staff', email, password: PASSWORD, role: 'STAFF', branchIds: [] }), 201, 'create a STAFF user');

    const staff = new Client('staff');
    must(await staff.login(email, PASSWORD), 200, 'staff signs in');
    must(await staff.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'St4ff!Passw0rd' }), 200, 'staff changes password');
    const s2 = new Client('staff');
    must(await s2.login(email, 'St4ff!Passw0rd'), 200, 'staff signs in again');

    const read = must(await s2.get('/settings'), 200, 'STAFF can READ settings');
    assert.equal(read.permissions?.manage, false, 'and is told they may not manage them');
    notes.push('STAFF: GET /settings 200, permissions.manage=false');

    const save = await s2.patch('/settings/general', { version: read.version, dateFormat: 'yyyy-MM-dd' });
    assert.equal(save.status, 403, `a STAFF save must be refused by the server, got ${save.status}`);
    notes.push(`STAFF: PATCH /settings/general ${save.status} ${save.body?.code || ''}`);

    // And the same user cannot reach the administration screens at all.
    assert.equal((await s2.get('/roles')).status, 403, 'STAFF must not read roles');
    assert.equal((await s2.get('/users')).status, 403, 'STAFF must not read users');
    notes.push('STAFF: /roles and /users both 403');
    state.staffEmail = email;
    return notes;
  });

  /* ------------------------------------------------------------------ 3. posRoundOff -> cart == invoice */
  await S.step(3, 'Settings (posRoundOff) → Selling Point total equals the saved invoice total', async () => {
    const notes = [];
    const a = state.a;
    const settings = must(await a.get('/settings'), 200, 'read settings');

    // Turn rounding on at ₹1, the way the Settings screen does.
    must(await a.patch('/settings/general', { version: settings.version, posRoundOff: true }), 200, 'enable posRoundOff');
    const after = must(await a.get('/settings'), 200, 're-read settings');
    must(await a.patch('/settings/invoice', { version: after.version, calculation: { roundOffNearest: 1 } }), 200, 'round to the nearest rupee');

    // A product whose line total has paise in it.
    const products = must(await a.get('/pos/products?q='), 200, 'POS products');
    const list = products.items || products;
    const pick = list.find((p) => p.nextBatch && p.availableStock > 2 && Number(p.nextBatch.sellingPrice) % 1 !== 0) || list.find((p) => p.nextBatch && p.availableStock > 2);
    assert.ok(pick, 'a sellable product is needed for this check');

    const price = Number(pick.nextBatch.sellingPrice);
    const qty = 3;
    // A discount that leaves paise on the total, so the round-off is actually exercised rather than being a no-op.
    const discountPercent = 3;
    const items = [{ medicineId: pick._id || pick.id, quantity: qty, discountPercent }];

    // What the cart would show, from the SAME shared arithmetic the client uses.
    const { cartBill } = await import(new URL('../../client/src/utils/cartBill.js', import.meta.url).href);
    const cart = cartBill({
      cart: [{ medicineId: pick._id || pick.id, name: pick.medicineName, price, quantity: qty, discountPercent, gstPercent: pick.gstPercentage ?? pick.nextBatch.gstPercent ?? 0 }],
      discount: { type: 'percent', value: 0 },
      customerGstin: '',
      orgState: '',
      paymentType: 'Cash',
      roundOff: 1,
    });

    const saved = must(
      await a.post('/invoices', { items, customer: { name: 'Round Off Check' }, paymentType: 'Cash', discount: { type: 'percent', value: 0 }, idempotencyKey: `x-round-${uniq()}` }),
      201,
      'complete the sale',
    );
    const invoice = saved.invoice || saved;

    assert.equal(money(invoice.total), money(cart.total), `cart said ${cart.total}, the saved invoice says ${invoice.total}`);
    assert.equal(money(invoice.roundOff ?? 0), money(cart.roundOff ?? 0), `round-off differs: cart ${cart.roundOff}, invoice ${invoice.roundOff}`);
    assert.notEqual(money(cart.roundOff ?? 0), 0, `this check is worthless unless rounding actually moved the total (cart round-off was ${cart.roundOff})`);
    notes.push(`${qty} x ₹${price} less ${discountPercent}% → cart ₹${cart.total} (round-off ${cart.roundOff}) == invoice ₹${invoice.total} (${invoice.invoiceNo})`);
    state.roundOffInvoice = invoice;

    // Put it back, so later steps are not affected by rounding.
    const s3 = must(await a.get('/settings'), 200, 're-read settings');
    must(await a.patch('/settings/general', { version: s3.version, posRoundOff: false }), 200, 'disable posRoundOff again');
    notes.push('posRoundOff restored to off');
    return notes;
  });

  /* ------------------------------------------------------------------ 4. invoice prefix -> preview == real */
  await S.step(4, 'Settings (invoice numbering) → preview equals the next real invoice; counter only moves on a sale', async () => {
    const notes = [];
    const a = state.a;

    const preview1 = must(await a.get('/settings/invoice/preview-number?series=sales'), 200, 'preview the next number');
    notes.push(`preview before: ${preview1.next}`);

    // Reading the preview repeatedly must not consume numbers.
    const preview2 = must(await a.get('/settings/invoice/preview-number?series=sales'), 200, 'preview again');
    assert.equal(preview2.next, preview1.next, 'previewing twice must not advance the counter');
    notes.push('previewing twice gives the same number (no counter burn)');

    const products = must(await a.get('/pos/products?q='), 200, 'POS products');
    const list = products.items || products;
    const pick = list.find((p) => p.nextBatch && p.availableStock > 1);
    const saved = must(
      await a.post('/invoices', { items: [{ medicineId: pick._id || pick.id, quantity: 1, discountPercent: 0 }], customer: { name: 'Numbering Check' }, paymentType: 'Cash', idempotencyKey: `x-num-${uniq()}` }),
      201,
      'complete a sale',
    );
    const invoice = saved.invoice || saved;
    assert.equal(invoice.invoiceNo, preview1.next, `the sale took ${invoice.invoiceNo} but the preview promised ${preview1.next}`);
    notes.push(`real sale took exactly the previewed number: ${invoice.invoiceNo}`);

    const preview3 = must(await a.get('/settings/invoice/preview-number?series=sales'), 200, 'preview after the sale');
    assert.notEqual(preview3.next, preview1.next, 'the counter must advance after a real sale');
    notes.push(`preview after the sale: ${preview3.next}`);
    return notes;
  });

  /* ------------------------------------------------------------------ 5. FY lock */
  await S.step(5, 'Settings → the financial-year start month is locked once the pharmacy has an invoice', async () => {
    const notes = [];
    const a = state.a;
    const cur = must(await a.get('/settings'), 200, 'read settings');
    const r = await a.patch('/settings/general', { version: cur.version, fiscalYearStartMonth: cur.general?.fiscalYearStartMonth === 4 ? 1 : 4 });
    assert.equal(r.status, 409, `expected the FY change to be locked, got ${r.status}`);
    assert.equal(r.body?.code, 'FISCAL_YEAR_LOCKED', `wrong refusal code: ${r.body?.code}`);
    notes.push(`org A (has invoices): 409 ${r.body.code}`);

    // The brand-new pharmacy has no invoices, so it may still choose.
    const bCur = must(await state.b.get('/settings'), 200, 'org B settings');
    const bR = await state.b.patch('/settings/general', { version: bCur.version, fiscalYearStartMonth: 1 });
    assert.equal(bR.status, 200, `a pharmacy with no invoices should still be able to set it, got ${bR.status} ${JSON.stringify(bR.body)}`);
    notes.push('org B (no invoices yet): 200 — the lock is about history, not a blanket ban');
    return notes;
  });

  /* ------------------------------------------------------------------ 6. batch -> expiry tiers from org thresholds */
  await S.step(6, 'Inventory batch → Expiry Intelligence buckets follow the org own thresholds', async () => {
    const notes = [];
    const a = state.a;
    const cur = must(await a.get('/settings'), 200, 'read settings');

    // Deliberately NOT 15/30/90, so a hard-coded threshold would show up.
    must(await a.patch('/settings/general', { version: cur.version, expiry: { thresholds: [10, 20, 40] } }), 200, 'set thresholds 10/20/40');

    const medName = `Threshold Probe ${uniq()}`;
    // POST /medicines returns the medicine document only, so the batch is found by name on the report itself.
    must(
      await a.post('/medicines', {
        medicineName: medName,
        categoryName: 'Tablets',
        manufacturer: 'ACME',
        batch: { batchNumber: `TP-${uniq()}`, expiryDate: futureDate(25), mrp: 100, sellingPrice: 90, initialQuantity: 5 },
      }),
      201,
      'a batch expiring in 25 days',
    );

    const rows = must(await a.get('/analytics/expiry/batches?limit=100'), 200, 'expiry rows');
    const row = (rows.items || rows).find((r) => r.medicineName === medName);
    assert.ok(row, `the new batch should appear in Expiry Intelligence (looked for "${medName}")`);
    const batchId = String(row.id);
    assert.equal(row.daysToExpiry, 25, `expected 25 days to expiry, got ${row.daysToExpiry}`);
    // 25 days: above 20, at or below 40 -> the third bucket.
    assert.equal(row.bucket, 'under90', `25 days with thresholds 10/20/40 belongs to the third bucket, got "${row.bucket}"`);
    notes.push(`25-day batch with thresholds 10/20/40 → bucket "${row.bucket}" (the third tier, not the 30-day one)`);

    // Back to the defaults: the same batch must move tier, proving the tier is computed from settings and not stored.
    const c2 = must(await a.get('/settings'), 200, 're-read');
    must(await a.patch('/settings/general', { version: c2.version, expiry: { thresholds: [15, 30, 90] } }), 200, 'restore 15/30/90');
    const rows2 = must(await a.get('/analytics/expiry/batches?limit=100'), 200, 'expiry rows again');
    const row2 = (rows2.items || rows2).find((r) => String(r.id) === batchId);
    assert.ok(row2, 'the batch is still on the report after the thresholds changed back');
    assert.equal(row2.bucket, 'under30', `with 15/30/90 a 25-day batch is the 30-day tier, got "${row2.bucket}"`);
    notes.push(`same batch with 15/30/90 → "${row2.bucket}" — tiers are computed from settings, never stored`);
    state.probeBatchId = batchId;
    return notes;
  });

  /* ------------------------------------------------------------------ 7. expiry -> email digest agreement */
  await S.step(7, 'Expiry Intelligence → email digest: same batches, same tiers, matching totals', async () => {
    const notes = [];
    const a = state.a;

    // Switch the digest on for org A, as the Settings screen would.
    const cur = must(await a.get('/settings'), 200, 'read settings');
    must(await a.patch('/settings/general', { version: cur.version, notifications: { nearExpiry: { enabled: true, channel: 'email' } } }), 200, 'channel = email');
    must(await a.patch('/settings/organization', { version: must(await a.get('/settings'), 200, 'v').version, owner: { email: 'digest-check@example.test' } }), 200, 'set an owner email');

    // What the REPORT says, through HTTP.
    const summary = must(await a.get('/analytics/expiry/summary'), 200, 'expiry summary');
    const rows = must(await a.get('/analytics/expiry/batches?limit=100'), 200, 'expiry rows');
    const items = rows.items || rows;
    const alertable = items.filter((r) => ['expired', 'under15', 'under30', 'under90'].includes(r.bucket));
    const byTier = {};
    for (const r of alertable) byTier[r.bucket] = (byTier[r.bucket] || 0) + 1;

    // What the DIGEST would say, built by the REAL digest builder (services/expiryDigest.js) fed with the rows the
    // HTTP report just returned. Pure functions, no database — the job's own storage behaviour is covered by its own
    // suite; what matters here is that the email and the screen cannot disagree about the same stock.
    const { buildDigest, renderDigest } = await import(new URL('../../server/services/expiryDigest.js', import.meta.url).href);
    const settings = must(await a.get('/settings'), 200, 'settings for thresholds');
    const thresholds = settings.general?.expiry?.thresholds || settings.expiry?.thresholds || [15, 30, 90];
    const digest = buildDigest({ rows: items, lastTierByBatch: {}, thresholds });

    const digestByTier = Object.fromEntries(digest.groups.map((g) => [g.tier, g.count]));
    assert.deepEqual(digestByTier, byTier, `digest tiers ${JSON.stringify(digestByTier)} do not match the report ${JSON.stringify(byTier)}`);
    assert.equal(digest.count, alertable.length, `digest counted ${digest.count}, the report shows ${alertable.length}`);

    // The money must agree too, to the paisa.
    const reportValue = money(alertable.reduce((n, r) => n + Number(r.costValue || 0), 0));
    assert.equal(money(digest.totalValue), reportValue, `digest value ₹${digest.totalValue} vs report ₹${reportValue}`);

    // And the rendered message must actually name the batches the report lists.
    const message = renderDigest({ organizationName: 'E2E Pharmacy', digest, appUrl: 'http://localhost:5200', thresholds, today: '2026-11-14' });
    const worst = alertable.sort((x, y) => (x.daysToExpiry ?? 0) - (y.daysToExpiry ?? 0))[0];
    assert.ok(message.html.includes(worst.medicineName), `the digest must mention ${worst.medicineName}`);
    assert.ok(message.text.includes(worst.batchNumber), `the plain-text part must mention batch ${worst.batchNumber}`);

    notes.push(`report and digest agree: ${digest.count} batches, tiers ${JSON.stringify(byTier)}, ₹${reportValue}`);
    notes.push(`rendered message names the most urgent lot: ${worst.medicineName} / ${worst.batchNumber}`);
    notes.push(`summary cards: expired ${summary.counts?.expired ?? '?'} / under15 ${summary.counts?.under15 ?? '?'}`);
    return notes;
  });

  /* ------------------------------------------------------------------ 8. deactivation */
  await S.step(8, 'Roles → user deactivation: session dies, history intact, not selectable anywhere new', async () => {
    const notes = [];
    const a = state.a;
    const email = `leaver-${uniq()}@example.test`;
    const made = must(await a.post('/users', { name: 'Departing Staff', email, password: PASSWORD, role: 'BILLING_STAFF', branchIds: [] }), 201, 'create a user');

    const leaver = new Client('leaver');
    must(await leaver.login(email, PASSWORD), 200, 'they sign in');
    must(await leaver.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Le4ver!Passw0rd' }), 200, 'change password');
    const l2 = new Client('leaver');
    must(await l2.login(email, 'Le4ver!Passw0rd'), 200, 'sign in again');

    // They do some work that must survive them.
    const products = must(await a.get('/pos/products?q='), 200, 'products');
    const pick = (products.items || products).find((p) => p.nextBatch && p.availableStock > 1);
    const sale = must(
      await l2.post('/invoices', { items: [{ medicineId: pick._id || pick.id, quantity: 1, discountPercent: 0 }], customer: { name: 'Sold By Leaver' }, paymentType: 'Cash', idempotencyKey: `x-leaver-${uniq()}` }),
      201,
      'they make a sale',
    );
    const invoiceNo = (sale.invoice || sale).invoiceNo;
    assert.ok((await l2.get('/medicines')).status === 200, 'they can work');

    must(await a.post(`/users/${made.id}/deactivate`), 200, 'deactivate them');

    // The session dies on the very next request.
    const after = await l2.get('/medicines');
    assert.equal(after.status, 401, `their session should be over, got ${after.status}`);
    notes.push(`session ended immediately: GET /medicines → ${after.status}`);

    // They cannot sign in again.
    const relogin = await new Client('leaver').login(email, 'Le4ver!Passw0rd');
    assert.notEqual(relogin.status, 200, 'a deactivated account must not sign in');
    notes.push(`re-sign-in refused: ${relogin.status} ${relogin.body?.code || ''}`);

    // Their work is untouched.
    const invoices = must(await a.get(`/invoices?search=${encodeURIComponent(invoiceNo)}`), 200, 'find their invoice');
    const still = (invoices.items || invoices).find((i) => i.invoiceNo === invoiceNo);
    assert.ok(still, `the invoice ${invoiceNo} they raised must still exist`);
    notes.push(`their invoice ${invoiceNo} is intact`);

    // Still listed (not deleted), marked inactive.
    const users = must(await a.get('/users?limit=100&active=inactive'), 200, 'inactive users');
    assert.ok((users.items || []).some((u) => u.email === email), 'they remain listed as inactive, not deleted');
    notes.push('still listed under inactive users — not deleted');
    state.leaver = { email, id: made.id, invoiceNo };
    return notes;
  });

  /* ------------------------------------------------------------------ 9. cross-tenant isolation, every module */
  await S.step(9, 'Cross-tenant isolation re-checked across every module with two real orgs', async () => {
    const notes = [];
    const { a, b } = state;
    const modules = [
      ['/medicines?limit=100', 'All Inventory'],
      ['/batches?limit=100', 'Inventory Batch'],
      ['/invoices?limit=100', 'Recent Invoices'],
      ['/sales-returns?limit=100', 'Sales Returns'],
      ['/orders?limit=100', 'Orders'],
      ['/suppliers?limit=100', 'Suppliers'],
      ['/branches', 'Branch'],
      ['/transfers?limit=100', 'Inter Store Transfer'],
      ['/compounds?limit=100', 'All Compound'],
      ['/attributes?limit=100', 'Attributes'],
      ['/activity?limit=100', 'Activity Log'],
      ['/roles?limit=50', 'Roles'],
      ['/users?limit=50', 'Users'],
    ];

    const idsOf = (d) => {
      const items = d?.items || d || [];
      return new Set((Array.isArray(items) ? items : []).map((x) => String(x._id ?? x.id)));
    };

    for (const [url, label] of modules) {
      const ra = await a.get(url);
      const rb = await b.get(url);
      assert.equal(ra.status, 200, `org A ${label} ${url} → ${ra.status}`);
      assert.equal(rb.status, 200, `org B ${label} ${url} → ${rb.status}`);
      const ia = idsOf(ra.data);
      const ib = idsOf(rb.data);
      const shared = [...ia].filter((x) => ib.has(x));
      assert.equal(shared.length, 0, `${label}: ${shared.length} record(s) appear in BOTH organizations — ${shared.slice(0, 3).join(', ')}`);
    }
    notes.push(`${modules.length} modules checked: no record id appears in both organizations`);

    // Analytics figures must differ too — a new pharmacy has no sales.
    const aSales = must(await a.get('/analytics/sales'), 200, 'org A sales');
    const bSales = must(await b.get('/analytics/sales'), 200, 'org B sales');
    const aTotal = aSales.totals?.current?.gross ?? 0;
    const bTotal = bSales.totals?.current?.gross ?? 0;
    assert.ok(aTotal > 0, 'org A has revenue');
    assert.equal(bTotal, 0, `a pharmacy with no sales must report 0 revenue, got ${bTotal}`);
    notes.push(`Sales Report: org A ₹${aTotal}, org B ₹${bTotal}`);

    // And addressing another org's record directly must not work.
    const aInvoice = (must(await a.get('/invoices?limit=1'), 200, 'an org A invoice').items || [])[0];
    const direct = await b.get(`/invoices/${aInvoice._id || aInvoice.id}`);
    assert.equal(direct.status, 404, `org B fetching org A's invoice by id should be 404, got ${direct.status}`);
    notes.push(`direct fetch of another org's invoice by id → ${direct.status}`);
    return notes;
  });


}
