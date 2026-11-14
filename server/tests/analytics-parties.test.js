// Customer, supplier and branch analytics. These tests pin down the DEFINITIONS that make these three reports
// meaningful: that a customer is a phone number and an anonymous counter sale is not a customer at all, that "new"
// means first-ever rather than first-in-period, that a balance does not move when the period does, that a supplier
// known only as a name on an old order is still reported, that return rate and lead time mean what they say, and that
// every branch is compared the same way — including a branch that sold nothing.
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
const key = () => `pt-${Date.now()}-${++n}`;

const customers = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/customers${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const suppliers = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/suppliers${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const branchReport = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/branches${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const kpi = (data, k) => data.kpis.find((x) => x.key === k);

const stocked = async ({ cost = 60, price = 100, qty = 200, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('Party Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
  const batch = (
    await client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 200, sellingPrice: price, purchasePrice: cost, initialQuantity: qty })
  ).data;
  return { med, batch };
};
const sell = async (medicineId, quantity, extra = {}, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** A sale dated in the past, which only the database can do: invoices are always billed "now" through the API. */
const backdate = (org, invoiceId, date) =>
  h.tenant.runWithTenant(org._id, () => h.models.Invoice.updateOne({ _id: invoiceId }, { $set: { invoiceDate: date } }));
const makeOrder = (org, over = {}) =>
  h.tenant.runWithTenant(org._id, () =>
    h.models.Order.create({
      orderNo: uniq('ORD'),
      supplier: { name: 'Sun Pharma Distributors', phone: '9811100011' },
      status: 'ordered',
      orderDate: new Date(),
      items: [{ medicineId: new mongoose.Types.ObjectId(), name: 'Dolo 650', unit: 'Strip', quantity: 100, rate: 10, amount: 1000, gstPercent: 12, gstAmount: 120, total: 1120 }],
      totalQuantity: 100,
      subtotal: 1000,
      gstTotal: 120,
      grandTotal: 1120,
      payment: { status: 'unpaid', remaining: 1120 },
      ...over,
    }),
  );

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Parties Org');
  other = await h.makeTenant('Parties Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
});
after(async () => {
  await h?.stop();
});

describe('An empty organization', () => {
  it('has no customers, no suppliers and still lists its stores', async () => {
    const c = await customers('', other.client);
    assert.equal(kpi(c, 'totalCustomers').value, 0);
    assert.equal(c.total, 0);
    assert.deepEqual(c.charts.topCustomers, []);
    assert.equal(c.charts.frequency.length, 5, 'every band is still described, each as zero');
    assert.equal(c.charts.frequency.every((b) => b.customers === 0), true);

    const s = await suppliers('', other.client);
    assert.equal(kpi(s, 'activeSuppliers').value, 0);
    assert.equal(s.total, 0);

    const b = await branchReport('', other.client);
    // An organization that has never traded has no stores either, so the comparison is legitimately empty.
    assert.deepEqual(b.rows, []);
    assert.equal(b.totals.sales, 0);
    assert.equal(b.totals.stores, 0);
    assert.equal(b.totals.margin, null, 'no sales means no margin, not 0%');
    assert.equal(b.leaders.sales, null);
  });
});

describe('Who counts as a customer', () => {
  let org;
  let med;

  before(async () => {
    org = await h.makeTenant('Customers Org');
    med = (await stocked({ price: 100, client: org.client })).med;
  });

  it('treats one phone number as one customer, however the name is typed', async () => {
    await sell(med._id, 1, { customer: { name: 'Anita Sharma', phone: '9876500011' } }, org.client);
    await sell(med._id, 2, { customer: { name: 'Anita S', phone: '9876500011' } }, org.client);

    const d = await customers('', org.client);
    assert.equal(kpi(d, 'totalCustomers').value, 1, 'two visits on one number is one customer');
    assert.equal(kpi(d, 'repeatCustomers').value, 1);
    const row = d.items.find((i) => i.phone === '9876500011');
    assert.equal(row.orders, 2);
    assert.equal(row.spent, 300);
    assert.equal(row.name, 'Anita S', 'the most recent spelling wins');
  });

  it('never counts an anonymous counter sale as a customer, but still reports what it was worth', async () => {
    await sell(med._id, 5, {}, org.client); // no phone number at all

    const d = await customers('', org.client);
    assert.equal(kpi(d, 'totalCustomers').value, 1, 'still just Anita');
    assert.equal(kpi(d, 'walkInSales').value, 500, 'but the anonymous trade is reported on its own');
    assert.equal(d.summary.walkIn.orders, 1);
    assert.equal(d.items.some((i) => !i.identified), false, 'and it is not a row in the customer table');
    assert.ok(d.walkInRow, 'it is handed over separately instead');
    assert.match(d.notes.anonymous, /not counted as a customer/);
  });

  it('counts a customer as new only when their first ever purchase is inside the period', async () => {
    const fresh = await h.makeTenant('New Customers Org');
    const made = await stocked({ price: 100, client: fresh.client });
    const old = await sell(made.med._id, 1, { customer: { name: 'Old Hand', phone: '9000000001' } }, fresh.client);
    await backdate(fresh.org, old._id, new Date('2026-01-15T10:00:00Z'));
    await sell(made.med._id, 1, { customer: { name: 'Old Hand', phone: '9000000001' } }, fresh.client);
    await sell(made.med._id, 1, { customer: { name: 'Brand New', phone: '9000000002' } }, fresh.client);

    const d = await customers('', fresh.client);
    assert.equal(kpi(d, 'totalCustomers').value, 2);
    assert.equal(kpi(d, 'activeCustomers').value, 2, 'both bought in this period');
    assert.equal(kpi(d, 'newCustomers').value, 1, 'only one of them is new to the business');
    assert.equal(d.items.find((i) => i.phone === '9000000002').isNew, true);
    assert.equal(d.items.find((i) => i.phone === '9000000001').isNew, false);
    assert.equal(d.charts.growth.points.reduce((t, p) => t + p.customers, 0), 1, 'the growth curve counts first-ever purchases');
  });

  it('reports outstanding as a balance that the period does not move', async () => {
    const fresh = await h.makeTenant('Credit Customers Org');
    const made = await stocked({ price: 100, client: fresh.client });
    await sell(made.med._id, 3, { paymentType: 'Credit', customer: { name: 'Credit Buyer', phone: '9000000003' } }, fresh.client);

    const thisMonth = await customers('', fresh.client);
    const longAgo = await customers('?from=2026-01-01&to=2026-01-07', fresh.client);
    assert.equal(kpi(thisMonth, 'outstanding').value, 300);
    assert.equal(kpi(longAgo, 'outstanding').value, 300, 'what they owe does not change because you looked at January');
    assert.equal(kpi(longAgo, 'customerSales').value, 0, 'but what they spent in January does');
    assert.equal(kpi(thisMonth, 'outstanding').previous, null, 'a balance carries no previous-period comparison');
    assert.match(thisMonth.notes.outstanding, /balance/);
  });

  it('bands customers by how often they bought, and every band is always described', async () => {
    const d = await customers('', org.client);
    assert.deepEqual(d.charts.frequency.map((b) => b.key), ['once', 'twice', 'few', 'many', 'regular']);
    assert.equal(d.charts.frequency.find((b) => b.key === 'twice').customers, 1, 'Anita bought twice');
  });

  it('filters the table and refuses a filter value it cannot honour', async () => {
    assert.equal((await customers('?search=Anita', org.client)).total, 1);
    assert.equal((await customers('?search=9876500011', org.client)).total, 1);
    assert.equal((await customers('?search=nobody', org.client)).total, 0);
    assert.equal((await customers('?owing=true', org.client)).total, 0, 'nobody here owes anything');
    assert.equal((await org.client.get('/analytics/customers?owing=maybe')).status, 400);
    assert.equal((await org.client.get('/analytics/customers?sortBy=whatever')).status, 400);
  });

  it('withholds contact details from somebody who may not read the invoices they come from', async () => {
    const user = await h.makeUser(org.org, { role: 'STAFF', permissions: ['reports:read'] });
    const client = h.client();
    const signedIn = await client.login(user.email);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

    const d = await customers('', client);
    assert.equal(d.permissions.contacts, false);
    assert.equal(d.items.every((i) => i.phone === null), true);
    assert.match(d.notes.contacts, /do not have permission/);
  });

  it('exports every customer, saying how a customer is identified', async () => {
    const r = await org.client.get('/analytics/customers/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.data.fileName, /^usha-customers-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Customer Insights/);
    assert.equal(rows.find((x) => x[0] === 'Customer identity')[1], 'Phone number recorded on the invoice');
    const header = rows.find((x) => x[0] === 'Customer');
    assert.ok(header.includes('Phone'));
    const body = rows[rows.indexOf(header) + 1];
    assert.equal(body[header.indexOf('Invoices in period')], '2');
    assert.equal(body[header.indexOf('Spent in period (INR)')], '300.00');
  });
});

describe('Supplier performance', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('Suppliers Analytics Org');
    const listed = (await org.client.post('/suppliers', { name: 'Cipla Wholesale', contactPerson: 'Ravi', phone: '9811100022' })).data;
    await makeOrder(org.org, { supplier: { supplierId: listed._id, name: 'Cipla Wholesale', phone: '9811100022' } });
    await makeOrder(org.org, { supplier: { supplierId: listed._id, name: 'Cipla Wholesale' }, grandTotal: 500, subtotal: 450, gstTotal: 50, payment: { status: 'paid', remaining: 0 } });
    // An order from before the Suppliers module existed: a name and nothing else.
    await makeOrder(org.org, { supplier: { name: 'Legacy Traders' }, grandTotal: 800, subtotal: 720, gstTotal: 80, payment: { status: 'unpaid', remaining: 800 } });
    await makeOrder(org.org, { supplier: { name: 'Never Used Ltd' }, status: 'draft' });
  });

  it('groups by the supplier record, and still reports one known only as a name', async () => {
    const d = await suppliers('', org.client);
    assert.equal(kpi(d, 'activeSuppliers').value, 2, 'Cipla and Legacy — the draft was never placed');
    assert.equal(kpi(d, 'purchaseValue').value, 2420, '1120 + 500 + 800');
    assert.equal(kpi(d, 'orders').value, 3);
    assert.equal(kpi(d, 'outstanding').value, 1920, 'the paid order owes nothing');

    const cipla = d.items.find((i) => i.name === 'Cipla Wholesale');
    assert.equal(cipla.linked, true);
    assert.equal(cipla.orders, 2);
    assert.equal(cipla.value, 1620);
    assert.equal(cipla.owed, 1120);

    const legacy = d.items.find((i) => i.name === 'Legacy Traders');
    assert.equal(legacy.linked, false, 'it exists only as a name on an old order');
    assert.equal(legacy.value, 800);
    assert.match(d.notes.unlinked, /only as a name/);
  });

  it('counts total suppliers from the supplier list, not from who was ordered from', async () => {
    const d = await suppliers('', org.client);
    assert.equal(kpi(d, 'totalSuppliers').value, 1, 'only Cipla is actually on the list');
    assert.equal(d.summary.ordered, 2, 'but two suppliers were ordered from');
  });

  it('ranks suppliers by what was bought and by what is owed', async () => {
    const d = await suppliers('', org.client);
    assert.equal(d.charts.topSuppliers[0].name, 'Cipla Wholesale');
    assert.equal(d.charts.mostOwed[0].owed, 1120);
    assert.equal(d.charts.trend.points.reduce((t, p) => t + p.value, 0), 2420);
  });

  it('reports lead time only for orders that were actually received', async () => {
    const fresh = await h.makeTenant('Lead Time Org');
    const placed = new Date(Date.now() - 5 * 86400000);
    await makeOrder(fresh.org, { orderDate: placed, status: 'received', receivedAt: new Date(placed.getTime() + 3 * 86400000) });
    await makeOrder(fresh.org, { orderDate: placed }); // still on its way

    const d = await suppliers('', fresh.client);
    const row = d.items[0];
    assert.equal(row.orders, 2);
    assert.equal(row.leadTime, 3, 'only the received order can say how long it took');
    assert.equal(row.receivedOrders, 1);
    assert.match(d.notes.leadTime, /excluded rather than counted as fast/);
  });

  it('filters and sorts the table, and refuses an impossible filter', async () => {
    assert.equal((await suppliers('?search=Legacy', org.client)).total, 1);
    assert.equal((await suppliers('?owing=true', org.client)).total, 2);
    const asc = await suppliers('?sortBy=value&sortDir=asc', org.client);
    assert.equal(asc.items[0].name, 'Legacy Traders', 'the smaller buyer first');
    assert.equal((await org.client.get('/analytics/suppliers?supplierId=nope')).status, 400);
    assert.equal((await org.client.get('/analytics/suppliers?sortBy=returns')).status, 400, 'returns are joined on after paging, so they cannot be sorted by');
  });

  it('exports every supplier with its return rate and lead time', async () => {
    const r = await org.client.get('/analytics/suppliers/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 2);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Supplier Performance/);
    const header = rows.find((x) => x[0] === 'Supplier');
    const cipla = rows.slice(rows.indexOf(header) + 1).find((x) => x[0] === 'Cipla Wholesale');
    assert.equal(cipla[header.indexOf('Purchase value in period (INR)')], '1620.00');
    assert.equal(cipla[header.indexOf('On supplier list')], 'Yes');
    const legacy = rows.slice(rows.indexOf(header) + 1).find((x) => x[0] === 'Legacy Traders');
    assert.match(legacy[header.indexOf('On supplier list')], /^No/);
  });
});

describe('Branch performance', () => {
  let org;
  let north;
  let def;

  before(async () => {
    org = await h.makeTenant('Branch Analytics Org');
    def = (await org.client.get('/branches')).data.find((s) => s.isDefault);
    north = (await org.client.post('/branches', { name: 'Branch North', code: 'BRNORTH' })).data;
    const made = await stocked({ cost: 60, price: 100, client: org.client });
    await sell(made.med._id, 4, {}, org.client); // the default store
    await makeOrder(org.org, { branchId: def._id });
  });

  it('compares every store the person may see, including one that sold nothing', async () => {
    const d = await branchReport('', org.client);
    assert.equal(d.rows.length, 2);
    const quiet = d.rows.find((r) => r.name === 'Branch North');
    assert.ok(quiet, 'a store with no trade is still compared — "it sold nothing" is the answer somebody wants');
    assert.equal(quiet.sales, 0);
    assert.equal(quiet.invoices, 0);
    assert.equal(quiet.margin, null);

    const busy = d.rows.find((r) => r.id === String(def._id));
    assert.equal(busy.sales, 400);
    assert.equal(busy.invoices, 1);
    assert.equal(busy.cogs, 240, 'four units at the ₹60 they cost');
    assert.equal(busy.profit, 160);
    assert.equal(busy.margin, 40);
    assert.equal(busy.average, 400);
    assert.equal(busy.purchases, 1120);
  });

  it('adds the rows up into the totals, so the table and the headline cannot disagree', async () => {
    const d = await branchReport('', org.client);
    assert.equal(d.totals.sales, d.rows.reduce((t, r) => t + r.sales, 0));
    assert.equal(d.totals.profit, d.rows.reduce((t, r) => t + r.profit, 0));
    assert.equal(d.totals.invoices, 1);
    assert.equal(d.totals.margin, 40);
    assert.equal(d.leaders.sales.id, String(def._id));
    assert.equal(d.leaders.profit.id, String(def._id));
  });

  it('reports inventory value as a position, not a period figure', async () => {
    const d = await branchReport('', org.client);
    const old = await branchReport('?from=2026-01-01&to=2026-01-02', org.client);
    const sumStock = (x) => x.rows.reduce((t, r) => t + r.stockValue, 0);
    assert.equal(sumStock(old), sumStock(d), 'stock on hand does not change because you looked at January');
    assert.equal(old.totals.sales, 0, 'but the trade does');
    assert.match(d.notes.stockHasNoPeriod, /does not follow the date range/);
  });

  it('works out the return rate from what came back against what was sold', async () => {
    const fresh = await h.makeTenant('Branch Returns Org');
    const made = await stocked({ cost: 60, price: 100, client: fresh.client });
    const inv = await sell(made.med._id, 4, {}, fresh.client);
    await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'changed_mind',
      items: [{ medicineId: made.med._id, batchId: made.batch._id, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });

    const d = await branchReport('', fresh.client);
    const row = d.rows.find((r) => r.sales > 0);
    assert.equal(row.sales, 400);
    assert.equal(row.returns, 100);
    assert.equal(row.returnRate, 25);
    assert.equal(row.netSales, 300);
    assert.equal(row.cogs, 180, 'the restocked unit is back on the shelf');
    assert.equal(row.profit, 120);
  });

  it('sorts by any figure in the comparison, and compares with the period before', async () => {
    const d = await branchReport('?sortBy=sales&sortDir=desc', org.client);
    assert.equal(d.rows[0].id, String(def._id));
    assert.equal(d.rows[0].change.sales.isNew, true, 'there was no trade in the previous period');
    const asc = await branchReport('?sortBy=sales&sortDir=asc', org.client);
    assert.equal(asc.rows[0].name, 'Branch North');
    assert.equal((await org.client.get('/analytics/branches?sortBy=vibes')).status, 400);
  });

  it('exports the comparison with an all-stores line at the end', async () => {
    const r = await org.client.get('/analytics/branches/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 2);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Branch Performance/);
    // The heading block also opens a line with "Store", so the column header is the wide row, not the first match.
    const header = rows.find((x) => x[0] === 'Store' && x.length > 3);
    const last = rows[rows.length - 1];
    assert.equal(last[0], 'All stores');
    assert.equal(last[header.indexOf('Total sales (INR)')], '400.00');
    assert.equal(last[header.indexOf('Gross profit (INR)')], '160.00');
  });

  it('shows a person only the stores they may report on', async () => {
    const d = await branchReport(`?branchId=${north._id}`, org.client);
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].id, String(north._id));
    assert.match(d.notes.scope, /every store|only the stores/);
    const forbidden = await org.client.get(`/analytics/branches?branchId=${new mongoose.Types.ObjectId()}`);
    assert.equal(forbidden.status, 200, 'an unknown store of my own organization simply has nothing');
    assert.equal(forbidden.data.rows.length, 0);
  });
});

describe('Organization isolation', () => {
  it('never shows one organization another organization\'s customers, suppliers or stores', async () => {
    const made = await stocked({ price: 100 });
    await sell(made.med._id, 1, { customer: { name: 'Mine Only', phone: '9111111111' } });
    await makeOrder(T.org, { supplier: { name: 'My Supplier Only' } });

    const c = await customers('', other.client);
    assert.equal(c.items.some((i) => i.phone === '9111111111'), false);
    const s = await suppliers('', other.client);
    assert.equal(s.items.some((i) => i.name === 'My Supplier Only'), false);
    const b = await branchReport('', other.client);
    assert.equal(b.rows.some((r) => r.id === String(main._id)), false);
  });
});
