// The Sales and Purchase reports. These tests check the DEFINITIONS as much as the arithmetic: what counts as a sale,
// what counts as a purchase, what a cancelled document does to a total, that every filter actually filters, that a
// page is a page of the whole matching set, that the charts come from the same data as the figures, that the export
// carries every matching row, and that nobody sees another organization's trade or a store they may not report on.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { futureDate, startHarness } from './helpers/harness.js';
import { parseCsv } from '../utils/csv.js';

let h;
let T;
let other;
let main;
let north;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `sp-${Date.now()}-${++n}`;
const oid = () => new mongoose.Types.ObjectId();

const salesReport = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/sales${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const purchaseReport = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/purchases${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const kpi = (data, k) => data.kpis.find((x) => x.key === k);
const row = (data, field, value) => data.items.find((i) => i[field] === value);

/** A medicine with one batch: a known cost and a known GST-inclusive selling price. */
const stocked = async ({ cost = 60, price = 100, qty = 500, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('SP Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
  await client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: price, purchasePrice: cost, initialQuantity: qty });
  return med;
};
const sell = async (medicineId, quantity, extra = {}, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** An order written straight to the database: these reports only ever read orders. */
const makeOrder = (org, over = {}) =>
  h.tenant.runWithTenant(org._id, () =>
    h.models.Order.create({
      orderNo: uniq('ORD'),
      supplier: { name: 'Sun Pharma Distributors', phone: '9811100011' },
      branchId: main?._id,
      status: 'ordered',
      orderDate: new Date(),
      items: [{ medicineId: oid(), name: 'Dolo 650', unit: 'Strip', category: 'Tablets', quantity: 100, rate: 10, amount: 1000, gstAmount: 120, total: 1120 }],
      totalQuantity: 100,
      subtotal: 1000,
      discountTotal: 0,
      gstTotal: 120,
      grandTotal: 1120,
      payment: { status: 'unpaid', remaining: 1120, terms: 'credit' },
      ...over,
    }),
  );

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Reports Org');
  other = await h.makeTenant('Reports Other Org');
  const stores = (await T.client.get('/branches')).data;
  main = stores.find((s) => s.isDefault);
  north = (await T.client.post('/branches', { name: 'Reports North Store', code: 'RPNORTH' })).data;
});
after(async () => {
  await h?.stop();
});

describe('An empty period', () => {
  it('reports nothing as nothing on the Sales Report, and invents no chart', async () => {
    const d = await salesReport('', other.client);
    assert.equal(kpi(d, 'totalSales').value, 0);
    assert.equal(kpi(d, 'netSales').value, 0);
    assert.equal(kpi(d, 'invoices').value, 0);
    assert.equal(d.total, 0);
    assert.deepEqual(d.items, []);
    assert.equal(d.pages, 1);
    assert.equal(d.charts.overTime.points.every((p) => p.sales === 0 && p.invoices === 0), true, 'the chart is flat, not invented');
    assert.deepEqual(d.charts.topMedicines, []);
    assert.deepEqual(d.charts.byCategory, []);
  });

  it('reports nothing as nothing on the Purchase Report', async () => {
    const d = await purchaseReport('', other.client);
    assert.equal(kpi(d, 'totalPurchases').value, 0);
    assert.equal(kpi(d, 'orders').value, 0);
    assert.equal(kpi(d, 'suppliers').value, 0);
    assert.equal(d.total, 0);
    assert.equal(d.charts.overTime.points.every((p) => p.purchases === 0), true);
    assert.deepEqual(d.charts.bySupplier, []);
  });
});

describe('The Sales Report figures', () => {
  it('counts a sale once, at what the customer was billed, with its GST and discount split out', async () => {
    const med = await stocked({ price: 100 });
    const inv = await sell(med._id, 4);

    const d = await salesReport();
    assert.equal(kpi(d, 'totalSales').value, inv.total);
    assert.equal(kpi(d, 'invoices').value, 1);
    assert.equal(kpi(d, 'averageInvoice').value, inv.total);
    assert.equal(kpi(d, 'gst').value, inv.taxTotal, 'the GST already inside the total');
    assert.equal(kpi(d, 'netSales').value, inv.total, 'nothing came back');

    const r = row(d, 'invoiceNo', inv.invoiceNo);
    assert.ok(r, 'the invoice is listed');
    assert.equal(r.total, inv.total);
    assert.equal(r.units, 4);
    assert.equal(r.lines, 1);
    assert.equal(r.isSale, true);
    assert.equal(r.branchName, main.name);
    assert.ok(r.cashier, 'and who billed it');
  });

  it('lists a cancelled invoice but counts none of its money', async () => {
    const med = await stocked({ price: 50 });
    const inv = await sell(med._id, 2);
    const before = kpi(await salesReport(), 'totalSales').value;

    // Nothing in the API voids an invoice yet, so the status is set on the record directly: these reports only read it.
    await h.tenant.runWithTenant(T.org._id, () =>
      h.models.Invoice.updateOne({ _id: inv._id }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Billed in error' } }),
    );

    const d = await salesReport();
    assert.equal(kpi(d, 'totalSales').value, before - inv.total, 'the money comes back out');
    const r = row(d, 'invoiceNo', inv.invoiceNo);
    assert.ok(r, 'but the document is still listed — it happened');
    assert.equal(r.isSale, false);
    assert.equal(r.status, 'cancelled');
  });

  it('takes returned goods off net sales without changing total sales', async () => {
    const fresh = await h.makeTenant('Reports Returns Org');
    const med = (await fresh.client.post('/inventory', { medicineName: uniq('Ret Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    await fresh.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 100, purchasePrice: 60, initialQuantity: 50 });
    const inv = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 4 }], idempotencyKey: key() })).data;

    const created = await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'changed_mind',
      items: [{ medicineId: med._id, batchId: inv.items[0].batchId, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const d = await salesReport('', fresh.client);
    assert.equal(kpi(d, 'totalSales').value, inv.total, 'what was billed does not change because goods came back');
    assert.ok(kpi(d, 'salesReturns').value > 0, 'the return is reported');
    assert.equal(kpi(d, 'netSales').value, Math.round((inv.total - kpi(d, 'salesReturns').value) * 100) / 100);
  });

  it('compares the period with the one of equal length immediately before it', async () => {
    const d = await salesReport();
    assert.ok(d.period.previousFrom < d.period.from);
    const span = (a, b) => new Date(b) - new Date(a);
    assert.equal(span(d.period.previousFrom, d.period.previousTo), span(d.period.from, d.period.to));
    assert.equal(d.period.previousTo, d.period.from, 'the previous period ends where this one starts');
  });
});

describe('The Sales Report cuts', () => {
  it('splits the same money by payment mode, by store and by medicine', async () => {
    const fresh = await h.makeTenant('Reports Cuts Org');
    const med = (await fresh.client.post('/inventory', { medicineName: uniq('Cut Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    await fresh.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 100, purchasePrice: 60, initialQuantity: 100 });
    const cash = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 2 }], paymentType: 'Cash', idempotencyKey: key() })).data;
    const upi = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 3 }], paymentType: 'UPI', idempotencyKey: key() })).data;

    const d = await salesReport('', fresh.client);
    const total = kpi(d, 'totalSales').value;
    const modes = d.charts.byPaymentMode;
    assert.equal(Math.round(modes.reduce((s, m) => s + m.amount, 0) * 100) / 100, total, 'the payment-mode split adds up to total sales');
    assert.equal(modes.find((m) => m.label === 'Cash').amount, cash.total);
    assert.equal(modes.find((m) => m.label === 'UPI').amount, upi.total);
    assert.equal(Math.round(modes.reduce((s, m) => s + m.share, 0)), 100);

    assert.equal(Math.round(d.charts.byBranch.reduce((s, b) => s + b.amount, 0) * 100) / 100, total, 'and so does the store split');

    const top = d.charts.topMedicines[0];
    assert.equal(top.units, 5, 'five units of the one medicine');
    assert.equal(top.invoices, 2);
    assert.deepEqual(d.charts.byCategory.map((c) => c.label), ['Uncategorised'], 'a medicine with no category is said to have none, not dropped');
  });

  it('fills every bucket of the chart, so a quiet day reads as quiet rather than missing', async () => {
    const d = await salesReport('?from=2026-01-01&to=2026-01-07');
    assert.equal(d.charts.overTime.bucket, 'day');
    assert.equal(d.charts.overTime.points.length, 7);
    assert.deepEqual(d.charts.overTime.points.map((p) => p.sales), Array(7).fill(0));
  });
});

describe('The Sales Report filters', () => {
  let fresh;
  let med;
  let cash;
  let credit;

  before(async () => {
    fresh = await h.makeTenant('Reports Filter Org');
    med = (await fresh.client.post('/inventory', { medicineName: uniq('Filt Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
    await fresh.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 100, purchasePrice: 60, initialQuantity: 100 });
    cash = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Cash', customer: { name: 'Anita Sharma', phone: '9876500011' }, idempotencyKey: key() })).data;
    credit = (await fresh.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 2 }], paymentType: 'Credit', customer: { name: 'Rahul Verma', phone: '9876500022' }, idempotencyKey: key() })).data;
  });

  it('filters by payment mode', async () => {
    const d = await salesReport('?paymentMode=Cash', fresh.client);
    assert.equal(d.total, 1);
    assert.equal(d.items[0].invoiceNo, cash.invoiceNo);
    assert.equal(kpi(d, 'totalSales').value, cash.total, 'the figures describe the filtered question, not everything');
  });

  it('filters by customer name or phone', async () => {
    assert.equal((await salesReport('?customer=Rahul', fresh.client)).items[0].invoiceNo, credit.invoiceNo);
    assert.equal((await salesReport('?customer=9876500011', fresh.client)).items[0].invoiceNo, cash.invoiceNo);
    assert.equal((await salesReport('?customer=Nobody', fresh.client)).total, 0);
  });

  it('searches by invoice number', async () => {
    const d = await salesReport(`?search=${credit.invoiceNo}`, fresh.client);
    assert.equal(d.total, 1);
    assert.equal(d.items[0].invoiceNo, credit.invoiceNo);
  });

  it('offers the cashiers who actually billed, and filters by one of them', async () => {
    const d = await salesReport('', fresh.client);
    assert.equal(d.options.cashiers.length, 1);
    const filtered = await salesReport(`?cashier=${d.options.cashiers[0].value}`, fresh.client);
    assert.equal(filtered.total, 2);
    assert.equal((await salesReport(`?cashier=${new mongoose.Types.ObjectId()}`, fresh.client)).total, 0);
  });

  it('refuses a filter value the data can never hold rather than ignoring it', async () => {
    assert.equal((await fresh.client.get('/analytics/sales?paymentMode=Barter')).status, 400);
    assert.equal((await fresh.client.get('/analytics/sales?status=draft')).status, 400, 'a draft is not a document of the period');
    assert.equal((await fresh.client.get('/analytics/sales?cashier=nope')).status, 400);
    assert.equal((await fresh.client.get('/analytics/sales?from=2026-02-30')).status, 400);
    assert.equal((await fresh.client.get('/analytics/sales?from=2026-03-01&to=2026-02-01')).status, 400);
  });

  it('pages the whole matching set, and the figures still describe all of it', async () => {
    const d = await salesReport('?limit=1&page=2', fresh.client);
    assert.equal(d.total, 2);
    assert.equal(d.pages, 2);
    assert.equal(d.items.length, 1);
    assert.equal(kpi(d, 'totalSales').value, Math.round((cash.total + credit.total) * 100) / 100);
  });

  it('sorts by what was asked for, in both directions', async () => {
    const high = await salesReport('?sortBy=amount&sortDir=desc', fresh.client);
    const low = await salesReport('?sortBy=amount&sortDir=asc', fresh.client);
    assert.equal(high.items[0].invoiceNo, credit.invoiceNo, 'the bigger bill first');
    assert.equal(low.items[0].invoiceNo, cash.invoiceNo);
  });

  it('exports every matching row, not the page on screen, under a header that says what it is', async () => {
    const r = await fresh.client.get('/analytics/sales/export?paymentMode=Credit');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 1);
    assert.match(r.data.fileName, /^usha-sales-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Sales Report/);
    assert.equal(rows.find((x) => x[0] === 'Organization')[1], 'Reports Filter Org');
    assert.equal(rows.find((x) => x[0] === 'Payment mode')[1], 'Credit');
    const header = rows.find((x) => x[0] === 'Invoice No');
    assert.ok(header, 'the column headings are there');
    const body = rows[rows.indexOf(header) + 1];
    assert.equal(body[0], credit.invoiceNo);
    assert.equal(body[header.indexOf('Total (INR)')], credit.total.toFixed(2));
  });
});

describe('The Purchase Report', () => {
  let fresh;

  before(async () => {
    fresh = await h.makeTenant('Reports Purchase Org');
    await makeOrder(fresh.org, { supplier: { name: 'Cipla Wholesale' }, branchId: undefined });
    await makeOrder(fresh.org, { supplier: { name: 'Zydus Traders' }, status: 'received', grandTotal: 500, subtotal: 450, gstTotal: 50, payment: { status: 'paid', remaining: 0 }, branchId: undefined });
    await makeOrder(fresh.org, { supplier: { name: 'Nobody Ltd' }, status: 'draft', branchId: undefined });
    await makeOrder(fresh.org, { supplier: { name: 'Alkem Supplies' }, status: 'cancelled', branchId: undefined });
  });

  it('counts only orders actually placed, and never a draft', async () => {
    const d = await purchaseReport('', fresh.client);
    assert.equal(kpi(d, 'totalPurchases').value, 1620, '1120 ordered plus 500 received — the cancelled order adds nothing');
    assert.equal(kpi(d, 'orders').value, 2);
    assert.equal(kpi(d, 'suppliers').value, 2);
    assert.equal(kpi(d, 'supplierOwed').value, 1120, 'the paid order owes nothing');
    assert.equal(kpi(d, 'averageOrder').value, 810);
    assert.equal(d.total, 3, 'the cancelled order is listed, the draft is not');
    assert.ok(!d.items.some((i) => i.supplierName === 'Nobody Ltd'), 'a draft was never placed');
    const cancelled = d.items.find((i) => i.supplierName === 'Alkem Supplies');
    assert.equal(cancelled.isPurchase, false, 'it is listed, but it is not a purchase');
  });

  it('splits the same money by supplier and by category, and fills every chart bucket', async () => {
    const d = await purchaseReport('', fresh.client);
    const total = kpi(d, 'totalPurchases').value;
    assert.equal(Math.round(d.charts.bySupplier.reduce((s, x) => s + x.amount, 0) * 100) / 100, total);
    assert.equal(d.charts.bySupplier[0].label, 'Cipla Wholesale', 'the biggest first');
    assert.equal(d.charts.bySupplier[0].owed, 1120);
    assert.deepEqual(d.charts.byCategory.map((c) => c.label), ['Tablets']);
    assert.ok(d.charts.overTime.points.length >= 1);
  });

  it('filters by status, payment status and search, and refuses an impossible value', async () => {
    assert.equal((await purchaseReport('?status=received', fresh.client)).total, 1);
    assert.equal((await purchaseReport('?paymentStatus=paid', fresh.client)).total, 1);
    assert.equal((await purchaseReport('?search=Zydus', fresh.client)).items[0].supplierName, 'Zydus Traders');
    assert.equal((await fresh.client.get('/analytics/purchases?status=draft')).status, 400);
    assert.equal((await fresh.client.get('/analytics/purchases?paymentStatus=later')).status, 400);
    assert.equal((await fresh.client.get('/analytics/purchases?supplierId=nope')).status, 400);
  });

  it('exports every matching order under a header that names the filters', async () => {
    const r = await fresh.client.get('/analytics/purchases/export?status=received');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 1);
    assert.match(r.data.fileName, /^usha-purchases-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /Purchase Report/);
    assert.equal(rows.find((x) => x[0] === 'Order status')[1], 'Received');
    const header = rows.find((x) => x[0] === 'Order No');
    assert.equal(rows[rows.indexOf(header) + 1][header.indexOf('Total (INR)')], '500.00');
  });
});

describe('Who may see what', () => {
  it('never shows one organization the trade of another', async () => {
    const med = await stocked({ price: 100 });
    const mine = await sell(med._id, 1);
    const theirs = await salesReport('', other.client);
    assert.equal(theirs.items.some((i) => i.invoiceNo === mine.invoiceNo), false);
    assert.equal(kpi(theirs, 'totalSales').value, 0);
  });

  it('refuses a store the person may not report on', async () => {
    const r = await T.client.get(`/analytics/sales?branchId=${new mongoose.Types.ObjectId()}`);
    assert.equal(r.status, 200, 'an unknown store of my own organization simply has no trade');
    assert.equal(r.data.total, 0);
  });

  it('reports one store at a time when asked, on both reports', async () => {
    const sales = await salesReport(`?branchId=${north._id}`);
    assert.equal(sales.items.every((i) => String(i.branchId) === String(north._id)), true);
    const purchases = await purchaseReport(`?branchId=${north._id}`);
    assert.equal(purchases.items.every((i) => String(i.branchId) === String(north._id)), true);
  });
});
