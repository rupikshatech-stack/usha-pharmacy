// A billing-only user (no settings:read) issues and prints an invoice. The seller's address, GSTIN, licences and bank block, and the
// CGST+SGST-versus-IGST split, must all reach the PRINTED invoice. They used to be fetched by the browser from GET /settings, which such
// a user is refused: the print silently fell back to the bare organization name and went to the customer without a GSTIN.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness, futureDate } from './helpers/harness.js';
import { seedSystemRoles } from '../scripts/lib/rolesMigration.js';
import { renderInvoiceHtml } from '../../client/src/utils/invoiceTemplate.js'; // the REAL print function the browser uses

let h;
let T; // the organization and its administrator
let clerk; // a client signed in as a user with ONLY billing:create + billing:read
let n = 0;
const uniq = (p) => `${p}-${Date.now()}-${++n}`;
const email = () => `c${Date.now()}${++n}@example.test`;

const SELLER = {
  name: 'SWS Wholesale',
  legalName: 'SWS Wholesale Pvt Ltd',
  phone: '9876543210',
  gstin: '27AAPFU0939F1ZV',
  address: { line1: 'Venkatesh Imperia', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  licenses: [{ type: '20B', number: 'MH-20B-1' }],
  bank: { accountHolder: 'SWS', bankName: 'HDFC', accountNumber: '50100123456789', ifsc: 'HDFC0001234', upiId: 'sws@okhdfcbank' },
};

const stocked = async () => {
  const med = (await T.client.post('/inventory', { medicineName: uniq('Med'), unit: 'Strip', gstPercentage: 12, hsnCode: '30049099', reorderLevel: 0 })).data;
  await T.client.post('/batches', { medicineId: med._id, batchNumber: uniq('B'), expiryDate: futureDate(2), mrp: 150, sellingPrice: 112, initialQuantity: 100 });
  return med;
};
const sell = (c, med, customer) => c.post('/invoices', { idempotencyKey: uniq('k'), items: [{ medicineId: med._id, quantity: 2 }], ...(customer ? { customer } : {}) });
const setOrg = (set) => h.models.Organization.updateOne({ _id: T.org._id }, { $set: set });
const printed = (res) => {
  const { print, ...invoice } = res.data;
  return renderInvoiceHtml({ invoice, settings: print.settings, org: print.organization });
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** A client signed in as a user holding `role`, past the forced password change. */
async function signedInAs(role) {
  const address = email();
  const made = await T.client.post('/users', { name: 'Test User', email: address, password: PASSWORD, role });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const first = h.client();
  assert.equal((await first.login(address)).status, 200);
  await first.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Their0wn!Pass' });
  const c = h.client();
  assert.equal((await c.login(address, 'Their0wn!Pass')).status, 200);
  return c;
}

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Seller Block Org');
  await seedSystemRoles(h.mongoose.connection.db, { dryRun: false });
  await setOrg({ ...SELLER, 'settings.invoice.template.show.bankDetails': true });
  const till = await T.client.post('/roles', { name: 'Till Clerk', permissions: ['billing:create', 'billing:read'] });
  assert.equal(till.status, 201, JSON.stringify(till.body));
  clerk = await signedInAs('TILL_CLERK');
});
after(async () => {
  await h?.stop();
});

describe('the seller block on an invoice, for a user who cannot read settings', () => {
  it('(precondition) this clerk really is refused GET /settings and GET /organization', async () => {
    assert.equal((await clerk.get('/settings')).status, 403);
    assert.equal((await clerk.get('/organization')).status, 403);
  });

  it('arrives WITH the invoice the clerk creates: address, GSTIN, licences, the whole bank block, and the layout', async () => {
    const r = await sell(clerk, await stocked());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.data.print.organization;
    assert.equal(o.name, 'SWS Wholesale');
    assert.equal(o.legalName, 'SWS Wholesale Pvt Ltd');
    assert.equal(o.gstin, '27AAPFU0939F1ZV');
    assert.equal(o.address.city, 'Pune');
    assert.deepEqual(o.licenses, [{ type: '20B', number: 'MH-20B-1' }]);
    assert.equal(o.bank.accountNumber, '50100123456789', 'the whole account number, as printed: NOT masked the way GET /settings masks it for a non-manager');
    assert.equal(o.bank.ifsc, 'HDFC0001234');
    assert.equal(r.data.print.settings.template.show.bankDetails, true);
  });

  it('is frozen onto the invoice at sale time, and never sent raw: the response carries `print`, not the stored `seller`', async () => {
    const r = await sell(clerk, await stocked());
    assert.equal(r.data.seller, undefined, 'the response shape is unchanged: no new top-level field');
    assert.equal((await clerk.get(`/invoices/${r.data._id}`)).data.seller, undefined);
    const stored = await h.tenant.runWithTenant(T.org._id, () => h.models.Invoice.findById(r.data._id).select('+seller').lean());
    assert.equal(stored.seller.legalName, 'SWS Wholesale Pvt Ltd');
    assert.equal(stored.seller.gstin, '27AAPFU0939F1ZV');
    assert.equal(stored.seller.address.city, 'Pune');
    assert.equal(stored.seller.bank.accountNumber, '50100123456789');
    const plain = await h.tenant.runWithTenant(T.org._id, () => h.models.Invoice.findById(r.data._id).lean());
    assert.equal(plain.seller, undefined, 'and an ordinary read of the invoice does not load it');
  });

  it("comes back from GET /invoices/:id too (the dialog's Print), but not on every row of the list", async () => {
    const r = await sell(clerk, await stocked());
    const read = await clerk.get(`/invoices/${r.data._id}`);
    assert.equal(read.status, 200);
    assert.equal(read.data.print.organization.gstin, '27AAPFU0939F1ZV');
    const list = await clerk.get('/invoices?limit=5');
    assert.ok(list.data.items.length > 0);
    assert.ok(list.data.items.every((i) => i.print === undefined), 'the list stays lean');
  });

  it('leaves the bank block out entirely when the organization does not print it', async () => {
    await setOrg({ 'settings.invoice.template.show.bankDetails': false, 'settings.invoice.template.show.upiQr': false });
    const r = await sell(clerk, await stocked());
    assert.equal(r.data.print.organization.bank, undefined, 'nothing more is exposed than the invoice would print');
    await setOrg({ 'settings.invoice.template.show.bankDetails': true });
  });
});

describe("what the clerk's PRINTED invoice contains", () => {
  it('has the full seller block, the HSN and the CGST + SGST split for a sale within the state', async () => {
    const r = await sell(clerk, await stocked(), { name: 'Local', phone: '9800000001', gstin: '27AAACS9999A1Z5' });
    assert.equal(r.data.interState, false);
    const t = text(printed(r));
    assert.match(t, /SWS Wholesale Pvt Ltd/, 'the legal name');
    assert.match(t, /GSTIN 27AAPFU0939F1ZV/, 'the seller GSTIN');
    assert.match(t, /Venkatesh Imperia/);
    assert.match(t, /Pune/);
    assert.match(t, /DL 20B: MH-20B-1/, 'the drug licence');
    assert.match(t, /50100123456789/, 'the bank account');
    assert.match(t, /HDFC0001234/);
    assert.match(t, /30049099/, 'the HSN of the line');
    assert.ok(/CGST/.test(t) && /SGST/.test(t), 'CGST and SGST');
    assert.ok(!/IGST/.test(t), 'and no IGST');
  });

  it('has IGST, not CGST + SGST, for a sale across a state line, with the same seller block', async () => {
    const r = await sell(clerk, await stocked(), { name: 'Away', phone: '9800000002', gstin: '29AAACS9999A1Z5' });
    assert.equal(r.data.interState, true);
    const t = text(printed(r));
    assert.ok(/IGST/.test(t), 'IGST');
    assert.ok(!/CGST|SGST/.test(t), 'and neither CGST nor SGST');
    assert.match(t, /GSTIN 27AAPFU0939F1ZV/);
    assert.match(t, /Pune/);
  });
});

describe("what the till's preview is told, so it can decide CGST+SGST versus IGST and round the bill like the server does", () => {
  it("gives the seller's state (from its GSTIN) and the round-off setting to anyone who can sell", async () => {
    const r = await clerk.get('/pos/context');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.data, { sellerState: '27', roundOff: false });
    await setOrg({ 'settings.posRoundOff': true });
    assert.equal((await clerk.get('/pos/context')).data.roundOff, 1, 'round to the nearest rupee when the organization asks for it');
    await setOrg({ 'settings.posRoundOff': false });
  });

  it('is empty for an organization with no GSTIN (the preview then cannot call a sale inter-state, as before)', async () => {
    await setOrg({ gstin: '' });
    assert.equal((await clerk.get('/pos/context')).data.sellerState, '');
    await setOrg({ gstin: SELLER.gstin });
  });

  it('is refused to a user who cannot sell, and so is the logo', async () => {
    const viewer = await T.client.post('/roles', { name: 'Stock Viewer', permissions: ['inventory:read'] });
    assert.equal(viewer.status, 201);
    const c = await signedInAs('STOCK_VIEWER');
    assert.equal((await c.get('/pos/context')).status, 403);
    assert.equal((await c.get('/settings/logo/anything.png')).status, 403);
  });
});

describe('the logo printed on the invoice', () => {
  it('may be fetched by a user who can issue or view invoices (it was settings:read only, which left a broken image on their print)', async () => {
    const r = await clerk.get('/settings/logo/anything.png');
    assert.notEqual(r.status, 403, 'permission is not the obstacle: there is simply no such file');
    assert.equal(r.status, 404);
  });
});

describe('a reprint shows the seller as they were on the day of the sale', () => {
  const EDITED = { legalName: 'Renamed Traders LLP', gstin: '29AAACS9999A1Z5', phone: '1111111111', 'address.city': 'Mumbai', 'address.line1': 'New Road 9', 'bank.accountNumber': '99990000111122', 'bank.ifsc': 'ICIC0000001', licenses: [{ type: '20B', number: 'NEW-LIC-7' }] };
  const ORIGINAL = { legalName: SELLER.legalName, gstin: SELLER.gstin, phone: SELLER.phone, 'address.city': 'Pune', 'address.line1': 'Venkatesh Imperia', 'bank.accountNumber': SELLER.bank.accountNumber, 'bank.ifsc': SELLER.bank.ifsc, licenses: SELLER.licenses };

  it('keeps the original address, GSTIN, licence and bank after the organization is edited, and a new sale uses the new details', async () => {
    const med = await stocked();
    const before = await sell(clerk, med);
    await setOrg(EDITED);
    try {
      const reprint = await clerk.get(`/invoices/${before.data._id}`);
      const t = text(printed(reprint));
      assert.match(t, /SWS Wholesale Pvt Ltd/);
      assert.match(t, /GSTIN 27AAPFU0939F1ZV/);
      assert.match(t, /Venkatesh Imperia/);
      assert.match(t, /Pune/);
      assert.match(t, /DL 20B: MH-20B-1/);
      assert.match(t, /50100123456789/);
      assert.match(t, /HDFC0001234/);
      for (const gone of [/Renamed Traders/, /29AAACS9999A1Z5/, /Mumbai/, /New Road 9/, /NEW-LIC-7/, /99990000111122/, /ICIC0000001/, /1111111111/]) assert.doesNotMatch(t, gone, `${gone} is from after the sale`);

      const after = await sell(clerk, med);
      const t2 = text(printed(after));
      assert.match(t2, /Renamed Traders LLP/);
      assert.match(t2, /GSTIN 29AAACS9999A1Z5/);
      assert.match(t2, /NEW-LIC-7/);
      assert.match(t2, /99990000111122/);
      assert.doesNotMatch(t2, /Venkatesh Imperia/);
    } finally {
      await setOrg(ORIGINAL);
    }
  });

  it('is the same on the idempotent replay of the sale, and on the GET, as on the original response', async () => {
    const key = uniq('replay');
    const med = await stocked();
    const body = { idempotencyKey: key, items: [{ medicineId: med._id, quantity: 1 }] };
    const first = await clerk.post('/invoices', body);
    await setOrg(EDITED);
    try {
      const again = await clerk.post('/invoices', body);
      assert.equal(again.data._id, first.data._id);
      assert.deepEqual(again.data.print.organization, first.data.print.organization);
      assert.deepEqual((await clerk.get(`/invoices/${first.data._id}`)).data.print.organization, first.data.print.organization);
    } finally {
      await setOrg(ORIGINAL);
    }
  });

  it('still decides whether the bank prints, and how the page looks, from the CURRENT layout settings', async () => {
    const r = await sell(clerk, await stocked());
    await setOrg({ 'settings.invoice.template.show.bankDetails': false, 'settings.invoice.template.show.upiQr': false, 'settings.invoice.template.accentColor': '#123456' });
    try {
      const read = await clerk.get(`/invoices/${r.data._id}`);
      assert.equal(read.data.print.organization.bank, undefined);
      assert.equal(read.data.print.settings.template.accentColor, '#123456');
      assert.equal(read.data.print.organization.gstin, '27AAPFU0939F1ZV');
    } finally {
      await setOrg({ 'settings.invoice.template.show.bankDetails': true, 'settings.invoice.template.accentColor': '#0f766e' });
    }
  });

  it('falls back to the current organization for an invoice issued before snapshots existed', async () => {
    const r = await sell(clerk, await stocked());
    await h.tenant.runWithTenant(T.org._id, () => h.models.Invoice.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(r.data._id) }, { $unset: { seller: '' } }));
    await setOrg({ phone: '2222222222' });
    try {
      const read = await clerk.get(`/invoices/${r.data._id}`);
      assert.equal(read.status, 200);
      assert.equal(read.data.print.organization.phone, '2222222222', 'a legacy invoice has nothing frozen, so it reads live');
      assert.equal(read.data.seller, undefined);
    } finally {
      await setOrg({ phone: SELLER.phone });
    }
  });

  it('is not on the list rows, which stay lean', async () => {
    const list = await clerk.get('/invoices?limit=5');
    assert.ok(list.data.items.length > 0);
    assert.ok(list.data.items.every((i) => i.seller === undefined && i.print === undefined));
  });
});
