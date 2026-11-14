// Inventory Expiry Intelligence, end to end: the real app, a real database, real lots and real sales history.
// The maths itself is tested on its own in expiry-risk.test.js; what these check is that the endpoint reads the right
// records, scopes them to the right organization and store, and honours what it was asked.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { startHarness } from './helpers/harness.js';

let h;
let org;
let client;
let branch;
let otherBranch;
let models;

const DAY = 86400000;
const expiryIn = (days) => {
  const d = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const ago = (days) => new Date(Date.now() - days * DAY);

/**
 * Records written straight to the database. These tests are about the REPORT, not about the catalogue or billing APIs,
 * and the tenant-scope plugin requires a tenant context for any write outside a request — hence `runWithTenant`.
 */
const inOrg = (orgId, fn) => h.tenant.runWithTenant(orgId, fn);

async function makeMedicine(name, extra = {}) {
  return inOrg(org._id, () => models.Medicine.create({ organizationId: org._id, medicineName: name, manufacturer: 'ACME', ...extra }));
}
async function makeBatch(medicine, batchNumber, { days, qty, cost = 10, mrp = 25, supplierId, branchId, ...extra }) {
  return inOrg(org._id, () =>
    models.Batch.create({
      organizationId: org._id,
      medicineId: medicine._id,
      batchNumber,
      expiryDate: expiryIn(days),
      purchasePrice: cost,
      sellingPrice: mrp * 0.9,
      mrp,
      initialQuantity: qty,
      availableQuantity: qty,
      branchId: branchId || branch._id,
      supplierId,
      ...extra,
    }),
  );
}
/** `perDay` units of one lot sold on each of the last `days` days, as completed invoices. */
async function sell(medicine, batch, perDay, days, branchId) {
  const invoices = [];
  for (let d = 1; d <= days; d++) {
    const amount = perDay * batch.sellingPrice;
    invoices.push({
      organizationId: org._id,
      invoiceNo: `T-${medicine.medicineName}-${d}`,
      branchId: branchId || branch._id,
      items: [{ medicineId: medicine._id, batchId: batch._id, quantity: perDay, price: batch.sellingPrice, amount }],
      subTotal: amount,
      total: amount,
      status: 'completed',
      invoiceDate: ago(d),
    });
  }
  await inOrg(org._id, () => models.Invoice.insertMany(invoices));
}

const find = (rows, batchNumber) => rows.find((r) => r.batchNumber === batchNumber);

before(async () => {
  h = await startHarness();
  models = h.models;
  const tenant = await h.makeTenant('Expiry Co');
  org = tenant.org;
  client = tenant.client;
  branch = await h.tenant.runWithTenant(org._id, () => models.Branch.create({ organizationId: org._id, name: 'Main Store', code: 'MAIN', isDefault: true }));
  otherBranch = await h.tenant.runWithTenant(org._id, () => models.Branch.create({ organizationId: org._id, name: 'Second Store', code: 'SEC' }));
});
after(async () => h?.stop());

describe('the register', () => {
  test('sets up stock across every risk level', async () => {
    const supplier = await inOrg(org._id, () => models.Supplier.create({ organizationId: org._id, name: 'Medilink' }));

    // A fast mover: 40/day. Its near-dated lot will clear itself and must NOT read as a loss.
    const fast = await makeMedicine('Fast Mover');
    const fastNear = await makeBatch(fast, 'FAST-NEAR', { days: 12, qty: 300, supplierId: supplier._id });
    await makeBatch(fast, 'FAST-FAR', { days: 300, qty: 5000, supplierId: supplier._id });
    await sell(fast, fastNear, 40, 60);

    // A slow mover: 1/day, a near lot it cannot clear, and a lot behind it that inherits what is left of the demand.
    const slow = await makeMedicine('Slow Mover');
    const slowNear = await makeBatch(slow, 'SLOW-NEAR', { days: 20, qty: 400, cost: 30, supplierId: supplier._id });
    await makeBatch(slow, 'SLOW-FAR', { days: 120, qty: 400, cost: 30, supplierId: supplier._id });
    await sell(slow, slowNear, 1, 30); // 30 units over a 60-day window = exactly 0.5 a day

    // Expired stock, and a high-value lot with no supplier on it.
    const dead = await makeMedicine('Dead Stock');
    await makeBatch(dead, 'DEAD-EXPIRED', { days: -30, qty: 150, cost: 20, supplierId: supplier._id });
    await makeBatch(dead, 'DEAD-NOSUP', { days: 40, qty: 50, cost: 600, mrp: 950 });

    const r = await client.get('/analytics/expiry/batches?limit=100');
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 6, 'every lot with stock is in the register');
  });

  test('a fast-moving lot near its date is not reported as a loss', async () => {
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    const row = find(data.items, 'FAST-NEAR');
    assert.ok(row.avgDailySales > 30, `expected a real velocity, got ${row.avgDailySales}`);
    assert.equal(row.projectedUnsoldQty, 0, '40 a day clears 300 units in 12 days');
    assert.equal(row.projectedLoss, 0);
    assert.ok(['low', 'safe', 'medium'].includes(row.riskLevel), `a lot that clears itself should not be urgent, got ${row.riskLevel}`);
  });

  test('a slow-moving lot near its date carries a real projected loss', async () => {
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    const row = find(data.items, 'SLOW-NEAR');
    assert.equal(row.daysToExpiry, 20);
    assert.equal(row.avgDailySales, 0.5, '30 units sold across a 60-day window');
    assert.equal(row.projectedUnsoldQty, 390, 'half a unit a day clears only 10 of the 400');
    assert.equal(row.projectedLoss, 11700, '390 units at the ₹30 they cost');
    assert.ok(row.riskScore > 40, `expected a high score, got ${row.riskScore}`);
  });

  test('the lot behind it only gets the demand the first one leaves', async () => {
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    const near = find(data.items, 'SLOW-NEAR');
    const far = find(data.items, 'SLOW-FAR');
    assert.equal(near.expectedSales, 10, 'the near lot sells into its own 20 days at half a unit a day');
    assert.equal(far.expectedSales, 50, 'the far lot sees 120 days of demand (60 units) less the 10 already taken');
    assert.ok(far.projectedUnsoldQty > 0, 'the lot behind it cannot clear either');
  });

  test('an expired lot holding stock is Critical', async () => {
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    const row = find(data.items, 'DEAD-EXPIRED');
    assert.equal(row.riskLevel, 'critical');
    assert.equal(row.riskScore, 100);
    assert.equal(row.bucket, 'expired');
    assert.equal(row.projectedUnsoldQty, 150, 'none of it can be sold');
  });

  test('a lot with no supplier recorded is never counted as recoverable', async () => {
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    assert.equal(find(data.items, 'DEAD-NOSUP').recoverable, false);
    assert.equal(find(data.items, 'DEAD-NOSUP').supplierName, '');
    assert.equal(find(data.items, 'SLOW-NEAR').recoverable, true, 'this one has a supplier and is inside the window');
  });
});

describe('the summary', () => {
  test('the cards nest: each bucket includes the more urgent ones', async () => {
    const { data } = await client.get('/analytics/expiry/summary');
    const card = (key) => data.cards.find((c) => c.key === key);
    assert.ok(card('under15').batches >= card('expired').batches);
    assert.ok(card('under30').batches >= card('under15').batches);
    assert.ok(card('under90').batches >= card('under30').batches);
    assert.equal(card('expired').batches, 1);
  });

  test('value at risk is reported at cost and at MRP, and MRP is the larger', async () => {
    const { data } = await client.get('/analytics/expiry/summary');
    assert.ok(data.valueAtRisk.cost > 0);
    assert.ok(data.valueAtRisk.mrp > data.valueAtRisk.cost, 'stock retails for more than it cost');
  });

  test('stock with no supplier is reported separately from what is recoverable', async () => {
    const { data } = await client.get('/analytics/expiry/summary');
    assert.ok(data.recoverable.value > 0);
    assert.equal(data.recoverable.noSupplier.batches, 1, 'the one high-value lot with nobody to send it back to');
    assert.equal(data.recoverable.noSupplier.value, 30000, '50 units at ₹600');
  });

  test('the projected loss is the sum of what the register shows', async () => {
    const [summary, register] = await Promise.all([client.get('/analytics/expiry/summary'), client.get('/analytics/expiry/batches?limit=100')]);
    const fromRows = register.data.items.reduce((n, r) => n + r.projectedLoss, 0);
    assert.equal(Math.round(summary.data.projectedLoss.value), Math.round(fromRows), 'the cards and the table cannot disagree');
  });

  test('it reports the organization’s own settings, at their defaults', async () => {
    const { data } = await client.get('/analytics/expiry/summary');
    assert.deepEqual(data.settings.thresholds, [15, 30, 90]);
    assert.equal(data.settings.velocityWindowDays, 60);
    assert.equal(data.settings.supplierReturnWindowDays, 90);
  });
});

describe('filtering, sorting, grouping and paging', () => {
  test('a bucket filter means "at least this urgent"', async () => {
    const { data } = await client.get('/analytics/expiry/batches?status=under30&limit=100');
    const buckets = new Set(data.items.map((r) => r.bucket));
    assert.ok(!buckets.has('safe'), 'nothing comfortably in date');
    assert.ok(buckets.has('expired'), 'and the expired lot is included, because it is more urgent still');
  });

  test('search reaches the medicine, the batch, the manufacturer and the supplier', async () => {
    assert.equal((await client.get('/analytics/expiry/batches?search=SLOW-NEAR')).data.total, 1);
    assert.equal((await client.get('/analytics/expiry/batches?search=Slow Mover&limit=100')).data.total, 2);
    assert.ok((await client.get('/analytics/expiry/batches?search=Medilink&limit=100')).data.total >= 4);
    assert.equal((await client.get('/analytics/expiry/batches?search=nothing-like-this')).data.total, 0);
  });

  test('a minimum value filter leaves out the small stuff', async () => {
    const { data } = await client.get('/analytics/expiry/batches?minValue=20000&limit=100');
    assert.ok(data.items.every((r) => r.costValue >= 20000));
    assert.ok(data.total >= 1);
  });

  test('sorting is honoured in both directions', async () => {
    const worst = (await client.get('/analytics/expiry/batches?sortBy=risk&sortDir=desc&limit=100')).data.items;
    assert.equal(worst[0].batchNumber, 'DEAD-EXPIRED', 'the expired lot is the worst thing on the list');
    const soonest = (await client.get('/analytics/expiry/batches?sortBy=expiry&sortDir=asc&limit=100')).data.items;
    assert.deepEqual(soonest.map((r) => r.daysToExpiry), [...soonest.map((r) => r.daysToExpiry)].sort((a, b) => a - b));
  });

  test('paging splits the set without losing or repeating a row', async () => {
    const all = (await client.get('/analytics/expiry/batches?limit=100')).data;
    const first = (await client.get('/analytics/expiry/batches?page=1&limit=2')).data;
    const second = (await client.get('/analytics/expiry/batches?page=2&limit=2')).data;
    assert.equal(first.total, all.total, 'the total describes the whole filtered set, not the page');
    assert.equal(first.pages, Math.ceil(all.total / 2));
    assert.equal(first.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 4, 'no row appears on two pages');
  });

  test('the totals describe the whole filtered set, not the page on screen', async () => {
    const page = (await client.get('/analytics/expiry/batches?page=1&limit=1')).data;
    const everything = (await client.get('/analytics/expiry/batches?limit=100')).data;
    assert.equal(page.items.length, 1);
    assert.equal(page.totals.costValue, everything.totals.costValue);
  });

  test('grouping subtotals add up to the whole', async () => {
    const { data } = await client.get('/analytics/expiry/batches?groupBy=supplier&limit=100');
    assert.ok(data.groups.length >= 2);
    const summed = data.groups.reduce((n, g) => n + g.batches, 0);
    assert.equal(summed, data.total, 'every row belongs to exactly one group');
    assert.ok(data.groups.some((g) => g.label === 'Supplier not recorded'), 'lots with no supplier get their own group, not a blank one');
  });

  test('the dropdowns only offer values the data actually holds', async () => {
    const { data } = await client.get('/analytics/expiry/batches');
    assert.ok(data.options.suppliers.some((o) => o.label === 'Medilink'));
    assert.ok(data.options.suppliers.some((o) => o.value === 'none'));
    assert.ok(data.options.manufacturers.some((o) => o.value === 'ACME'));
  });

  test('an unknown filter value is refused rather than quietly ignored', async () => {
    assert.equal((await client.get('/analytics/expiry/batches?status=next-tuesday')).status, 400);
    assert.equal((await client.get('/analytics/expiry/batches?riskLevel=terrifying')).status, 400);
    assert.equal((await client.get('/analytics/expiry/batches?sortBy=whatever')).status, 400);
    assert.equal((await client.get('/analytics/expiry/batches?expiryFrom=2026-13-45')).status, 400);
    assert.equal((await client.get('/analytics/expiry/batches?expiryFrom=2026-12-01&expiryTo=2026-01-01')).status, 400, 'a backwards date range is an error');
  });
});

describe('scoping', () => {
  test('a store filter reports on that store alone', async () => {
    const med = await makeMedicine('Second Store Only');
    await makeBatch(med, 'OTHER-1', { days: 10, qty: 100, branchId: otherBranch._id });

    const mine = await client.get(`/analytics/expiry/batches?branchId=${branch._id}&limit=100`);
    assert.ok(!mine.data.items.some((r) => r.batchNumber === 'OTHER-1'));
    const theirs = await client.get(`/analytics/expiry/batches?branchId=${otherBranch._id}&limit=100`);
    assert.deepEqual(theirs.data.items.map((r) => r.batchNumber), ['OTHER-1']);
  });

  test('velocity is measured per store, so the same medicine can move at two speeds', async () => {
    const med = await makeMedicine('Split Speed');
    const here = await makeBatch(med, 'SPLIT-HERE', { days: 30, qty: 300 });
    const there = await makeBatch(med, 'SPLIT-THERE', { days: 30, qty: 300, branchId: otherBranch._id });
    await sell(med, here, 20, 60, branch._id); // busy in the main store, never sold in the second

    const all = (await client.get('/analytics/expiry/batches?limit=100')).data.items;
    assert.ok(find(all, 'SPLIT-HERE').avgDailySales > 15);
    assert.equal(find(all, 'SPLIT-THERE').avgDailySales, 0, 'it has never sold in that store');
    assert.equal(find(all, 'SPLIT-THERE').projectedUnsoldQty, 300, 'so all of it is projected loss there');
  });

  test('one organization never sees another’s stock', async () => {
    const other = await h.makeTenant('Rival Pharmacy');
    const otherBranchOfRival = await inOrg(other.org._id, () => models.Branch.create({ organizationId: other.org._id, name: 'Rival Store', code: 'RIV', isDefault: true }));
    const med = await inOrg(other.org._id, () => models.Medicine.create({ organizationId: other.org._id, medicineName: 'Rival Medicine' }));
    await inOrg(other.org._id, () =>
      models.Batch.create({
        organizationId: other.org._id,
        medicineId: med._id,
        batchNumber: 'RIVAL-1',
        expiryDate: expiryIn(5),
        sellingPrice: 10,
        mrp: 12,
        initialQuantity: 999,
        availableQuantity: 999,
        branchId: otherBranchOfRival._id,
      }),
    );

    const ours = await client.get('/analytics/expiry/batches?limit=100');
    assert.ok(!ours.data.items.some((r) => r.batchNumber === 'RIVAL-1'));
    const theirs = await other.client.get('/analytics/expiry/batches?limit=100');
    assert.deepEqual(theirs.data.items.map((r) => r.batchNumber), ['RIVAL-1']);
  });

  test('reporting on a store you are not assigned to is refused', async () => {
    const staff = await h.makeUser(org, { role: 'BRANCH_MANAGER', branchIds: [otherBranch._id] });
    const c = h.client();
    await c.login(staff.email);
    const r = await c.get(`/analytics/expiry/batches?branchId=${branch._id}`);
    assert.equal(r.status, 403);
  });

  test('reading the report needs permission to read reports', async () => {
    const staff = await h.makeUser(org, { role: 'BILLING_STAFF' });
    const c = h.client();
    await c.login(staff.email);
    assert.equal((await c.get('/analytics/expiry/summary')).status, 403);
    assert.equal((await c.get('/analytics/expiry/batches')).status, 403);
  });

  test('signing out closes the report too', async () => {
    const anon = h.client();
    assert.equal((await anon.get('/analytics/expiry/summary')).status, 401);
  });
});
