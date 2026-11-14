// The charts, the calendar, the CSV export and the organization's thresholds.
//
// The thing these are really checking is that none of it can disagree with the register: a bar, a calendar cell, a
// row of the CSV and a row of the table are four views of one set of figures, and a dashboard whose chart contradicts
// its own list is worse than no dashboard.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { startHarness } from './helpers/harness.js';

let h;
let org;
let client;
let branch;
let models;

const DAY = 86400000;
const expiryIn = (days) => {
  const d = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const monthOf = (days) => expiryIn(days).toISOString().slice(0, 7);
const inOrg = (orgId, fn) => h.tenant.runWithTenant(orgId, fn);

let seq = 0;
async function makeLot({ days = 30, qty = 100, cost = 10, mrp = 25, maker = 'ACME', supplierId, ...extra } = {}) {
  const n = ++seq;
  const medicine = await inOrg(org._id, () => models.Medicine.create({ organizationId: org._id, medicineName: `Report Med ${n}`, manufacturer: maker }));
  const batch = await inOrg(org._id, () =>
    models.Batch.create({
      organizationId: org._id,
      medicineId: medicine._id,
      batchNumber: `RPT-${n}`,
      expiryDate: expiryIn(days),
      purchasePrice: cost,
      sellingPrice: mrp * 0.9,
      mrp,
      initialQuantity: qty,
      availableQuantity: qty,
      branchId: branch._id,
      supplierId,
      ...extra,
    }),
  );
  return { medicine, batch };
}

before(async () => {
  h = await startHarness();
  models = h.models;
  const tenant = await h.makeTenant('Reports Co');
  org = tenant.org;
  client = tenant.client;
  branch = await inOrg(org._id, () => models.Branch.create({ organizationId: org._id, name: 'Main Store', code: 'MAIN', isDefault: true }));
});
after(async () => h?.stop());

describe('the charts', () => {
  test('sets up stock spread across months, companies and suppliers', async () => {
    const cipla = await inOrg(org._id, () => models.Supplier.create({ organizationId: org._id, name: 'Cipla Depot' }));
    const sun = await inOrg(org._id, () => models.Supplier.create({ organizationId: org._id, name: 'Sun Agency' }));

    await makeLot({ days: 10, qty: 100, cost: 50, maker: 'Cipla', supplierId: cipla._id }); // ₹5,000
    await makeLot({ days: 40, qty: 100, cost: 30, maker: 'Cipla', supplierId: cipla._id }); // ₹3,000
    await makeLot({ days: 70, qty: 100, cost: 20, maker: 'Sun Pharma', supplierId: sun._id }); // ₹2,000
    await makeLot({ days: -20, qty: 50, cost: 40, maker: 'Sun Pharma', supplierId: sun._id }); // ₹2,000 expired
    await makeLot({ days: 400, qty: 100, cost: 10, maker: 'Mankind' }); // beyond the year, and Safe
    await makeLot({ days: 25, qty: 100, cost: 12 }); // no supplier at all

    const r = await client.get('/analytics/expiry/insights');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('the wave by month covers a full year, with quiet months as zeros rather than gaps', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    assert.equal(data.expiryByMonth.length, 12, 'twelve months, always');
    assert.ok(data.expiryByMonth.every((m) => /^\d{4}-\d{2}$/.test(m.key)));
    assert.ok(data.expiryByMonth.every((m) => typeof m.costValue === 'number'), 'a quiet month is a zero, not a missing entry');

    // The lot ten days out must be counted in the month it actually expires in.
    const target = data.expiryByMonth.find((m) => m.key === monthOf(10));
    assert.ok(target, 'the month ten days from now is inside the window');
    assert.ok(target.costValue >= 5000, `expected the ₹5,000 lot in ${monthOf(10)}, got ${target.costValue}`);
  });

  test('stock already expired, and stock more than a year out, are not in the wave', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    const total = data.expiryByMonth.reduce((n, m) => n + m.costValue, 0);
    assert.ok(!data.expiryByMonth.some((m) => m.key === monthOf(-20)), 'a past month is not one of the twelve ahead');
    assert.ok(total < 13200, 'the ₹2,000 expired lot and the ₹1,000 lot a year out are both outside the window');
  });

  test('the top companies are ranked by at-risk value, and Safe stock is not at risk', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    const cipla = data.topManufacturers.find((m) => m.label === 'Cipla');
    assert.equal(cipla.costValue, 8000, '₹5,000 + ₹3,000');
    assert.equal(cipla.batches, 2);
    assert.ok(!data.topManufacturers.some((m) => m.label === 'Mankind'), 'the lot 400 days out is Safe, so it is not at-risk value');
    // Ranked biggest first.
    assert.deepEqual(
      data.topManufacturers.map((m) => m.costValue),
      [...data.topManufacturers.map((m) => m.costValue)].sort((a, b) => b - a),
    );
  });

  test('the top suppliers separate what has already expired, and name the ones with no supplier', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    const sun = data.topSuppliers.find((s) => s.label === 'Sun Agency');
    assert.equal(sun.costValue, 4000, '₹2,000 live + ₹2,000 expired');
    assert.equal(sun.expiredValue, 2000, 'and the expired part is called out on its own');

    const none = data.topSuppliers.find((s) => s.id === 'none');
    assert.ok(none, 'lots with no supplier get their own row rather than being dropped');
    assert.equal(none.label, 'Supplier not recorded');
    assert.equal(none.costValue, 1200);
  });

  test('at most ten of each are returned', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    assert.ok(data.topManufacturers.length <= 10);
    assert.ok(data.topSuppliers.length <= 10);
  });

  test('the loss trend is six months of what was actually written off, not a projection', async () => {
    const before = await client.get('/analytics/expiry/insights');
    assert.equal(before.data.lossTrend.length, 6);
    const thisMonth = before.data.lossTrend[5];
    assert.equal(thisMonth.value, 0, 'nothing written off yet');

    // Write a lot off for real, and the trend must pick it up.
    const { batch } = await makeLot({ days: -5, qty: 60, cost: 25 });
    const d = await client.post('/analytics/expiry/actions', { action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired' });
    assert.equal(d.status, 200, JSON.stringify(d.body));

    const after_ = await client.get('/analytics/expiry/insights');
    const now = after_.data.lossTrend[5];
    assert.equal(now.value, 1500, '60 units at the ₹25 they cost');
    assert.equal(now.units, 60);
    assert.equal(now.events, 1);
  });

  test('each chart carries the caveat that explains it', async () => {
    const { data } = await client.get('/analytics/expiry/insights');
    assert.match(data.notes.lossTrend, /history, not a projection/i);
    assert.ok(data.notes.expiryByMonth && data.notes.topSuppliers && data.notes.topManufacturers);
  });

  test('the charts agree with the register they sit beside', async () => {
    const [insights, register] = await Promise.all([client.get('/analytics/expiry/insights'), client.get('/analytics/expiry/batches?limit=100')]);
    const fromCharts = insights.data.topManufacturers.reduce((n, m) => n + m.costValue, 0);
    const fromRows = register.data.items.filter((r) => r.bucket !== 'safe').reduce((n, r) => n + r.costValue, 0);
    assert.equal(Math.round(fromCharts), Math.round(fromRows), 'a bar cannot disagree with the list under it');
  });
});

describe('the calendar', () => {
  test('lays out one month, day by day, and says which weekday it opens on', async () => {
    const month = monthOf(10);
    const { data, status } = await client.get(`/analytics/expiry/calendar?month=${month}`);
    assert.equal(status, 200);
    assert.equal(data.month, month);
    assert.ok(data.days.length >= 28 && data.days.length <= 31);
    assert.ok(data.startWeekday >= 0 && data.startWeekday <= 6);
    assert.ok(data.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  });

  test('a day carries what expires on it, and the worst risk sitting there', async () => {
    const month = monthOf(10);
    const { data } = await client.get(`/analytics/expiry/calendar?month=${month}`);
    const target = expiryIn(10).toISOString().slice(0, 10);
    const day = data.days.find((d) => d.date === target);
    assert.ok(day, 'the day the lot expires is in the grid');
    assert.equal(day.batches, 1);
    assert.equal(day.costValue, 5000);
    assert.ok(['critical', 'high', 'medium', 'low'].includes(day.worstRisk));
  });

  test('a month with nothing in it comes back empty rather than failing', async () => {
    const { data, status } = await client.get('/analytics/expiry/calendar?month=2031-07');
    assert.equal(status, 200);
    assert.equal(data.totals.batches, 0);
    assert.equal(data.busiest, null);
    assert.ok(data.days.every((d) => d.batches === 0));
  });

  test('it says which months hold anything, so the arrows can skip the empty ones', async () => {
    const { data } = await client.get('/analytics/expiry/calendar');
    assert.ok(data.monthsWithStock.includes(monthOf(10)));
    assert.ok(data.monthsWithStock.includes(monthOf(400)), 'including months outside the twelve-month chart');
    assert.deepEqual(data.monthsWithStock, [...data.monthsWithStock].sort(), 'in order');
  });

  test('the filters apply to the calendar too, so it shows the same stock the table would', async () => {
    const all = await client.get(`/analytics/expiry/calendar?month=${monthOf(10)}`);
    const filtered = await client.get(`/analytics/expiry/calendar?month=${monthOf(10)}&manufacturer=Sun%20Pharma`);
    assert.ok(all.data.totals.costValue > filtered.data.totals.costValue, 'narrowing the question narrows the calendar');
  });

  test('a nonsense month is refused', async () => {
    assert.equal((await client.get('/analytics/expiry/calendar?month=2026-13')).status, 400);
    assert.equal((await client.get('/analytics/expiry/calendar?month=November')).status, 400);
  });
});

describe('the export', () => {
  test('carries every matching lot, not the page on screen', async () => {
    const page = await client.get('/analytics/expiry/batches?limit=2');
    const file = await client.get('/analytics/expiry/export');
    assert.equal(file.status, 200);
    assert.equal(page.data.items.length, 2);
    assert.equal(file.data.rows, page.data.total, 'the file holds the whole filtered set');
    assert.match(file.data.fileName, /^usha-expiry-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('opens with a header block that explains what it is a report of', async () => {
    const { data } = await client.get('/analytics/expiry/export');
    assert.match(data.csv, /Usha Pharmacy — Inventory Expiry Intelligence/);
    assert.match(data.csv, /Organization,Reports Co/);
    assert.match(data.csv, /Velocity window \(days\),60/);
    assert.match(data.csv, /Total projected loss \(INR\)/);
    assert.match(data.csv, /Generated,/);
  });

  test('the figures in the file are the figures on the screen', async () => {
    const [file, register] = await Promise.all([client.get('/analytics/expiry/export'), client.get('/analytics/expiry/batches?limit=100')]);
    const lines = file.data.csv.split('\r\n');
    const headerRow = lines.findIndex((l) => l.startsWith('Medicine,Generic'));
    assert.ok(headerRow > 0, 'the column header follows the block');
    assert.equal(lines.length - headerRow - 1, register.data.total, 'one line per lot');

    const first = register.data.items.find((r) => r.batchNumber === 'RPT-1');
    assert.ok(file.data.csv.includes('RPT-1'));
    assert.ok(file.data.csv.includes(first.costValue.toFixed(2)), 'the value in the file matches the value on screen');
  });

  test('the same filters narrow the file', async () => {
    const all = await client.get('/analytics/expiry/export');
    const filtered = await client.get('/analytics/expiry/export?manufacturer=Cipla');
    assert.ok(filtered.data.rows < all.data.rows);
    assert.ok(!filtered.data.csv.includes('Sun Pharma'));
    assert.match(filtered.data.csv, /Company,Cipla/);
  });

  test('asking for a spreadsheet gets a clear answer rather than a silent CSV', async () => {
    const r = await client.get('/analytics/expiry/export?format=xlsx');
    assert.equal(r.status, 400);
    assert.match(r.body.message, /CSV/);
    assert.equal(r.body.code, 'FORMAT_UNAVAILABLE');
  });

  test('format=csv is accepted explicitly', async () => {
    assert.equal((await client.get('/analytics/expiry/export?format=csv')).status, 200);
  });

  test('reading the export needs permission to read reports', async () => {
    const staff = await h.makeUser(org, { role: 'BILLING_STAFF' });
    const c = h.client();
    await c.login(staff.email);
    assert.equal((await c.get('/analytics/expiry/export')).status, 403);
  });
});

describe('the organization’s thresholds', () => {
  const SETTINGS = { thresholds: [7, 21, 60], velocityWindowDays: 30, supplierReturnWindowDays: 45, clearanceMaxDiscount: 40 };

  test('changing them changes what the report counts', async () => {
    const before = await client.get('/analytics/expiry/summary');
    assert.deepEqual(before.data.settings.thresholds, [15, 30, 90]);

    const put = await client.put('/analytics/expiry/settings', SETTINGS);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.data.thresholds, [7, 21, 60]);

    const after_ = await client.get('/analytics/expiry/summary');
    assert.deepEqual(after_.data.settings.thresholds, [7, 21, 60]);
    assert.equal(after_.data.settings.velocityWindowDays, 30);
    assert.equal(after_.data.recoverable.windowDays, 45);
    // The cards are renamed to match, so the screen never claims a bucket it is not counting.
    assert.equal(after_.data.cards.find((c) => c.key === 'under15').label, 'Under 7 days');
    assert.equal(after_.data.cards.find((c) => c.key === 'under90').label, 'Under 60 days');
  });

  test('a lot moves bucket when the thresholds move', async () => {
    // With buckets at 7/21/60, the lot 40 days out is in the longest bucket, not the middle one.
    const { data } = await client.get('/analytics/expiry/batches?limit=100');
    assert.equal(data.items.find((r) => r.batchNumber === 'RPT-2').bucket, 'under90', '40 days is inside 60 but past 21');
    assert.equal(data.items.find((r) => r.batchNumber === 'RPT-3').bucket, 'safe', '70 days is now past the longest bucket');
  });

  test('the change is audited, naming the new figures', async () => {
    const entries = await h.tenant.runWithTenant(org._id, () => models.AuditLog.find({ action: 'EXPIRY_SETTINGS_UPDATE' }).lean());
    assert.ok(entries.length >= 1);
    assert.match(entries[entries.length - 1].message, /7 \/ 21 \/ 60/);
  });

  test('buckets out of order, or an impossible window, are refused', async () => {
    assert.equal((await client.put('/analytics/expiry/settings', { ...SETTINGS, thresholds: [30, 15, 90] })).status, 400);
    assert.equal((await client.put('/analytics/expiry/settings', { ...SETTINGS, thresholds: [15, 30] })).status, 400);
    assert.equal((await client.put('/analytics/expiry/settings', { ...SETTINGS, velocityWindowDays: 2 })).status, 400);
    assert.equal((await client.put('/analytics/expiry/settings', { ...SETTINGS, clearanceMaxDiscount: 95 })).status, 400);
  });

  test('a partial update is refused rather than half-applied', async () => {
    assert.equal((await client.put('/analytics/expiry/settings', { velocityWindowDays: 45 })).status, 400);
  });

  test('changing settings is its own privilege, separate from reading the report', async () => {
    // An inventory manager may read reports and edit stock, but not change organization settings.
    const manager = await h.makeUser(org, { role: 'INVENTORY_MANAGER' });
    const c = h.client();
    await c.login(manager.email);
    assert.equal((await c.get('/analytics/expiry/summary')).status, 200, 'they can read it');
    assert.equal((await c.put('/analytics/expiry/settings', SETTINGS)).status, 403, 'but not redefine it');
  });

  test('settings are per organization', async () => {
    const other = await h.makeTenant('Untouched Co');
    const { data } = await other.client.get('/analytics/expiry/summary');
    assert.deepEqual(data.settings.thresholds, [15, 30, 90], 'another organization keeps the defaults');
  });
});
