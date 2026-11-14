import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addressText, blankBranch, branchActions, fromBranch, serverErrors, toBody, validateBranch } from './branchForm.js';

const ok = () => ({ ...blankBranch(), name: 'North Branch', code: 'north-1', addressLine1: '12 Market Road', pincode: '411001' });

describe('the branch form', () => {
  it('starts blank, active and in India', () => {
    const b = blankBranch();
    assert.deepEqual([b.name, b.status, b.country], ['', 'active', 'India']);
  });

  it('needs a name, a code, address line 1 and a PIN code — each with its own message', () => {
    assert.deepEqual(validateBranch(blankBranch()), {
      name: 'Branch name is required',
      code: 'Branch code is required',
      addressLine1: 'Address line 1 is required',
      pincode: 'PIN code is required',
    });
    assert.deepEqual(validateBranch(ok()), {});
    assert.deepEqual(validateBranch({ ...ok(), name: '   ' }), { name: 'Branch name is required' });
  });

  it('checks the code, PIN, phone, email, GSTIN and date formats, only when given', () => {
    assert.match(validateBranch({ ...ok(), code: 'has space' }).code, /letters, numbers/);
    assert.match(validateBranch({ ...ok(), pincode: '41100' }).pincode, /6 digits/);
    assert.match(validateBranch({ ...ok(), pincode: '011001' }).pincode, /6 digits/);
    assert.equal(validateBranch({ ...ok(), country: 'Nepal', pincode: '44600' }).pincode, undefined, 'a postal code outside India is not held to the Indian format');
    assert.match(validateBranch({ ...ok(), phone: '12345' }).phone, /7 to 15 digits/);
    assert.match(validateBranch({ ...ok(), phone: 'call me' }).phone, /valid phone/);
    assert.equal(validateBranch({ ...ok(), phone: '+91 98765-43210' }).phone, undefined);
    assert.match(validateBranch({ ...ok(), email: 'nope' }).email, /valid email/);
    assert.match(validateBranch({ ...ok(), gstin: '27ABCDE1234' }).gstin, /valid format/);
    assert.equal(validateBranch({ ...ok(), gstin: '27abcde1234f1z5' }).gstin, undefined, 'lower case is fine; it is saved in capitals');
    assert.match(validateBranch({ ...ok(), openingDate: '2026-02-30' }).openingDate, /real date/);
    assert.equal(validateBranch({ ...ok(), phone: '', email: '', gstin: '', openingDate: '' }).phone, undefined);
  });

  it('sends every profile field, trimmed, with the code and GSTIN in capitals — empty ones included', () => {
    const b = toBody({ ...ok(), gstin: '27abcde1234f1z5', name: '  North  ', managerName: ' Asha ' });
    assert.deepEqual([b.name, b.code, b.gstin, b.managerName, b.country, b.status], ['North', 'NORTH-1', '27ABCDE1234F1Z5', 'Asha', 'India', 'active']);
    for (const k of ['addressLine1', 'addressLine2', 'state', 'city', 'pincode', 'landmark', 'email', 'phone', 'openingDate', 'notes']) assert.ok(k in b, k);
    assert.equal(b.addressLine2, '');
  });

  it('opens a saved branch as text, and shows an older quick-made branch’s one-line address so it can be completed', () => {
    const f = fromBranch({ _id: 'b1', name: 'Old', code: 'OLD', address: '3 Old Lane, Pune', status: 'inactive', openingDate: '2026-04-01T00:00:00.000Z' });
    assert.deepEqual([f.id, f.status, f.openingDate, f.addressLine1, f.legacyAddress, f.country], ['b1', 'inactive', '2026-04-01', '', '3 Old Lane, Pune', 'India']);
    assert.equal(fromBranch({ _id: 'b2', name: 'New', code: 'N', addressLine1: '1 Road', address: '1 Road, India' }).legacyAddress, '');
  });

  it('shows an address in full', () => {
    assert.equal(
      addressText({ addressLine1: '12 Market Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', country: 'India' }),
      '12 Market Road, Pune, Maharashtra, 411001, India',
    );
    assert.equal(addressText({ address: '3 Old Lane' }), '3 Old Lane');
    assert.equal(addressText({}), '');
  });

  it('turns the server’s field errors into form errors', () => {
    assert.deepEqual(
      serverErrors([
        { path: 'code', message: 'A branch with this code already exists' },
        { path: '', message: 'x' },
      ]),
      { code: 'A branch with this code already exists' },
    );
    assert.deepEqual(serverErrors(undefined), {});
  });

  it('offers actions by permission, and never deactivates or deletes the default branch', () => {
    assert.deepEqual(branchActions({ status: 'active' }, false), { view: true, edit: false, toggle: false, toggleLabel: 'Deactivate', remove: false });
    assert.deepEqual(branchActions({ status: 'inactive' }, true), { view: true, edit: true, toggle: true, toggleLabel: 'Activate', remove: true });
    assert.deepEqual([branchActions({ status: 'active', isDefault: true }, true).toggle, branchActions({ status: 'active', isDefault: true }, true).remove], [false, false]);
  });
});
