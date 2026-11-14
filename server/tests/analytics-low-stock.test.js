// The Low Stock Report. What matters here is that the list is a BUYING list: that it agrees with the inventory
// screen's own definition of low and out, that it counts sellable units rather than units on hand, that a medicine
// with no batch at all is reported as out of stock rather than quietly missing, that "critical" and "out" are kept
// apart, and that the two suggested figures — how many to order and what it would cost — are never invented when
// there is no reorder level or no price ever paid.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { futureDate, startHarness } from './helpers/harness.js';
import { parseCsv } from '../utils/csv.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `ls-${Date.now()}-${++n}`;

const lowStock = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/low-stock${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const card = (d, k) => d.cards.find((c) => c.key === k);
const row = (d, name) => d.items.find((i) => i.medicineName === name);

/** A medicine with a reorder level, and optionally a batch holding stock. */
const medicine = async ({ reorderLevel = 10, name, salt = 'Paracetamol 250 mg', manufacturer = 'MICRO LABS', client = T.client } = {}) =>
  (await client.post('/inventory', { medicineName: name || uniq('Dolo'), unit: 'Strip', gstPercentage: 12, reorderLevel, salt, manufacturer })).data;

const batch = async (medicineId, { qty = 100, cost = 40, price = 100, client = T.client } = {}) => {
  const r = await client.post('/batches', {
    medicineId,
    batchNumber: uniq('B'),
    expiryDate: futureDate(2),
    mrp: Math.max(price, 200),
    sellingPrice: price,
    purchasePrice: cost,
    initialQuantity: qty,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Low Stock Org');
  other = await h.makeTenant('Low Stock Other Org');
});
after(async () => {
  await h?.stop();
});

describe('What lands on the buying list', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('Low Stock Register Org');
    // Plenty in stock: must never appear.
    const healthy = await medicine({ reorderLevel: 10, name: uniq('Healthy'), client: org.client });
    await batch(healthy._id, { qty: 100, client: org.client });
    // At the threshold exactly: low, because the rule is "at or below".
    const atLevel = await medicine({ reorderLevel: 10, name: uniq('AtLevel'), client: org.client });
    await batch(atLevel._id, { qty: 10, client: org.client });
    // Below half the threshold: critical.
    const critical = await medicine({ reorderLevel: 20, name: uniq('Critical'), client: org.client });
    await batch(critical._id, { qty: 4, cost: 25, client: org.client });
    // A medicine that has never had a batch at all: out of stock, and still a buying decision.
    await medicine({ reorderLevel: 10, name: uniq('NeverStocked'), client: org.client });
  });

  it('lists only what needs ordering, and leaves healthy stock alone', async () => {
    const d = await lowStock('?limit=50', org.client);
    assert.equal(d.total, 3, 'the three that need ordering, not the healthy one');
    assert.equal(d.items.some((i) => i.medicineName.startsWith('Healthy')), false);
  });

  it('counts a medicine at exactly its reorder level as low', async () => {
    const d = await lowStock('?limit=50', org.client);
    const r = d.items.find((i) => i.medicineName.startsWith('AtLevel'));
    assert.equal(r.status, 'low', 'at or below the level, not below it');
    assert.equal(r.available, 10);
    assert.equal(r.threshold, 10);
    assert.equal(r.shortfall, 0, 'it is at its minimum, so nothing is needed to get back to it');
  });

  it('keeps critical and out of stock apart, and never counts one as the other', async () => {
    const d = await lowStock('?limit=50', org.client);
    assert.equal(card(d, 'total').value, 3);
    assert.equal(card(d, 'out').value, 1);
    assert.equal(card(d, 'critical').value, 1, 'the item at zero is out, not critical');
    assert.equal(d.summary.low, 1);
    assert.equal(d.items.find((i) => i.medicineName.startsWith('Critical')).status, 'critical');
    assert.equal(d.items.find((i) => i.medicineName.startsWith('NeverStocked')).status, 'out');
  });

  it('reports a medicine with no batch at all as out of stock rather than omitting it', async () => {
    const d = await lowStock('?limit=50', org.client);
    const never = d.items.find((i) => i.medicineName.startsWith('NeverStocked'));
    assert.ok(never, 'no lot is exactly what out of stock means to the person ordering');
    assert.equal(never.available, 0);
    assert.equal(never.statusLabel, 'OUT_OF_STOCK');
  });

  it('puts the most urgent first without being asked', async () => {
    const d = await lowStock('?limit=50', org.client);
    assert.deepEqual(d.items.map((i) => i.status), ['out', 'critical', 'low']);
  });

  it('agrees with Inventory Analytics, which is where the definition lives', async () => {
    const inv = (await org.client.get('/analytics/inventory?limit=1')).data;
    const d = await lowStock('?limit=50', org.client);
    assert.equal(inv.position.low, d.summary.low + d.summary.critical, 'both kinds of "still has stock" are low there');
    assert.equal(inv.position.out, d.summary.out);
  });
});

describe('Stock that cannot be sold', () => {
  it('counts sellable units, not units sitting on the shelf', async () => {
    const org = await h.makeTenant('Low Stock Sellable Org');
    const med = await medicine({ reorderLevel: 10, name: uniq('Reserved'), client: org.client });
    const b = await batch(med._id, { qty: 30, client: org.client });
    assert.equal((await lowStock('', org.client)).total, 0, '30 units against a level of 10 is healthy');

    // Most of it is spoken for: what is left cannot be sold to the next customer.
    await h.tenant.runWithTenant(org.org._id, () => h.models.Batch.updateOne({ _id: b._id }, { $set: { reservedQuantity: 26 } }));

    const d = await lowStock('', org.client);
    assert.equal(d.total, 1, 'four sellable units against a level of 10 is low');
    assert.equal(d.items[0].available, 4);
    assert.equal(d.items[0].status, 'critical');
    assert.match(d.notes.sellable, /reserved for somebody else/);
  });

  it('does not count expired units as stock', async () => {
    const org = await h.makeTenant('Low Stock Expired Org');
    const med = await medicine({ reorderLevel: 10, name: uniq('Expired'), client: org.client });
    await h.tenant.runWithTenant(org.org._id, () =>
      h.models.Batch.create({
        medicineId: med._id,
        batchNumber: uniq('GONE'),
        expiryDate: new Date(Date.now() - 3 * 86400000),
        purchasePrice: 40,
        sellingPrice: 100,
        mrp: 200,
        initialQuantity: 50,
        availableQuantity: 50,
      }),
    );
    const d = await lowStock('', org.client);
    assert.equal(d.total, 1);
    assert.equal(d.items[0].available, 0, 'fifty expired units are not fifty units of stock');
    assert.equal(d.items[0].status, 'out');
  });
});

describe('What to order, and what it would cost', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('Low Stock Order Org');
  });

  it('suggests the quantity that brings a medicine back to its own reorder level', async () => {
    const med = await medicine({ reorderLevel: 50, name: uniq('Suggest'), client: org.client });
    await batch(med._id, { qty: 12, cost: 25, client: org.client });

    const d = await lowStock('?search=Suggest', org.client);
    const r = d.items[0];
    assert.equal(r.available, 12);
    assert.equal(r.shortfall, 38, '50 less the 12 that are left');
    assert.equal(r.lastCost, 25);
    assert.equal(r.estimatedCost, 950, '38 units at the last price actually paid');
    assert.match(d.notes.suggestion, /not a forecast/);
  });

  it('suggests nothing at all when there is no reorder level to return to', async () => {
    const med = await medicine({ reorderLevel: 0, name: uniq('NoLevel'), client: org.client });
    assert.ok(med);

    const d = await lowStock('?search=NoLevel', org.client);
    assert.equal(d.total, 1, 'it still appears, because there is nothing left');
    const r = d.items[0];
    assert.equal(r.status, 'out');
    assert.equal(r.thresholdSet, false);
    assert.equal(r.shortfall, null, 'no minimum means no suggestion — not a guess');
    assert.equal(r.estimatedCost, null);
    assert.match(d.notes.noThreshold, /no reorder level set/);
  });

  it('leaves the cost blank for a medicine nobody has ever bought, rather than calling it free', async () => {
    const med = await medicine({ reorderLevel: 20, name: uniq('NeverBought'), client: org.client });
    assert.ok(med);

    const d = await lowStock('?search=NeverBought', org.client);
    const r = d.items[0];
    assert.equal(r.shortfall, 20, 'the quantity is still arithmetic');
    assert.equal(r.lastCost, null);
    assert.equal(r.estimatedCost, null, 'zero would read as free');
    assert.match(d.notes.noCost, /no purchase price on record/);
  });

  it('says the cost is not known rather than zero when nothing on the list has a price', async () => {
    const org = await h.makeTenant('Low Stock No Price Org');
    await medicine({ reorderLevel: 12, name: uniq('Unpriced'), client: org.client });

    const d = await lowStock('', org.client);
    assert.equal(d.summary.suggestedUnits, 12, 'the quantity is still known');
    assert.equal(d.summary.estimatedCost, 0);
    assert.equal(d.summary.costKnown, false, 'zero rupees would read as free');
    assert.equal(d.summary.noCost, 1);

    const rows = parseCsv((await org.client.get('/analytics/low-stock/export')).data.csv);
    assert.match(rows.find((x) => x[0] === 'Estimated cost (INR)')[1], /^Not known/);
  });

  it('marks the total as partial when only some of the list can be priced', async () => {
    const org = await h.makeTenant('Low Stock Partial Price Org');
    const priced = await medicine({ reorderLevel: 20, name: uniq('Priced'), client: org.client });
    await batch(priced._id, { qty: 5, cost: 10, client: org.client });
    await medicine({ reorderLevel: 10, name: uniq('Unpriced'), client: org.client });

    const d = await lowStock('', org.client);
    assert.equal(d.summary.estimatedCost, 150, '15 units at the one price we know');
    assert.equal(d.summary.costKnown, true);
    assert.equal(d.summary.costIsPartial, true, 'and it is only part of the answer');

    const rows = parseCsv((await org.client.get('/analytics/low-stock/export')).data.csv);
    assert.match(rows.find((x) => x[0] === 'Estimated cost (INR)')[1], /^150\.00 \(partial/);
  });

  it('totals the units and the money across the whole list', async () => {
    const d = await lowStock('?limit=50', org.client);
    const items = d.items;
    assert.equal(d.summary.suggestedUnits, items.reduce((t, r) => t + (r.shortfall || 0), 0));
    assert.equal(d.summary.estimatedCost, Math.round(items.reduce((t, r) => t + (r.estimatedCost || 0), 0) * 100) / 100);
    assert.ok(d.summary.noCost >= 1);
  });
});

describe('Narrowing the list', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('Low Stock Filter Org');
    const a = await medicine({ reorderLevel: 10, name: 'Amoxil Low', salt: 'Amoxicillin 500 mg', manufacturer: 'CIPLA', client: org.client });
    await batch(a._id, { qty: 9, client: org.client });
    await medicine({ reorderLevel: 10, name: 'Crocin Gone', salt: 'Paracetamol 500 mg', manufacturer: 'GSK', client: org.client });
  });

  it('filters by status without making the other cards read zero', async () => {
    const all = await lowStock('', org.client);
    assert.equal(all.total, 2);

    const outOnly = await lowStock('?status=out', org.client);
    assert.equal(outOnly.total, 1, 'the table narrows');
    assert.equal(outOnly.items[0].medicineName, 'Crocin Gone');
    assert.equal(card(outOnly, 'total').value, 2, 'but the cards still describe everything that needs ordering');
    assert.equal(card(outOnly, 'critical').value, 0);
  });

  it('searches by medicine, salt and manufacturer', async () => {
    assert.equal((await lowStock('?search=Amoxil', org.client)).total, 1);
    assert.equal((await lowStock('?search=Amoxicillin', org.client)).total, 1, 'by salt');
    assert.equal((await lowStock('?search=GSK', org.client)).total, 1, 'by manufacturer');
    assert.equal((await lowStock('?search=nothing', org.client)).total, 0);
  });

  it('refuses a question it cannot answer, including a date range', async () => {
    assert.equal((await org.client.get('/analytics/low-stock?status=whatever')).status, 400);
    assert.equal((await org.client.get('/analytics/low-stock?sortBy=vibes')).status, 400);
    assert.equal((await org.client.get('/analytics/low-stock?branchId=nope')).status, 400);
    const withDates = await org.client.get('/analytics/low-stock?from=2026-01-01&to=2026-01-31');
    assert.equal(withDates.status, 400, 'a position cannot be asked for a date range, so the range is refused rather than ignored');
  });

  it('sorts and pages, and says so', async () => {
    const d = await lowStock('?sortBy=medicine&sortDir=asc&limit=1&page=2', org.client);
    assert.equal(d.total, 2);
    assert.equal(d.pages, 2);
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].medicineName, 'Crocin Gone');
  });

  it('carries the product details the buyer identifies the medicine by', async () => {
    const d = await lowStock('?search=Amoxil', org.client);
    const r = d.items[0];
    assert.equal(r.salt, 'Amoxicillin 500 mg');
    assert.equal(r.manufacturer, 'CIPLA');
    assert.equal(r.unit, 'Strip');
    assert.ok(r.id);
  });
});

describe('The report itself', () => {
  it('states that it is a position, with no period anywhere on it', async () => {
    const d = await lowStock('', T.client);
    assert.ok(d.asOf, 'it says when it was true');
    assert.equal(d.period, undefined, 'there is no period on a position');
    assert.match(d.notes.noPeriod, /no date range/);
    assert.match(d.notes.definition, /same definitions as Inventory Analytics/);
    assert.ok(d.timezone);
  });

  it('exports the whole list, with the heading saying it is not a period', async () => {
    const org = await h.makeTenant('Low Stock Export Org');
    const med = await medicine({ reorderLevel: 30, name: 'Pantop 40', client: org.client });
    await batch(med._id, { qty: 5, cost: 12, client: org.client });

    const r = await org.client.get('/analytics/low-stock/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 1);
    assert.match(r.data.fileName, /^usha-low-stock-\d{4}-\d{2}-\d{2}\.csv$/);

    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Low Stock Report/);
    assert.match(rows.find((x) => x[0] === 'Period')[1], /position as at the time of export/);
    assert.equal(rows.find((x) => x[0] === 'Suggested units to order')[1], '25');
    assert.equal(rows.find((x) => x[0] === 'Estimated cost (INR)')[1], '300.00');

    const header = rows.find((x) => x[0] === 'Medicine');
    const body = rows[rows.indexOf(header) + 1];
    assert.equal(body[header.indexOf('Sellable stock')], '5');
    assert.equal(body[header.indexOf('Suggested order')], '25');
    assert.equal(body[header.indexOf('Status')], 'CRITICAL');
  });

  it('says in the file when a medicine has no reorder level and when nothing was ever paid for it', async () => {
    const org = await h.makeTenant('Low Stock Export Gaps Org');
    await medicine({ reorderLevel: 0, name: 'No Level Med', client: org.client });
    await medicine({ reorderLevel: 15, name: 'Never Bought Med', client: org.client });

    const rows = parseCsv((await org.client.get('/analytics/low-stock/export')).data.csv);
    const header = rows.find((x) => x[0] === 'Medicine');
    const body = rows.slice(rows.indexOf(header) + 1);
    const noLevel = body.find((x) => x[0] === 'No Level Med');
    assert.equal(noLevel[header.indexOf('Reorder level')], 'Not set');
    assert.equal(noLevel[header.indexOf('Suggested order')], 'No reorder level set');
    const neverBought = body.find((x) => x[0] === 'Never Bought Med');
    assert.equal(neverBought[header.indexOf('Last purchase price (INR)')], 'Never purchased');
    assert.equal(neverBought[header.indexOf('Estimated cost (INR)')], '');
  });
});

describe('Who sees what', () => {
  it('never shows one organization another organization\'s shortages', async () => {
    const med = await medicine({ reorderLevel: 10, name: uniq('MineOnly') });
    assert.ok(med);
    const theirs = await lowStock('', other.client);
    assert.equal(theirs.items.some((i) => i.medicineName.startsWith('MineOnly')), false);
  });

  it('reports one store at a time when asked', async () => {
    const org = await h.makeTenant('Low Stock Branch Org');
    const main = (await org.client.get('/branches')).data.find((s) => s.isDefault);
    const med = await medicine({ reorderLevel: 10, name: uniq('Branchy'), client: org.client });
    await batch(med._id, { qty: 4, client: org.client });

    const here = await lowStock(`?branchId=${main._id}`, org.client);
    assert.equal(here.items.find((i) => i.medicineName.startsWith('Branchy')).available, 4);

    // Another store of the same organization holds none of it, so there it is out of stock entirely.
    const elsewhere = (await org.client.post('/branches', { name: 'Low Stock North', code: 'LSNORTH' })).data;
    const there = await lowStock(`?branchId=${elsewhere._id}`, org.client);
    assert.equal(there.items.find((i) => i.medicineName.startsWith('Branchy')).status, 'out');
    assert.equal(there.items.find((i) => i.medicineName.startsWith('Branchy')).available, 0);
  });

  it('refuses somebody without permission to read reports', async () => {
    const user = await h.makeUser(T.org, { role: 'STAFF' });
    const client = h.client();
    assert.equal((await client.login(user.email)).status, 200);
    assert.equal((await client.get('/analytics/low-stock')).status, 403);
    assert.equal((await client.get('/analytics/low-stock/export')).status, 403);
    assert.equal((await h.client().get('/analytics/low-stock')).status, 401);
    assert.ok(mongoose.Types.ObjectId.isValid(String(T.org._id)));
  });
});
