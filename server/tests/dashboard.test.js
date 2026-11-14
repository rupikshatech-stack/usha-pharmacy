// Dashboard analytics: calculation rules, timezone/period boundaries, duplicate protection,
// date filters and tenant isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMedicine, startHarness } from './helpers/harness.js';

let h;
let M;
let dash; // services/dashboard.service.js
let org; // organization used for the date-rule tests
const NOW = new Date('2026-11-06T08:00:00Z'); // 13:30 on 6 Nov 2026 in India
const oid = () => new h.mongoose.Types.ObjectId();

const orgDoc = (extra = {}) => ({ _id: org._id, timezone: 'Asia/Kolkata', settings: { reportingPeriod: 'fiscal_year', fiscalYearStartMonth: 4 }, ...extra });
const inTenant = (fn) => h.tenant.runWithTenant(org._id, fn);

let n = 0;
const mkInvoice = (spec) => {
  const total = spec.total;
  return inTenant(() =>
    M.Invoice.create({
      invoiceNo: `INV-T${String(++n).padStart(4, '0')}`,
      customer: { name: 'Walk-in Customer' },
      items: [{ medicineId: oid(), batchId: oid(), name: 'x', batchNo: 'b', quantity: 1, price: total, amount: total }],
      subTotal: total,
      total,
      paymentType: 'Cash',
      paid: spec.paid ?? total,
      due: spec.due ?? 0,
      status: spec.status,
      invoiceDate: new Date(spec.at),
    }),
  );
};

before(async () => {
  h = await startHarness();
  M = h.models;
  dash = await import('../services/dashboard.service.js');
  org = await h.makeOrg('Dashboard Rules Org'); // a data-only organization for the date rules (services are called directly)

  /*  status      total  invoiceDate (UTC)            India (IST)
   *  completed    100   2026-11-06T03:00:00Z         6 Nov 08:30   -> today   (customer still owes 60)
   *  completed    200   2026-11-05T18:30:00Z         6 Nov 00:00   -> today (first instant of the day)
   *  completed     50   2026-11-05T18:29:59.999Z     5 Nov 23:59   -> yesterday
   *  cancelled   1000   2026-11-06T04:00:00Z         6 Nov         -> never counts
   *  reversed    2000   2026-11-06T05:00:00Z         6 Nov         -> never counts
   *  draft       3000   2026-11-06T06:00:00Z         6 Nov         -> never counts
   *  completed    400   2026-11-06T18:30:00Z         7 Nov 00:00   -> tomorrow (not today)
   *  completed    700   2026-03-31T18:30:00Z         1 Apr 00:00   -> first instant of FY 2026-27
   *  completed    800   2026-03-31T18:29:59Z         31 Mar        -> previous financial year
   *  completed     10   2026-10-31T18:30:00Z         1 Nov 00:00   -> November
   *  completed     20   2026-10-31T18:29:59Z         31 Oct 23:59  -> October
   */
  await mkInvoice({ status: 'completed', total: 100, paid: 40, due: 60, at: '2026-11-06T03:00:00Z' });
  await mkInvoice({ status: 'completed', total: 200, at: '2026-11-05T18:30:00Z' });
  await mkInvoice({ status: 'completed', total: 50, at: '2026-11-05T18:29:59.999Z' });
  await mkInvoice({ status: 'cancelled', total: 1000, at: '2026-11-06T04:00:00Z' });
  await mkInvoice({ status: 'reversed', total: 2000, at: '2026-11-06T05:00:00Z' });
  await mkInvoice({ status: 'draft', total: 3000, at: '2026-11-06T06:00:00Z' });
  await mkInvoice({ status: 'completed', total: 400, at: '2026-11-06T18:30:00Z' });
  await mkInvoice({ status: 'completed', total: 700, at: '2026-03-31T18:30:00Z' });
  await mkInvoice({ status: 'completed', total: 800, at: '2026-03-31T18:29:59Z' });
  await mkInvoice({ status: 'completed', total: 10, at: '2026-10-31T18:30:00Z' });
  await mkInvoice({ status: 'completed', total: 20, at: '2026-10-31T18:29:59Z' });
});

after(async () => {
  await h?.stop();
});

const overview = (o = orgDoc(), q = {}, now = NOW) => inTenant(() => dash.getOverview(o, q, now));

describe("Today's Revenue (current business day in the organization's timezone)", () => {
  it('sums completed sales for today only, excluding cancelled, reversed and draft invoices', async () => {
    const o = await overview();
    assert.equal(o.todayRevenue, 300); // 100 + 200  (not 1000 cancelled, 2000 reversed, 3000 draft)
    assert.equal(o.todayInvoices, 2);
    assert.equal(o.businessDate, '2026-11-06');
    assert.equal(o.timezone, 'Asia/Kolkata');
  });

  it('the day starts exactly at midnight India time and ends exactly at the next midnight', async () => {
    const o = await overview();
    assert.equal(o.yesterdayRevenue, 50, 'an invoice 1 ms before midnight IST is yesterday');
    assert.equal(o.todayRevenue, 300, '00:00:00 IST is today, and 7 Nov 00:00 IST is NOT');
    assert.equal(o.todayVsYesterday, 500); // (300-50)/50
  });

  it('what counts as "today" follows the organization timezone', async () => {
    const ny = await overview(orgDoc({ timezone: 'America/New_York' }));
    assert.equal(ny.businessDate, '2026-11-06');
    // Today in New York is 6 Nov 05:00Z .. 7 Nov 05:00Z -> only the 400 invoice (18:30Z) falls inside it.
    assert.equal(ny.todayRevenue, 400);
    assert.equal(ny.timezone, 'America/New_York');
  });

  it('revenue is the invoice total, never the sum of payments (credit sale still counts in full)', async () => {
    const o = await overview();
    assert.equal(o.totalRevenue, 1480);
    assert.equal(o.collected, 1420, 'payments received are reported separately');
    assert.equal(o.outstanding, 60);
  });
});

describe('Total Revenue and Total Invoices (organization reporting period)', () => {
  it('defaults to the Indian financial year (1 Apr – 31 Mar India time)', async () => {
    const o = await overview();
    assert.equal(o.period.type, 'fiscal_year');
    assert.equal(o.period.label, 'FY 2026-27');
    assert.equal(o.period.start, '2026-03-31T18:30:00.000Z');
    assert.equal(o.period.end, '2027-03-31T18:30:00.000Z');
    // 100+200+50+400+700+10+20; the 800 invoice (31 Mar, last year's FY) is excluded
    assert.equal(o.totalRevenue, 1480);
    assert.equal(o.totalInvoices, 7);
  });

  it('counts only completed invoices, and reports the other statuses separately', async () => {
    const o = await overview();
    assert.deepEqual(o.invoiceStatusCounts, { draft: 1, completed: 7, cancelled: 1, reversed: 1 });
    assert.equal(o.totalInvoices, o.invoiceStatusCounts.completed);
  });

  it('the first instant of the financial year is included; the last instant before it is not', async () => {
    const o = await overview();
    assert.ok(o.totalRevenue >= 700, '1 Apr 00:00 IST invoice is in');
    assert.equal(o.totalRevenue, 1480, '31 Mar 23:59:59 IST invoice is out');
  });

  it('honours calendar_year, all_time and a custom fiscal start month', async () => {
    const cal = await overview(orgDoc({ settings: { reportingPeriod: 'calendar_year' } }));
    assert.equal(cal.period.label, '2026');
    assert.equal(cal.totalRevenue, 2280); // includes the 31 Mar 800 invoice

    const all = await overview(orgDoc({ settings: { reportingPeriod: 'all_time' } }));
    assert.equal(all.period.label, 'All time');
    assert.equal(all.period.start, null);
    assert.equal(all.totalRevenue, 2280);
    assert.equal(all.totalInvoices, 8);

    const oct = await overview(orgDoc({ settings: { reportingPeriod: 'fiscal_year', fiscalYearStartMonth: 10 } }));
    assert.equal(oct.period.start, '2026-09-30T18:30:00.000Z'); // 1 Oct IST
    assert.equal(oct.totalRevenue, 780); // 20 + 10 + 100 + 200 + 50 + 400
    assert.equal(oct.totalInvoices, 6);
  });

  it('the financial year rolls over correctly: in February the year started the previous April', async () => {
    const feb = await overview(orgDoc(), {}, new Date('2027-02-10T08:00:00Z'));
    assert.equal(feb.period.label, 'FY 2026-27');
    const apr = await overview(orgDoc(), {}, new Date('2027-04-01T00:00:00Z'));
    assert.equal(apr.period.label, 'FY 2027-28');
    const marEnd = await overview(orgDoc(), {}, new Date('2027-03-31T18:29:59Z'));
    assert.equal(marEnd.period.label, 'FY 2026-27', 'still 31 Mar in India');
  });

  it('a custom from/to range overrides the period and includes the whole "to" day', async () => {
    const q = { from: new Date('2026-11-05T18:30:00Z'), to: new Date('2026-11-06T18:30:00Z') }; // 6 Nov IST, as the controller builds it
    const r = await overview(orgDoc(), q);
    assert.equal(r.period.type, 'custom');
    assert.equal(r.totalRevenue, 300);
    assert.equal(r.totalInvoices, 2);
  });

  it('this month vs last month use local calendar months', async () => {
    const o = await overview();
    assert.equal(o.thisMonthRevenue, 760); // 100+200+50+400+10  (1 Nov 00:00 IST is November)
    assert.equal(o.lastMonthRevenue, 20); // 31 Oct 23:59:59 IST is October
    assert.equal(o.monthVsLastMonth, 3700);
  });
});

describe('Monthly sales (last six months)', () => {
  it('returns exactly six zero-filled months ending with the current month, bucketed in local time', async () => {
    const r = await inTenant(() => dash.getMonthlySales(orgDoc(), { months: 6 }, NOW));
    assert.deepEqual(r.items.map((i) => i.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    assert.deepEqual(r.items.map((i) => i.revenue), [0, 0, 0, 0, 20, 760]);
    assert.deepEqual(r.items.map((i) => i.invoices), [0, 0, 0, 0, 1, 5]);
    assert.equal(r.items[5].label, 'Nov 2026');
    assert.equal(r.totalRevenue, 780);
    assert.equal(r.timezone, 'Asia/Kolkata');
  });

  it('excludes cancelled, reversed and draft invoices and anything older than the window', async () => {
    const r = await inTenant(() => dash.getMonthlySales(orgDoc(), { months: 6 }, NOW));
    assert.equal(r.items[5].revenue, 760, 'no 1000/2000/3000 from non-completed invoices');
    const wide = await inTenant(() => dash.getMonthlySales(orgDoc(), { months: 12 }, NOW));
    assert.equal(wide.items.length, 12);
    assert.equal(wide.items.find((i) => i.month === '2026-04').revenue, 700, '1 Apr 00:00 IST is April');
    assert.equal(wide.items.find((i) => i.month === '2026-03').revenue, 800);
  });
});

describe('Low stock, stock chart and alerts (needs real batches)', () => {
  let meds;
  const day = 86400000;
  const batch = (m, qty, offsetDays, no) =>
    inTenant(() => M.Batch.create({ medicineId: m._id, batchNumber: no, expiryDate: new Date(Date.now() + offsetDays * day), mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty }));
  const med = (name, reorderLevel, isActive = true) => inTenant(() => M.Medicine.create({ medicineName: name, reorderLevel, isActive }));

  before(async () => {
    meds = {
      m1: await med('M1 below reorder', 10),
      m2: await med('M2 exactly at reorder', 10),
      m3: await med('M3 plenty', 10),
      m4: await med('M4 only expired stock', 5),
      m5: await med('M5 discontinued', 5, false),
      m6: await med('M6 reorder level zero', 0),
      m7: await med('M7 no batches', 10),
    };
    await batch(meds.m1, 9, 400, 'M1-A');
    await batch(meds.m2, 10, 400, 'M2-A');
    await batch(meds.m3, 100, 400, 'M3-A');
    await batch(meds.m3, 4, 30, 'M3-SOON'); // expires in 30 days -> "expiring soon"
    await batch(meds.m4, 50, -5, 'M4-EXPIRED'); // expired 5 days ago
    await batch(meds.m5, 500, 400, 'M5-A'); // discontinued but stocked
  });

  const now = () => new Date();

  it('Low Stock Alerts counts medicines whose available stock is BELOW their reorder level', async () => {
    const o = await inTenant(() => dash.getOverview(orgDoc(), {}, now()));
    // low: M1 (9<10), M4 (expired stock isn't available: 0<5), M7 (0<10).
    // not low: M2 (10 is not below 10), M3, M5 (discontinued), M6 (reorder level 0).
    assert.equal(o.lowStockAlerts, 3);
  });

  it('alerts list the low-stock items lowest first, and the expired / expiring batches', async () => {
    const a = await inTenant(() => dash.getAlerts(org._id, { limit: 10, expiryDays: 90 }, now()));
    assert.deepEqual(a.lowStockItems.map((i) => i.name), ['M4 only expired stock', 'M7 no batches', 'M1 below reorder']);
    assert.deepEqual(a.lowStockItems.map((i) => i.qty), [0, 0, 9]);
    assert.equal(a.counts.lowStock, 3);
    assert.equal(a.counts.expired, 1);
    assert.equal(a.counts.expiringSoon, 1);
    assert.deepEqual(a.expiringBatches.map((b) => [b.batchNumber, b.expired]), [['M4-EXPIRED', true], ['M3-SOON', false]]);
  });

  it('the stock chart returns active medicines with the highest sellable stock, descending', async () => {
    const s = await inTenant(() => dash.getStockLevels(org._id, { limit: 8 }, now()));
    assert.deepEqual(s.items.map((i) => [i.name, i.qty]), [['M3 plenty', 104], ['M2 exactly at reorder', 10], ['M1 below reorder', 9]]);
    assert.ok(!s.items.some((i) => /M4|M5/.test(i.name)), 'expired-only and discontinued medicines are not charted');
    assert.equal(s.totalUnits, 123);
    const top1 = await inTenant(() => dash.getStockLevels(org._id, { limit: 1 }, now()));
    assert.deepEqual(top1.items.map((i) => i.name), ['M3 plenty']);
  });

  it('inventory status filters use the same rule (below reorder = low; equal = in stock)', async () => {
    const { listMedicines } = await import('../services/medicine.service.js');
    const q = (stock) => inTenant(() => listMedicines(org._id, { search: '', page: 1, limit: 50, categoryId: undefined, manufacturer: '', stock, sortBy: 'medicineName', sortDir: 'asc' }));
    assert.deepEqual((await q('low_stock')).items.map((m) => m.medicineName), ['M1 below reorder']);
    assert.ok((await q('in_stock')).items.some((m) => m.medicineName === 'M2 exactly at reorder'));
    const out = (await q('out_of_stock')).items.map((m) => m.medicineName);
    assert.ok(out.includes('M7 no batches'));
    assert.ok(!out.includes('M4 only expired stock'), 'expired-only stock is "expired", not "out of stock"');
    assert.deepEqual((await q('expired')).items.map((m) => m.medicineName), ['M4 only expired stock']);
  });
});

describe('Duplicate protection (idempotent invoice creation)', () => {
  let t;
  let med;
  before(async () => {
    t = await h.makeTenant('Idempotency Org');
    med = await addMedicine(t.client, 'Idem Tabs', { stock: 50 });
  });
  const stockOf = async (client = t.client) => (await client.get(`/medicines/${med._id}`)).data.batches.reduce((s, b) => s + b.availableQuantity, 0);
  const key = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  it('the same idempotencyKey never creates a second invoice or deducts stock twice', async () => {
    const k = key();
    const body = { items: [{ medicineId: med._id, quantity: 3 }], idempotencyKey: k };
    const first = await t.client.post('/invoices', body);
    const second = await t.client.post('/invoices', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200, 'a replay is a 200, not a new 201');
    assert.equal(second.data._id, first.data._id);
    assert.equal(await stockOf(), 47, 'stock deducted exactly once');
    assert.equal((await t.client.get('/invoices')).data.total, 1);
  });

  it('five simultaneous identical requests produce exactly one invoice', async () => {
    const k = key();
    const before = await stockOf();
    const results = await Promise.all(Array.from({ length: 5 }, () => t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 2 }], idempotencyKey: k })));
    assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.data._id)).size, 1);
    assert.equal(await stockOf(), before - 2);
  });

  it('revenue counts a retried sale once', async () => {
    const o = (await t.client.get('/dashboard/overview')).data;
    const invoices = (await t.client.get('/invoices?limit=100')).data.items;
    assert.equal(o.totalInvoices, invoices.length);
    assert.equal(o.totalRevenue, Math.round(invoices.reduce((s, i) => s + i.total, 0) * 100) / 100);
    assert.equal(o.todayInvoices, invoices.length);
  });

  it('requests without a key are independent sales; keys are per organization', async () => {
    const a = await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] });
    const b = await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.notEqual(a.data._id, b.data._id);

    const other = await h.makeTenant('Idempotency Org 2');
    const m2 = await addMedicine(other.client, 'Other Tabs');
    const k = key();
    const x = await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: k });
    const y = await other.client.post('/invoices', { items: [{ medicineId: m2._id, quantity: 1 }], idempotencyKey: k });
    assert.equal(x.status, 201);
    assert.equal(y.status, 201, 'the same key in another organization is a different sale');
  });

  it('rejects a malformed idempotencyKey', async () => {
    assert.equal((await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: 'x' })).status, 400);
  });

  it('a failed sale (insufficient stock) leaves nothing behind, so the same key can be retried later', async () => {
    const k = key();
    const tooMany = await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 9999 }], idempotencyKey: k });
    assert.equal(tooMany.status, 409);
    const retry = await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: k });
    assert.equal(retry.status, 201);
  });
});

describe('Recent activity', () => {
  it('is newest-first, limited, organization-specific, and hides failed-login noise', async () => {
    const t = await h.makeTenant('Activity Org');
    // two failed sign-ins create AUTH_LOGIN_FAILED audit rows
    await h.client().login(t.user.email, 'wrong-password-1');
    await h.client().login(t.user.email, 'wrong-password-2');
    await addMedicine(t.client, 'Activity Tabs');

    const full = (await t.client.get('/activity?limit=100')).data.items;
    assert.ok(full.some((e) => e.action === 'AUTH_LOGIN_FAILED'), 'the full audit log has the failures');

    const feed = (await t.client.get('/dashboard/recent-activity?limit=50')).data.items;
    assert.ok(feed.length > 0);
    assert.ok(!feed.some((e) => /AUTH_LOGIN_FAILED|AUTH_LOCKED/.test(e.action)));
    const times = feed.map((e) => new Date(e.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.equal((await t.client.get('/dashboard/recent-activity?limit=1')).data.items.length, 1);
    assert.ok(/Z$/.test(feed[0].createdAt), 'timestamps are ISO-8601 UTC');
    assert.deepEqual(Object.keys(feed[0]).sort(), ['action', 'createdAt', 'entity', 'id', 'message', 'userName']);
  });

  it('supports from/to date filters in the organization timezone', async () => {
    const t = await h.makeTenant('Activity Dates Org');
    assert.ok((await t.client.get('/dashboard/recent-activity')).data.items.length > 0);
    assert.equal((await t.client.get('/dashboard/recent-activity?from=2001-01-01&to=2001-01-31')).data.items.length, 0);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    assert.ok((await t.client.get(`/dashboard/recent-activity?from=${today}&to=${tomorrow}`)).data.items.length > 0);
  });
});

describe('Tenant isolation of every dashboard endpoint', () => {
  let A;
  let B;
  before(async () => {
    A = await h.makeTenant('Dash Alpha');
    B = await h.makeTenant('Dash Beta');
    const med = await addMedicine(A.client, 'Alphavit', { stock: 77, category: 'AlphaOnly' });
    assert.equal((await A.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 2 }] })).status, 201);
    await addMedicine(B.client, 'Betavit', { stock: 5 });
  });

  it('overview: B never sees A\'s revenue, invoices or medicines', async () => {
    const a = (await A.client.get('/dashboard/overview')).data;
    const b = (await B.client.get('/dashboard/overview')).data;
    assert.equal(a.totalInvoices, 1);
    assert.ok(a.totalRevenue > 0);
    assert.equal(b.totalInvoices, 0);
    assert.equal(b.totalRevenue, 0);
    assert.equal(b.todayRevenue, 0);
    assert.equal(b.medicineCount, 1);
  });

  it('monthly-sales: B gets six empty months', async () => {
    const a = (await A.client.get('/dashboard/monthly-sales')).data;
    const b = (await B.client.get('/dashboard/monthly-sales')).data;
    assert.equal(a.items.length, 6);
    assert.ok(a.items[5].revenue > 0);
    assert.equal(b.items.length, 6);
    assert.ok(b.items.every((m) => m.revenue === 0 && m.invoices === 0));
  });

  it('stock-levels: only the caller\'s medicines', async () => {
    assert.deepEqual((await A.client.get('/dashboard/stock-levels')).data.items.map((i) => [i.name, i.qty]), [['Alphavit', 75]]);
    assert.deepEqual((await B.client.get('/dashboard/stock-levels')).data.items.map((i) => i.name), ['Betavit']);
  });

  it('recent-activity and alerts: only the caller\'s organization', async () => {
    const feedB = (await B.client.get('/dashboard/recent-activity?limit=50')).data.items;
    assert.ok(!feedB.some((e) => /Alphavit|INV-/.test(e.message)));
    const alertsB = (await B.client.get('/dashboard/alerts')).data;
    assert.ok(!JSON.stringify(alertsB).includes('Alphavit'));
  });

  it('organization ids in the query string are ignored', async () => {
    const r = (await B.client.get(`/dashboard/overview?organizationId=${A.org._id}&orgId=${A.org._id}`)).data;
    assert.equal(r.totalInvoices, 0);
  });

  it('every dashboard endpoint requires authentication', async () => {
    for (const p of ['overview', 'monthly-sales', 'stock-levels', 'recent-activity', 'alerts']) {
      assert.equal((await h.client().get(`/dashboard/${p}`)).status, 401, p);
    }
  });
});

describe('Query validation and date filters', () => {
  let t;
  before(async () => {
    t = await h.makeTenant('Validation Org');
  });
  const status = async (path) => (await t.client.get(path)).status;

  it('rejects malformed, impossible and reversed dates', async () => {
    assert.equal(await status('/dashboard/overview?from=yesterday'), 400);
    assert.equal(await status('/dashboard/overview?from=2026-02-30'), 400);
    assert.equal(await status('/dashboard/overview?from=2026-05-02&to=2026-05-01'), 400);
    assert.equal(await status('/dashboard/overview?from=2000-01-01&to=2026-01-01'), 400, 'longer than 5 years');
    assert.equal(await status('/dashboard/recent-activity?from=2026-13-01'), 400);
  });

  it('accepts valid ranges, including a single day and open-ended ranges', async () => {
    assert.equal(await status('/dashboard/overview?from=2026-04-01&to=2026-04-30'), 200);
    assert.equal(await status('/dashboard/overview?from=2026-11-06&to=2026-11-06'), 200);
    assert.equal(await status('/dashboard/overview?from=2026-04-01'), 200);
    assert.equal(await status('/dashboard/overview?to=2026-04-01'), 200);
  });

  it('validates numeric parameters', async () => {
    assert.equal(await status('/dashboard/monthly-sales?months=0'), 400);
    assert.equal(await status('/dashboard/monthly-sales?months=25'), 400);
    assert.equal(await status('/dashboard/monthly-sales?months=abc'), 400);
    assert.equal(await status('/dashboard/stock-levels?limit=0'), 400);
    assert.equal(await status('/dashboard/stock-levels?limit=21'), 400);
    assert.equal(await status('/dashboard/recent-activity?limit=51'), 400);
    assert.equal(await status('/dashboard/alerts?expiryDays=0'), 400);
    assert.equal((await t.client.get('/dashboard/monthly-sales?months=12')).data.items.length, 12);
    assert.equal((await t.client.get('/dashboard/monthly-sales')).data.items.length, 6, 'default is six months');
  });
});

describe('Organization settings drive the dashboard', () => {
  it('timezone and reporting period can be changed by an admin and take effect', async () => {
    const t = await h.makeTenant('Settings Org');
    assert.equal((await t.client.get('/dashboard/overview')).data.timezone, 'Asia/Kolkata');
    assert.equal((await t.client.get('/dashboard/overview')).data.period.type, 'fiscal_year');

    const r = await t.client.put('/organization', { timezone: 'America/New_York', settings: { reportingPeriod: 'calendar_year' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.timezone, 'America/New_York');
    const o = (await t.client.get('/dashboard/overview')).data;
    assert.equal(o.timezone, 'America/New_York');
    assert.equal(o.period.type, 'calendar_year');

    assert.equal((await t.client.put('/organization', { timezone: 'Mars/Phobos' })).status, 400);
    assert.equal((await t.client.put('/organization', { settings: { reportingPeriod: 'whenever' } })).status, 400);
    assert.equal((await t.client.put('/organization', { settings: { fiscalYearStartMonth: 13 } })).status, 400);
  });

  it('the signed-in user carries the organization timezone for display', async () => {
    const t = await h.makeTenant('Display TZ Org');
    assert.equal((await t.client.get('/auth/me')).data.user.organization.timezone, 'Asia/Kolkata');
  });
});

describe('Low-stock alert events', () => {
  it('records one LOW_STOCK_ALERT when a sale takes a medicine below its reorder level, and not again while it stays below', async () => {
    const t = await h.makeTenant('Low Stock Event Org');
    const med = await addMedicine(t.client, 'Crossing Tabs', { stock: 12 }); // reorder level defaults to 10
    const sell = (q) => t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: q }] });
    const alerts = async () => (await t.client.get('/activity?limit=100')).data.items.filter((e) => e.action === 'LOW_STOCK_ALERT');

    assert.equal((await sell(1)).status, 201); // 11 left: still at/above 10
    assert.equal((await alerts()).length, 0);
    assert.equal((await sell(2)).status, 201); // 9 left: crossed below 10
    const after = await alerts();
    assert.equal(after.length, 1);
    assert.match(after[0].message, /Crossing Tabs.*9 left.*reorder level 10/);
    assert.equal((await sell(1)).status, 201); // 8 left: already below, so no second alert
    assert.equal((await alerts()).length, 1);

    const feed = (await t.client.get('/dashboard/recent-activity?limit=50')).data.items;
    assert.ok(feed.some((e) => e.action === 'LOW_STOCK_ALERT'), 'it shows in the dashboard feed');
  });

  it('a failed sale records no alert', async () => {
    const t = await h.makeTenant('No Alert Org');
    const med = await addMedicine(t.client, 'Stable Tabs', { stock: 12 });
    assert.equal((await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 500 }] })).status, 409);
    const items = (await t.client.get('/activity?limit=100')).data.items;
    assert.ok(!items.some((e) => e.action === 'LOW_STOCK_ALERT'));
  });
});

describe('Models and indexes', () => {
  it('invoices have the report indexes and the partial unique idempotency index', () => {
    const idx = M.Invoice.schema.indexes();
    const has = (keys, pred = () => true) => idx.some(([k, o]) => JSON.stringify(k) === JSON.stringify(keys) && pred(o || {}));
    assert.ok(has({ organizationId: 1, status: 1, invoiceDate: -1 }), 'status + date index');
    assert.ok(has({ organizationId: 1, invoiceDate: -1 }));
    assert.ok(has({ organizationId: 1, idempotencyKey: 1 }, (o) => o.unique && o.partialFilterExpression), 'unique partial idempotency index');
    assert.ok(has({ organizationId: 1, invoiceNo: 1 }, (o) => o.unique));
  });

  it('only the four defined invoice statuses are allowed', async () => {
    assert.deepEqual([...M.INVOICE_STATUSES], ['draft', 'completed', 'cancelled', 'reversed']);
    await assert.rejects(() => mkInvoice({ status: 'returned', total: 1, at: NOW }), { name: 'ValidationError' });
  });

  it('batches have the sellable-stock / expiry index', () => {
    const idx = M.Batch.schema.indexes().map(([k]) => JSON.stringify(k));
    assert.ok(idx.includes(JSON.stringify({ organizationId: 1, expiryDate: 1, availableQuantity: 1 })));
    assert.ok(idx.includes(JSON.stringify({ organizationId: 1, medicineId: 1, expiryDate: 1 })));
  });

  it('every stored timestamp is a UTC Date and API timestamps are ISO-8601 with Z', async () => {
    const t = await h.makeTenant('UTC Org');
    const med = await addMedicine(t.client, 'Utc Tabs');
    const inv = (await t.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }] })).data;
    assert.match(inv.invoiceDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const raw = await h.tenant.unscoped(() => M.Invoice.findById(inv._id).lean());
    assert.ok(raw.invoiceDate instanceof Date);
    assert.equal(raw.status, 'completed');
  });
});
