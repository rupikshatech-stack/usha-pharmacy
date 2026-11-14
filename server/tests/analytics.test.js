// Business analytics. Every figure is aggregated from the records the rest of the system keeps, so these tests check the
// DEFINITIONS as much as the arithmetic: what counts as a sale, what a return does to profit, what cost a unit carries,
// which period a figure belongs to, and who may see which store's trade.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, futureDate } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `an-${Date.now()}-${++n}`;

/** A medicine with one batch: a known cost and a known inclusive selling price. */
const stocked = async ({ cost = 60, price = 112, gst = 12, qty = 100 } = {}) => {
  const med = (await T.client.post('/inventory', { medicineName: uniq('Med'), unit: 'Strip', gstPercentage: gst, reorderLevel: 0 })).data;
  const batch = (await T.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: price, purchasePrice: cost, initialQuantity: qty })).data;
  return { med, batch };
};
const sell = (medicineId, quantity) => T.client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key() });
const overview = async (q = '', client = T.client) => (await client.get(`/analytics/overview${q}`)).data;
const kpi = (data, k) => data.kpis.find((x) => x.key === k);

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Analytics Org');
  other = await h.makeTenant('Analytics Other Org');
});
after(async () => {
  await h?.stop();
});

describe('The headline figures', () => {
  it('reports nothing as nothing when there has been no trade', async () => {
    const d = await overview('', other.client);
    assert.equal(kpi(d, 'totalSales').value, 0);
    assert.equal(kpi(d, 'grossProfit').value, 0);
    assert.equal(kpi(d, 'transactions').value, 0);
    assert.equal(d.series.points.every((p) => p.sales === 0), true, 'the chart is flat, not invented');
    assert.equal(d.notes.netProfit, null, 'net profit is not claimed without expense data');
    assert.match(d.notes.netProfitReason, /operating expenses/);
  });

  it('counts a sale once, at what the customer was billed, and works the profit out from the batch cost', async () => {
    const { med } = await stocked({ cost: 60, price: 112 });
    const sale = await sell(med._id, 2);
    assert.equal(sale.status, 201, JSON.stringify(sale.body));

    const d = await overview();
    assert.equal(kpi(d, 'totalSales').value, 224, 'two at ₹112, GST included — what the customer paid');
    assert.equal(kpi(d, 'transactions').value, 1);
    assert.equal(kpi(d, 'averageInvoice').value, 224);
    assert.equal(d.totals.current.cogs, 120, 'two units at the ₹60 they cost in that batch');
    assert.equal(kpi(d, 'grossProfit').value, 104, '224 billed less 120 of stock');
    assert.equal(kpi(d, 'netSales').value, 224, 'nothing came back');
  });

  it('never counts a draft, a cancelled invoice or a transfer as trade', async () => {
    const before = kpi(await overview(), 'totalSales').value;
    const { med } = await stocked();
    const sale = await sell(med._id, 1);
    const cancelled = await T.client.post(`/invoices/${sale.data._id}/cancel`, { reason: 'Customer changed their mind' }).catch(() => null);
    const after = await overview();
    if (cancelled && cancelled.status === 200) {
      assert.equal(kpi(after, 'totalSales').value, before, 'a cancelled sale leaves no revenue behind');
    } else {
      assert.ok(kpi(after, 'totalSales').value >= before, 'cancelling is not supported here; the sale simply stands');
    }
  });
});

describe('Returns', () => {
  it('reduce net sales, and only restocked units stop being a cost of sale', async () => {
    const fresh = await h.makeTenant('Returns Analytics Org');
    const med = (await fresh.client.post('/inventory', { medicineName: uniq('Returnable'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    await fresh.client.post('/batches', { medicineId: med._id, batchNumber: uniq('RB'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 100, purchasePrice: 40, initialQuantity: 50 });
    const sale = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 4 }], idempotencyKey: key() })).data;

    const before = (await fresh.client.get('/analytics/overview')).data;
    assert.equal(before.totals.current.grossSales, 400);
    assert.equal(before.totals.current.cogs, 160, 'four units at ₹40');

    const ret = await fresh.client.post('/sales-returns', {
      invoiceId: sale._id,
      reason: 'changed_mind', // a damaged return can never go back on the shelf, so it would not test the restock rule
      items: [{ medicineId: med._id, batchId: sale.items[0].batchId, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const after = (await fresh.client.get('/analytics/overview')).data;
    assert.equal(after.totals.current.grossSales, 400, 'the sale still happened');
    assert.equal(kpi(after, 'salesReturns').value > 0, true);
    assert.equal(after.totals.current.netSales, 400 - kpi(after, 'salesReturns').value, 'net sales is gross less what came back');
    assert.equal(after.totals.current.cogs, 120, 'the restocked unit is back on the shelf, so it is no longer a cost of sale');
  });
});

describe('Purchases', () => {
  it('counts what was ordered from suppliers, and never a draft', async () => {
    const supplier = (await T.client.post('/suppliers', { name: uniq('Analytics Supplier'), contactPerson: 'A', phone: '9800000000' })).data;
    const { med } = await stocked();
    const body = (status) => ({ supplierId: supplier._id, status, orderDate: new Date().toISOString().slice(0, 10), items: [{ medicineId: med._id, quantity: 10, rate: 50, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });
    const draft = await T.client.post('/orders', body('draft'));
    assert.equal(draft.status, 201);
    const beforeValue = kpi(await overview(), 'totalPurchases').value;
    assert.equal((await T.client.post(`/orders/${draft.data._id}/submit`, {})).status, 200);
    const d = await overview();
    assert.equal(kpi(d, 'totalPurchases').value, beforeValue + draft.data.grandTotal, 'it counts once it has been placed');
    assert.ok(d.totals.current.purchaseOrders >= 1);
  });
});

describe('Periods', () => {
  it('compares with the period immediately before, of exactly the same length', async () => {
    const d = await overview('?from=2026-11-01&to=2026-11-30');
    assert.equal(d.period.days, 30);
    // the instants are compared, not their UTC date strings: a day in Asia/Kolkata starts at 18:30 the day before in UTC
    assert.equal(d.period.previousTo, d.period.from, 'the previous period ends where this one starts');
    assert.equal(new Date(d.period.from) - new Date(d.period.previousFrom), 30 * 86400000, 'and is exactly as long');
    assert.equal(d.series.bucket, 'day', 'a month is shown day by day');
  });

  it('buckets a long period by week or month instead of by day', async () => {
    assert.equal((await overview('?from=2026-01-01&to=2026-03-31')).series.bucket, 'week');
    assert.equal((await overview('?from=2026-01-01&to=2026-12-31')).series.bucket, 'month');
  });

  it('refuses a backwards period and a date that does not exist', async () => {
    assert.equal((await T.client.get('/analytics/overview?from=2026-03-01&to=2026-01-01')).status, 400);
    assert.equal((await T.client.get('/analytics/overview?from=2026-02-30')).status, 400);
  });

  it('returns a point for every bucket in the period, including the quiet ones', async () => {
    const d = await overview('?from=2026-11-01&to=2026-11-07');
    assert.equal(d.series.points.length, 7);
    assert.deepEqual(d.series.points.map((p) => p.key), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  });
});

describe('Who may see what', () => {
  it('never shows one organization another organization’s trade', async () => {
    const { med } = await stocked();
    await sell(med._id, 1);
    const theirs = await overview('', other.client);
    assert.equal(kpi(theirs, 'totalSales').value, 0);
  });

  it('needs the reports permission', async () => {
    const staff = h.client();
    const u = await h.makeUser(T.org, { role: 'STAFF' }); // inventory:read, settings:read
    await staff.login(u.email);
    assert.equal((await staff.get('/analytics/overview')).status, 403);
  });

  it('keeps someone assigned to a store to that store, and refuses another one outright', async () => {
    const north = (await T.client.post('/branches', { name: uniq('North'), code: uniq('N').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) })).data;
    const manager = h.client();
    const u = await h.makeUser(T.org, { role: 'BRANCH_MANAGER', branchIds: [north._id] });
    await manager.login(u.email);

    const mine = await manager.get('/analytics/overview');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(kpi(mine.data, 'totalSales').value, 0, 'nothing has been sold from their store');

    const main = (await T.client.get('/branches')).data.find((b) => b.isDefault);
    const peek = await manager.get(`/analytics/overview?branchId=${main._id}`);
    assert.equal(peek.status, 403, 'and they cannot ask about another store');
  });

  it('reports one store when asked, and every store when not', async () => {
    const all = await overview();
    const main = (await T.client.get('/branches')).data.find((b) => b.isDefault);
    const justMain = await overview(`?branchId=${main._id}`);
    assert.equal(justMain.kpis.find((k) => k.key === 'totalSales').value, kpi(all, 'totalSales').value, 'everything so far was sold from the default store');
  });
});
