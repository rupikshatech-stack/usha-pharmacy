// The GST report. These tests check that the report REPORTS rather than recalculates: that every figure comes from the
// tax each document recorded, that inclusive pricing is respected (tax is split out of the price, never added on top),
// that CGST and SGST halve the tax and IGST replaces them, that a cancelled invoice charged nobody any tax, that the
// returns adjustment is derived from the original invoice line's rate, that round-off is never counted as tax, and
// that the net position is output less input — with the disclaimer carried into the export.
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
const key = () => `gst-${Date.now()}-${++n}`;

const gst = async (q = '', client = T.client) => {
  const r = await client.get(`/analytics/gst${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};

/** A medicine at a known GST rate, with one batch at a known inclusive selling price. */
const stocked = async ({ gstPercent = 12, price = 112, cost = 60, qty = 100, client = T.client } = {}) => {
  const med = (await client.post('/inventory', { medicineName: uniq('GST Med'), unit: 'Strip', gstPercentage: gstPercent, reorderLevel: 0 })).data;
  const batch = (
    await client.post('/batches', {
      medicineId: med._id,
      batchNumber: uniq('B'),
      expiryDate: futureDate(2),
      mrp: Math.max(price, 200),
      sellingPrice: price,
      purchasePrice: cost,
      initialQuantity: qty,
    })
  ).data;
  return { med, batch };
};
const sell = async (medicineId, quantity, extra = {}, client = T.client) => {
  const r = await client.post('/invoices', { items: [{ medicineId, quantity }], idempotencyKey: key(), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** An order written straight to the database: this report only reads orders. */
const makeOrder = (org, over = {}) =>
  h.tenant.runWithTenant(org._id, () =>
    h.models.Order.create({
      orderNo: uniq('ORD'),
      supplier: { name: 'Sun Pharma Distributors', gstin: '27AAACS1234A1Z5' },
      status: 'ordered',
      orderDate: new Date(),
      items: [{ medicineId: new mongoose.Types.ObjectId(), name: 'Dolo 650', unit: 'Strip', quantity: 100, rate: 10, amount: 1000, discountAmount: 0, gstPercent: 12, gstAmount: 120, total: 1120 }],
      totalQuantity: 100,
      subtotal: 1000,
      discountTotal: 0,
      gstTotal: 120,
      grandTotal: 1120,
      payment: { status: 'unpaid', remaining: 1120 },
      ...over,
    }),
  );

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('GST Org');
  other = await h.makeTenant('GST Other Org');
  main = (await T.client.get('/branches')).data.find((s) => s.isDefault);
});
after(async () => {
  await h?.stop();
});

describe('An empty period', () => {
  it('reports no tax rather than an estimate, and still says what the report is', async () => {
    const d = await gst('', other.client);
    assert.equal(d.summary.output.tax, 0);
    assert.equal(d.summary.input.tax, 0);
    assert.equal(d.summary.net.tax, 0);
    assert.deepEqual(d.byRate, []);
    assert.deepEqual(d.hsn, []);
    assert.equal(d.total, 0);
    assert.match(d.notes.disclaimer, /not a GST return/i);
    assert.match(d.notes.inclusivePricing, /split out of the price/i);
  });
});

describe('Tax charged on sales', () => {
  let org;

  before(async () => {
    org = await h.makeTenant('GST Sales Org');
  });

  it('splits the tax out of an inclusive price and halves it into CGST and SGST', async () => {
    const { med } = await stocked({ gstPercent: 12, price: 112, client: org.client });
    const inv = await sell(med._id, 1, {}, org.client);

    const d = await gst('', org.client);
    assert.equal(d.summary.output.total, 112, 'the customer paid ₹112 — tax was never added on top');
    assert.equal(d.summary.output.taxable, 100, 'the part that is not tax');
    assert.equal(d.summary.output.tax, 12);
    assert.equal(d.summary.output.cgst, 6);
    assert.equal(d.summary.output.sgst, 6);
    assert.equal(d.summary.output.igst, 0);
    assert.equal(d.summary.output.taxable + d.summary.output.tax, inv.total - inv.roundOff, 'taxable plus tax is the payable before rounding');

    const rate = d.byRate.find((r) => r.rate === 12);
    assert.equal(rate.taxable, 100);
    assert.equal(rate.tax, 12);
    assert.equal(rate.units, 1);
  });

  it('reports each rate on its own line, and the lines add back up to the total', async () => {
    const five = await stocked({ gstPercent: 5, price: 105, client: org.client });
    await sell(five.med._id, 2, {}, org.client);

    const d = await gst('', org.client);
    const rates = d.byRate.map((r) => r.rate);
    assert.deepEqual(rates, [...rates].sort((a, b) => a - b), 'in rate order');
    assert.ok(rates.includes(5) && rates.includes(12));
    const sum = (k) => Math.round(d.byRate.reduce((t, r) => t + r[k], 0) * 100) / 100;
    assert.equal(sum('taxable'), d.summary.output.taxable);
    assert.equal(sum('tax'), d.summary.output.tax);
    assert.equal(sum('cgst'), d.summary.output.cgst);
  });

  it('uses IGST instead of CGST and SGST on an inter-state sale', async () => {
    const fresh = await h.makeTenant('GST Interstate Org');
    // A sale is inter-state when both GSTINs are known and their state codes differ, so the organization needs one.
    await h.models.Organization.updateOne({ _id: fresh.org._id }, { $set: { gstin: '29AAACS1234A1Z5' } });
    const { med } = await stocked({ gstPercent: 12, price: 112, client: fresh.client });
    await sell(med._id, 1, { interState: true, customer: { name: 'Out of state buyer', phone: '9876500099', gstin: '27AAACS1234A1Z5' } }, fresh.client);

    const d = await gst('', fresh.client);
    assert.equal(d.summary.output.igst, 12);
    assert.equal(d.summary.output.cgst, 0);
    assert.equal(d.summary.output.sgst, 0);
    assert.equal(d.summary.output.interStateInvoices, 1);
    assert.equal(d.summary.output.withGstin, 1);
    assert.equal(d.items[0].interState, true);
  });

  it('charges no tax for a cancelled invoice', async () => {
    const fresh = await h.makeTenant('GST Cancelled Org');
    const { med } = await stocked({ gstPercent: 12, price: 112, client: fresh.client });
    const inv = await sell(med._id, 1, {}, fresh.client);
    assert.equal((await gst('', fresh.client)).summary.output.tax, 12);

    await h.tenant.runWithTenant(fresh.org._id, () => h.models.Invoice.updateOne({ _id: inv._id }, { $set: { status: 'cancelled', cancelledAt: new Date() } }));

    const d = await gst('', fresh.client);
    assert.equal(d.summary.output.tax, 0, 'a cancelled invoice charged nobody any tax');
    assert.equal(d.total, 0, 'and it is not in the invoice-level detail either');
  });

  it('summarises by HSN code, saying where the code came from', async () => {
    const fresh = await h.makeTenant('GST HSN Org');
    const med = (await fresh.client.post('/inventory', { medicineName: uniq('HSN Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0, hsnCode: '30049099' })).data;
    await fresh.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 200, sellingPrice: 112, purchasePrice: 60, initialQuantity: 50 });
    await sell(med._id, 3, {}, fresh.client);

    const d = await gst('', fresh.client);
    const row = d.hsn.find((x) => x.hsn === '30049099');
    assert.ok(row, 'the HSN code is reported');
    assert.equal(row.rate, 12);
    assert.equal(row.units, 3);
    assert.equal(row.taxable, 300);
    assert.equal(row.tax, 36);
    assert.match(d.notes.hsnSource, /as they stand now/);
  });

  it('names a medicine with no HSN code rather than dropping its sales', async () => {
    const d = await gst('', org.client);
    assert.ok(d.hsn.some((x) => x.hsnLabel === 'Not recorded'));
    assert.equal(Math.round(d.hsn.reduce((t, r) => t + r.tax, 0) * 100) / 100, d.summary.output.tax, 'every line of tax is in the HSN summary somewhere');
  });
});

describe('What the returns adjust', () => {
  it('derives the tax on a return from the rate on the invoice line it came back against', async () => {
    const fresh = await h.makeTenant('GST Returns Org');
    const { med, batch } = await stocked({ gstPercent: 12, price: 112, client: fresh.client });
    const inv = await sell(med._id, 4, {}, fresh.client);

    const r = await fresh.client.post('/sales-returns', {
      invoiceId: inv._id,
      reason: 'changed_mind',
      items: [{ medicineId: med._id, batchId: batch._id, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 112 },
      idempotencyKey: key(),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const d = await gst('', fresh.client);
    assert.equal(d.summary.output.tax, 48, 'four units at ₹12 of tax each');
    assert.equal(d.summary.salesReturns.tax, 12, 'one unit came back, carrying its ₹12 of tax');
    assert.equal(d.summary.salesReturns.taxable, 100);
    assert.equal(d.summary.salesReturns.cgst, 6);
    assert.equal(d.summary.salesReturns.sgst, 6);
    assert.equal(d.summary.salesReturns.derived, true, 'and the report says it was derived, not recorded');
    assert.equal(d.summary.outputNet.tax, 36, '48 charged less 12 that came back');
    assert.match(d.notes.returnsDerived, /no tax of their own/);
    const rate = d.returnsByRate.find((x) => x.rate === 12);
    assert.equal(rate.tax, 12);
  });
});

describe('Tax paid on purchases', () => {
  let fresh;

  before(async () => {
    fresh = await h.makeTenant('GST Purchase Org');
    await makeOrder(fresh.org);
    await makeOrder(fresh.org, { status: 'draft' });
    await makeOrder(fresh.org, { status: 'cancelled' });
  });

  it('counts the GST on orders actually placed, and never on a draft or a cancelled one', async () => {
    const d = await gst('', fresh.client);
    assert.equal(d.summary.input.orders, 1);
    assert.equal(d.summary.input.tax, 120);
    assert.equal(d.summary.input.taxable, 1000);
    assert.equal(d.inputByRate.find((r) => r.rate === 12).tax, 120);
    assert.match(d.notes.inputSplit, /no inter-state flag/);
  });

  it('counts GST charged on shipping and other charges as its own figure', async () => {
    const withCharges = await h.makeTenant('GST Charges Org');
    await makeOrder(withCharges.org, {
      charges: { shipping: 100, packaging: 0, other: 0, gstPercent: 18, gstAmount: 18, additionalDiscount: 0 },
      grandTotal: 1238,
    });
    const d = await gst('', withCharges.client);
    assert.equal(d.summary.input.chargesTax, 18);
    assert.equal(d.summary.input.tax, 138, 'the product GST plus the GST on the charges');
    assert.equal(d.inputByRate.reduce((t, r) => t + r.tax, 0), 120, 'the per-rate breakdown is products only — charges belong to no product rate');
  });

  it('works out the net position as output tax less input tax', async () => {
    const d = await gst('', fresh.client);
    assert.equal(d.summary.inputNet.tax, 120);
    assert.equal(d.summary.net.payable, false, 'nothing was sold, so the tax paid is a credit');
    assert.equal(d.summary.net.signed, -120);
    assert.equal(d.summary.net.label, 'Net input tax credit');
    assert.match(d.notes.netPosition, /takes no account of opening credit/);
  });
});

describe('The invoice-level detail', () => {
  let fresh;
  let inv;

  before(async () => {
    fresh = await h.makeTenant('GST Detail Org');
    const twelve = await stocked({ gstPercent: 12, price: 112, client: fresh.client });
    const five = await stocked({ gstPercent: 5, price: 105, client: fresh.client });
    inv = await sell(twelve.med._id, 1, { customer: { name: 'Anita Sharma', phone: '9876500011', gstin: '27AAACS1234A1Z5' } }, fresh.client);
    await sell(five.med._id, 1, {}, fresh.client);
  });

  it('lists each invoice with its own tax, and never counts round-off as tax', async () => {
    const d = await gst('', fresh.client);
    const row = d.items.find((i) => i.invoiceNo === inv.invoiceNo);
    assert.equal(row.taxable, 100);
    assert.equal(row.cgst, 6);
    assert.equal(row.sgst, 6);
    assert.equal(row.tax, 12);
    assert.equal(row.customerGstin, '27AAACS1234A1Z5');
    assert.deepEqual(row.rates, [12]);
    assert.equal(Math.round((row.taxable + row.tax + (row.roundOff || 0)) * 100) / 100, row.total);
    assert.match(d.notes.roundOff, /not tax/);
  });

  it('filters by GST rate, and offers only the rates actually charged', async () => {
    const d = await gst('', fresh.client);
    assert.deepEqual(d.options.rates.map((r) => r.value), ['5', '12']);
    const only12 = await gst('?rate=12', fresh.client);
    assert.equal(only12.total, 1);
    assert.equal(only12.items[0].invoiceNo, inv.invoiceNo);
    assert.deepEqual(only12.byRate.map((r) => r.rate), [12], 'the breakdown follows the filter too');
    assert.equal((await gst('?rate=28', fresh.client)).total, 0);
  });

  it('searches by invoice number, customer and GSTIN', async () => {
    assert.equal((await gst(`?search=${inv.invoiceNo}`, fresh.client)).total, 1);
    assert.equal((await gst('?search=Anita', fresh.client)).total, 1);
    assert.equal((await gst('?search=27AAACS1234A1Z5', fresh.client)).total, 1);
    assert.equal((await gst('?search=nobody', fresh.client)).total, 0);
  });

  it('refuses a rate that could never have been charged', async () => {
    assert.equal((await fresh.client.get('/analytics/gst?rate=120')).status, 400);
    assert.equal((await fresh.client.get('/analytics/gst?rate=-5')).status, 400);
    assert.equal((await fresh.client.get('/analytics/gst?rate=abc')).status, 400);
    assert.equal((await fresh.client.get('/analytics/gst?sortBy=whatever')).status, 400);
  });

  it('pages the detail while the summary still describes the whole period', async () => {
    const d = await gst('?limit=1&page=2', fresh.client);
    assert.equal(d.total, 2);
    assert.equal(d.pages, 2);
    assert.equal(d.items.length, 1);
    assert.equal(d.summary.output.invoices, 2);
    assert.equal(d.summary.output.tax, 17, 'both invoices: ₹12 and ₹5');
  });

  it('exports the summary, the rate breakdown, the HSN summary and every invoice, with the disclaimer first', async () => {
    const r = await fresh.client.get('/analytics/gst/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.rows, 2, 'every matching invoice, not the page on screen');
    assert.match(r.data.fileName, /^usha-gst-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = parseCsv(r.data.csv);
    assert.match(rows[0][0], /GST Report/);
    assert.match(rows.find((x) => x[0] === 'IMPORTANT')[1], /not a GST return/i);
    assert.equal(rows.find((x) => x[0] === 'Total tax on sales (INR)')[1], '17.00');
    assert.equal(rows.find((x) => x[0] === 'Net tax payable (INR)')[1], '17.00');
    assert.ok(rows.some((x) => x[0] === '12%'), 'the rate breakdown is in the file');
    assert.ok(rows.some((x) => x[0] === 'HSN'), 'and so is the HSN summary');
    const header = rows.find((x) => x[0] === 'Invoice No');
    const body = rows.slice(rows.indexOf(header) + 1);
    assert.equal(body.length, 2);
    assert.equal(body.some((x) => x[0] === inv.invoiceNo), true);
    assert.equal(body.find((x) => x[0] === inv.invoiceNo)[header.indexOf('CGST (INR)')], '6.00');
  });
});

describe('Who may see what', () => {
  it('never shows one organization the tax of another', async () => {
    const { med } = await stocked({ gstPercent: 12, price: 112 });
    await sell(med._id, 1);
    const theirs = await gst('', other.client);
    assert.equal(theirs.summary.output.tax, 0);
    assert.equal(theirs.total, 0);
  });

  it('reports one store at a time when asked, and names the organization on the report', async () => {
    const d = await gst(`?branchId=${main._id}`);
    assert.equal(d.items.every((i) => !i.branchId || String(i.branchId) === String(main._id)), true);
    assert.equal(d.organization.name, 'GST Org');
  });
});
