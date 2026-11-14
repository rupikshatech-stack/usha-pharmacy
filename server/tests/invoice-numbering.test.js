// Invoice numbering, against a real database and the real billing path.
//
// A document number is the one thing in this system that must never be issued twice. These tests exercise the whole
// route — settings, counter, transaction, invoice — rather than the counter on its own, because the counter has
// never been the risky part: the risk is a configuration change that quietly points billing at a fresh counter, or
// a financial year that turns over at a different instant than the server thinks it does.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { issueNumber, seedCounters, sequenceOf } from '../services/documentNumbering.service.js';

/**
 * `issueNumber` writes to the Counter collection, which is tenant-scoped — the same guard that stops one
 * organization's numbering reaching another's. Calling it straight from a test means supplying the tenant context
 * the request pipeline would normally have established.
 */
const issueFor = (org, args) => h.tenant.runWithTenant(org._id, () => issueNumber({ orgId: org._id, ...args }));

let h;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `num-${Date.now()}-${++n}`;

/** A medicine with plenty of stock, so fifty sales in parallel are about numbering and nothing else. */
const stocked = async (client, qty = 500) => {
  const med = (await client.post('/inventory', { medicineName: uniq('Num Med'), unit: 'Strip', gstPercentage: 12, reorderLevel: 0 })).data;
  const made = await client.post('/batches', {
    medicineId: med._id,
    batchNumber: uniq('B'),
    expiryDate: futureDate(2),
    mrp: 200,
    sellingPrice: 100,
    purchasePrice: 60,
    initialQuantity: qty,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return med;
};

const saveNumbering = async (tenant, series) => {
  const current = await tenant.client.get('/settings');
  const r = await tenant.client.patch('/settings/invoice', { version: current.data.version, ...series });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
});

describe('Fifty tills at once', () => {
  it('issues fifty invoices with no duplicate and no skipped number', async () => {
    const org = await h.makeTenant('Numbering Parallel Org');
    const med = await stocked(org.client, 500);

    // Fifty sales fired together, through the real endpoint — stock allocation, transaction, numbering and all.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() })),
    );

    const failed = results.filter((r) => r.status !== 201);
    assert.equal(failed.length, 0, `every sale must succeed: ${JSON.stringify(failed.map((f) => f.body).slice(0, 3))}`);

    const numbers = results.map((r) => r.data.invoiceNo);
    assert.equal(new Set(numbers).size, 50, 'fifty different invoice numbers — a duplicate here is two customers with the same bill');

    const sequences = numbers.map(sequenceOf).sort((a, b) => a - b);
    assert.deepEqual(sequences, Array.from({ length: 50 }, (_, i) => i + 1), 'and 1 to 50 with no gaps: a skipped number is a question nobody can answer at audit');
    assert.equal(numbers.every((no) => /^INV-\d{5}$/.test(no)), true, 'in the format this system has always printed');
  });

  it('keeps each organization’s numbering to itself when both are billing at once', async () => {
    const a = await h.makeTenant('Numbering Org A');
    const b = await h.makeTenant('Numbering Org B');
    const [medA, medB] = [await stocked(a.client, 40), await stocked(b.client, 40)];

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => a.client.post('/invoices', { items: [{ medicineId: medA._id, quantity: 1 }], idempotencyKey: key() })),
      ...Array.from({ length: 20 }, () => b.client.post('/invoices', { items: [{ medicineId: medB._id, quantity: 1 }], idempotencyKey: key() })),
    ]);
    assert.equal(results.every((r) => r.status === 201), true);

    const seqA = (await a.client.get('/invoices?limit=100')).data.items.map((i) => sequenceOf(i.invoiceNo)).sort((x, y) => x - y);
    const seqB = (await b.client.get('/invoices?limit=100')).data.items.map((i) => sequenceOf(i.invoiceNo)).sort((x, y) => x - y);
    assert.deepEqual(seqA, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(seqB, Array.from({ length: 20 }, (_, i) => i + 1), 'one organization’s sales never advance another’s numbering');
  });
});

describe('The financial year turning over', () => {
  it('puts a sale at 23:59 on 31 March in the old year and 00:00 on 1 April in the new one', async () => {
    const org = await h.makeTenant('Numbering FY Org');
    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true, resetEveryFinancialYear: true }] });
    const saved = await h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());

    // India is UTC+5:30, so local midnight on 1 April is 18:30 UTC on 31 March. These two instants are one minute
    // apart and must land in different financial years.
    const lastMinute = new Date('2027-03-31T18:29:00Z'); // 23:59 IST on 31 March 2027
    const firstMinute = new Date('2027-03-31T18:30:00Z'); // 00:00 IST on 1 April 2027

    const before = await issueFor(org.org, { org: saved, series: 'sales', now: lastMinute });
    const after = await issueFor(org.org, { org: saved, series: 'sales', now: firstMinute });

    assert.equal(before.number, 'SWS/26-27/0001', 'one minute before midnight is still 2026-27');
    assert.equal(after.number, 'SWS/27-28/0001', 'one minute later is 2027-28, and its own sequence starts again');
    assert.notEqual(before.key, after.key, 'a year that resets gets its own counter');
    assert.match(before.key, /fy:2026-27$/);
    assert.match(after.key, /fy:2027-28$/);
  });

  it('keeps counting within a year, and starts the next year from one', async () => {
    const org = await h.makeTenant('Numbering FY Count Org');
    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'INV', separator: '/', padding: 3, includeFinancialYear: true, resetEveryFinancialYear: true }] });
    const saved = await h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());

    const march = new Date('2027-03-31T18:29:00Z');
    const april = new Date('2027-03-31T18:30:00Z');
    const a = await issueFor(org.org, { org: saved, series: 'sales', now: march });
    const b = await issueFor(org.org, { org: saved, series: 'sales', now: march });
    const c = await issueFor(org.org, { org: saved, series: 'sales', now: april });

    assert.deepEqual([a.number, b.number, c.number], ['INV/26-27/001', 'INV/26-27/002', 'INV/27-28/001']);
  });

  it('does not reset when the organization has not asked it to', async () => {
    const org = await h.makeTenant('Numbering No Reset Org');
    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'INV', separator: '-', padding: 4, includeFinancialYear: false, resetEveryFinancialYear: false }] });
    const saved = await h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());

    const a = await issueFor(org.org, { org: saved, series: 'sales', now: new Date('2027-03-31T18:29:00Z') });
    const b = await issueFor(org.org, { org: saved, series: 'sales', now: new Date('2027-03-31T18:30:00Z') });
    assert.deepEqual([a.number, b.number], ['INV-0001', 'INV-0002'], 'one continuous sequence across the year end');
    assert.equal(a.key, b.key);
  });
});

describe('Changing the numbering settings', () => {
  it('renames what comes next and never touches an invoice that exists', async () => {
    const org = await h.makeTenant('Numbering Rename Org');
    const med = await stocked(org.client, 20);
    const first = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(first.status, 201);
    assert.equal(first.data.invoiceNo, 'INV-00001');

    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'SWS', separator: '/', padding: 4 }] });

    const second = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(second.data.invoiceNo, 'SWS/0002', 'the next one is renamed and the sequence carries on');

    const reread = await org.client.get(`/invoices/${first.data._id}`);
    assert.equal(reread.data.invoiceNo, 'INV-00001', 'the first invoice is still called what it was called');
  });

  it('starts a series where it was told to, and never below a number already issued', async () => {
    const org = await h.makeTenant('Numbering Start Org');
    const med = await stocked(org.client, 20);
    await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });

    // Lowering the start below what exists is refused outright (Phase 1), so this raises it instead.
    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'INV', separator: '-', padding: 5, start: 500 }] });

    const next = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(next.data.invoiceNo, 'INV-00500', 'numbering begins where the organization asked');

    const after = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(after.data.invoiceNo, 'INV-00501', 'and carries on from there, not from the start again');
  });

  it('seeds a new counter when per-branch numbering is switched on, so an existing number cannot come back', async () => {
    const org = await h.makeTenant('Numbering Per Branch Org');
    const med = await stocked(org.client, 20);
    // Three invoices on the organization-wide counter.
    for (let i = 0; i < 3; i += 1) await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });

    const saved = await saveNumbering(org, { perBranch: true });
    assert.ok(Array.isArray(saved.counters), 'the save reports what it did to the counters');
    const salesCounter = saved.counters.find((c) => c.series === 'sales');
    assert.equal(salesCounter.raised, true, 'the new per-branch counter was raised above what exists');
    assert.equal(salesCounter.counterNow, 3);

    const next = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(next.data.invoiceNo, 'INV-00004', 'the next number is above every number already issued — not INV-00001 again');

    const all = (await org.client.get('/invoices?limit=100')).data.items.map((i) => i.invoiceNo);
    assert.equal(new Set(all).size, all.length, 'and nothing is duplicated');
  });
});

describe('Seeding counters from the documents themselves', () => {
  it('reports what it would do without writing anything', async () => {
    const org = await h.makeTenant('Numbering Dryrun Org');
    const med = await stocked(org.client, 10);
    await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });

    // A counter left behind — as happens when documents are imported rather than billed.
    await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 0 } }));

    const saved = await h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());
    const dry = await h.tenant.runWithTenant(org.org._id, () => seedCounters({ orgId: org.org._id, org: saved, dryRun: true }));
    const sales = dry.find((r) => r.series === 'sales');
    assert.equal(sales.highestIssued, 1);
    assert.equal(sales.counterWas, 0);
    assert.equal(sales.raised, true, 'it would raise it');

    const counter = await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.findOne({ organizationId: org.org._id, key: 'invoice' }).lean());
    assert.equal(counter.seq, 0, 'but a dry run writes nothing');
  });

  it('raises a counter that is behind, and leaves one that is ahead alone', async () => {
    const org = await h.makeTenant('Numbering Seed Org');
    const med = await stocked(org.client, 10);
    await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    const saved = await h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());

    await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 0 } }));
    await h.tenant.runWithTenant(org.org._id, () => seedCounters({ orgId: org.org._id, org: saved }));
    let counter = await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.findOne({ organizationId: org.org._id, key: 'invoice' }).lean());
    assert.equal(counter.seq, 1, 'raised to the highest number actually issued');

    await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 99 } }));
    await h.tenant.runWithTenant(org.org._id, () => seedCounters({ orgId: org.org._id, org: saved }));
    counter = await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.findOne({ organizationId: org.org._id, key: 'invoice' }).lean());
    assert.equal(counter.seq, 99, 'a counter ahead of the documents is never walked backwards');
  });

  it('reads the number out of any format, so an imported document still protects its number', async () => {
    assert.equal(sequenceOf('INV-00042'), 42);
    assert.equal(sequenceOf('SWS/25-26/0007'), 7);
    assert.equal(sequenceOf('EXP-DEMO-090'), 90);
    assert.equal(sequenceOf('no-digits'), 0);
    assert.equal(sequenceOf(null), 0);
  });
});

describe('The other series', () => {
  it('numbers purchase orders and credit notes from their own settings', async () => {
    const org = await h.makeTenant('Numbering Series Org');
    await saveNumbering(org, {
      series: [
        { series: 'purchase', prefix: 'PO', separator: '/', padding: 3 },
        { series: 'salesReturn', prefix: 'CN', separator: '/', padding: 3 },
      ],
    });

    const supplier = (await org.client.post('/suppliers', { name: uniq('Numbering Supplier'), contactPerson: 'R', phone: '9811100022' })).data;
    const med = await stocked(org.client, 20);
    const order = await org.client.post('/orders', {
      supplierId: supplier._id,
      items: [{ medicineId: med._id, quantity: 10, rate: 50 }],
      status: 'draft',
      payment: { terms: 'credit', advance: 0 },
      idempotencyKey: key(),
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.data.orderNo, 'PO/001');

    const inv = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 2 }], idempotencyKey: key() });
    const batchId = inv.data.items[0].batchId;
    const ret = await org.client.post('/sales-returns', {
      invoiceId: inv.data._id,
      reason: 'changed_mind',
      items: [{ medicineId: med._id, batchId, quantity: 1, restock: true, verified: true, condition: 'good' }],
      refund: { method: 'Cash', status: 'completed', amount: 100 },
      idempotencyKey: key(),
    });
    assert.equal(ret.status, 201, JSON.stringify(ret.body));
    assert.equal(ret.data.returnNo, 'CN/001');
  });
});

describe('Saving the invoice tab once invoices exist', () => {
  it('saves an unrelated change without mistaking the untouched start for a restart', async () => {
    const org = await h.makeTenant('Numbering Unrelated Save Org');
    const med = await stocked(org.client, 20);
    for (let i = 0; i < 3; i += 1) await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });

    // Exactly what the screen sends: every series with its untouched default start of 1, plus the one real change.
    const current = await org.client.get('/settings');
    const r = await org.client.patch('/settings/invoice', {
      version: current.data.version,
      series: [
        { series: 'sales', branchId: null, prefix: 'INV', separator: '-', padding: 5, start: 1 },
        { series: 'salesReturn', branchId: null, prefix: 'SR', separator: '-', padding: 4, start: 1 },
        { series: 'purchase', branchId: null, prefix: 'ORD', separator: '-', padding: 4, start: 1 },
      ],
      template: { paperSize: 'A5' },
    });
    assert.equal(r.status, 200, `three invoices exist and nobody touched the start: ${JSON.stringify(r.body)}`);

    const next = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(next.data.invoiceNo, 'INV-00004', 'and numbering simply carries on');
  });

  it('still refuses a start that somebody deliberately lowered below an issued number', async () => {
    const org = await h.makeTenant('Numbering Lowered Start Org');
    const med = await stocked(org.client, 20);
    for (let i = 0; i < 5; i += 1) await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });

    const current = await org.client.get('/settings');
    const r = await org.client.patch('/settings/invoice', {
      version: current.data.version,
      series: [{ series: 'sales', branchId: null, prefix: 'INV', separator: '-', padding: 5, start: 3 }],
    });
    assert.equal(r.status, 400, 'three is already on an invoice');
    assert.equal(r.body.code, 'NUMBER_ALREADY_ISSUED');
  });
});

describe('Seeding only from documents that belong to the series', () => {
  /** A bare invoice row, written straight to the collection — the way imported or demo data arrives. */
  const rawInvoice = (orgId, invoiceNo, over = {}) =>
    h.mongoose.connection.db.collection('invoices').insertOne({ organizationId: orgId, invoiceNo, status: 'completed', invoiceDate: new Date(), total: 0, items: [], ...over });
  const seed = (org, saved, opts = {}) => h.tenant.runWithTenant(org.org._id, () => seedCounters({ orgId: org.org._id, org: saved, ...opts }));
  const orgDoc = (org) => h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());
  const counterOf = (org, key = 'invoice') => h.tenant.runWithTenant(org.org._id, () => h.models.Counter.findOne({ organizationId: org.org._id, key }).lean());

  it('does not raise a counter because of a document in some other format, and lists it for review', async () => {
    const org = await h.makeTenant('Seed Demo Row Org');
    await rawInvoice(org.org._id, 'INV-00001');
    await rawInvoice(org.org._id, 'INV-00002');
    const demo = await rawInvoice(org.org._id, 'EXP-DEMO-090');

    const report = await seed(org, await orgDoc(org));
    const sales = report.find((r) => r.series === 'sales');

    assert.equal(sales.highestIssued, 2, 'the demo row, which ends in 90, says nothing about what has been issued');
    assert.equal((await counterOf(org)).seq, 2, 'so the counter stands at 2 and the next invoice is INV-00003');
    assert.equal(sales.needsReview.length, 1);
    assert.equal(sales.needsReview[0].number, 'EXP-DEMO-090');
    assert.equal(sales.needsReview[0]._id, String(demo.insertedId), 'with its _id, so somebody can open it');
  });

  it('keeps the next serial consecutive: no jump, even though nothing would have collided', async () => {
    const org = await h.makeTenant('Seed Consecutive Org');
    const med = await stocked(org.client, 10);
    for (let i = 0; i < 3; i += 1) await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    await rawInvoice(org.org._id, 'EXP-DEMO-090');
    await rawInvoice(org.org._id, 'INV-80000'); // matches the format but sits miles above its neighbours

    await saveNumbering(org, { perBranch: true }); // runs the real seeding
    const next = await org.client.post('/invoices', { items: [{ medicineId: med._id, quantity: 1 }], idempotencyKey: key() });
    assert.equal(next.data.invoiceNo, 'INV-00004', 'a GST serial that jumps to 91 or 80001 is a compliance problem');
  });

  it('sets aside a matching number that jumps more than 1000, and reports both reasons separately', async () => {
    const org = await h.makeTenant('Seed Jump Org');
    await rawInvoice(org.org._id, 'INV-00001');
    await rawInvoice(org.org._id, 'INV-00002');
    await rawInvoice(org.org._id, 'INV-90000');
    await rawInvoice(org.org._id, 'LEGACY-7');

    const sales = (await seed(org, await orgDoc(org), { dryRun: true })).find((r) => r.series === 'sales');
    assert.equal(sales.highestIssued, 2);
    const byNumber = Object.fromEntries(sales.needsReview.map((d) => [d.number, d.reason]));
    assert.match(byNumber['INV-90000'], /above the next-highest number/);
    assert.match(byNumber['LEGACY-7'], /not in this series' format/);
  });

  it('reports a counter that is ahead of every valid document as a gap, and never lowers it', async () => {
    const org = await h.makeTenant('Seed Gap Org');
    await rawInvoice(org.org._id, 'INV-00001');
    await h.tenant.runWithTenant(org.org._id, () => h.models.Counter.updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 90 } }, { upsert: true }));

    const sales = (await seed(org, await orgDoc(org))).find((r) => r.series === 'sales');
    assert.equal(sales.gap, 89, 'the next number would skip 89 serials');
    assert.equal(sales.raised, false);
    assert.equal((await counterOf(org)).seq, 90, 'lowering a counter is a decision for a person, not for a seeder');
  });

  it('keeps last year out of this year’s counter when the series resets each year', async () => {
    const org = await h.makeTenant('Seed FY Org');
    await saveNumbering(org, { series: [{ series: 'sales', prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true, resetEveryFinancialYear: true }] });
    const saved = await orgDoc(org);
    const fy = (await import('../utils/financialYear.js')).financialYearOf(new Date(), 4, 'Asia/Kolkata');
    const lastYear = new Date(fy.start.getTime() - 86400000 * 30);
    const lastLabel = (await import('../utils/financialYear.js')).financialYearOf(lastYear, 4, 'Asia/Kolkata').label;

    await rawInvoice(org.org._id, `SWS/${fy.label}/0001`);
    await rawInvoice(org.org._id, `SWS/${fy.label}/0002`);
    await rawInvoice(org.org._id, `SWS/${lastLabel}/0900`, { invoiceDate: lastYear });

    const sales = (await seed(org, saved)).find((r) => r.series === 'sales');
    assert.equal(sales.highestIssued, 2, 'last year’s 900 belongs to last year’s counter');
    assert.equal(sales.documents, 2, 'and is not even in this year’s scope');
    assert.match(sales.key, /fy:/);
  });

  it('writes nothing on a dry run, however much it finds', async () => {
    const org = await h.makeTenant('Seed Dry Run Org');
    await rawInvoice(org.org._id, 'INV-00001');
    await rawInvoice(org.org._id, 'INV-00002');
    const sales = (await seed(org, await orgDoc(org), { dryRun: true })).find((r) => r.series === 'sales');
    assert.equal(sales.raised, true, 'it would raise it to 2');
    assert.equal(await counterOf(org), null, 'but no counter exists, because a dry run wrote nothing');
  });
});

describe('Correcting a counter that is too high', () => {
  const rawInvoice = (orgId, invoiceNo, over = {}) =>
    h.mongoose.connection.db.collection('invoices').insertOne({ organizationId: orgId, invoiceNo, status: 'completed', invoiceDate: new Date(), total: 0, items: [], ...over });
  const setCounter = (org, seq) => h.mongoose.connection.db.collection('counters').updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq } }, { upsert: true });
  const counterOf = async (org) => (await h.mongoose.connection.db.collection('counters').findOne({ organizationId: org.org._id, key: 'invoice' }))?.seq;
  const orgDoc = (org) => h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());
  const correct = async (org, opts) => {
    const { correctCounter } = await import('../services/documentNumbering.service.js');
    return h.tenant.runWithTenant(org.org._id, async () => correctCounter({ orgId: org.org._id, org: await orgDoc(org), ...opts }));
  };
  const auditOf = (org) => h.mongoose.connection.db.collection('auditlogs').find({ organizationId: org.org._id, action: 'SETTINGS_COUNTER_CORRECTED' }).toArray();

  /** The situation on the dev database: seven real invoices, ninety demo rows, and a counter at 90. */
  const wrongCounter = async (name) => {
    const org = await h.makeTenant(name);
    for (let i = 1; i <= 7; i += 1) await rawInvoice(org.org._id, `INV-${String(i).padStart(5, '0')}`);
    for (let i = 1; i <= 90; i += 1) await rawInvoice(org.org._id, `EXP-DEMO-${String(i).padStart(3, '0')}`);
    await setCounter(org, 90);
    return org;
  };

  it('does nothing on a dry run, however sure it is', async () => {
    const org = await wrongCounter('Correct Dry Org');
    const r = await correct(org, { dryRun: true });
    assert.equal(r.aborted, null);
    assert.equal(r.counterWas, 90);
    assert.equal(r.target, 7, 'the highest number that actually belongs to the series');
    assert.equal(r.wouldBeNext, 'INV-00008');
    assert.equal(r.applied, false);
    assert.equal(await counterOf(org), 90, 'not a thing was written');
    assert.equal((await auditOf(org)).length, 0);
  });

  it('lowers the counter, and writes the audit entry with the reason, in one step', async () => {
    const org = await wrongCounter('Correct Apply Org');
    const r = await correct(org, { dryRun: false, reason: 'EXP-DEMO-090 raised it past the real invoices', actor: 'test' });
    assert.equal(r.applied, true, JSON.stringify(r));
    assert.equal(await counterOf(org), 7);

    const [entry] = await auditOf(org);
    assert.ok(entry, 'the correction is on file');
    assert.equal(entry.meta.from, 90);
    assert.equal(entry.meta.to, 7);
    assert.match(entry.meta.reason, /EXP-DEMO-090/);
    assert.match(entry.message, /corrected from 90 to 7/);
    assert.equal(entry.userName, 'test');
  });

  it('then numbers the next real invoice INV-00008, with no serials skipped', async () => {
    const org = await wrongCounter('Correct Next Org');
    await correct(org, { dryRun: false, reason: 'counter was raised by demo rows' });
    const { issueNumber } = await import('../services/documentNumbering.service.js');
    const next = await h.tenant.runWithTenant(org.org._id, async () => issueNumber({ orgId: org.org._id, org: await orgDoc(org), series: 'sales' }));
    assert.equal(next.number, 'INV-00008');
  });

  it('refuses without a reason: it is a change to the sequence behind real invoice numbers', async () => {
    const org = await wrongCounter('Correct No Reason Org');
    await assert.rejects(() => correct(org, { dryRun: false }), /needs a reason/);
    await assert.rejects(() => correct(org, { dryRun: false, reason: '   ' }), /needs a reason/);
    assert.equal(await counterOf(org), 90);
  });

  it('aborts, naming the documents, if ANY invoice of the series carries a number above the target', async () => {
    const org = await wrongCounter('Correct Blocked Org');
    const real = await rawInvoice(org.org._id, 'INV-00042'); // a real invoice above 7
    const r = await correct(org, { dryRun: false, to: 7, reason: 'should not be allowed' });
    assert.match(r.aborted, /carry a number above 7/);
    assert.match(r.aborted, /INV-00042/);
    assert.equal(r.blockedBy[0]._id, String(real.insertedId), 'with its _id, so somebody can open it');
    assert.equal(r.applied, false);
    assert.equal(await counterOf(org), 90, 'and the counter is untouched');
    assert.equal((await auditOf(org)).length, 0, 'with nothing on file, because nothing happened');
  });

  it('is blocked even by an invoice that seeding would set aside as an outlier', async () => {
    const org = await wrongCounter('Correct Outlier Org');
    await rawInvoice(org.org._id, 'INV-90000'); // matches the format, jumps miles above its neighbours
    const r = await correct(org, { dryRun: true, to: 7 });
    assert.match(r.aborted, /INV-90000/, 'a number on a real document is on paper somewhere, whatever seeding thinks of it');
  });

  it('only ever lowers: a target at or above the counter is refused', async () => {
    const org = await wrongCounter('Correct Raise Org');
    for (const to of [90, 91, 500]) {
      const r = await correct(org, { dryRun: false, to, reason: 'trying to raise it' });
      assert.match(r.aborted, /nothing to lower/, `to ${to}`);
    }
    assert.equal(await counterOf(org), 90);
  });

  it('rejects a target that is not a counter value', async () => {
    const org = await wrongCounter('Correct Bad Value Org');
    for (const to of [-1, 3.5, 'abc']) assert.match((await correct(org, { dryRun: true, to })).aborted, /not a valid counter value/, String(to));
  });

  it('does nothing if the counter moved while it was checking: the write is conditional on what was read', async () => {
    const org = await wrongCounter('Correct Race Org');
    const { correctCounter } = await import('../services/documentNumbering.service.js');
    const o = await orgDoc(org);
    // Two corrections fired together: exactly one can win, because each only writes if the counter still holds 90.
    const results = await h.tenant.runWithTenant(org.org._id, () =>
      Promise.allSettled([correctCounter({ orgId: org.org._id, org: o, dryRun: false, reason: 'first' }), correctCounter({ orgId: org.org._id, org: o, dryRun: false, reason: 'second' })]),
    );
    const applied = results.filter((r) => r.status === 'fulfilled' && r.value.applied).length;
    assert.equal(applied, 1, 'one correction landed, never two');
    assert.equal(await counterOf(org), 7);
    assert.equal((await auditOf(org)).length, 1, 'and there is exactly one entry on file');
  });

  it('is scoped to one organization: another organization’s counter is not its business', async () => {
    const a = await wrongCounter('Correct Scope A');
    const b = await wrongCounter('Correct Scope B');
    await correct(a, { dryRun: false, reason: 'only A' });
    assert.equal(await counterOf(a), 7);
    assert.equal(await counterOf(b), 90, 'B is exactly as it was');
  });
});

describe('Demo sales are numbered like real ones', () => {
  const draftsFor = (days) =>
    days.map((d) => ({ key: String(d).padStart(3, '0'), customer: { name: 'Demo Counter Sale' }, items: [{ medicineId: new h.mongoose.Types.ObjectId(), batchId: new h.mongoose.Types.ObjectId(), name: 'Demo', batchNo: 'D1', quantity: 1, price: 10, amount: 10, mrp: 12, expiryDate: new Date(Date.now() + 90 * 86400000), gstPercent: 12, taxableAmount: 9, taxAmount: 1 }], subTotal: 10, taxableAmount: 9, taxTotal: 1, total: 10, paid: 10, due: 0, paymentType: 'Cash', status: 'completed', invoiceDate: new Date(Date.now() - d * 86400000) }));
  const orgDoc = (org) => h.tenant.runWithTenant(org.org._id, () => h.models.Organization.findById(org.org._id).lean());
  // A new organization gets its default store the first time anything asks for the store list.
  const branchOf = async (org) => {
    await org.client.get('/branches');
    return h.tenant.runWithTenant(org.org._id, () => h.models.Branch.findOne({ organizationId: org.org._id }).lean());
  };
  const counterOf = async (org) => (await h.mongoose.connection.db.collection('counters').findOne({ organizationId: org.org._id, key: 'invoice' }))?.seq;
  const numbers = async (org) => (await h.mongoose.connection.db.collection('invoices').find({ organizationId: org.org._id }).project({ invoiceNo: 1 }).sort({ invoiceNo: 1 }).toArray()).map((d) => d.invoiceNo);
  const replace = async (org, days) => {
    const { replaceDemoSales } = await import('../scripts/lib/demoSales.js');
    const [o, branch] = [await orgDoc(org), await branchOf(org)];
    return h.tenant.runWithTenant(org.org._id, () => replaceDemoSales({ orgId: org.org._id, org: o, branch, userId: org.user._id, drafts: draftsFor(days) }));
  };

  it('issues them through the series formatter, oldest first, consecutive, with nothing called EXP-DEMO', async () => {
    const org = await h.makeTenant('Demo Numbering Org');
    const r = await replace(org, [5, 4, 3, 2, 1]);
    assert.equal(r.created, 5);
    assert.deepEqual(await numbers(org), ['INV-00001', 'INV-00002', 'INV-00003', 'INV-00004', 'INV-00005']);
    assert.equal(r.first, 'INV-00001');
    assert.equal(r.last, 'INV-00005');
    assert.equal(await counterOf(org), 5, 'they came from the real counter');
    assert.equal((await numbers(org)).some((x) => /EXP-DEMO/.test(x)), false, 'no invented numbers in the sales scope');
    // The earliest sale has the lowest number.
    const first = await h.mongoose.connection.db.collection('invoices').findOne({ organizationId: org.org._id, invoiceNo: 'INV-00001' });
    const last = await h.mongoose.connection.db.collection('invoices').findOne({ organizationId: org.org._id, invoiceNo: 'INV-00005' });
    assert.ok(first.invoiceDate < last.invoiceDate);
  });

  it('follows the configured format', async () => {
    const org = await h.makeTenant('Demo Format Org');
    await h.mongoose.connection.db.collection('organizations').updateOne({ _id: org.org._id }, { $set: { 'settings.invoice.series': [{ series: 'sales', branchId: null, prefix: 'SWS', separator: '/', padding: 4, start: 1, includeFinancialYear: false, resetEveryFinancialYear: false }] } });
    await replace(org, [3, 2, 1]);
    assert.deepEqual(await numbers(org), ['SWS/0001', 'SWS/0002', 'SWS/0003']);
  });

  it('continues after real invoices rather than colliding with them', async () => {
    const org = await h.makeTenant('Demo After Real Org');
    for (let i = 1; i <= 3; i += 1) await h.mongoose.connection.db.collection('invoices').insertOne({ organizationId: org.org._id, invoiceNo: `INV-0000${i}`, status: 'completed', invoiceDate: new Date(), total: 0, items: [] });
    await h.mongoose.connection.db.collection('counters').updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 3 } }, { upsert: true });
    await replace(org, [2, 1]);
    assert.deepEqual(await numbers(org), ['INV-00001', 'INV-00002', 'INV-00003', 'INV-00004', 'INV-00005']);
  });

  it('re-seeds into the very same numbers, leaving no gap', async () => {
    const org = await h.makeTenant('Demo Reseed Org');
    await replace(org, [4, 3, 2, 1]);
    const before = await numbers(org);
    const again = await replace(org, [4, 3, 2, 1]);
    assert.equal(again.removed, 4);
    assert.equal(again.rewound, true, 'the serials were returned to the series first');
    assert.deepEqual(await numbers(org), before, 'identical, consecutive numbers: no hole where the old ones were');
    assert.equal(await counterOf(org), 4);
  });

  it('replaces the older EXP-DEMO rows and returns the counter they wrongly raised', async () => {
    const org = await h.makeTenant('Demo Legacy Org');
    const db = h.mongoose.connection.db;
    for (let i = 1; i <= 3; i += 1) await db.collection('invoices').insertOne({ organizationId: org.org._id, invoiceNo: `INV-0000${i}`, status: 'completed', invoiceDate: new Date(), total: 0, items: [] });
    for (let i = 1; i <= 20; i += 1) await db.collection('invoices').insertOne({ organizationId: org.org._id, invoiceNo: `EXP-DEMO-${String(i).padStart(3, '0')}`, status: 'completed', invoiceDate: new Date(), total: 0, items: [] });
    await db.collection('counters').updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 20 } }, { upsert: true }); // wrongly raised by the demo rows

    const r = await replace(org, [2, 1]);
    assert.equal(r.removed, 20);
    assert.deepEqual(await numbers(org), ['INV-00001', 'INV-00002', 'INV-00003', 'INV-00004', 'INV-00005'], 'the real three, then the two new demo ones: no jump to 21');
  });

  it('leaves demo invoices alone, and says so, when a real invoice was issued after them', async () => {
    const org = await h.makeTenant('Demo Interleaved Org');
    await replace(org, [3, 2, 1]); // INV-00001..3
    await h.mongoose.connection.db.collection('invoices').insertOne({ organizationId: org.org._id, invoiceNo: 'INV-00004', status: 'completed', invoiceDate: new Date(), total: 0, items: [] }); // a REAL one, after
    await h.mongoose.connection.db.collection('counters').updateOne({ organizationId: org.org._id, key: 'invoice' }, { $set: { seq: 4 } });

    const r = await replace(org, [3, 2, 1]);
    assert.equal(r.removed, 0);
    assert.equal(r.created, 0);
    assert.equal(r.kept, 3);
    assert.match(r.note, /gap in the middle of real numbers/);
    assert.deepEqual(await numbers(org), ['INV-00001', 'INV-00002', 'INV-00003', 'INV-00004'], 'nothing was deleted or added');
  });
});
