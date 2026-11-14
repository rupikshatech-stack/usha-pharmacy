// The rules behind the Settings screens, tested as pure functions — no database, no HTTP.
//
// These are the checks that decide whether a number somebody typed can possibly be real, and how a document number
// is built. Both matter more than they look: a GSTIN that passes a regex but fails its own check digit is a typo
// that ends up on every invoice until somebody notices, and a numbering rule that is a day out at the financial
// year boundary issues an invoice into last year's series.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bankFromIfsc,
  gstCodeForState,
  gstinCheckDigit,
  inspectGstin,
  isValidGstin,
  maskAccountNumber,
  normaliseMobile,
  panFromGstin,
  IFSC_PATTERN,
  PIN_PATTERN,
} from '../utils/indianTax.js';
import { financialYearOf } from '../utils/financialYear.js';
import { counterKey, formatDocumentNumber, seriesConfig, seriesDefaults } from '../utils/documentNumber.js';
import { generalSettingsSchema, invoiceSettingsSchema, organizationSettingsSchema } from '../validators/settings.validator.js';

/** Two GSTINs published as examples of the real thing; both must survive every check. */
const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4'];
const version = () => new Date().toISOString();
const firstIssue = (r) => r.error?.issues?.[0];

describe('The GSTIN check digit', () => {
  it('reproduces the final character of a genuine GSTIN', () => {
    for (const g of VALID) {
      assert.equal(gstinCheckDigit(g.slice(0, 14)), g[14], `${g} should check out`);
      assert.equal(isValidGstin(g), true);
    }
  });

  it('rejects a GSTIN with one character mistyped, which a regex alone would accept', () => {
    // The shape is perfect; only the fourth character has changed. This is the common real error.
    const typo = '27AAPFU0939F1ZX';
    assert.match(typo, /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'the regex is happy with it');
    assert.equal(isValidGstin(typo), false, 'but the check digit is not');
  });

  it('rejects anything that is not a GSTIN at all', () => {
    for (const bad of ['', '27AAPFU0939F1Z', 'ABCDEFGHIJKLMNO', '271234509391ZV', '27AAPFU0939F1AV']) {
      assert.equal(isValidGstin(bad), false, `${bad} is not a GSTIN`);
    }
    assert.equal(gstinCheckDigit('short'), null);
  });

  it('accepts a GSTIN pasted in lower case or with stray spaces, rather than making a person retype it', () => {
    assert.equal(isValidGstin('  27aapfu0939f1zv '), true);
    assert.equal(panFromGstin(' 27aapfu0939f1zv'), 'AAPFU0939F');
  });

  it('reads the PAN out of the GSTIN rather than asking for it twice', () => {
    assert.equal(panFromGstin('27AAPFU0939F1ZV'), 'AAPFU0939F');
    assert.equal(panFromGstin('29AAGCB7383J1Z4'), 'AAGCB7383J');
    assert.equal(panFromGstin(''), null);
    assert.equal(panFromGstin('27AAP'), null);
  });
});

describe('The state a GSTIN was issued in', () => {
  it('knows the GST code for each state', () => {
    assert.equal(gstCodeForState('Maharashtra'), '27');
    assert.equal(gstCodeForState('karnataka'), '29');
    assert.equal(gstCodeForState('Delhi'), '07');
    assert.equal(gstCodeForState('Atlantis'), null);
  });

  it('accepts a GSTIN whose state matches the address, with nothing to say about it', () => {
    const r = inspectGstin('27AAPFU0939F1ZV', 'Maharashtra');
    assert.equal(r.ok, true);
    assert.equal(r.warning, null);
    assert.equal(r.stateName, 'Maharashtra');
    assert.equal(r.pan, 'AAPFU0939F');
  });

  it('warns — but does not refuse — when the GSTIN was issued in another state', () => {
    const r = inspectGstin('27AAPFU0939F1ZV', 'Karnataka');
    assert.equal(r.ok, true, 'a business may legitimately be registered elsewhere');
    assert.match(r.warning, /issued in Maharashtra/);
    assert.match(r.warning, /Karnataka/);
  });

  it('refuses a mistyped GSTIN outright, because that is not a judgement call', () => {
    const r = inspectGstin('27AAPFU0939F1ZX', 'Maharashtra');
    assert.equal(r.ok, false);
    assert.match(r.error, /check character/);
  });

  it('has nothing to say about an empty GSTIN: not every business is registered', () => {
    const r = inspectGstin('', 'Maharashtra');
    assert.equal(r.ok, true);
    assert.equal(r.warning, null);
  });
});

describe('The other identifiers', () => {
  it('accepts an IFSC in the only shape an IFSC has', () => {
    assert.match('HDFC0001234', IFSC_PATTERN);
    assert.match('SBIN0000456', IFSC_PATTERN);
    assert.equal(IFSC_PATTERN.test('HDFC1001234'), false, 'the fifth character is always 0');
    assert.equal(IFSC_PATTERN.test('HDF00001234'), false);
    assert.equal(bankFromIfsc('HDFC0001234'), 'HDFC');
    assert.equal(bankFromIfsc('nonsense'), null);
  });

  it('accepts a PIN code and refuses one that starts with zero', () => {
    assert.match('411001', PIN_PATTERN);
    assert.equal(PIN_PATTERN.test('041100'), false, 'no Indian PIN code starts with 0');
    assert.equal(PIN_PATTERN.test('41100'), false);
    assert.equal(PIN_PATTERN.test('4110011'), false);
  });

  it('takes a mobile number out of however somebody typed it', () => {
    for (const input of ['9876543210', '+91 98765 43210', '+919876543210', '098765 43210', '(+91)-9876-543-210']) {
      assert.equal(normaliseMobile(input), '9876543210', `${input} is the same number`);
    }
    assert.equal(normaliseMobile('1234567890'), null, 'an Indian mobile starts 6-9');
    assert.equal(normaliseMobile('98765'), null);
    assert.equal(normaliseMobile(''), null);
  });

  it('shows an account number by its last four digits and nothing more', () => {
    assert.equal(maskAccountNumber('50100123456789'), '••••••••••6789');
    assert.equal(maskAccountNumber('1234'), '••••');
    assert.equal(maskAccountNumber(''), '');
  });
});

describe('Which financial year a sale belongs to', () => {
  const tz = 'Asia/Kolkata';

  it('rolls over on 1 April, in the organization’s own timezone', () => {
    // 31 March, late evening in India — still last year's books.
    const before = financialYearOf(new Date('2026-03-31T18:29:00Z'), 4, tz);
    assert.equal(before.key, '2025-26');
    assert.equal(before.label, '25-26');
    // 1 April, just after midnight in India (18:30 UTC on 31 March) — the new year.
    const after = financialYearOf(new Date('2026-03-31T18:31:00Z'), 4, tz);
    assert.equal(after.key, '2026-27');
    assert.equal(after.label, '26-27');
  });

  it('follows an organization that starts its year in a different month', () => {
    assert.equal(financialYearOf(new Date('2026-06-15T00:00:00Z'), 7, tz).key, '2025-26', 'July start: June is still last year');
    assert.equal(financialYearOf(new Date('2026-07-15T00:00:00Z'), 7, tz).key, '2026-27');
    const calendar = financialYearOf(new Date('2026-06-15T00:00:00Z'), 1, tz);
    assert.equal(calendar.startYear, 2026);
    assert.equal(calendar.isCalendarYear, true, 'a January start is just a calendar year');
  });
});

describe('Building a document number', () => {
  it('reproduces exactly what this system printed before any of this was configurable', () => {
    assert.equal(formatDocumentNumber(seriesDefaults('sales'), 42), 'INV-00042');
    assert.equal(formatDocumentNumber(seriesDefaults('purchase'), 7), 'ORD-0007');
    assert.equal(formatDocumentNumber(seriesDefaults('salesReturn'), 3), 'SR-0003');
  });

  it('pads to the configured width', () => {
    const c = { series: 'sales', prefix: 'INV', separator: '-', padding: 6 };
    assert.equal(formatDocumentNumber(c, 1), 'INV-000001');
    assert.equal(formatDocumentNumber({ ...c, padding: 0 }, 1), 'INV-1');
  });

  it('never truncates a number that has outgrown its padding', () => {
    // A wrong number is worse than an unevenly formatted one.
    assert.equal(formatDocumentNumber({ series: 'sales', prefix: 'INV', separator: '-', padding: 4 }, 123456), 'INV-123456');
  });

  it('puts the financial year in the number when asked', () => {
    const c = { series: 'sales', prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true };
    assert.equal(formatDocumentNumber(c, 1, { financialYearLabel: '25-26' }), 'SWS/25-26/0001');
    assert.equal(formatDocumentNumber(c, 1), 'SWS/0001', 'and leaves it out when there is none to print');
  });

  it('leaves out the parts that are not set instead of printing empty separators', () => {
    assert.equal(formatDocumentNumber({ series: 'sales', prefix: '', separator: '-', padding: 4 }, 9), '0009');
    assert.equal(formatDocumentNumber({ series: 'sales', prefix: 'A', suffix: 'B', separator: '-', padding: 2 }, 9), 'A-09-B');
    assert.equal(formatDocumentNumber({ series: 'sales', prefix: 'A', separator: '', padding: 3 }, 9), 'A009');
  });

  it('changes only what comes next — a prefix change cannot reach an invoice that exists', () => {
    // The sequence is kept in the counter, not parsed back out of the string, so the old numbers are untouchable.
    const was = formatDocumentNumber({ series: 'sales', prefix: 'INV', separator: '-', padding: 5 }, 90);
    const now = formatDocumentNumber({ series: 'sales', prefix: 'SWS', separator: '/', padding: 5 }, 91);
    assert.equal(was, 'INV-00090');
    assert.equal(now, 'SWS/00091', 'the next one is renamed; number 90 is still INV-00090 wherever it is filed');
  });
});

describe('Which counter a series uses', () => {
  it('uses the key this system has always used, so numbering continues with no migration', () => {
    assert.equal(counterKey({ series: 'sales' }), 'invoice');
    assert.equal(counterKey({ series: 'purchase' }), 'order');
    assert.equal(counterKey({ series: 'salesReturn' }), 'salesReturn');
  });

  it('starts a separate sequence per store only when per-branch numbering is on', () => {
    assert.equal(counterKey({ series: 'sales', branchId: 'abc123' }), 'invoice', 'a branch id alone changes nothing');
    assert.equal(counterKey({ series: 'sales', branchId: 'abc123', perBranch: true }), 'invoice|b:abc123');
  });

  it('starts a separate sequence per year only when the yearly reset is on', () => {
    assert.equal(counterKey({ series: 'sales', financialYearKey: '2026-27' }), 'invoice');
    assert.equal(counterKey({ series: 'sales', financialYearKey: '2026-27', resetEveryFinancialYear: true }), 'invoice|fy:2026-27');
    assert.notEqual(
      counterKey({ series: 'sales', financialYearKey: '2025-26', resetEveryFinancialYear: true }),
      counterKey({ series: 'sales', financialYearKey: '2026-27', resetEveryFinancialYear: true }),
      'last year and this year must not share a sequence',
    );
  });
});

describe('Which settings a branch follows', () => {
  const numbering = {
    series: [
      { series: 'sales', branchId: null, prefix: 'ORG', padding: 4, separator: '-' },
      { series: 'sales', branchId: 'b1', prefix: 'NORTH', padding: 3, separator: '/' },
    ],
  };

  it('uses the branch’s own configuration when it has one', () => {
    const c = seriesConfig(numbering, 'sales', 'b1');
    assert.equal(formatDocumentNumber(c, 5), 'NORTH/005');
  });

  it('falls back to the organization’s, so an unconfigured branch behaves like the shop, not like an empty form', () => {
    const c = seriesConfig(numbering, 'sales', 'b2');
    assert.equal(formatDocumentNumber(c, 5), 'ORG-0005');
  });

  it('falls back to the built-in defaults for a series nobody has configured', () => {
    assert.equal(formatDocumentNumber(seriesConfig(numbering, 'purchase', 'b1'), 5), 'ORD-0005');
  });
});

describe('What each Settings screen will accept', () => {
  it('needs the version the screen was looking at, so two people cannot overwrite each other blindly', () => {
    assert.equal(organizationSettingsSchema.safeParse({ name: 'X' }).success, false);
    assert.equal(invoiceSettingsSchema.safeParse({ perBranch: true }).success, false);
    assert.equal(generalSettingsSchema.safeParse({ posRoundOff: true }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: 'not-a-time', name: 'X' }).success, false);
  });

  it('accepts a patch of only the fields somebody actually changed', () => {
    const r = organizationSettingsSchema.safeParse({ version: version(), name: 'SWS Wholesale' });
    assert.equal(r.success, true);
    assert.deepEqual(Object.keys(r.data), ['version', 'name']);
  });

  it('tidies a phone number instead of refusing a perfectly clear one', () => {
    const r = organizationSettingsSchema.safeParse({ version: version(), owner: { phone: '+91 98765-43210' } });
    assert.equal(r.data.owner.phone, '9876543210');
    assert.equal(organizationSettingsSchema.safeParse({ version: version(), owner: { phone: '12345' } }).success, false);
  });

  it('refuses a GSTIN that fails its check digit, with a reason a person can act on', () => {
    const r = organizationSettingsSchema.safeParse({ version: version(), gstin: '27AAACS1234A1Z5' });
    assert.equal(r.success, false);
    assert.match(firstIssue(r).message, /check character/);
    assert.equal(organizationSettingsSchema.safeParse({ version: version(), gstin: VALID[0] }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: version(), gstin: '' }).success, true, 'and allows it to be cleared');
  });

  it('refuses a state it cannot map to a GST code', () => {
    assert.equal(organizationSettingsSchema.safeParse({ version: version(), address: { state: 'Maharashtra' } }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: version(), address: { state: 'Atlantis' } }).success, false);
  });

  it('checks the other identifiers only against their own shapes', () => {
    const v = version();
    assert.equal(organizationSettingsSchema.safeParse({ version: v, tax: { fssai: '12345678901234' } }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, tax: { fssai: '123' } }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { ifsc: 'HDFC0001234' } }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { ifsc: 'HDFC1001234' } }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { upiId: 'sws@okhdfcbank' } }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { upiId: 'not-a-upi' } }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { accountNumber: '50100123456789' } }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, bank: { accountNumber: '50100-123' } }).success, false);
  });

  it('refuses a licence that expires before it starts', () => {
    const v = version();
    const good = { type: '20B', number: 'MH-20B-123', validFrom: '2026-04-01', validUntil: '2029-03-31' };
    assert.equal(organizationSettingsSchema.safeParse({ version: v, licenses: [good] }).success, true);
    const r = organizationSettingsSchema.safeParse({ version: v, licenses: [{ ...good, validUntil: '2020-01-01' }] });
    assert.equal(r.success, false);
    assert.match(firstIssue(r).message, /cannot expire before it starts/);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, licenses: [{ type: 'FORM-99', number: 'x' }] }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, licenses: [{ type: '20', number: '' }] }).success, false);
  });

  it('refuses a year a business cannot have been established in', () => {
    const v = version();
    assert.equal(organizationSettingsSchema.safeParse({ version: v, establishedYear: 1998 }).success, true);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, establishedYear: new Date().getFullYear() + 1 }).success, false);
    assert.equal(organizationSettingsSchema.safeParse({ version: v, establishedYear: 1500 }).success, false);
  });

  it('refuses exclusive pricing, because the billing code does not do it', () => {
    const r = invoiceSettingsSchema.safeParse({ version: version(), calculation: { pricesIncludeGst: false } });
    assert.equal(r.success, false);
    assert.match(firstIssue(r).message, /GST-inclusive/);
    assert.equal(invoiceSettingsSchema.safeParse({ version: version(), calculation: { pricesIncludeGst: true } }).success, true);
  });

  it('accepts the invoice layout it can actually print, and nothing else', () => {
    const v = version();
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, template: { paperSize: 'thermal58', style: 'compact', accentColor: '#0f766e' } }).success, true);
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, template: { paperSize: 'A3' } }).success, false);
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, template: { accentColor: 'teal' } }).success, false);
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, template: { show: { hsn: false, upiQr: true } } }).success, true);
  });

  it('accepts only a series this system actually issues', () => {
    const v = version();
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, series: [{ series: 'sales', prefix: 'SWS', padding: 4 }] }).success, true);
    // There is no estimate or quotation in this system, so there is nothing to number.
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, series: [{ series: 'estimate', prefix: 'EST' }] }).success, false);
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, series: [{ series: 'sales', padding: 20 }] }).success, false);
    assert.equal(invoiceSettingsSchema.safeParse({ version: v, series: [{ series: 'sales', start: 0 }] }).success, false);
  });

  it('keeps the expiry module’s own numbers honest', () => {
    const v = version();
    assert.equal(generalSettingsSchema.safeParse({ version: v, expiry: { thresholds: [15, 30, 90] } }).success, true);
    assert.equal(generalSettingsSchema.safeParse({ version: v, expiry: { thresholds: [30, 15, 90] } }).success, false, 'each one must be larger than the last');
    assert.equal(generalSettingsSchema.safeParse({ version: v, expiry: { thresholds: [15, 30] } }).success, false, 'there are exactly three buckets');
    assert.equal(generalSettingsSchema.safeParse({ version: v, expiry: { velocityWindowDays: 3 } }).success, false);
    assert.equal(generalSettingsSchema.safeParse({ version: v, expiry: { clearanceMaxDiscount: 95 } }).success, false);
  });

  it('accepts the general settings a person can actually change', () => {
    const v = version();
    assert.equal(generalSettingsSchema.safeParse({ version: v, timezone: 'Asia/Kolkata', dateFormat: 'dd MMM yyyy' }).success, true);
    assert.equal(generalSettingsSchema.safeParse({ version: v, timezone: 'Mars/Olympus' }).success, false);
    assert.equal(generalSettingsSchema.safeParse({ version: v, dateFormat: 'MM-DD-YY' }).success, false);
    assert.equal(generalSettingsSchema.safeParse({ version: v, billing: { defaultCreditDays: 400 } }).success, false);
    assert.equal(generalSettingsSchema.safeParse({ version: v, notifications: { lowStock: { enabled: true, channel: 'in_app' } } }).success, true);
    assert.equal(generalSettingsSchema.safeParse({ version: v, notifications: { lowStock: { channel: 'whatsapp' } } }).success, false, 'there is no WhatsApp channel yet');
  });
});

describe('Which existing documents may seed a counter', () => {
  const cfg = seriesDefaults('sales'); // INV-00001
  const doc = (_id, number, date) => ({ _id, number, date });

  it('accepts a number only if this series would have printed exactly that', async () => {
    const { sequenceIfIssuedBy } = await import('../utils/documentNumber.js');
    assert.equal(sequenceIfIssuedBy(cfg, 'INV-00042'), 42);
    assert.equal(sequenceIfIssuedBy(cfg, 'EXP-DEMO-090'), null, 'ends in 90, but is not an invoice of this series');
    assert.equal(sequenceIfIssuedBy(cfg, 'INV-0042'), null, 'wrong padding for a five-wide series');
    assert.equal(sequenceIfIssuedBy(cfg, 'INV-000042'), null, 'a leading zero the formatter would never print');
    assert.equal(sequenceIfIssuedBy(cfg, 'inv-00042'), null, 'prefixes are exact');
    assert.equal(sequenceIfIssuedBy(cfg, ''), null);
    assert.equal(sequenceIfIssuedBy(cfg, null), null);
  });

  it('includes the financial-year segment when the format has one, and only the right year', async () => {
    const { sequenceIfIssuedBy } = await import('../utils/documentNumber.js');
    const fy = { ...cfg, prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true };
    assert.equal(sequenceIfIssuedBy(fy, 'SWS/26-27/0007', { financialYearLabel: '26-27' }), 7);
    assert.equal(sequenceIfIssuedBy(fy, 'SWS/25-26/0007', { financialYearLabel: '26-27' }), null, 'last year’s number is not this year’s series');
    assert.equal(sequenceIfIssuedBy(fy, 'SWS/0007', { financialYearLabel: '26-27' }), null, 'the year segment is missing');
  });

  it('handles a prefix that is full of regex punctuation without being fooled by it', async () => {
    const { sequenceIfIssuedBy } = await import('../utils/documentNumber.js');
    const odd = { ...cfg, prefix: 'A.B+C', separator: '.', padding: 3 };
    assert.equal(sequenceIfIssuedBy(odd, 'A.B+C.007'), 7);
    assert.equal(sequenceIfIssuedBy(odd, 'AxB+C.007'), null, 'a dot in the prefix is a dot, not "any character"');
  });

  it('sets aside a number in some other format and never lets it move the highest', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const r = classifyForSeeding({ docs: [doc('a', 'INV-00001'), doc('b', 'INV-00002'), doc('c', 'EXP-DEMO-090'), doc('d', 'INV-00003')], config: cfg });
    assert.equal(r.highest, 3, 'the demo row does not count');
    assert.deepEqual(r.needsReview.map((x) => [x._id, x.number]), [['c', 'EXP-DEMO-090']], 'and it is listed with its id, for a person to look at');
    assert.match(r.needsReview[0].reason, /not in this series' format/);
  });

  it('sets aside a number more than 1000 above the next-highest, and does not let it drag the rest out of range', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const r = classifyForSeeding({ docs: [doc('a', 'INV-00001'), doc('b', 'INV-00002'), doc('c', 'INV-50000'), doc('d', 'INV-00003')], config: cfg });
    assert.equal(r.highest, 3);
    assert.deepEqual(r.needsReview.map((x) => x.number), ['INV-50000']);
    assert.match(r.needsReview[0].reason, /above the next-highest number/);
  });

  it('accepts a jump of exactly 1000 and refuses 1001', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const at = classifyForSeeding({ docs: [doc('a', 'INV-00001'), doc('b', 'INV-01001')], config: cfg });
    assert.equal(at.highest, 1001, '1001 is 1000 above 1: allowed');
    const over = classifyForSeeding({ docs: [doc('a', 'INV-00001'), doc('b', 'INV-01002')], config: cfg });
    assert.equal(over.highest, 1);
    assert.equal(over.needsReview.length, 1);
  });

  it('measures the first number from where the series starts, not from zero', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const started = { ...cfg, start: 5000 };
    const r = classifyForSeeding({ docs: [doc('a', 'INV-05000'), doc('b', 'INV-05001')], config: started });
    assert.equal(r.highest, 5001);
    assert.deepEqual(r.needsReview, [], 'a series that was told to start at 5000 did not jump to get there');
  });

  it('judges a document against the financial year ITS OWN date falls in', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const fy = { ...cfg, prefix: 'SWS', separator: '/', padding: 4, includeFinancialYear: true };
    const labelFor = (d) => (new Date(d) < new Date('2026-04-01') ? '25-26' : '26-27');
    const r = classifyForSeeding({
      docs: [doc('a', 'SWS/25-26/0900', '2026-02-01'), doc('b', 'SWS/26-27/0003', '2026-06-01'), doc('c', 'SWS/25-26/0004', '2026-06-01')],
      config: fy,
      labelFor,
    });
    assert.equal(r.highest, 900, 'a number carrying the year its date belongs to is valid');
    assert.deepEqual(r.needsReview.map((x) => x.number), ['SWS/25-26/0004'], 'but a June invoice carrying last year’s label is not');
  });

  it('reports nothing usable when there is nothing to use', async () => {
    const { classifyForSeeding } = await import('../utils/documentNumber.js');
    const r = classifyForSeeding({ docs: [], config: cfg });
    assert.equal(r.highest, 0);
    assert.deepEqual(r.needsReview, []);
  });
});

describe('Where every Settings field is stored', () => {
  /**
   * Mongoose silently DROPS a path its schema lacks, so a mislocated field answers "saved" and persists nothing. That
   * happened to every field under settings.general. This walks the real validators for ALL THREE save routes and checks
   * each field they accept against the organization schema, so adding a field to a validator without giving it a home
   * fails here the moment it is added - on any of the three tabs, not only the one it happened on.
   */
  const unwrap = (sch) => {
    let s = sch;
    while (s?.def && ['optional', 'default', 'nullable', 'readonly'].includes(s.def.type)) s = s.def.innerType;
    return s;
  };
  const leaves = (sch, prefix = '', out = []) => {
    const s = unwrap(sch);
    if (s?.def?.type === 'object') {
      for (const [k, v] of Object.entries(s.shape)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
      return out;
    }
    out.push(prefix);
    return out;
  };

  const routes = async () => {
    const v = await import('../validators/settings.validator.js');
    const svc = await import('../services/settings.service.js');
    return [
      ['organization', v.organizationSettingsSchema, svc.organizationPath],
      ['invoice', v.invoiceSettingsSchema, svc.invoicePath],
      ['general', v.generalSettingsSchema, svc.generalFieldPath],
    ];
  };

  it('can actually see the fields of each route, so a pass is not an empty loop', async () => {
    for (const [name, schema] of await routes()) {
      const fields = leaves(schema).filter((f) => f !== 'version');
      assert.ok(fields.length >= 20, `${name}: only found ${fields.length} fields, so the walk is not seeing the schema`);
    }
  });

  it('maps every field each route accepts to a path the schema really has', async () => {
    const { Organization } = await import('../models/Organization.js');
    const missing = [];
    for (const [name, schema, pathOf] of await routes()) {
      for (const field of leaves(schema)) {
        if (field === 'version') continue; // the concurrency token, never stored as a field
        const path = pathOf(field);
        if (Organization.schema.pathType(path) === 'adhocOrUndefined') missing.push(`${name}: ${field} -> ${path}`);
      }
    }
    assert.deepEqual(missing, [], `these fields would be silently dropped on save:\n  ${missing.join('\n  ')}`);
  });

  it('also covers the paths the services write themselves, beside what the validators accept', async () => {
    const { Organization } = await import('../models/Organization.js');
    for (const path of ['tax.pan', 'logo', 'settings.updatedAt', 'settings.updatedBy', 'settings.updatedByName', 'settings.general.defaultsVersion', 'settings.invoice.template', 'settings.invoice.calculation', 'settings.invoice.series', 'licenses']) {
      assert.notEqual(Organization.schema.pathType(path), 'adhocOrUndefined', `${path} is not in the organization schema`);
    }
  });

  it('keeps the older switches where they always were, and puts the new ones under general', async () => {
    const { generalPath, invoicePath, organizationPath, generalFieldPath } = await import('../services/settings.service.js');
    assert.equal(generalPath('posRoundOff'), 'settings.posRoundOff');
    assert.equal(generalPath('expiry.thresholds'), 'settings.expiry.thresholds');
    assert.equal(generalPath('billing.defaultCreditDays'), 'settings.general.billing.defaultCreditDays');
    assert.equal(generalPath('dateFormat'), 'settings.general.dateFormat');
    assert.equal(generalFieldPath('timezone'), 'timezone', 'the timezone is on the organization itself');
    assert.equal(invoicePath('template.paperSize'), 'settings.invoice.template.paperSize');
    assert.equal(organizationPath('bank.ifsc'), 'bank.ifsc');
  });

  it('would catch a mislocated field: the schema really does not have the path the old code wrote', async () => {
    const { Organization } = await import('../models/Organization.js');
    assert.equal(Organization.schema.pathType('settings.billing.defaultCreditDays'), 'adhocOrUndefined', 'the old, wrong location');
    assert.equal(Organization.schema.pathType('settings.general.billing.defaultCreditDays'), 'real', 'the right one');
  });
});
