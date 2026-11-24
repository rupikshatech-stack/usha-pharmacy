import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { at, blankOrganization, handoverText, put, serverErrors, toBody, validateOrganization } from './platformForm.js';

const ok = () => ({ ...blankOrganization(), name: 'Shree Medical Stores', owner: { firstName: 'Asha', lastName: 'Rao', email: 'asha@shree.test', phone: '' } });

describe('validateOrganization', () => {
  it('accepts the three things the server actually requires, and nothing more', () => {
    assert.deepEqual(validateOrganization(ok()), {});
    const bare = { ...blankOrganization(), name: 'Ab', owner: { firstName: 'A', lastName: '', email: 'a@b.co', phone: '' } };
    assert.deepEqual(validateOrganization(bare), {}, 'no address, no phone, no category of its own — still fine');
  });

  it('names the missing required fields by their server paths', () => {
    const e = validateOrganization(blankOrganization());
    assert.equal(e.name, 'The pharmacy needs a name');
    assert.match(e['owner.firstName'], /first name is required/);
    assert.match(e['owner.email'], /how they sign in/);
  });

  it('refuses a one-character name, because the server refuses it too', () => {
    assert.match(validateOrganization({ ...ok(), name: 'A' }).name, /at least 2 characters/);
    assert.equal(validateOrganization({ ...ok(), name: '  Ab  ' }).name, undefined, 'it is the trimmed length that counts');
  });

  it('checks the owner email, which is the account they sign in to', () => {
    assert.match(validateOrganization({ ...ok(), owner: { ...ok().owner, email: 'asha@' } })['owner.email'], /valid email/);
    assert.equal(validateOrganization({ ...ok(), owner: { ...ok().owner, email: 'ASHA@Shree.test' } })['owner.email'], undefined);
  });

  it('only checks the optional fields when they were filled in', () => {
    assert.equal(validateOrganization({ ...ok(), phone: '' }).phone, undefined);
    assert.match(validateOrganization({ ...ok(), phone: '12' }).phone, /7 to 15 digits/);
    assert.equal(validateOrganization({ ...ok(), phone: '+91 98765 43210' }).phone, undefined);
  });

  it('applies the same PIN code rule as the pharmacy own settings screen', () => {
    const pin = (v) => validateOrganization({ ...ok(), address: { ...ok().address, pincode: v } })['address.pincode'];
    assert.equal(pin(''), undefined, 'a PIN code is optional here');
    assert.equal(pin('411001'), undefined);
    assert.match(pin('0411001'), /6 digits/);
    assert.match(pin('41100'), /6 digits/);
  });
});

describe('toBody', () => {
  it('leaves out what was never filled in, rather than sending empty strings', () => {
    const body = toBody(ok());
    assert.deepEqual(body, { name: 'Shree Medical Stores', businessCategory: 'retail', owner: { firstName: 'Asha', email: 'asha@shree.test', lastName: 'Rao' } });
    assert.equal('address' in body, false, 'an untouched address is not sent at all');
    assert.equal('phone' in body, false);
  });

  it('trims, lowercases the sign-in email, and keeps a partly filled address', () => {
    const body = toBody({ ...ok(), phone: ' 9876543210 ', owner: { ...ok().owner, email: '  ASHA@Shree.test ' }, address: { line1: ' 12 Market Road ', city: 'Pune', state: '', pincode: '' } });
    assert.equal(body.owner.email, 'asha@shree.test');
    assert.equal(body.phone, '9876543210');
    assert.deepEqual(body.address, { line1: '12 Market Road', city: 'Pune' }, 'the empty parts of the address are dropped');
  });
});

describe('server errors and paths', () => {
  it('maps the server field errors onto the form fields', () => {
    assert.deepEqual(serverErrors([{ path: 'owner.email', message: 'That email is taken' }, { path: 'name', message: 'That name is taken' }]), {
      'owner.email': 'That email is taken',
      name: 'That name is taken',
    });
  });

  it('ignores details that point at no field, so a general message is not silently lost in a field', () => {
    assert.deepEqual(serverErrors([{ message: 'Invalid request' }, null]), {});
    assert.deepEqual(serverErrors(undefined), {});
  });

  it('reads and writes dotted paths without mutating the form', () => {
    const f = blankOrganization();
    const next = put(f, 'owner.email', 'a@b.co');
    assert.equal(at(next, 'owner.email'), 'a@b.co');
    assert.equal(at(f, 'owner.email'), '', 'the original is untouched');
  });

  it('reads back exactly what was typed, so a space mid-word survives the keystroke', () => {
    assert.equal(at(put(blankOrganization(), 'name', 'Shree '), 'name'), 'Shree ');
    assert.equal(validateOrganization({ ...ok(), name: 'Shree ' }).name, undefined, 'though the checks still trim');
  });
});

describe('handoverText', () => {
  it('carries the four things the pharmacy needs, in full', () => {
    const text = handoverText({
      organization: { name: 'Shree Medical Stores' },
      administrator: { email: 'asha@shree.test' },
      temporaryPassword: 'Ab3$kdmPQ7xz',
      signInUrl: 'https://example.test/login',
    });
    assert.match(text, /Pharmacy: Shree Medical Stores/);
    assert.match(text, /Sign in at: https:\/\/example\.test\/login/);
    assert.match(text, /Email: asha@shree\.test/);
    assert.match(text, /Temporary password: Ab3\$kdmPQ7xz/);
    assert.match(text, /choose your own password/);
  });
});
