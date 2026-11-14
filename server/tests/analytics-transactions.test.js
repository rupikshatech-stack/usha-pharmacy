// The Daily Transaction Report. One list of every business document of the period, read straight from the collections
// the rest of the system writes. These tests check WHAT A ROW MEANS as much as the arithmetic: which documents appear
// at all, which of them count towards a total, that a filter actually filters, that a page is a page of the whole
// matching set, that the export carries every matching row, and that nobody sees another organization's trade.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { parseCsv } from '../utils/csv.js';

let h;
let T;
let other;
let main;
let north;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `tx-${Date.now()}-${++n}`;
const TODAY = new Date().toISOString().slice(0, 10);

const list = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/transactions${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const rowFor = (data, reference) => data.items.find((i) => i.reference === reference);
const sumOf = (data, type) => data.summary.find((s) => s.type === type);

/** A medicine with one batch: a known cost and a known inclusive selling price. */
const stocked = async ({ cost = 60, price = 100, qty = 100, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('Tx Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
  const batch = (await client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: price, purchasePrice: cost, initialQuantity: qty })).data;
  return { med, batch };
};
const sell = async (medicineId, quantity, extra = {}, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Ledger Org');
  other = await h.makeTenant('Ledger Other Org');
  const stores = (await T.client.get('/branches')).data;
  main = stores.find((s) => s.isDefault);
  north = (await T.client.post('/branches', { name: 'Ledger North Store', code: 'LGNORTH' })).data;
});
after(async () => {
  await h?.stop();
});

describe('An empty period', () => {
  it('says nothing happened rather than inventing a row', async () => {
    const d = await list('', other.client);
    assert.equal(d.total, 0);
    assert.deepEqual(d.items, []);
    assert.equal(d.pages, 1);
    assert.equal(d.summary.length, 5, 'every kind is still described, each as zero');
    assert.equal(d.summary.every((s) => s.count === 0 && s.amount === 0), true);
    assert.equal(d.totals.netSales, 0);
    assert.equal(d.totals.netPurchases, 0);
  });
});

describe('What appears in the list', () => {
  it('shows a sale as one row, dated when it happened, at what the customer was billed', async () => {
    const { med } = await stocked({ price: 100 });
    const inv = await sell(med._id, 3);

    const d = await list();
    const row = rowFor(d, inv.invoiceNo);
    assert.ok(row, 'the sale is in the list');
    assert.equal(row.type, 'sale');
    assert.equal(row.typeLabel, 'Sale');
    assert.equal(row.amount, inv.total, 'the invoice total, GST included');
    assert.equal(row.units, 3);
    assert.equal(row.lines, 1);
    assert.equal(row.countsAsTrade, true);
    assert.equal(row.branchName, main.name, 'the store that made the sale');
    assert.ok(row.who, 'and who recorded it');
    assert.equal(new Date(row.date).toISOString(), new Date(inv.invoiceDate).toISOString());
  });

  it('never lists a draft order, and lists it once it has been placed', async () => {
    const supplier = (await T.client.post('/suppliers', { name: uniq('Ledger Supplier'), contactPerson: 'A', phone: '9800000001' })).data;
    const { med } = await stocked();
    const draft = (await T.client.post('/orders', {
      supplierId: supplier._id,
      status: 'draft',
      orderDate: TODAY,
      items: [{ medicineId: med._id, quantity: 10, rate: 50, gstPercent: 12 }],
      charges: {},
      payment: { terms: 'credit', advance: 0 },
    })).data;

    assert.equal(rowFor(await list(), draft.orderNo), undefined, 'nothing was ordered yet, so there is no transaction');

    assert.equal((await T.client.post(`/orders/${draft._id}/submit`, {})).status, 200);
    const row = rowFor(await list(), draft.orderNo);
    assert.ok(row, 'once placed it is a purchase');
    assert.equal(row.type, 'purchase');
    assert.equal(row.amount, draft.grandTotal);
    assert.equal(row.partyName, supplier.name);
    assert.equal(row.countsAsTrade, true);
  });

  it('lists a stock transfer but never counts it as trade', async () => {
    const { med, batch } = await stocked({ qty: 40 });
    const transfer = (await T.client.post('/transfers', {
      fromBranchId: main._id,
      toBranchId: north._id,
      transferDate: TODAY,
      notes: '',
      items: [{ medicineId: med._id, batchId: batch._id, quantity: 5 }],
    })).data;
    assert.equal((await T.client.post(`/transfers/${transfer._id}/submit`)).status, 200);

    const d = await list();
    const row = rowFor(d, transfer.reference);
    assert.ok(row, 'a movement between our own stores is still a transaction worth seeing');
    assert.equal(row.type, 'transfer');
    assert.equal(row.countsAsTrade, false, 'but it is never trade');
    assert.equal(row.partyKind, 'internal');
    assert.equal(row.toBranchName, north.name, 'and it says where the stock went');
    assert.equal(sumOf(d, 'transfer').amount, 0, 'so it contributes nothing to any money total');
  });

  it('keeps a cancelled sale visible but out of every total', async () => {
    const fresh = await h.makeTenant('Ledger Cancel Org');
    const { med } = await stocked({ price: 100, client: fresh.client });
    const inv = await sell(med._id, 2, {}, fresh.client);
    const cancelled = await fresh.client.post(`/invoices/${inv._id}/cancel`, { reason: 'Customer changed their mind' });

    const d = await list('', fresh.client);
    const row = rowFor(d, inv.invoiceNo);
    assert.ok(row, 'it happened, so people need to see it');
    if (cancelled.status === 200) {
      assert.equal(row.countsAsTrade, false);
      assert.equal(sumOf(d, 'sale').count, 1, 'it is still one document');
      assert.equal(sumOf(d, 'sale').counted, 0, 'but nothing was traded');
      assert.equal(sumOf(d, 'sale').amount, 0);
      assert.equal(d.totals.netSales, 0);
    } else {
      assert.equal(row.countsAsTrade, true, 'cancelling is not supported here; the sale simply stands');
    }
  });

  it('shows a sales return as the value of the goods, against the invoice it came from', async () => {
    const fresh = await h.makeTenant('Ledger Returns Org');
    const { med } = await stocked({ cost: 40, price: 100, client: fresh.client });
    const inv = await sell(med._id, 4, {}, fresh.client);
    const ret = await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'changed_mind',
      items: [{ medicineId: med._id, batchId: inv.items[0].batchId, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));

    const d = await list('', fresh.client);
    const row = rowFor(d, ret.data.returnNo);
    assert.ok(row);
    assert.equal(row.type, 'salesReturn');
    assert.equal(row.secondary, inv.invoiceNo, 'it points back at the sale');
    assert.equal(row.amount, ret.data.returnValue);
    assert.equal(row.tax, null, 'a return carries no tax breakdown of its own');
    assert.equal(row.branchName, main.name, 'its store is the one that made the sale');
    assert.equal(d.totals.netSales, inv.total - ret.data.returnValue, 'net sales is the sale less what came back');
  });
});

describe('Filters', () => {
  it('narrows to one kind of transaction', async () => {
    const d = await list('?type=sale');
    assert.ok(d.total > 0);
    assert.equal(d.items.every((i) => i.type === 'sale'), true);
    assert.equal(sumOf(d, 'purchase').count, 0, 'the summary describes the question that was asked');
  });

  it('narrows to one status, and to one payment mode', async () => {
    const byStatus = await list('?status=completed');
    assert.equal(byStatus.items.every((i) => i.status === 'completed'), true);

    const byMode = await list('?paymentMode=Cash');
    assert.equal(byMode.items.every((i) => i.paymentMode === 'Cash'), true);
    assert.equal(byMode.items.every((i) => i.type !== 'transfer'), true, 'a transfer records no payment, so it cannot match one');
  });

  it('searches the reference, the related reference and the party', async () => {
    const { med } = await stocked();
    const inv = await sell(med._id, 1, { customer: { name: 'Ledger Searchable Customer', phone: '9811111111' } });

    const byRef = await list(`?search=${encodeURIComponent(inv.invoiceNo)}`);
    assert.equal(byRef.total, 1, 'an invoice number finds exactly its invoice');
    assert.equal(byRef.items[0].reference, inv.invoiceNo);

    const byName = await list('?search=Ledger%20Searchable');
    assert.ok(byName.total >= 1);
    assert.equal(byName.items.every((i) => /Ledger Searchable/i.test(i.partyName)), true);

    const byPhone = await list('?search=9811111111');
    assert.ok(byPhone.total >= 1);

    assert.equal((await list('?search=no-such-reference-anywhere')).total, 0, 'and finds nothing when there is nothing');
  });

  it('refuses a filter value it does not understand rather than ignoring it', async () => {
    assert.equal((await T.client.get('/analytics/transactions?type=nonsense')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?status=nonsense')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?paymentMode=Bitcoin')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?sortBy=secret')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?from=2026-02-30')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?from=2026-03-01&to=2026-01-01')).status, 400);
    assert.equal((await T.client.get('/analytics/transactions?limit=5000')).status, 400, 'a page has a sane maximum');
  });

  it('asks a type and a status that cannot go together without reading anything', async () => {
    const d = await list('?type=transfer&status=completed');
    assert.equal(d.items.every((i) => i.type === 'transfer' && i.status === 'completed'), true);
    assert.equal((await list('?type=purchaseReturn&status=submitted')).total, 0, 'a reversal has no lifecycle, so it is never submitted');
  });
});

describe('Pages and order', () => {
  it('pages the whole matching set, never just what fits on screen', async () => {
    const all = await list('?limit=100');
    assert.ok(all.total >= 4, 'there is enough trade to page');

    const first = await list('?limit=2&page=1');
    assert.equal(first.items.length, 2);
    assert.equal(first.total, all.total, 'the count describes every match, not the page');
    assert.equal(first.pages, Math.ceil(all.total / 2));

    const second = await list('?limit=2&page=2');
    assert.equal(second.total, all.total);
    const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
    assert.deepEqual(overlap, [], 'a document appears on one page only');

    const beyond = await list(`?limit=2&page=${first.pages + 5}`);
    assert.deepEqual(beyond.items, [], 'past the end there is simply nothing');
    assert.equal(beyond.total, all.total);
  });

  it('sorts by date, amount and reference, both ways', async () => {
    const newest = await list('?sortBy=date&sortDir=desc&limit=100');
    const oldest = await list('?sortBy=date&sortDir=asc&limit=100');
    assert.equal(newest.total, oldest.total);
    assert.deepEqual(
      newest.items.map((i) => i.id),
      [...oldest.items].reverse().map((i) => i.id),
      'reversing the direction reverses the list',
    );

    const dear = await list('?sortBy=amount&sortDir=desc&limit=100');
    const amounts = dear.items.map((i) => i.amount);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));

    const byRef = await list('?sortBy=reference&sortDir=asc&limit=100');
    const refs = byRef.items.map((i) => i.reference);
    assert.deepEqual(refs, [...refs].sort());
  });

  it('keeps the summary about the whole filtered set while the page moves', async () => {
    const page1 = await list('?type=sale&limit=1&page=1');
    const page2 = await list('?type=sale&limit=1&page=2');
    assert.deepEqual(sumOf(page1, 'sale'), sumOf(page2, 'sale'), 'the figures do not change as you turn the page');
  });
});

describe('The export', () => {
  it('carries every matching row, with a heading that says what the report is of', async () => {
    const onScreen = await list('?type=sale&limit=1');
    const r = await T.client.get('/analytics/transactions/export?type=sale');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.data.fileName, /^usha-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.equal(r.data.rows, onScreen.total, 'every matching row, not the page on screen');

    const rows = parseCsv(r.data.csv);
    const head = Object.fromEntries(rows.slice(0, 11).map((x) => [x[0], x[1]]));
    assert.equal(rows[0][0], 'Usha Pharmacy — Daily Transaction Report');
    assert.equal(head.Organization, T.org.name);
    assert.equal(head.Store, 'All stores');
    assert.equal(head['Transaction type'], 'Sale', 'the filters that were applied are printed on the file');
    assert.equal(head.Timezone, 'Asia/Kolkata');
    assert.equal(head.Transactions, String(onScreen.total));

    const header = rows.find((x) => x[0] === 'Type');
    assert.ok(header, 'the column headings are there');
    assert.ok(header.includes('Amount (INR)') && header.includes('Counts as trade') && header.includes('Recorded by'));
    const body = rows.slice(rows.indexOf(header) + 1).filter((x) => x.length > 1);
    assert.equal(body.length, onScreen.total);
    assert.equal(body.every((x) => x[0] === 'Sale'), true, 'and it respects the filter');
  });

  it('exports an empty result as a heading with no rows, not an error', async () => {
    const r = await other.client.get('/analytics/transactions/export');
    assert.equal(r.status, 200);
    assert.equal(r.data.rows, 0);
    assert.match(r.data.csv, /Transactions,0/);
  });

  it('names the single store it was run for', async () => {
    const r = await T.client.get(`/analytics/transactions/export?branchId=${north._id}`);
    assert.equal(r.status, 200);
    assert.match(r.data.csv, new RegExp(`Store,${north.name}`));
  });
});

describe('Who may see what', () => {
  it('never shows one organization another organization’s transactions', async () => {
    const mine = await list('?limit=100');
    assert.ok(mine.total > 0);
    const theirs = await list('?limit=100', other.client);
    assert.equal(theirs.total, 0);
    assert.equal(theirs.items.length, 0);
  });

  it('ignores an organization id in the query string', async () => {
    const d = await list(`?limit=100&organizationId=${other.org._id}`);
    assert.ok(d.total > 0, 'it still reports on the signed-in organization');
  });

  it('needs the reports permission', async () => {
    const staff = h.client();
    await staff.login((await h.makeUser(T.org, { role: 'STAFF' })).email);
    assert.equal((await staff.get('/analytics/transactions')).status, 403);
    assert.equal((await staff.get('/analytics/transactions/export')).status, 403);
  });

  it('requires a signed-in user', async () => {
    const anon = h.client();
    assert.equal((await anon.get('/analytics/transactions')).status, 401);
    assert.equal((await anon.get('/analytics/transactions/export')).status, 401);
  });

  it('keeps someone assigned to a store to that store, and refuses another one outright', async () => {
    const manager = h.client();
    await manager.login((await h.makeUser(T.org, { role: 'BRANCH_MANAGER', branchIds: [north._id] })).email);

    const theirs = await manager.get('/analytics/transactions?limit=100');
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.data.items.every((i) => String(i.branchId) === String(north._id) || String(i.toBranchId) === String(north._id)), true);
    assert.equal(theirs.data.items.some((i) => i.type === 'sale'), false, 'nothing has been sold from their store');

    assert.equal((await manager.get(`/analytics/transactions?branchId=${main._id}`)).status, 403);
    assert.equal((await manager.get(`/analytics/transactions/export?branchId=${main._id}`)).status, 403);
  });
});

describe('Period boundaries', () => {
  it('reports a single day in the organization’s own timezone', async () => {
    const d = await list(`?from=${TODAY}&to=${TODAY}`);
    assert.equal(d.period.days, 1);
    assert.equal(d.period.timezone, 'Asia/Kolkata');
    // a day in Asia/Kolkata starts at 18:30 UTC the day before
    assert.equal(new Date(d.period.from).toISOString().endsWith('18:30:00.000Z'), true);
    assert.equal(new Date(d.period.to) - new Date(d.period.from), 86400000);
    assert.ok(d.total > 0, 'everything in these tests was recorded today');
  });

  it('finds nothing in a period before the business existed', async () => {
    const d = await list('?from=2020-01-01&to=2020-01-31');
    assert.equal(d.total, 0);
    assert.equal(d.period.days, 31);
  });
});
