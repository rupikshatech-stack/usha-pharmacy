import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { creditDaysFor, emptySupplier, rupees, serverErrors, supplierPayload, supplierProblems, supplierToForm, termsSummary } from './supplierForm.js';

const valid = () => ({ ...emptySupplier(), name: 'Sunrise Medical', contactPerson: 'Meera Iyer', phone: '+91 98200 11223', line1: '5 Industrial Estate' });

describe('what the supplier form insists on', () => {
  it('accepts the three required things and nothing more', () => {
    assert.deepEqual(supplierProblems(valid()), {});
  });

  it('names each missing required field', () => {
    const e = supplierProblems(emptySupplier());
    assert.deepEqual(Object.keys(e).sort(), ['contactPerson', 'line1', 'name', 'phone']);
    assert.equal(e.name, 'Enter the company name');
  });

  it('checks the formats, and only when something was typed', () => {
    const bad = { ...valid(), email: 'nope', altEmail: 'also nope', phone: 'call me', altPhone: 'x', gstin: '27ABCDE1234F1Z', pan: 'ABCD1234F', website: 'example.test', pincode: '4110', code: 'A B' };
    assert.deepEqual(Object.keys(supplierProblems(bad)).sort(), ['altEmail', 'altPhone', 'code', 'email', 'gstin', 'pan', 'phone', 'pincode', 'website'].sort());
    const good = { ...valid(), email: 'a@b.test', altEmail: 'c@d.test', gstin: '27AAACS1234A1Z5', pan: 'ABCDE1234F', website: 'https://example.test', pincode: '411001', code: 'SUP-01' };
    assert.deepEqual(supplierProblems(good), {});
  });

  it('asks for the credit period only when the terms are custom', () => {
    assert.equal(supplierProblems({ ...valid(), paymentTerms: 'net30' }).creditPeriodDays, undefined);
    assert.equal(supplierProblems({ ...valid(), paymentTerms: 'custom' }).creditPeriodDays, 'Enter the credit period in days');
    assert.equal(supplierProblems({ ...valid(), paymentTerms: 'custom', creditPeriodDays: '400' }).creditPeriodDays, 'Enter whole days, 365 or fewer');
    assert.deepEqual(supplierProblems({ ...valid(), paymentTerms: 'custom', creditPeriodDays: '20' }), {});
  });

  it('checks the minimum order value looks like money', () => {
    assert.equal(supplierProblems({ ...valid(), minimumOrderValue: '5000.5' }).minimumOrderValue, undefined);
    assert.equal(supplierProblems({ ...valid(), minimumOrderValue: 'lots' }).minimumOrderValue, 'Enter an amount like 5000 or 5000.50');
  });
});

describe('the credit period a term implies', () => {
  it('comes from the term, except for custom', () => {
    assert.deepEqual([creditDaysFor('advance'), creditDaysFor('cod'), creditDaysFor('net7'), creditDaysFor('net30'), creditDaysFor('net45')], [0, 0, 7, 30, 45]);
    assert.equal(creditDaysFor('custom', '20'), 20);
    assert.equal(creditDaysFor('custom', 'x'), 0);
    assert.equal(creditDaysFor('net30', '999'), 30, 'a leftover number is ignored once the term decides');
  });

  it('reads as a sentence', () => {
    assert.equal(termsSummary('net30'), '30 days (30 days credit)');
    assert.equal(termsSummary('cod'), 'Cash on delivery');
    assert.equal(termsSummary('custom', '1'), 'Custom (1 day credit)');
  });
});

describe('turning the form into a request', () => {
  it('trims, upper-cases the identifiers and sends numbers as numbers', () => {
    const body = supplierPayload({ ...valid(), name: '  Sunrise Medical  ', code: ' sup-7 ', gstin: '27aaacs1234a1z5', pan: 'abcde1234f', minimumOrderValue: '5000', paymentTerms: 'net15', city: ' Pune ' });
    assert.equal(body.name, 'Sunrise Medical');
    assert.equal(body.code, 'SUP-7');
    assert.equal(body.gstin, '27AAACS1234A1Z5');
    assert.equal(body.pan, 'ABCDE1234F');
    assert.equal(body.address.city, 'Pune');
    assert.equal(body.procurement.minimumOrderValue, 5000);
    assert.equal(body.procurement.creditPeriodDays, 15);
    assert.equal(body.isActive, true);
  });

  it('sends the status as the flag the server keeps', () => {
    assert.equal(supplierPayload({ ...valid(), status: 'inactive' }).isActive, false);
    assert.equal(supplierPayload({ ...valid(), isPreferred: true }).isPreferred, true);
  });

  it('comes back from a saved supplier unchanged', () => {
    const saved = {
      name: 'Sunrise Medical', code: 'SUP-7', gstin: '27AAACS1234A1Z5', pan: 'ABCDE1234F', supplierType: 'manufacturer', website: 'https://x.test', isPreferred: true, isActive: false,
      contactPerson: 'Meera', phone: '9820011223', altPhone: '', email: 'a@b.test', altEmail: '',
      address: { line1: '5 Estate', line2: '', city: 'Pune', state: 'MH', pincode: '411001', country: 'India', landmark: 'Depot' },
      procurement: { paymentTerms: 'custom', creditPeriodDays: 20, minimumOrderValue: 5000, preferredDeliveryTime: '2-3 days', notes: 'Mornings' },
    };
    const f = supplierToForm(saved);
    assert.equal(f.status, 'inactive');
    assert.equal(f.creditPeriodDays, '20');
    assert.equal(f.landmark, 'Depot');
    const body = supplierPayload(f);
    assert.equal(body.name, saved.name);
    assert.equal(body.procurement.creditPeriodDays, 20);
    assert.equal(body.address.pincode, '411001');
    assert.equal(body.isActive, false);
    assert.deepEqual(supplierProblems(f), {}, 'what the server gave back is valid to send again');
  });
});

describe('errors from the server', () => {
  it('land on the field the form shows', () => {
    const e = serverErrors([{ path: 'address.pincode', message: 'Enter a 6-digit PIN code' }, { path: 'code', message: 'This supplier code is already used' }, { path: 'procurement.defaultBranchId', message: 'Choose a store from the list' }]);
    assert.deepEqual(e, { pincode: 'Enter a 6-digit PIN code', code: 'This supplier code is already used', defaultBranchId: 'Choose a store from the list' });
  });
});

describe('money on the details screen', () => {
  it('reads as rupees, and says nothing when there is nothing', () => {
    assert.deepEqual([rupees(5000), rupees(1234.5), rupees(0)], ['₹5,000', '₹1,234.50', '₹0']);
    assert.deepEqual([rupees(null), rupees(undefined), rupees('')], ['—', '—', '—']);
  });
});
