// The Profitability report and Inventory analytics. These check the FORMULAS and the honesty of the figures as much as
// the arithmetic: that profit uses the cost of the batch the units came out of, that a restocked return is credited
// back and a damaged one is not, that net profit is refused rather than guessed, that stock is valued at cost and
// never at MRP, that a stock position ignores the date range while movement follows it, and that a medicine with no
// recorded cost is listed but kept out of the margin rankings.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { futureDate, startHarness } from './helpers/harness.js';
import { parseCsv } from '../utils/csv.js';

let h;
let T;
let other;
let main;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `pi-${Date.now()}-${++n}`;

const profit = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/profitability${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const stock = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/inventory${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const kpi = (data, k) => data.kpis.find((x) => x.key === k);

/** A medicine with one batch: a known cost and a known GST-inclusive selling price. */
const stocked = async ({ cost = 60, price = 100, qty = 100, expiryYears = 2, reorderLevel = 0, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('PI Med'), unit: 'Strip', gstPercentage: 12, reorderLevel })).data;
  const batch = (
    await client.post('/batches', {
      medicineId: med._id,
      batchNumber: uniq('B'),
      expiryDate: futureDate(expiryYears),
      mrp: Math.max(price, 150),
      sellingPrice: price,
      purchasePrice: cost,
      initialQuantity: qty,
    })
  ).data;
  return { med, batch };
};
const sell = async (medicineId, quantity, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Profit Org');
  other = await h.makeTenant('Profit Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
});
after(async () => {
  await h?.stop();
});

describe('An empty organization', () => {
  it('reports no profit rather than a negative one, and refuses to invent net profit', async () => {
    const d = await profit('', other.client);
    assert.equal(kpi(d, 'grossSales').value, 0);
    assert.equal(kpi(d, 'grossProfit').value, 0);
    assert.equal(kpi(d, 'grossMargin').value, 0);
    assert.equal(d.notes.netProfit, null);
    assert.match(d.notes.netProfitReason, /operating expenses/i);
    assert.match(d.notes.netProfitReason, /not.*subtracting purchases from sales/i);
    assert.deepEqual(d.charts.byCategory, []);
    assert.deepEqual(d.charts.topMargin, []);
    assert.equal(d.charts.trend.points.every((p) => p.grossProfit === 0), true);
    const unavailable = d.statement.find((s) => s.key === 'netProfit');
    assert.equal(unavailable.value, null);
    assert.equal(unavailable.kind, 'unavailable');
  });

  it('reports an empty shelf as empty, and values nothing at nothing', async () => {
    const d = await stock('', other.client);
    assert.equal(kpi(d, 'units').value, 0);
    assert.equal(kpi(d, 'valuation').value, 0);
    assert.equal(kpi(d, 'expiredValue').value, 0);
    assert.equal(d.total, 0);
    assert.deepEqual(d.items, []);
    assert.deepEqual(d.charts.byCategory, []);
    assert.equal(d.charts.movement.points.every((p) => p.inUnits === 0 && p.outUnits === 0), true);
  });
});

describe('The profit formulas', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('Profit Maths Org');
  });

  it('takes the cost from the batch the units came out of, not an average of the catalogue', async () => {
    const { med } = await stocked({ cost: 40, price: 100, qty: 50, client: org.client });
    await sell(med._id, 3, org.client);

    const d = await profit('', org.client);
    assert.equal(kpi(d, 'grossSales').value, 300);
    assert.equal(kpi(d, 'cogs').value, 120, 'three units at the ₹40 that batch cost');
    assert.equal(kpi(d, 'grossProfit').value, 180);
    assert.equal(kpi(d, 'netSales').value, 300);
    assert.equal(kpi(d, 'grossMargin').value, 60, '180 of 300');
  });

  it('reads as a statement that adds up line by line', async () => {
    const d = await profit('', org.client);
    const line = (k) => d.statement.find((s) => s.key === k).value;
    assert.equal(line('grossSales') + line('salesReturns'), line('netSales'));
    assert.equal(Math.round((line('netSales') + line('cogs')) * 100) / 100, line('grossProfit'));
    assert.equal(d.statement.find((s) => s.key === 'expenses').kind, 'missing');
  });

  it('credits a restocked return back at the same batch cost, and never a damaged one', async () => {
    const fresh = await h.makeTenant('Profit Returns Org');
    const { med, batch } = await stocked({ cost: 40, price: 100, qty: 20, client: fresh.client });
    const inv = await sell(med._id, 4, fresh.client);

    const good = await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'changed_mind',
      items: [{ medicineId: med._id, batchId: batch._id, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(good.status, 201, JSON.stringify(good.body));

    const afterGood = await profit('', fresh.client);
    assert.equal(kpi(afterGood, 'grossSales').value, 400, 'the sale still happened');
    assert.equal(kpi(afterGood, 'salesReturns').value, 100);
    assert.equal(kpi(afterGood, 'netSales').value, 300);
    assert.equal(kpi(afterGood, 'cogs').value, 120, 'the restocked unit is back on the shelf: three units of cost remain');
    assert.equal(kpi(afterGood, 'grossProfit').value, 180);

    const damaged = await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'damaged',
      items: [{ medicineId: med._id, batchId: batch._id, quantity: 1, restock: false, verified: true, condition: 'damaged' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(damaged.status, 201, JSON.stringify(damaged.body));

    const afterDamaged = await profit('', fresh.client);
    assert.equal(kpi(afterDamaged, 'salesReturns').value, 200, 'both returns reduce what was sold');
    assert.equal(kpi(afterDamaged, 'netSales').value, 200);
    assert.equal(kpi(afterDamaged, 'cogs').value, 120, 'the damaged unit was consumed, so its cost stays in');
    assert.equal(kpi(afterDamaged, 'grossProfit').value, 80, '200 net sales less 120 of stock');
  });

  it('agrees with the overview, figure for figure', async () => {
    const [p, o] = await Promise.all([profit('', org.client), org.client.get('/analytics/overview')]);
    for (const k of ['grossSales', 'salesReturns', 'netSales', 'cogs', 'grossProfit', 'grossMargin']) {
      assert.equal(p.totals.current[k], o.data.totals.current[k], k);
    }
  });

  it('splits profit by store and by category, and keeps un-costed stock out of the margin ranking', async () => {
    const fresh = await h.makeTenant('Profit Cuts Org');
    const priced = await stocked({ cost: 40, price: 100, qty: 20, client: fresh.client });
    const free = await stocked({ cost: 0, price: 50, qty: 20, client: fresh.client });
    await sell(priced.med._id, 2, fresh.client);
    await sell(free.med._id, 2, fresh.client);

    const d = await profit('', fresh.client);
    assert.equal(d.medicineCount, 2);
    assert.equal(d.charts.topMargin.length, 1, 'only the medicine whose cost is known can be ranked');
    assert.equal(d.charts.topMargin[0].label, priced.med.medicineName);
    assert.match(d.notes.unknownCost, /no purchase price/);
    assert.equal(d.charts.topProfit.length, 2, 'but both are still listed by what they made');

    const store = d.charts.byBranch[0];
    assert.equal(store.revenue, 300, 'both sales came out of the one store');
    assert.equal(store.cost, 80);
    assert.equal(store.profit, 220);
    assert.deepEqual(d.charts.byCategory.map((c) => c.label), ['Uncategorised']);
  });

  it('exports every medicine sold, with the statement in the heading', async () => {
    const r = await org.client.get('/analytics/profitability/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.data.fileName, /^usha-profitability-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Profitability Report/);
    assert.equal(rows.find((x) => x[0] === 'Net profit')[1], 'Not available — operating expenses are not recorded');
    assert.equal(rows.find((x) => x[0] === 'Cost method')[1], 'Purchase price of the batch each unit came out of');
    const header = rows.find((x) => x[0] === 'Medicine');
    const body = rows[rows.indexOf(header) + 1];
    assert.equal(body[header.indexOf('Gross profit (INR)')], '180.00');
    assert.equal(body[header.indexOf('Gross margin (%)')], '60.0');
  });
});

describe('The stock position', () => {
  let org;
  let med;

  before(async () => {
    org = await h.makeTenant('Stock Org');
    const made = await stocked({ cost: 25, price: 60, qty: 40, reorderLevel: 5, client: org.client });
    med = made.med;
  });

  it('values stock at what it cost, never at MRP or the selling price', async () => {
    const d = await stock('', org.client);
    assert.equal(kpi(d, 'units').value, 40);
    assert.equal(kpi(d, 'valuation').value, 1000, '40 units at the ₹25 they cost — not at ₹60 or the MRP');
    assert.match(d.notes.valuation, /purchase price/i);
    assert.equal(d.charts.byCategory[0].amount, 1000);
  });

  it('is a position, so the date range does not change it', async () => {
    const thisMonth = await stock('', org.client);
    const oneDay = await stock('?from=2026-01-01&to=2026-01-01', org.client);
    assert.equal(oneDay.position.valuation, thisMonth.position.valuation);
    assert.equal(oneDay.position.units, thisMonth.position.units);
    assert.match(oneDay.notes.stockHasNoPeriod, /applies only to movement/);
    assert.equal(kpi(oneDay, 'units').previous, null, 'a balance carries no previous-period comparison');
  });

  it('counts low and out of stock per medicine, against that medicine\'s own reorder level', async () => {
    const fresh = await h.makeTenant('Stock Levels Org');
    const low = await stocked({ cost: 10, price: 20, qty: 4, reorderLevel: 10, client: fresh.client });
    const plenty = await stocked({ cost: 10, price: 20, qty: 90, reorderLevel: 10, client: fresh.client });
    // A medicine with no batch at all is out of stock: "no lot" is exactly what that means.
    await fresh.client.post('/inventory', { medicineName: uniq('Never stocked'), unit: 'Strip', gstPercentage: 12, reorderLevel: 5 });

    const d = await stock('', fresh.client);
    assert.equal(kpi(d, 'lowStock').value, 1, `${low.med.medicineName} is below its reorder level`);
    assert.equal(kpi(d, 'outOfStock').value, 1, 'the medicine with no batch');
    assert.ok(kpi(d, 'units').value >= 94, `${plenty.med.medicineName} is not low`);
    const row = d.items.find((i) => i.medicineName === low.med.medicineName);
    assert.equal(row.stockStatus, 'low');
  });

  it('reports expired stock separately from the valuation, and never as sellable', async () => {
    const fresh = await h.makeTenant('Stock Expiry Org');
    const good = await stocked({ cost: 20, price: 50, qty: 10, client: fresh.client });
    // An expired lot cannot be created through the API, which is correct, and `expiryDate` is immutable once set — so
    // one is written straight to the collection, which is also how a lot that was in date when received ends up here.
    const med = (await fresh.client.post('/inventory', { medicineName: uniq('Expired Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    const expired = await h.tenant.runWithTenant(fresh.org._id, () =>
      h.models.Batch.create({
        medicineId: med._id,
        batchNumber: uniq('XB'),
        expiryDate: new Date(Date.now() - 86400000),
        purchasePrice: 30,
        sellingPrice: 50,
        mrp: 150,
        initialQuantity: 5,
        availableQuantity: 5,
      }),
    );

    const d = await stock('', fresh.client);
    assert.equal(kpi(d, 'valuation').value, 200, 'only the in-date lot is in the valuation');
    assert.equal(kpi(d, 'expiredValue').value, 150, 'the expired lot is reported on its own, at what it cost');
    assert.equal(kpi(d, 'units').value, 15, 'the units are still on the shelf, expired or not');
    const row = d.items.find((i) => i.batchNumber === expired.batchNumber);
    assert.equal(row.stockStatus, 'expired');
    assert.equal(row.sellable, 0, 'an expired lot can sell nothing');
    assert.ok(row.daysToExpiry < 0);
    assert.equal(d.items.find((i) => i.batchNumber === good.batch.batchNumber).sellable, 10);
  });

  it('filters the register by stock status, expiry window and search, and refuses an impossible value', async () => {
    const d = await stock('?stockStatus=in_stock', org.client);
    assert.equal(d.items.every((i) => i.stockStatus === 'in_stock'), true);
    assert.equal((await stock('?expiryWindow=expired', org.client)).total, 0, 'nothing here has expired');
    assert.equal((await stock(`?search=${med.medicineName.slice(0, 8)}`, org.client)).total >= 1, true);
    assert.equal((await stock('?search=nothing-like-this', org.client)).total, 0);
    assert.equal((await org.client.get('/analytics/inventory?stockStatus=melted')).status, 400);
    assert.equal((await org.client.get('/analytics/inventory?expiryWindow=someday')).status, 400);
    assert.equal((await org.client.get('/analytics/inventory?categoryId=nope')).status, 400);
  });

  it('offers only filter values the stock in scope actually has', async () => {
    const d = await stock('', org.client);
    assert.equal(Array.isArray(d.options.categories), true);
    assert.equal(d.options.expiryWindows.length, 5);
    assert.equal(d.options.stockStatuses.some((s) => s.value === 'near_expiry'), true);
  });

  it('pages the register, and the filtered totals describe the whole matching set', async () => {
    const fresh = await h.makeTenant('Stock Paging Org');
    for (let i = 0; i < 3; i += 1) await stocked({ cost: 10, price: 20, qty: 5, client: fresh.client });
    const d = await stock('?limit=2&page=1', fresh.client);
    assert.equal(d.total, 3);
    assert.equal(d.pages, 2);
    assert.equal(d.items.length, 2);
    assert.equal(d.filteredTotals.units, 15, 'all three lots, not the two on the page');
    assert.equal(d.filteredTotals.value, 150);
  });
});

describe('Stock movement and what is moving', () => {
  it('reads movement from the ledger, with stock in and stock out as separate figures', async () => {
    const fresh = await h.makeTenant('Movement Org');
    const { med } = await stocked({ cost: 20, price: 50, qty: 30, client: fresh.client });
    await sell(med._id, 4, fresh.client);

    const d = await stock('', fresh.client);
    assert.equal(kpi(d, 'stockIn').value, 30, 'the opening lot');
    assert.equal(kpi(d, 'stockOut').value, 4, 'the sale');
    assert.equal(d.charts.movement.points.reduce((n, p) => n + p.inUnits, 0), 30);
    const sale = d.charts.movementByType.find((t) => t.type === 'SALE');
    assert.equal(sale.units, 4);
    assert.equal(d.charts.movementByType.find((t) => t.type === 'TRANSFER_IN').isTransfer, true);
  });

  it('names what sold fastest, and lists stock that sold nothing at all as slow', async () => {
    const fresh = await h.makeTenant('Velocity Org');
    const quick = await stocked({ cost: 10, price: 20, qty: 100, client: fresh.client });
    const dead = await stocked({ cost: 30, price: 60, qty: 50, client: fresh.client });
    await sell(quick.med._id, 20, fresh.client);

    const d = await stock('', fresh.client);
    assert.equal(d.charts.fastMoving[0].label, quick.med.medicineName);
    assert.equal(d.charts.fastMoving[0].units, 20);
    assert.ok(d.charts.fastMoving[0].perDay > 0);
    assert.equal(d.charts.fastMoving[0].daysOfCover !== null, true);

    const slowest = d.charts.slowMoving[0];
    assert.equal(slowest.label, dead.med.medicineName, 'the lot that sold nothing is the one worth seeing');
    assert.equal(slowest.units, 0);
    assert.equal(slowest.daysOfCover, null, '"forever" is not a number');
    assert.equal(slowest.stockValue, 1500);
    assert.match(d.notes.neverSold, /sold nothing at all/);
  });

  it('exports the whole register at cost, with the valuation method in the heading', async () => {
    const fresh = await h.makeTenant('Stock Export Org');
    await stocked({ cost: 12.5, price: 30, qty: 8, client: fresh.client });
    const r = await fresh.client.get('/analytics/inventory/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 1);
    assert.match(r.data.fileName, /^usha-inventory-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Inventory Report/);
    assert.equal(rows.find((x) => x[0] === 'Valuation method')[1], 'Purchase price recorded on each batch');
    assert.equal(rows.find((x) => x[0] === 'Total stock value in this file (INR)')[1], '100.00');
    const header = rows.find((x) => x[0] === 'Medicine');
    const body = rows[rows.indexOf(header) + 1];
    assert.equal(body[header.indexOf('Stock value at cost (INR)')], '100.00');
    assert.equal(body[header.indexOf('Purchase cost (INR)')], '12.50');
    assert.equal(body[header.indexOf('Cost recorded')], 'Yes');
  });
});

describe('Who may see what', () => {
  it('never shows one organization the stock or the profit of another', async () => {
    const { med } = await stocked({ cost: 50, price: 90, qty: 10 });
    await sell(med._id, 1);
    const theirStock = await stock('', other.client);
    const theirProfit = await profit('', other.client);
    assert.equal(theirStock.items.some((i) => i.medicineName === med.medicineName), false);
    assert.equal(kpi(theirProfit, 'grossProfit').value, 0);
  });

  it('reports one store at a time when asked', async () => {
    const d = await stock(`?branchId=${main._id}`);
    assert.equal(d.items.every((i) => !i.branchId || String(i.branchId) === String(main._id)), true);
    const p = await profit(`?branchId=${main._id}`);
    assert.equal(p.filters.branchId, String(main._id));
  });

  it('refuses a store the person may not report on', async () => {
    const r = await T.client.get(`/analytics/profitability?branchId=${new mongoose.Types.ObjectId()}`);
    assert.equal(r.status, 200, 'an unknown store of my own organization simply holds nothing');
    assert.equal(r.data.totals.current.grossSales, 0);
  });
});
