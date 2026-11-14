// The Settings endpoints, against a real database.
//
// The interesting cases here are not "does it save" — they are the ones that protect somebody else's work: a patch
// that only touches what it was given, a save that refuses to overwrite a colleague's, an audit entry that says what
// actually changed, an account number that is not shown to people who cannot edit it, and a counter that cannot
// issue the same invoice number twice however many tills ask at once.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';
import { nextSeq } from '../models/Counter.js';

let h;
let T;
let other;
const VALID_GSTIN = '27AAPFU0939F1ZV';

const get = async (client = T.client) => {
  const r = await client.get('/settings');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
/** Saves a patch at the current version, so a test never has to track the version by hand. */
const save = async (tab, patch, client = T.client) => {
  const current = await get(client);
  return client.patch(`/settings/${tab}`, { version: current.version, ...patch });
};
const auditFor = (org, action) =>
  h.tenant.runWithTenant(org._id, () => h.models.AuditLog.find({ action }).sort({ createdAt: -1 }).limit(1).lean());

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Settings Org');
  other = await h.makeTenant('Settings Other Org');
});
after(async () => {
  await h?.stop();
});

describe('Reading the settings', () => {
  it('answers for all three tabs in one request, with the options each one needs', async () => {
    const d = await get();
    assert.ok(d.version, 'and the version the screen must send back when it saves');
    assert.equal(d.organization.name, 'Settings Org');
    assert.ok(d.invoice.series.length >= 3, 'every series this system issues');
    assert.ok(d.general.expiry.thresholds.length === 3);
    assert.ok(d.options.states.length > 30, 'the states to choose from');
    assert.ok(d.options.licenseTypes.some((t) => t.value === '20B'));
  });

  it('shows the series settings resolved, so the screen never has to guess what a blank means', async () => {
    const d = await get();
    const sales = d.invoice.series.find((s) => s.series === 'sales');
    assert.equal(sales.organization.prefix, 'INV', 'the format this system already prints');
    assert.equal(sales.organization.padding, 5);
    for (const b of sales.branches) assert.equal(b.configured, false, 'no store has its own numbering yet');
  });

  it('states the rules no setting can switch off, rather than leaving people to assume', async () => {
    const d = await get();
    const keys = d.enforced.map((e) => e.key);
    assert.deepEqual(keys.sort(), ['expired', 'fefo', 'negativeStock']);
    assert.match(d.enforced.find((e) => e.key === 'expired').detail, /cannot reach a bill/);
  });

  it('derives the PAN from the GSTIN instead of asking for it twice', async () => {
    const saved = await save('organization', { gstin: VALID_GSTIN });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const d = await get();
    assert.equal(d.organization.gstin, VALID_GSTIN);
    assert.equal(d.organization.tax.pan, 'AAPFU0939F');
  });

  it('warns when the GSTIN was issued in a different state from the address, without refusing it', async () => {
    const r = await save('organization', { address: { state: 'Karnataka' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = await get();
    assert.match(d.organization.gstinWarning, /issued in Maharashtra/);
  });
});

describe('Saving only what changed', () => {
  it('leaves every field the patch did not mention exactly as it was', async () => {
    await save('organization', { legalName: 'Settings Org Pvt Ltd', owner: { firstName: 'Asha', lastName: 'Patil' } });
    await save('organization', { owner: { phone: '9876543210' } });

    const d = await get();
    assert.equal(d.organization.legalName, 'Settings Org Pvt Ltd', 'untouched by the second save');
    assert.equal(d.organization.owner.firstName, 'Asha', 'and so is the rest of the owner block');
    assert.equal(d.organization.owner.phone, '9876543210');
  });

  it('tells an empty string apart from an absent field', async () => {
    await save('organization', { description: 'Something' });
    assert.equal((await get()).organization.description, 'Something');
    await save('organization', { legalName: 'Still here' });
    assert.equal((await get()).organization.description, 'Something', 'not touched is not cleared');
    await save('organization', { description: '' });
    assert.equal((await get()).organization.description, '', 'but an empty string does clear it');
  });

  it('does nothing at all when the patch changes nothing', async () => {
    const before = await get();
    const r = await T.client.patch('/settings/organization', { version: before.version, name: before.organization.name });
    assert.equal(r.status, 200);
    assert.equal(r.data.unchanged, true);
    assert.deepEqual(r.data.changes, []);
    assert.equal((await get()).version, before.version, 'and the version does not move, so nobody else is disturbed');
  });

  it('edits the expiry module’s own settings in place rather than keeping a second copy', async () => {
    const r = await save('general', { expiry: { thresholds: [10, 45, 120], velocityWindowDays: 90 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const d = await get();
    assert.deepEqual(d.general.expiry.thresholds, [10, 45, 120]);
    // The expiry report reads the same place, so it must see the change.
    const expiry = await T.client.get('/analytics/expiry/summary');
    assert.equal(expiry.status, 200);
    assert.equal(expiry.data.settings.velocityWindowDays, 90, 'one set of numbers, not two');
  });
});

describe('Two people saving at once', () => {
  it('refuses the second save and says who got there first, instead of overwriting their work', async () => {
    const stale = await get();
    const first = await T.client.patch('/settings/organization', { version: stale.version, description: 'Written first' });
    assert.equal(first.status, 200);

    const second = await T.client.patch('/settings/organization', { version: stale.version, description: 'Written second' });
    assert.equal(second.status, 409, 'the version it was based on is gone');
    assert.equal(second.body.code, 'SETTINGS_CONFLICT');
    assert.match(second.body.message, /changed these settings/);
    assert.match(second.body.message, /Reload/);

    assert.equal((await get()).organization.description, 'Written first', 'and the first save survives');
  });

  it('accepts the same change once the screen has reloaded', async () => {
    const fresh = await get();
    const r = await T.client.patch('/settings/organization', { version: fresh.version, description: 'Written second' });
    assert.equal(r.status, 200);
    assert.equal((await get()).organization.description, 'Written second');
  });
});

describe('The audit trail', () => {
  it('records what each field was and what it became, not just that something happened', async () => {
    await save('organization', { legalName: 'Before Ltd' });
    await save('organization', { legalName: 'After Ltd', establishedYear: 2011 });

    const [entry] = await auditFor(T.org, 'SETTINGS_ORGANIZATION_UPDATE');
    assert.ok(entry, 'an entry was written');
    assert.equal(entry.userName, T.user.name, 'and it says who');
    const changes = entry.meta.changes;
    const legal = changes.find((c) => c.field === 'legalName');
    assert.equal(legal.from, 'Before Ltd');
    assert.equal(legal.to, 'After Ltd');
    assert.ok(changes.find((c) => c.field === 'establishedYear' && c.to === 2011));
    assert.equal(changes.some((c) => c.field === 'description'), false, 'and nothing that did not move');
  });

  it('records the invoice and general tabs under their own actions', async () => {
    await save('invoice', { template: { paperSize: 'A5' } });
    await save('general', { posRoundOff: true });
    const [inv] = await auditFor(T.org, 'SETTINGS_INVOICE_UPDATE');
    const [gen] = await auditFor(T.org, 'SETTINGS_GENERAL_UPDATE');
    assert.equal(inv.meta.scope, 'invoice');
    assert.ok(inv.meta.changes.some((c) => c.field === 'settings.invoice.template.paperSize' && c.to === 'A5'));
    assert.equal(gen.meta.scope, 'general');
    assert.ok(gen.meta.changes.some((c) => c.field === 'settings.posRoundOff' && c.to === true));
  });
});

describe('Who may see and change what', () => {
  let reader;

  before(async () => {
    const user = await h.makeUser(T.org, { role: 'STAFF' }); // settings:read, but not settings:manage
    const client = h.client();
    assert.equal((await client.login(user.email)).status, 200);
    reader = client;
  });

  it('hides the bank account number from somebody who cannot change it', async () => {
    await save('organization', { bank: { accountHolder: 'SWS Wholesale', accountNumber: '50100123456789', ifsc: 'HDFC0001234' } });

    const mine = await get();
    assert.equal(mine.organization.bank.accountNumber, '50100123456789', 'whole for somebody who may edit it');
    assert.equal(mine.organization.bank.accountNumberMasked, false);

    const theirs = await get(reader);
    assert.equal(theirs.organization.bank.accountNumber, '••••••••••6789', 'and masked for everybody else');
    assert.equal(theirs.organization.bank.accountNumberMasked, true, 'which the response says plainly');
    assert.equal(theirs.organization.bank.ifsc, 'HDFC0001234', 'the rest of it is on the invoice anyway');
  });

  it('refuses a save from somebody with read access only', async () => {
    const current = await get(reader);
    for (const tab of ['organization', 'invoice', 'general']) {
      const r = await reader.patch(`/settings/${tab}`, { version: current.version, description: 'nope' });
      assert.equal(r.status, 403, `${tab} must need settings:manage`);
    }
  });

  it('refuses anyone who is not signed in', async () => {
    assert.equal((await h.client().get('/settings')).status, 401);
  });

  it('never shows one organization another organization’s settings', async () => {
    const theirs = await get(other.client);
    assert.equal(theirs.organization.name, 'Settings Other Org');
    assert.equal(theirs.organization.gstin, '', 'not ours');
    assert.equal(theirs.organization.bank.accountNumber, '');
  });
});

describe('The next document number', () => {
  it('shows what will be issued next without burning a number', async () => {
    const first = await T.client.get('/analytics/../settings/invoice/preview-number?series=sales');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await T.client.get('/settings/invoice/preview-number?series=sales');
    assert.equal(again.data.next, first.data.next, 'looking at it twice does not move it');
    assert.equal(again.data.next, 'INV-00001', 'the format this system already prints');
    assert.equal(again.data.counterKey, 'invoice', 'and the counter it has always used');
  });

  it('follows the configured format, and shows what the financial year rollover will look like', async () => {
    await save('invoice', {
      series: [{ series: 'sales', prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true, resetEveryFinancialYear: true }],
    });
    const r = await T.client.get('/settings/invoice/preview-number?series=sales');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.data.next, /^SWS\/\d{2}-\d{2}\/0001$/);
    assert.ok(r.data.afterFinancialYearRollover, 'and says what next year starts at');
    assert.notEqual(r.data.afterFinancialYearRollover, r.data.next, 'which is a different year');
    assert.match(r.data.counterKey, /^invoice\|fy:/, 'a year that resets gets its own counter');
  });

  it('refuses a series this system does not issue', async () => {
    assert.equal((await T.client.get('/settings/invoice/preview-number?series=estimate')).status, 400);
    assert.equal((await T.client.get('/settings/invoice/preview-number')).status, 400);
  });

  it('will not let numbering restart below a number already issued', async () => {
    const org = await h.makeTenant('Settings Numbering Org');
    // Five invoices have been issued, so the counter stands at 5.
    for (let i = 0; i < 5; i += 1) await h.tenant.runWithTenant(org.org._id, () => nextSeq(org.org._id, 'invoice'));

    const current = await get(org.client);
    const r = await org.client.patch('/settings/invoice', {
      version: current.version,
      series: [{ series: 'sales', prefix: 'INV', separator: '-', padding: 5, start: 3 }],
    });
    assert.equal(r.status, 400, 'number 3 is already on an invoice somewhere');
    assert.equal(r.body.code, 'NUMBER_ALREADY_ISSUED');
    assert.match(r.body.message, /already been issued/);

    const ok = await org.client.patch('/settings/invoice', {
      version: current.version,
      series: [{ series: 'sales', prefix: 'INV', separator: '-', padding: 5, start: 6 }],
    });
    assert.equal(ok.status, 200, 'starting after the last one is fine');
  });
});

describe('The counter behind the numbering', () => {
  it('gives every caller a different number, however many ask at the same moment', async () => {
    const org = await h.makeTenant('Settings Counter Org');
    const seqs = await h.tenant.runWithTenant(org.org._id, () => Promise.all(Array.from({ length: 50 }, () => nextSeq(org.org._id, 'invoice'))));

    assert.equal(seqs.length, 50);
    assert.equal(new Set(seqs).size, 50, 'fifty tills, fifty different numbers — no duplicates');
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1), 'and no gaps either');
  });

  it('keeps each organization’s numbering to itself', async () => {
    const a = await h.makeTenant('Settings Counter A');
    const b = await h.makeTenant('Settings Counter B');
    await h.tenant.runWithTenant(a.org._id, () => Promise.all([nextSeq(a.org._id, 'invoice'), nextSeq(a.org._id, 'invoice')]));
    const first = await h.tenant.runWithTenant(b.org._id, () => nextSeq(b.org._id, 'invoice'));
    assert.equal(first, 1, 'another organization’s invoices do not advance ours');
  });
});

describe('Resetting the invoice settings', () => {
  it('puts the layout back to the defaults, and leaves the counters alone', async () => {
    const org = await h.makeTenant('Settings Reset Org');
    await h.tenant.runWithTenant(org.org._id, () => nextSeq(org.org._id, 'invoice'));
    await save('invoice', { template: { paperSize: 'thermal58', accentColor: '#112233' } }, org.client);

    const current = await get(org.client);
    const bad = await org.client.post('/settings/invoice/reset', { version: current.version, confirm: 'yes' });
    assert.equal(bad.status, 400, 'it has to be typed exactly');

    const r = await org.client.post('/settings/invoice/reset', { version: current.version, confirm: 'RESET' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const after = await get(org.client);
    assert.equal(after.invoice.template.paperSize, 'A4');
    assert.equal(after.invoice.template.accentColor, '#0f766e');
    assert.equal(after.invoice.template.show.hsn, true, 'and the print toggles come back on, not back to empty');
    assert.equal(after.invoice.template.show.upiQr, false, 'except the ones that were never on');
    const preview = await org.client.get('/settings/invoice/preview-number?series=sales');
    assert.equal(preview.data.next, 'INV-00002', 'the number already issued is still issued');
  });
});

describe('The store logo', () => {
  // The smallest real PNG there is: the bytes decide the type, so a real one is what the test must send.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = (client, buffer, type = 'image/png') =>
    client.request('POST', '/settings/logo', { body: buffer, headers: { 'content-type': type, 'x-file-name': 'logo.png' } });

  let org;

  before(async () => {
    org = await h.makeTenant('Settings Logo Org');
  });

  it('stores the file, points the organization at it, and serves it back', async () => {
    const r = await upload(org.client, PNG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.data.url, /^\/api\/settings\/logo\/[a-f0-9]{24}\.png$/, 'the server names the file, not the caller');
    assert.equal(r.data.mimeType, 'image/png');

    const d = await get(org.client);
    assert.equal(d.organization.logo, r.data.url);

    const fetched = await org.client.get(`/settings/logo/${r.data.fileName}`);
    assert.equal(fetched.status, 200);
  });

  it('refuses a file that is not the picture it claims to be', async () => {
    // A PDF renamed and sent as a PNG: the bytes say otherwise.
    const r = await upload(org.client, Buffer.from('%PDF-1.7 pretending to be a picture'), 'image/png');
    assert.equal(r.status, 415);
    assert.equal(r.body.code, 'FILE_UNSUPPORTED_TYPE');
  });

  it('refuses an SVG, because an SVG can carry script', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await upload(org.client, svg, 'image/svg+xml');
    assert.ok([415, 400].includes(r.status), `an SVG must never be stored as a logo (got ${r.status})`);
  });

  it('replaces the old file rather than leaving it behind, and can remove the logo entirely', async () => {
    const first = await upload(org.client, PNG);
    const second = await upload(org.client, PNG);
    assert.notEqual(first.data.fileName, second.data.fileName);
    // The replaced file is gone from the store, so repeated edits do not pile up files.
    assert.equal((await org.client.get(`/settings/logo/${first.data.fileName}`)).status, 404);

    const removed = await org.client.del('/settings/logo');
    assert.equal(removed.status, 200);
    assert.equal((await get(org.client)).organization.logo, '');
    assert.equal((await org.client.get(`/settings/logo/${second.data.fileName}`)).status, 404);
  });

  it('never serves one organization logo to another', async () => {
    const mine = await upload(org.client, PNG);
    const theirs = await other.client.get(`/settings/logo/${mine.data.fileName}`);
    assert.equal(theirs.status, 404, 'another organization logo is simply not there');
  });

  it('refuses an upload from somebody who may only read settings', async () => {
    const user = await h.makeUser(org.org, { role: 'STAFF' });
    const client = h.client();
    assert.equal((await client.login(user.email)).status, 200);
    assert.equal((await upload(client, PNG)).status, 403);
    assert.equal((await client.del('/settings/logo')).status, 403);
  });

  it('records the change in the audit trail, with what the logo was and what it became', async () => {
    await upload(org.client, PNG);
    const [entry] = await auditFor(org.org, 'SETTINGS_LOGO_UPLOAD');
    assert.ok(entry);
    assert.match(entry.message, /Store logo updated/);
    assert.equal(entry.meta.changes[0].field, 'logo');
  });
});

describe('Licence documents', () => {
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  let org;

  before(async () => {
    org = await h.makeTenant('Settings Licence Org');
  });

  const uploadDoc = (client, buffer = PDF, type = 'application/pdf') =>
    client.request('POST', '/settings/documents', { body: buffer, headers: { 'content-type': type, 'x-file-name': 'form-20b.pdf' } });

  it('accepts a scanned licence as a PDF and hands back a descriptor to save with it', async () => {
    const r = await uploadDoc(org.client);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.mimeType, 'application/pdf');
    assert.match(r.data.storageKey, /\/licenses\/[a-f0-9]{24}\.pdf$/);
    assert.equal(r.data.fileName, 'form-20b.pdf', 'the original name is kept to show, never to store by');

    const current = await get(org.client);
    const saved = await org.client.patch('/settings/organization', {
      version: current.version,
      licenses: [
        {
          type: '20B',
          number: 'MH-20B-0001',
          validFrom: '2026-04-01',
          validUntil: '2029-03-31',
          document: { storageKey: r.data.storageKey, fileName: r.data.fileName, mimeType: r.data.mimeType, size: r.data.size },
        },
      ],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const after = await get(org.client);
    assert.equal(after.organization.licenses.length, 1);
    assert.equal(after.organization.licenses[0].document.fileName, 'form-20b.pdf');
    assert.match(after.organization.licenses[0].typeLabel, /Form 20B/);
  });

  it('refuses a licence pointing at a file from another organization', async () => {
    const theirs = await uploadDoc(other.client);
    const current = await get(org.client);
    const r = await org.client.patch('/settings/organization', {
      version: current.version,
      licenses: [{ type: '20', number: 'X', document: { storageKey: theirs.data.storageKey } }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'UNKNOWN_DOCUMENT');
  });

  it('removes the file once no licence refers to it any more', async () => {
    const doc = await uploadDoc(org.client);
    const name = doc.data.storageKey.split('/').pop();
    let current = await get(org.client);
    await org.client.patch('/settings/organization', {
      version: current.version,
      licenses: [
        { type: '21', number: 'MH-21-0002', document: { storageKey: doc.data.storageKey, fileName: 'a.pdf', mimeType: 'application/pdf', size: doc.data.size } },
      ],
    });
    assert.equal((await org.client.get(`/settings/documents/${name}`)).status, 200);

    current = await get(org.client);
    await org.client.patch('/settings/organization', { version: current.version, licenses: [] });
    assert.equal((await org.client.get(`/settings/documents/${name}`)).status, 404, 'a document nothing points at is not kept');
  });

  it('warns about a licence that is expiring, and marks one that has expired', async () => {
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const gone = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const current = await get(org.client);
    const r = await org.client.patch('/settings/organization', {
      version: current.version,
      licenses: [
        { type: '20', number: 'EXPIRING', validUntil: soon },
        { type: '21', number: 'EXPIRED', validUntil: gone },
        { type: '20C', number: 'FINE', validUntil: '2099-01-01' },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const d = await get(org.client);
    const byNumber = Object.fromEntries(d.organization.licenses.map((l) => [l.number, l]));
    assert.equal(byNumber.EXPIRING.status, 'expiring');
    assert.ok(byNumber.EXPIRING.daysToExpiry <= 60 && byNumber.EXPIRING.daysToExpiry > 0);
    assert.equal(byNumber.EXPIRED.status, 'expired');
    assert.ok(byNumber.EXPIRED.daysToExpiry < 0);
    assert.equal(byNumber.FINE.status, 'valid');
    assert.equal(d.organization.licenseAlerts.length, 2, 'the two that need attention are listed on their own');
  });
});

describe('The bank account number never leaves the server unmasked', () => {
  const ACCOUNT = '50100123456789';
  let org;
  let reader;

  before(async () => {
    org = await h.makeTenant('Settings Masking Org');
    const current = await get(org.client);
    const saved = await org.client.patch('/settings/organization', {
      version: current.version,
      bank: { accountHolder: 'SWS Wholesale', accountNumber: ACCOUNT, ifsc: 'HDFC0001234' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const user = await h.makeUser(org.org, { role: 'STAFF' }); // settings:read, never settings:manage
    const client = h.client();
    assert.equal((await client.login(user.email)).status, 200);
    reader = client;
  });

  it('is masked in the RESPONSE BODY, not merely hidden by the screen', async () => {
    const r = await reader.get('/settings');
    assert.equal(r.status, 200);
    const whole = JSON.stringify(r.body);
    // The strongest form of the check: the digits do not appear anywhere in the payload at all.
    assert.equal(whole.includes(ACCOUNT), false, 'the account number must not be anywhere in the response');
    assert.equal(whole.includes('0100123456789'), false, 'nor any long run of it');
    assert.equal(r.data.organization.bank.accountNumber, '••••••••••6789');
    assert.equal(r.data.organization.bank.accountNumberMasked, true);
  });

  it('is whole only for somebody who could change it anyway', async () => {
    const r = await org.client.get('/settings');
    assert.equal(r.data.organization.bank.accountNumber, ACCOUNT);
    assert.equal(r.data.organization.bank.accountNumberMasked, false);
  });

  it('keeps the details that are printed on the invoice visible to everyone', async () => {
    const r = await reader.get('/settings');
    assert.equal(r.data.organization.bank.ifsc, 'HDFC0001234');
    assert.equal(r.data.organization.bank.accountHolder, 'SWS Wholesale');
  });

  it('is settled by a permission that exists, held only by the organization administrator', async () => {
    const { PERMISSIONS, ROLE_PERMISSIONS, effectivePermissions } = await import('../config/permissions.js');
    assert.equal(PERMISSIONS.includes('settings:manage'), true);
    assert.equal(PERMISSIONS.includes('settings:write'), false, 'there is no settings:write in this system');
    assert.equal(effectivePermissions({ role: 'ORG_ADMIN', permissions: [] }).includes('settings:manage'), true);
    for (const role of ['BRANCH_MANAGER', 'INVENTORY_MANAGER', 'BILLING_STAFF', 'STAFF']) {
      assert.equal(effectivePermissions({ role, permissions: [] }).includes('settings:manage'), false, `${role} must not manage settings`);
      assert.equal(effectivePermissions({ role, permissions: [] }).includes('settings:read'), true, `${role} may read them`);
    }
    assert.ok(ROLE_PERMISSIONS.ORG_ADMIN.length > 0);
  });
});

describe('Uploads that were never attached to anything', () => {
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  let org;

  before(async () => {
    org = await h.makeTenant('Settings Orphan Org');
  });

  const uploadDoc = (client) =>
    client.request('POST', '/settings/documents', { body: PDF, headers: { 'content-type': 'application/pdf', 'x-file-name': 'scan.pdf' } });

  it('keeps a freshly uploaded file that nobody has saved yet', async () => {
    const { sweepAbandonedDocuments } = await import('../services/settingsFiles.service.js');
    const doc = await uploadDoc(org.client);
    const name = doc.data.storageKey.split('/').pop();

    const result = await sweepAbandonedDocuments(org.org._id, []);
    assert.equal(result.removed, 0, 'somebody may still be filling in the form it belongs to');
    assert.equal(result.keptYoung >= 1, true);
    assert.equal((await org.client.get(`/settings/documents/${name}`)).status, 200, 'and it is still readable');
  });

  it('removes one that nothing refers to once it is older than the grace period', async () => {
    const { sweepAbandonedDocuments } = await import('../services/settingsFiles.service.js');
    const doc = await uploadDoc(org.client);
    const name = doc.data.storageKey.split('/').pop();

    // Twenty-five hours later, nothing has ever pointed at it.
    const result = await sweepAbandonedDocuments(org.org._id, [], { now: Date.now() + 25 * 3600 * 1000 });
    assert.equal(result.removed >= 1, true);
    assert.equal((await org.client.get(`/settings/documents/${name}`)).status, 404);
  });

  it('never touches a file a licence still points at, however old it is', async () => {
    const doc = await uploadDoc(org.client);
    const name = doc.data.storageKey.split('/').pop();
    const current = await get(org.client);
    const saved = await org.client.patch('/settings/organization', {
      version: current.version,
      licenses: [{ type: '20', number: 'KEEP-ME', document: { storageKey: doc.data.storageKey, fileName: 'scan.pdf', mimeType: 'application/pdf', size: doc.data.size } }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const { sweepAbandonedDocuments } = await import('../services/settingsFiles.service.js');
    const licenses = saved.data.settings.organization.licenses.map((l) => ({ document: { storageKey: doc.data.storageKey } }));
    const result = await sweepAbandonedDocuments(org.org._id, licenses, { now: Date.now() + 365 * 24 * 3600 * 1000 });
    assert.equal(result.removed, 0, 'a referenced file is never swept, whatever its age');
    assert.equal((await org.client.get(`/settings/documents/${name}`)).status, 200);
  });

  it('sweeps one organization without reaching into another', async () => {
    const theirs = await h.makeTenant('Settings Orphan Other Org');
    const doc = await uploadDoc(theirs.client);
    const name = doc.data.storageKey.split('/').pop();

    const { sweepAbandonedDocuments } = await import('../services/settingsFiles.service.js');
    await sweepAbandonedDocuments(org.org._id, [], { now: Date.now() + 25 * 3600 * 1000 });
    assert.equal((await theirs.client.get(`/settings/documents/${name}`)).status, 200, 'another organization’s file is not ours to delete');
  });
});
