// Business Insights. The whole value of this endpoint is that it only ever says things the data supports, so these
// tests are mostly about SILENCE: nothing is claimed below a threshold, nothing is claimed about a cause, an empty
// organization gets an honest empty answer, and every insight carries the figure it rests on and a link to the report
// that proves it. The rest check that each rule fires on data built to trigger exactly that rule.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let empty;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `in-${Date.now()}-${++n}`;

const insights = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/insights${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const find = (d, k) => d.insights.find((i) => i.key === k);

const stocked = async ({ cost = 60, price = 100, qty = 500, reorderLevel = 0, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('Insight Med'), unit: 'Strip', gstPercentage: 12, reorderLevel })).data;
  // The MRP has to be at least the selling price, or the batch is refused — and a refused batch would show up much
  // later as a confusing "insufficient stock" when the sale is attempted.
  const made = await client.post('/batches', {
    medicineId: med._id,
    batchNumber: uniq('B'),
    expiryDate: futureDate(2),
    mrp: Math.max(price, 200),
    sellingPrice: price,
    purchasePrice: cost,
    initialQuantity: qty,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { med, batch: made.data };
};
const sell = async (medicineId, quantity, extra = {}, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** Moves an invoice into the previous period, which only the database can do. */
const backdate = (org, id, date) => h.tenant.runWithTenant(org._id, () => h.models.Invoice.updateOne({ _id: id }, { $set: { invoiceDate: date } }));
const daysAgo = (d) => new Date(Date.now() - d * 86400000);

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Insights Org');
  empty = await h.makeTenant('Insights Empty Org');
});
after(async () => {
  await h?.stop();
});

describe('When there is nothing to say', () => {
  it('says nothing, and says what it looked at', async () => {
    const d = await insights('', empty.client);
    assert.deepEqual(d.insights, []);
    assert.equal(d.counts.total, 0);
    assert.equal(d.examined.invoices, 0);
    assert.equal(d.examined.batchesOnHand, 0);
    assert.match(d.notes.silence, /nothing crossed a threshold/);
    assert.match(d.notes.causation, /never why/);
    assert.ok(d.thresholds.changePercent > 0, 'the thresholds it used are published with the answer');
    assert.ok(d.generatedAt);
  });

  it('stays quiet about a change too small to matter, and about one on too small a base', async () => {
    const org = await h.makeTenant('Insights Quiet Org');
    const { med } = await stocked({ price: 100, client: org.client });
    // ₹200 against ₹100 is a 100% rise — but on a base far below the minimum, so it is noise, not news.
    const old = await sell(med._id, 1, {}, org.client);
    await backdate(org.org, old._id, daysAgo(20));
    await sell(med._id, 2, {}, org.client);

    const d = await insights('?from=2026-11-01&to=2026-11-30', org.client);
    assert.equal(find(d, 'salesChange'), undefined, 'a 100% rise on ₹100 of trade is not reported');
  });
});

describe('How trade is moving', () => {
  it('reports a fall against the comparable previous period, without claiming a cause', async () => {
    const org = await h.makeTenant('Insights Decline Org');
    const { med } = await stocked({ price: 1000, qty: 500, client: org.client });
    // 8 days each side of a 16-day window, so "previous period" is the 8 days before it.
    const before = await sell(med._id, 30, {}, org.client); // ₹30,000
    await backdate(org.org, before._id, daysAgo(12));
    const now = await sell(med._id, 10, {}, org.client); // ₹10,000
    await backdate(org.org, now._id, daysAgo(2));

    const from = daysAgo(7).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const d = await insights(`?from=${from}&to=${to}`, org.client);
    const change = find(d, 'salesChange');
    assert.ok(change, 'the fall is reported');
    assert.equal(change.severity, 'warning');
    assert.match(change.title, /fell 66.7% against the previous 8 days/);
    assert.match(change.detail, /nothing here identifies a cause/i);
    assert.equal(change.metric.format, 'percent');
    assert.equal(change.evidence.current.value, 10000);
    assert.equal(change.evidence.previous.value, 30000);
    assert.match(change.link, /^\/analytics\/sales\?from=/);
    assert.ok(change.linkLabel);
  });

  it('reports a rise as good news, with the profit change beside it', async () => {
    const org = await h.makeTenant('Insights Growth Org');
    const { med } = await stocked({ cost: 400, price: 1000, qty: 500, client: org.client });
    const before = await sell(med._id, 10, {}, org.client);
    await backdate(org.org, before._id, daysAgo(12));
    await sell(med._id, 30, {}, org.client);

    const from = daysAgo(7).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const d = await insights(`?from=${from}&to=${to}`, org.client);
    assert.equal(find(d, 'salesChange').severity, 'positive');
    assert.match(find(d, 'salesChange').title, /rose 200%/);
    const profit = find(d, 'profitChange');
    assert.ok(profit, 'profit is reported on its own terms, not inferred from sales');
    assert.equal(profit.severity, 'positive');
    assert.match(profit.detail, /batch each unit came out of/);
  });
});

describe('What the stock is doing', () => {
  it('names the best seller with the units behind it, and how long the stock would last', async () => {
    const org = await h.makeTenant('Insights Seller Org');
    const { med } = await stocked({ price: 100, qty: 200, client: org.client });
    await sell(med._id, 40, {}, org.client);

    const d = await insights('', org.client);
    const best = find(d, 'bestSeller');
    assert.ok(best);
    assert.match(best.title, new RegExp(`${med.medicineName} sold the most units`));
    assert.equal(best.metric.value, 40);
    assert.equal(best.evidence.revenue.value, 4000);
    assert.match(best.detail, /Stock on hand would last about/);
  });

  it('points out money tied up in stock that sold nothing at all', async () => {
    const org = await h.makeTenant('Insights Dead Org');
    const moving = await stocked({ price: 100, qty: 50, client: org.client });
    await stocked({ cost: 100, price: 200, qty: 60, client: org.client }); // ₹6,000 of cost, never sold
    await sell(moving.med._id, 5, {}, org.client);

    const d = await insights('', org.client);
    const dead = find(d, 'deadStock');
    assert.ok(dead, 'stock with no sales is worth saying');
    assert.equal(dead.severity, 'opportunity');
    assert.equal(dead.metric.value, 6000);
    assert.match(dead.detail, /no sales in the/);
    assert.match(dead.link, /^\/analytics\/inventory/);
  });

  it('separates stock that is about to expire from stock that already has', async () => {
    const org = await h.makeTenant('Insights Expiry Org');
    const med = (await org.client.post('/inventory', { medicineName: uniq('Expiring'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    // Expiring soon, through the API.
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await org.client.post('/batches', { medicineId: med._id, batchNumber: uniq('SOON'), expiryDate: soon, mrp: 200, sellingPrice: 150, purchasePrice: 100, initialQuantity: 30 });
    // Already expired: the expiry date is immutable, so this lot is written straight to the collection.
    await h.tenant.runWithTenant(org.org._id, () =>
      h.models.Batch.create({
        medicineId: med._id,
        batchNumber: uniq('GONE'),
        expiryDate: daysAgo(3),
        purchasePrice: 50,
        sellingPrice: 150,
        mrp: 200,
        initialQuantity: 10,
        availableQuantity: 10,
      }),
    );

    const d = await insights('', org.client);
    const near = find(d, 'nearExpiry');
    assert.ok(near, 'what is about to go is one statement');
    assert.equal(near.metric.value, 3000, '30 units at the ₹100 they cost');
    assert.match(near.detail, /nearest is/);

    const gone = find(d, 'expiredStock');
    assert.ok(gone, 'and what already went is another');
    assert.equal(gone.severity, 'critical', 'expired stock outranks everything else on the list');
    assert.equal(gone.metric.value, 500);
    assert.equal(d.insights[0].key, 'expiredStock', 'the most serious thing is first');
  });

  it('suggests reordering only what is both low and actually selling', async () => {
    const org = await h.makeTenant('Insights Reorder Org');
    const selling = await stocked({ price: 100, qty: 12, reorderLevel: 20, client: org.client }); // low AND sells
    await stocked({ price: 100, qty: 5, reorderLevel: 20, client: org.client }); // low, but never sold
    await sell(selling.med._id, 4, {}, org.client);

    const d = await insights('', org.client);
    const reorder = find(d, 'reorder');
    assert.ok(reorder);
    assert.equal(reorder.metric.value, 1, 'only the one that is selling is a buying opportunity');
    assert.match(reorder.detail, new RegExp(selling.med.medicineName));
    assert.equal(reorder.evidence.lowStock.value >= 1, true);
  });
});

describe('What is coming back and what is owed', () => {
  it('reports a product returned on an unusual share of what was sold', async () => {
    const org = await h.makeTenant('Insights Returns Org');
    const { med, batch } = await stocked({ price: 100, qty: 100, client: org.client });
    const inv = await sell(med._id, 10, {}, org.client);
    const r = await org.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'quality_issue',
      items: [{ medicineId: med._id, batchId: batch._id, quantity: 4, restock: false, verified: true, condition: 'damaged' }],
      refund: { method: 'Cash', status: 'completed', amount: 400 },
      idempotencyKey: key(),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const d = await insights('', org.client);
    const high = find(d, 'highReturns');
    assert.ok(high);
    assert.equal(high.metric.value, 40, 'four of ten units came back');
    assert.equal(high.evidence.returned.value, 4);
    assert.match(high.detail, /The reason on each return says more/);
  });

  it('names the biggest debtor as a balance, not a figure for the period', async () => {
    const org = await h.makeTenant('Insights Debt Org');
    const { med } = await stocked({ price: 1000, qty: 100, client: org.client });
    await sell(med._id, 5, { paymentType: 'Credit', customer: { name: 'Slow Payer', phone: '9000012345' } }, org.client);

    const d = await insights('', org.client);
    const owed = find(d, 'receivables');
    assert.ok(owed);
    assert.match(owed.title, /Slow Payer owes/);
    assert.equal(owed.metric.value, 5000);
    assert.match(owed.detail, /balance as it stands now/);
    assert.match(owed.link, /owing=true/);
  });
});

describe('Which store', () => {
  it('compares stores only when there is more than one with trade', async () => {
    const org = await h.makeTenant('Insights Branch Org');
    const { med } = await stocked({ price: 100, qty: 100, client: org.client });
    await sell(med._id, 5, {}, org.client);
    const one = await insights('', org.client);
    assert.equal(find(one, 'bestBranch'), undefined, 'one store is not a comparison');
  });

  it('names the store that billed the most, with its share', async () => {
    const org = await h.makeTenant('Insights Two Stores Org');
    const stores = (await org.client.get('/branches')).data;
    const main = stores.find((s) => s.isDefault) || stores[0];
    const north = (await org.client.post('/branches', { name: 'Insights North', code: 'INNORTH' })).data;
    const { med } = await stocked({ price: 100, qty: 200, client: org.client });
    await sell(med._id, 6, {}, org.client);
    // A sale recorded against the other store, written directly: billing always uses the signed-in store.
    const second = await sell(med._id, 2, {}, org.client);
    await h.tenant.runWithTenant(org.org._id, () =>
      h.models.Invoice.updateOne({ _id: second._id }, { $set: { branchId: north._id, branchName: north.name } }),
    );

    const d = await insights('', org.client);
    const best = find(d, 'bestBranch');
    assert.ok(best, 'two stores with trade is a comparison');
    assert.equal(best.metric.value, 600);
    assert.match(best.detail, /75% of all sales/);
    assert.ok(main);
  });
});

describe('The shape of every insight', () => {
  it('carries a severity, a figure and a link that can be checked', async () => {
    const org = await h.makeTenant('Insights Shape Org');
    const { med } = await stocked({ price: 100, qty: 100, client: org.client });
    await sell(med._id, 20, {}, org.client);

    const d = await insights('', org.client);
    assert.ok(d.insights.length > 0);
    for (const i of d.insights) {
      assert.ok(i.key && i.title && i.detail, `${i.key} says what it is`);
      assert.ok(['critical', 'warning', 'opportunity', 'positive', 'info'].includes(i.severity), `${i.key} has a severity`);
      assert.ok(i.metric && i.metric.label && ['money', 'number', 'percent', 'text'].includes(i.metric.format), `${i.key} carries its figure`);
      assert.ok(i.link && i.link.startsWith('/'), `${i.key} links to the report behind it`);
      assert.ok(i.linkLabel, `${i.key} says where the link goes`);
    }
    const order = d.insights.map((i) => ['critical', 'warning', 'opportunity', 'positive', 'info'].indexOf(i.severity));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the most serious first');
  });

  it('honours the limit, the period and the store, and refuses an impossible question', async () => {
    const d = await insights('?limit=1');
    assert.ok(d.insights.length <= 1);
    assert.equal((await T.client.get('/analytics/insights?limit=99')).status, 400);
    assert.equal((await T.client.get('/analytics/insights?from=2026-13-01')).status, 400);
    assert.equal((await T.client.get('/analytics/insights?branchId=nope')).status, 400);
    const scoped = await insights(`?branchId=${new mongoose.Types.ObjectId()}`);
    assert.equal(scoped.filters.branchId !== null, true);
    assert.deepEqual(scoped.insights.filter((i) => i.key === 'salesChange'), [], 'a store with no trade produces no trade insight');
  });

  it('never leaks another organization into an insight', async () => {
    const { med } = await stocked({ price: 1000, qty: 100 });
    await sell(med._id, 50);
    const theirs = await insights('', empty.client);
    assert.deepEqual(theirs.insights, []);
    assert.equal(theirs.examined.sales, 0);
  });
});
