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

  it('is not stored on the invoice: it is read from the organization each time, so an edit to the organization shows on the next print', async () => {
    const r = await sell(clerk, await stocked());
    const stored = await h.tenant.runWithTenant(T.org._id, () => h.models.Invoice.findById(r.data._id).lean());
    assert.equal(stored.print, undefined);
    await setOrg({ phone: '1111111111' });
    const read = await clerk.get(`/invoices/${r.data._id}`);
    assert.equal(read.data.print.organization.phone, '1111111111');
    await setOrg({ phone: SELLER.phone });
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
