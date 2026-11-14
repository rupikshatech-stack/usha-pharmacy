// Phase 4: the settings that billing and inventory actually read.
//
// The first thing this file proves is the promise the whole phase rests on: DEFAULTS KEEP TODAY'S BEHAVIOUR. Three
// organizations are put through the same working day — one with none of the new settings at all (an organization that
// existed before any of this), one that has had the migration run over it, and one created fresh — and must come out
// the same. Everything after that is about the settings doing what they say once somebody does change them, and about
// the rules that are NOT settings (never sell expired stock, always sell the oldest first) holding on the server.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';
import { applySettingsDefaults } from '../scripts/lib/settingsMigration.js';

let h;
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const key = () => `p4-${Date.now()}-${++n}`;

const get = async (client) => {
  const r = await client.get('/settings');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const saveGeneral = async (client, patch) => {
  const cur = await get(client);
  return client.patch('/settings/general', { version: cur.version, ...patch });
};
const orgs = () => h.mongoose.connection.db.collection('organizations');

const medicine = async (client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('P4 Med'), unit: 'Strip', gstPercentage: 12, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const batch = async (client, medicineId, { qty = 50, years = 2, price = 100, cost = 60 } = {}) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('B'), expiryDate: futureDate(years), mrp: Math.max(price, 200), sellingPrice: price, purchasePrice: cost, initialQuantity: qty });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const sell = (client, body) => client.post('/invoices', { idempotencyKey: key(), ...body });

/**
 * One working day: a medicine with two lots, a cash sale that spans both, a credit sale to nobody in particular, and a
 * discounted sale. Everything that varies by organization (ids, names, batch numbers, dates) is stripped, so what is
 * left is exactly what billing and stock DID.
 */
async function workingDay(client) {
  const med = await medicine(client); // no reorder level given: whatever a new medicine starts with
  await batch(client, med._id, { qty: 20, years: 3, price: 110 }); // the later-expiring lot, received first
  await batch(client, med._id, { qty: 5, years: 1, price: 100 }); // the earlier-expiring lot, received second

  const cash = await sell(client, { items: [{ medicineId: med._id, quantity: 7 }] });
  const credit = await sell(client, { items: [{ medicineId: med._id, quantity: 3 }], paymentType: 'Credit', paid: 100, customer: { name: 'Walk-in', phone: '' } });
  const discounted = await sell(client, { items: [{ medicineId: med._id, quantity: 2, discountPercent: 10 }], discount: { type: 'amount', value: 5 } });
  for (const r of [cash, credit, discounted]) assert.equal(r.status, 201, JSON.stringify(r.body));

  const shape = (r) => ({
    invoiceNo: r.data.invoiceNo,
    subTotal: r.data.subTotal,
    itemDiscount: r.data.itemDiscount,
    discount: r.data.discount,
    taxableAmount: r.data.taxableAmount,
    cgstTotal: r.data.cgstTotal,
    sgstTotal: r.data.sgstTotal,
    igstTotal: r.data.igstTotal,
    taxTotal: r.data.taxTotal,
    roundOff: r.data.roundOff,
    total: r.data.total,
    paymentType: r.data.paymentType,
    paid: r.data.paid,
    due: r.data.due,
    hasDueDate: r.data.dueDate !== undefined,
    lines: r.data.items.map((l) => ({ quantity: l.quantity, price: l.price, amount: l.amount, gstPercent: l.gstPercent, taxAmount: l.taxAmount })),
  });
  const after = (await client.get(`/inventory/${med._id}`)).data;
  return {
    reorderLevel: after.reorderLevel,
    invoices: [shape(cash), shape(credit), shape(discounted)].map((x) => ({ ...x })),
    // Which lot each unit came out of, by expiry order rather than by name: FEFO is part of "what billing did".
    lotsAfter: after.batches.map((b) => b.availableQuantity).sort((a, b) => a - b),
    totalStock: after.totalStock,
  };
}

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
});

describe('Defaults keep today’s behaviour', () => {
  it('bills and adjusts stock identically for a legacy organization, a migrated one and a new one', async () => {
    // (a) An organization that existed before any of this: none of the new fields at all.
    const legacy = await h.makeTenant('P4 Legacy Org');
    await orgs().updateOne(
      { _id: legacy.org._id },
      { $unset: { 'settings.invoice': '', 'settings.general': '', owner: '', bank: '', tax: '', licenses: '', billingAddress: '', legalName: '', businessCategory: '', billingSameAsRegistered: '' } },
    );
    const raw = await orgs().findOne({ _id: legacy.org._id });
    assert.equal(raw.settings.invoice, undefined, 'the legacy organization really has none of the new settings');
    assert.equal(raw.settings.general, undefined);

    // (b) The same kind of organization after the migration has run over it.
    const migrated = await h.makeTenant('P4 Migrated Org');
    await orgs().updateOne({ _id: migrated.org._id }, { $unset: { 'settings.invoice': '', 'settings.general': '', licenses: '', owner: '', bank: '', tax: '' } });
    // ...carrying the OLD, wrong defaults the first version of the migration wrote, to prove they get corrected.
    await orgs().updateOne(
      { _id: migrated.org._id },
      { $set: { 'settings.general.billing.requireCustomerPhoneOnCredit': true, 'settings.general.billing.defaultCreditDays': 15, 'settings.general.dateFormat': 'dd/MM/yyyy' } },
    );
    const report = await applySettingsDefaults(h.mongoose.connection.db);
    assert.ok(report.corrected >= 1, 'the migration corrected the wrong defaults');
    const fixed = await orgs().findOne({ _id: migrated.org._id });
    assert.equal(fixed.settings.general.billing.requireCustomerPhoneOnCredit, false);
    assert.equal(fixed.settings.general.billing.defaultCreditDays, 0);
    assert.equal(fixed.settings.general.dateFormat, 'dd MMM yyyy');

    // (c) A brand new organization, on the schema's own defaults.
    const fresh = await h.makeTenant('P4 Fresh Org');

    const [a, b, c] = [await workingDay(legacy.client), await workingDay(migrated.client), await workingDay(fresh.client)];

    // Not vacuous: the day itself came out as it should.
    assert.deepEqual(a.invoices.map((i) => i.invoiceNo), ['INV-00001', 'INV-00002', 'INV-00003'], 'numbered exactly as before');
    assert.equal(a.reorderLevel, 10, 'a new medicine still starts at a reorder level of 10');
    assert.equal(a.invoices[0].total, 5 * 100 + 2 * 110, 'five units from the soonest-expiring lot at ₹100, then two from the later one at ₹110: FEFO');
    assert.equal(a.invoices[1].due, a.invoices[1].total - 100, 'a credit sale with no phone number is still allowed');
    assert.equal(a.invoices[1].hasDueDate, false, 'and still carries no due date');
    assert.equal(a.invoices[0].roundOff, 0, 'totals are exact: nothing is rounded unless asked');

    assert.deepEqual(b, a, 'a migrated organization bills exactly like a legacy one');
    assert.deepEqual(c, a, 'and so does a brand new one');
  });

  it('reads its dates the way it always has', async () => {
    const fresh = await h.makeTenant('P4 Dates Org');
    const me = await fresh.client.get('/auth/me');
    assert.equal(me.data.user.organization.dateFormat, 'dd MMM yyyy', '"06 Nov 2026" — what every screen has always shown');
    assert.equal((await get(fresh.client)).general.dateFormat, 'dd MMM yyyy');
  });

  it('shows the same alerts in the bell as before, and the same expiry window', async () => {
    const fresh = await h.makeTenant('P4 Bell Org');
    const alerts = (await fresh.client.get('/dashboard/alerts')).data;
    assert.equal(alerts.expiryWindowDays, 90, 'the dashboard window was 90 days and still is');
    assert.deepEqual(alerts.notifications, { lowStock: true, nearExpiry: true, licenseExpiry: true, dailySummary: false });
    assert.equal(alerts.dailySummary, null, 'no new alert appears until somebody asks for it');
    assert.deepEqual(alerts.licenses, []);
  });

  it('migrating twice changes nothing the second time', async () => {
    await applySettingsDefaults(h.mongoose.connection.db);
    const second = await applySettingsDefaults(h.mongoose.connection.db);
    assert.deepEqual(second, { filled: 0, toggles: 0, notifications: 0, pans: 0, corrected: 0 }, 'idempotent: every step found nothing left to do');
  });

  it('never overwrites a choice made after the correction ran', async () => {
    const org = await h.makeTenant('P4 Choice Org');
    await applySettingsDefaults(h.mongoose.connection.db); // stamps the corrected version on this organization
    assert.equal((await saveGeneral(org.client, { billing: { requireCustomerPhoneOnCredit: true, defaultCreditDays: 21 } })).status, 200);
    await applySettingsDefaults(h.mongoose.connection.db); // a re-run must leave a deliberate choice alone
    const g = (await get(org.client)).general;
    assert.equal(g.billing.requireCustomerPhoneOnCredit, true);
    assert.equal(g.billing.defaultCreditDays, 21);
  });
});

describe('Credit sales', () => {
  let org;
  let med;
  before(async () => {
    org = await h.makeTenant('P4 Credit Org');
    med = await medicine(org.client);
    await batch(org.client, med._id, { qty: 100 });
  });

  it('refuses a credit sale with no phone number — on the server — once the organization requires one', async () => {
    assert.equal((await saveGeneral(org.client, { billing: { requireCustomerPhoneOnCredit: true } })).status, 200);

    const refused = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Credit', paid: 0, customer: { name: 'Nobody', phone: '' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'CUSTOMER_PHONE_REQUIRED');
    assert.equal(refused.body.details[0].path, 'customer.phone');

    const ok = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Credit', paid: 0, customer: { name: 'Asha', phone: '9876543210' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('refuses it before any stock moves, not after allocating and rolling back', async () => {
    const before = (await org.client.get(`/inventory/${med._id}`)).data.totalStock;
    await sell(org.client, { items: [{ medicineId: med._id, quantity: 4 }], paymentType: 'Credit', paid: 0, customer: { phone: '' } });
    assert.equal((await org.client.get(`/inventory/${med._id}`)).data.totalStock, before, 'nothing was taken');
  });

  it('still lets a cash sale through without a phone, whatever the credit rule says', async () => {
    const r = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Cash', customer: { phone: '' } });
    assert.equal(r.status, 201, 'the rule is about credit only');
  });

  it('lets a credit sale through again when the rule is switched off', async () => {
    assert.equal((await saveGeneral(org.client, { billing: { requireCustomerPhoneOnCredit: false } })).status, 200);
    const r = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Credit', paid: 0, customer: { phone: '' } });
    assert.equal(r.status, 201);
  });

  it('stamps a due date from the default credit period, only when something is actually due', async () => {
    assert.equal((await saveGeneral(org.client, { billing: { defaultCreditDays: 10 } })).status, 200);

    const owed = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Credit', paid: 0 });
    assert.ok(owed.data.dueDate, 'a credit sale with a balance carries a due date');
    const days = Math.round((new Date(owed.data.dueDate) - new Date(owed.data.invoiceDate)) / 86400000);
    assert.equal(days, 10, 'ten days after the sale');

    const settled = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Credit', paid: 100000 });
    assert.equal(settled.data.due, 0);
    assert.equal(settled.data.dueDate, undefined, 'nothing due, so no due date');

    const cash = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }], paymentType: 'Cash' });
    assert.equal(cash.data.dueDate, undefined, 'a cash sale is never on credit');
  });

  it('refuses a credit period that is not a credit period', async () => {
    assert.equal((await saveGeneral(org.client, { billing: { defaultCreditDays: 400 } })).status, 400);
    assert.equal((await saveGeneral(org.client, { billing: { defaultCreditDays: -1 } })).status, 400);
  });
});

describe('Rounding', () => {
  it('rounds to the nearest rupee exactly as before, and to ₹0.50 when asked', async () => {
    const org = await h.makeTenant('P4 Round Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id, { qty: 100, price: 99.3 });

    const exact = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal(exact.data.roundOff, 0, 'off until the organization turns it on');
    assert.equal(exact.data.total, 99.3);

    await saveGeneral(org.client, { posRoundOff: true });
    const rupee = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal(rupee.data.total, 99, 'to the nearest rupee, which is what turning it on has always done');

    const cur = await get(org.client);
    const half = await org.client.patch('/settings/invoice', { version: cur.version, calculation: { roundOffNearest: 0.5 } });
    assert.equal(half.status, 200, JSON.stringify(half.body));
    const fifty = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal(fifty.data.total, 99.5, '99.30 is closer to 99.50 than to 99.00');
    assert.equal(fifty.data.roundOff, 0.2);
    assert.equal(fifty.data.total * 2, Math.round(fifty.data.total * 2), 'a multiple of ₹0.50');
  });
});

describe('The rules that are not settings', () => {
  let org;
  let med;
  before(async () => {
    org = await h.makeTenant('P4 Rules Org');
    med = await medicine(org.client);
  });

  it('sells the soonest-expiring lot first, however the request is dressed up', async () => {
    const late = await batch(org.client, med._id, { qty: 10, years: 3 });
    const soon = await batch(org.client, med._id, { qty: 10, years: 1 });

    // A caller trying to steer the sale: none of these fields exist, so none of them can have any effect.
    const r = await sell(org.client, { items: [{ medicineId: med._id, quantity: 4, batchId: late._id, fefo: false }], fefo: 'off', allowExpired: true, batchId: late._id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.items.length, 1);
    assert.equal(String(r.data.items[0].batchId), String(soon._id), 'the lot that expires first, as always');

    const after = (await org.client.get(`/inventory/${med._id}`)).data.batches;
    assert.equal(after.find((b) => String(b._id) === String(soon._id)).availableQuantity, 6);
    assert.equal(after.find((b) => String(b._id) === String(late._id)).availableQuantity, 10, 'the later lot was not touched');
  });

  it('never sells a batch that has expired, even if it is the only stock and the request insists', async () => {
    const solo = await medicine(org.client);
    await h.tenant.runWithTenant(org.org._id, () =>
      h.models.Batch.create({ medicineId: solo._id, batchNumber: uniq('GONE'), expiryDate: new Date(Date.now() - 3 * 86400000), purchasePrice: 50, sellingPrice: 100, mrp: 200, initialQuantity: 30, availableQuantity: 30 }),
    );
    const r = await sell(org.client, { items: [{ medicineId: solo._id, quantity: 1 }], allowExpired: true, blockExpired: false });
    assert.equal(r.status, 409, 'expired stock is not stock');
    assert.match(r.body.message, /Insufficient stock/);
    const after = (await org.client.get(`/inventory/${solo._id}`)).data;
    assert.equal(after.batches[0].availableQuantity, 30, 'and not a unit of it was taken');
  });

  it('has no setting that could turn either rule off', async () => {
    const d = await get(org.client);
    const everything = JSON.stringify(d);
    assert.ok(!/allowNegative|negativeStock":\s*(true|false)|blockExpired|fefoMode|allowExpired/i.test(everything.replace(/"key":"negativeStock"/g, '')), 'no switch for either rule exists in the settings');
    assert.deepEqual(d.enforced.map((e) => e.key).sort(), ['expired', 'fefo', 'negativeStock'], 'they are listed as enforced instead');

    // And an attempt to send one is not stored: unknown keys are dropped by the validator.
    const r = await saveGeneral(org.client, { inventory: { defaultLowStockThreshold: 12, blockExpired: false, allowNegativeStock: true } });
    assert.equal(r.status, 200);
    const saved = await h.mongoose.connection.db.collection('organizations').findOne({ _id: org.org._id });
    assert.equal(saved.settings.general.inventory.blockExpired, undefined);
    assert.equal(saved.settings.general.inventory.allowNegativeStock, undefined);
  });

  it('refuses to receive a batch that has already expired — by hand, and when a stale import is confirmed', async () => {
    const m = await medicine(org.client);
    const byHand = await org.client.post('/batches', { medicineId: m._id, batchNumber: uniq('OLD'), expiryDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10), mrp: 200, sellingPrice: 100, purchasePrice: 60, initialQuantity: 5 });
    assert.equal(byHand.status, 400, 'the form refuses it');

    // A spreadsheet previewed while its lot was still in date, then confirmed after it was not. The preview said
    // "fine"; only the write itself can notice that it no longer is.
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const csv = ['medicineName,batchNumber,expiryDate,purchasePrice,mrp,sellingPrice,quantity', `Stale Import ${n},STALE-1,${tomorrow},10,20,18,40`].join('\n');
    const preview = await org.client.request('POST', '/import/inventory/preview?fileName=stale.csv', { body: csv, headers: { 'content-type': 'text/csv' } });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    const jobId = preview.data._id || preview.data.id;

    // Time passes: the sheet's expiry cell now holds yesterday's date. (Confirm re-reads the raw sheet against today's
    // date - that is what a real delay would look like to it - so the cell is what has to change.)
    const yesterdayText = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const coll = h.mongoose.connection.db.collection('importjobs');
    const job = await coll.findOne({ _id: new h.mongoose.Types.ObjectId(jobId) });
    let rewritten = 0;
    for (const row of job.parsedRows) {
      for (const [k, v] of Object.entries(row.cells || {})) {
        if (v === tomorrow) {
          row.cells[k] = yesterdayText;
          rewritten += 1;
        }
      }
    }
    assert.ok(rewritten >= 1, 'the simulation really did age the sheet');
    await coll.updateOne({ _id: job._id }, { $set: { parsedRows: job.parsedRows } });

    const confirmed = await org.client.post(`/import/inventory/${jobId}/confirm`, {});
    const stale = await h.tenant.runWithTenant(org.org._id, () => h.models.Batch.findOne({ batchNumber: 'STALE-1' }).lean());
    assert.equal(stale, null, `no expired batch was created (confirm answered ${confirmed.status})`);
  });
});

describe('Receiving stock', () => {
  it('refuses an expired batch at the write itself, whoever is calling', async () => {
    const org = await h.makeTenant('P4 Write Guard Org');
    const m = await medicine(org.client);
    const medDoc = await h.tenant.runWithTenant(org.org._id, () => h.models.Medicine.findById(m._id).lean());
    const { createBatchInTx } = await import('../services/batch.service.js');
    const { withTransaction } = await import('../services/transaction.service.js');
    const req = { orgId: org.org._id, user: org.user };
    const attempt = (expiryDate) =>
      h.tenant.runWithTenant(org.org._id, () =>
        withTransaction((session) => createBatchInTx(req, medDoc, { batchNumber: uniq('W'), expiryDate, initialQuantity: 5, mrp: 20, sellingPrice: 10, purchasePrice: 5 }, session)),
      );

    await assert.rejects(() => attempt(new Date(Date.now() - 86400000)), (e) => e.status === 400 && /already expired/.test(e.message), 'yesterday: refused');
    await assert.rejects(() => attempt(undefined), (e) => e.status === 400, 'no expiry at all: refused');
    const ok = await attempt(new Date(Date.now() + 90 * 86400000));
    assert.ok(ok._id, 'a lot still in date is received as before');
  });
});

describe('The financial year start', () => {
  it('can be changed freely while no invoice exists in the current year', async () => {
    const org = await h.makeTenant('P4 FY Free Org');
    const g = (await get(org.client)).general.fiscalYear;
    assert.equal(g.locked, false);
    assert.equal(g.reason, null);
    const r = await saveGeneral(org.client, { fiscalYearStartMonth: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await get(org.client)).general.fiscalYearStartMonth, 7);
  });

  it('locks from the first invoice, says why, and refuses on the server', async () => {
    const org = await h.makeTenant('P4 FY Locked Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    assert.equal((await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] })).status, 201);

    const lock = (await get(org.client)).general.fiscalYear;
    assert.equal(lock.locked, true);
    assert.equal(lock.invoicesThisYear, 1);
    assert.match(lock.reason, /already been issued in the financial year/);

    const refused = await saveGeneral(org.client, { fiscalYearStartMonth: 1 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'FISCAL_YEAR_LOCKED');
    assert.equal((await get(org.client)).general.fiscalYearStartMonth, 4, 'and it did not move');
  });

  it('is locked through the older organization endpoint too — there is only one lock, with two doors', async () => {
    const org = await h.makeTenant('P4 FY Door Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });

    const viaOld = await org.client.put('/organization', { settings: { fiscalYearStartMonth: 1 } });
    assert.equal(viaOld.status, 409, JSON.stringify(viaOld.body));
    assert.equal(viaOld.body.code, 'FISCAL_YEAR_LOCKED');
    // Saving the value it already has is not a change.
    assert.equal((await org.client.put('/organization', { settings: { fiscalYearStartMonth: 4 } })).status, 200);
  });

  it('does not count last year’s invoices, only this year’s', async () => {
    const org = await h.makeTenant('P4 FY Old Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    const inv = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    // That invoice belongs to a financial year that is over.
    await h.mongoose.connection.db.collection('invoices').updateOne({ _id: new h.mongoose.Types.ObjectId(inv.data._id) }, { $set: { invoiceDate: new Date(Date.now() - 400 * 86400000) } });
    assert.equal((await get(org.client)).general.fiscalYear.locked, false);
    assert.equal((await saveGeneral(org.client, { fiscalYearStartMonth: 10 })).status, 200);
  });

  it('allows saving the same start month even when locked, so other changes are not blocked', async () => {
    const org = await h.makeTenant('P4 FY Same Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal((await saveGeneral(org.client, { fiscalYearStartMonth: 4, dateFormat: 'dd/MM/yyyy' })).status, 200);
  });
});

describe('Timezone and date format are display only', () => {
  /** Every stored date in the organization, as one string, so "unchanged" means byte-for-byte unchanged. */
  const snapshot = async (org) => {
    const db = h.mongoose.connection.db;
    const q = { organizationId: org.org._id };
    return JSON.stringify({
      invoices: await db.collection('invoices').find(q).sort({ invoiceNo: 1 }).project({ invoiceNo: 1, invoiceDate: 1, createdAt: 1, updatedAt: 1, total: 1 }).toArray(),
      batches: await db.collection('batches').find(q).sort({ batchNumber: 1 }).project({ expiryDate: 1, createdAt: 1, manufacturingDate: 1 }).toArray(),
      ledger: await db.collection('stockmovements').find(q).sort({ _id: 1 }).project({ createdAt: 1, quantity: 1 }).toArray(),
    });
  };

  it('rewrites no stored date when the date format changes, however many documents exist', async () => {
    const org = await h.makeTenant('P4 Display Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id, { qty: 30 });
    for (let i = 0; i < 3; i += 1) await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    const before = await snapshot(org);

    const r = await saveGeneral(org.client, { dateFormat: 'yyyy-MM-dd' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.equal(await snapshot(org), before, 'every stored date is byte-for-byte what it was');
    assert.equal((await org.client.get('/auth/me')).data.user.organization.dateFormat, 'yyyy-MM-dd', 'only what is DISPLAYED follows');
  });

  it('rewrites no stored date when the timezone changes either — once it is allowed to change', async () => {
    const org = await h.makeTenant('P4 Display Zone Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id, { qty: 30 });
    const old = [];
    for (let i = 0; i < 3; i += 1) old.push(await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] }));
    // The year those invoices belong to is over, so the timezone is not locked.
    for (const inv of old) {
      await h.mongoose.connection.db.collection('invoices').updateOne({ _id: new h.mongoose.Types.ObjectId(inv.data._id) }, { $set: { invoiceDate: new Date(Date.now() - 400 * 86400000) } });
    }
    const before = await snapshot(org);

    const r = await saveGeneral(org.client, { timezone: 'America/New_York' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await snapshot(org), before, 'every stored date is byte-for-byte what it was');
    assert.equal((await org.client.get('/auth/me')).data.user.organization.timezone, 'America/New_York');
  });

  it('refuses a format or zone that does not exist', async () => {
    const org = await h.makeTenant('P4 Display Bad Org');
    assert.equal((await saveGeneral(org.client, { dateFormat: 'MM/DD/YY' })).status, 400);
    assert.equal((await saveGeneral(org.client, { timezone: 'Mars/Olympus' })).status, 400);
  });
});

describe('The timezone lock', () => {
  const withInvoice = async (name) => {
    const org = await h.makeTenant(name);
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    assert.equal((await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] })).status, 201);
    return org;
  };

  it('can be changed freely while no invoice exists in the current financial year', async () => {
    const org = await h.makeTenant('P4 TZ Free Org');
    const lock = (await get(org.client)).general.timezoneLock;
    assert.equal(lock.locked, false);
    assert.equal(lock.reason, null);
    assert.equal((await saveGeneral(org.client, { timezone: 'Asia/Dubai' })).status, 200);
    assert.equal((await get(org.client)).general.timezone, 'Asia/Dubai');
  });

  it('locks from the first invoice, says why, and refuses on the server', async () => {
    const org = await withInvoice('P4 TZ Locked Org');
    const lock = (await get(org.client)).general.timezoneLock;
    assert.equal(lock.locked, true);
    assert.equal(lock.invoicesThisYear, 1);
    assert.match(lock.reason, /decides where local midnight falls/);

    const refused = await saveGeneral(org.client, { timezone: 'Europe/London' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'TIMEZONE_LOCKED');
    assert.equal((await get(org.client)).general.timezone, 'Asia/Kolkata', 'and it did not move');
  });

  it('is locked through all three doors — there is one lock', async () => {
    const org = await withInvoice('P4 TZ Doors Org');

    const viaGeneral = await saveGeneral(org.client, { timezone: 'Asia/Singapore' });
    assert.equal(viaGeneral.status, 409, 'PATCH /settings/general');
    assert.equal(viaGeneral.body.code, 'TIMEZONE_LOCKED');

    const cur = await get(org.client);
    const viaOrganizationPatch = await org.client.patch('/settings/organization', { version: cur.version, timezone: 'Asia/Singapore' });
    assert.equal(viaOrganizationPatch.status, 409, 'PATCH /settings/organization');
    assert.equal(viaOrganizationPatch.body.code, 'TIMEZONE_LOCKED');

    const viaOld = await org.client.put('/organization', { timezone: 'Asia/Singapore' });
    assert.equal(viaOld.status, 409, 'PUT /organization');
    assert.equal(viaOld.body.code, 'TIMEZONE_LOCKED');

    assert.equal((await get(org.client)).general.timezone, 'Asia/Kolkata', 'not one of the three moved it');
  });

  it('lets the same timezone through, so unrelated changes are never blocked', async () => {
    const org = await withInvoice('P4 TZ Same Org');
    assert.equal((await saveGeneral(org.client, { timezone: 'Asia/Kolkata', dateFormat: 'dd/MM/yyyy' })).status, 200);
    assert.equal((await org.client.put('/organization', { timezone: 'Asia/Kolkata' })).status, 200);
    const cur = await get(org.client);
    assert.equal((await org.client.patch('/settings/organization', { version: cur.version, timezone: 'Asia/Kolkata', legalName: 'X Pvt Ltd' })).status, 200);
  });

  it('does not count last year’s invoices, only this year’s', async () => {
    const org = await withInvoice('P4 TZ Old Org');
    await h.mongoose.connection.db.collection('invoices').updateMany({ organizationId: org.org._id }, { $set: { invoiceDate: new Date(Date.now() - 400 * 86400000) } });
    assert.equal((await get(org.client)).general.timezoneLock.locked, false);
    assert.equal((await saveGeneral(org.client, { timezone: 'Asia/Tokyo' })).status, 200);
  });
});

describe('Resetting the invoice settings', () => {
  it('resets layout and toggles only — never numbering, terms, counters or an existing number', async () => {
    const org = await h.makeTenant('P4 Reset Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id, { qty: 30 });
    const first = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal(first.data.invoiceNo, 'INV-00001');

    let cur = await get(org.client);
    await org.client.patch('/settings/invoice', {
      version: cur.version,
      series: [{ series: 'sales', prefix: 'SWS', separator: '/', padding: 4 }],
      template: { paperSize: 'thermal58', accentColor: '#112233', show: { hsn: false } },
      terms: { terms: 'Goods once sold…', signatoryName: 'Asha' },
    });
    const counterBefore = await h.mongoose.connection.db.collection('counters').findOne({ organizationId: org.org._id, key: 'invoice' });

    cur = await get(org.client);
    const reset = await org.client.post('/settings/invoice/reset', { version: cur.version, confirm: 'RESET' });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const after = await get(org.client);
    assert.equal(after.invoice.template.paperSize, 'A4', 'layout is back');
    assert.equal(after.invoice.template.accentColor, '#0f766e');
    assert.equal(after.invoice.template.show.hsn, true, 'toggles are back');

    const sales = after.invoice.series.find((s) => s.series === 'sales').organization;
    assert.equal(sales.prefix, 'SWS', 'the numbering format is NOT layout, and is untouched');
    assert.equal(after.invoice.terms.terms, 'Goods once sold…', 'so are the terms somebody wrote');
    assert.equal(after.invoice.terms.signatoryName, 'Asha');

    const counterAfter = await h.mongoose.connection.db.collection('counters').findOne({ organizationId: org.org._id, key: 'invoice' });
    assert.equal(counterAfter.seq, counterBefore.seq, 'the counter is exactly where it was');
    const stored = await h.mongoose.connection.db.collection('invoices').findOne({ _id: new h.mongoose.Types.ObjectId(first.data._id) });
    assert.equal(stored.invoiceNo, 'INV-00001', 'and an invoice that exists is still called what it was called');

    const next = await sell(org.client, { items: [{ medicineId: med._id, quantity: 1 }] });
    assert.equal(next.data.invoiceNo, 'SWS/0002', 'numbering carries on from the same counter, in the same format');
  });
});

describe('New medicines', () => {
  it('start from the organization’s default reorder level, unless the form says otherwise', async () => {
    const org = await h.makeTenant('P4 Reorder Org');
    assert.equal((await medicine(org.client)).reorderLevel, 10, 'ten, until somebody changes it');

    assert.equal((await saveGeneral(org.client, { inventory: { defaultLowStockThreshold: 25 } })).status, 200);
    assert.equal((await medicine(org.client)).reorderLevel, 25, 'the new default');
    assert.equal((await medicine(org.client, { reorderLevel: 7 })).reorderLevel, 7, 'an explicit level always wins');
    assert.equal((await medicine(org.client, { reorderLevel: 0 })).reorderLevel, 0, 'including zero, which is a deliberate choice');
  });

  it('leaves existing medicines alone when the default changes', async () => {
    const org = await h.makeTenant('P4 Reorder Existing Org');
    const old = await medicine(org.client);
    await saveGeneral(org.client, { inventory: { defaultLowStockThreshold: 40 } });
    assert.equal((await org.client.get(`/inventory/${old._id}`)).data.reorderLevel, 10, 'each medicine keeps its own level');
  });
});

describe('What the bell shows', () => {
  it('follows the organization’s own expiry thresholds for its window', async () => {
    const org = await h.makeTenant('P4 Window Org');
    assert.equal((await org.client.get('/dashboard/alerts')).data.expiryWindowDays, 90);
    assert.equal((await saveGeneral(org.client, { expiry: { thresholds: [10, 20, 45] } })).status, 200);
    assert.equal((await org.client.get('/dashboard/alerts')).data.expiryWindowDays, 45, 'the largest threshold, read from settings.expiry — not a copy of it');
    assert.equal((await org.client.get('/dashboard/alerts?expiryDays=30')).data.expiryWindowDays, 30, 'an explicit ask still wins');
  });

  it('reports licences that are expiring or lapsed, only when that alert is on', async () => {
    const org = await h.makeTenant('P4 Licence Bell Org');
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const gone = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const cur = await get(org.client);
    await org.client.patch('/settings/organization', {
      version: cur.version,
      licenses: [
        { type: '20', number: 'SOON-1', validUntil: soon },
        { type: '21', number: 'GONE-1', validUntil: gone },
        { type: '20B', number: 'FINE-1', validUntil: '2099-01-01' },
      ],
    });

    const on = (await org.client.get('/dashboard/alerts')).data;
    assert.deepEqual(on.licenses.map((l) => l.number), ['GONE-1', 'SOON-1'], 'lapsed first, then soonest; the fine one is not an alert');
    assert.equal(on.licenses[0].expired, true);

    await saveGeneral(org.client, { notifications: { licenseExpiry: { enabled: false } } });
    const off = (await org.client.get('/dashboard/alerts')).data;
    assert.deepEqual(off.licenses, []);
    assert.equal(off.notifications.licenseExpiry, false);
  });

  it('gives yesterday’s trade only when the daily summary is switched on', async () => {
    const org = await h.makeTenant('P4 Summary Org');
    const med = await medicine(org.client);
    await batch(org.client, med._id);
    const inv = await sell(org.client, { items: [{ medicineId: med._id, quantity: 2 }] });
    // Move the sale to yesterday (the organization's own day) so there is something to summarise.
    await h.mongoose.connection.db.collection('invoices').updateOne({ _id: new h.mongoose.Types.ObjectId(inv.data._id) }, { $set: { invoiceDate: new Date(Date.now() - 24 * 3600 * 1000) } });

    assert.equal((await org.client.get('/dashboard/alerts')).data.dailySummary, null, 'off by default');
    await saveGeneral(org.client, { notifications: { dailySummary: { enabled: true } } });
    const s = (await org.client.get('/dashboard/alerts')).data.dailySummary;
    assert.equal(s.invoices, 1);
    assert.equal(s.sales, inv.data.total);
  });

  it('keeps the figures when an alert is switched off — only the bell is quieter', async () => {
    const org = await h.makeTenant('P4 Quiet Org');
    await saveGeneral(org.client, { notifications: { lowStock: { enabled: false } } });
    const a = (await org.client.get('/dashboard/alerts')).data;
    assert.equal(a.notifications.lowStock, false);
    assert.ok('lowStock' in a.counts, 'the dashboard cards still get their counts');
  });

  /**
   * This pinned "in_app is the only channel" when it was written, which was true then. `email` became a real
   * channel when the near-expiry digest was built (scripts/run-expiry-alerts.js), so the half of the assertion
   * about email now describes the feature rather than its absence. The other half still matters: a channel the
   * system cannot actually deliver on must still be refused.
   */
  it('accepts only the channels that exist', async () => {
    const org = await h.makeTenant('P4 Channel Org');
    assert.equal((await saveGeneral(org.client, { notifications: { lowStock: { channel: 'whatsapp' } } })).status, 400, 'whatsapp cannot be delivered, so it cannot be chosen');
    assert.equal((await saveGeneral(org.client, { notifications: { lowStock: { channel: 'email' } } })).status, 200, 'email is a real channel now');
    assert.equal((await saveGeneral(org.client, { notifications: { lowStock: { channel: 'none' } } })).status, 200);
  });
});

describe('The calculation choices that cannot be changed', () => {
  it('refuses to apply an item discount after tax, because billing does not', async () => {
    const org = await h.makeTenant('P4 Calc Org');
    const cur = await get(org.client);
    const r = await org.client.patch('/settings/invoice', { version: cur.version, calculation: { itemDiscountBeforeTax: false } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /always taken off before the tax/);
  });
});
