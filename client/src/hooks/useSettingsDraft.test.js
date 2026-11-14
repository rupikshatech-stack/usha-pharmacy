// The parts of the draft that decide WHAT is kept and whether it is worth offering back. The hook itself needs a
// browser; these two pure functions are where the rules live, and they are the ones that must never be wrong —
// one of them keeps a bank account number out of browser storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftDifferences, draftKey, stripExcluded } from './useSettingsDraft.js';

const server = {
  name: 'SWS Wholesale',
  legalName: '',
  owner: { firstName: 'Asha', lastName: 'Patil', phone: '9876543210' },
  bank: { accountHolder: 'SWS', accountNumber: '50100123456789', ifsc: 'HDFC0001234' },
  licenses: [{ type: '20B', number: 'MH-1' }],
};

test('never writes an excluded field, however deep it is', () => {
  const kept = stripExcluded(server, ['bank.accountNumber']);
  assert.equal(kept.bank.accountNumber, undefined, 'the account number is not in the draft at all');
  assert.equal('accountNumber' in kept.bank, false, 'not even as an empty key');
  assert.equal(kept.bank.ifsc, 'HDFC0001234', 'the rest of the bank block is kept');
  assert.equal(kept.owner.firstName, 'Asha');
});

test('does not alter the values it was given', () => {
  const before = JSON.stringify(server);
  stripExcluded(server, ['bank.accountNumber']);
  assert.equal(JSON.stringify(server), before, 'the form state is untouched');
});

test('copes with an excluded path that is not there', () => {
  const kept = stripExcluded({ a: 1 }, ['bank.accountNumber', 'nothing.here']);
  assert.deepEqual(kept, { a: 1 });
  assert.deepEqual(stripExcluded(null, ['x']), {});
});

test('finds the fields a restored draft would change', () => {
  const draft = { ...server, legalName: 'SWS Wholesale Pvt Ltd', owner: { ...server.owner, phone: '9000000000' } };
  const changed = draftDifferences(draft, server, ['bank.accountNumber']);
  assert.deepEqual(changed.sort(), ['legalName', 'owner.phone']);
});

test('sees a changed list as one change, not a change per row', () => {
  const draft = { ...server, licenses: [{ type: '20B', number: 'MH-1' }, { type: '21', number: 'MH-2' }] };
  assert.deepEqual(draftDifferences(draft, server), ['licenses']);
});

test('offers nothing when the draft matches what the server already has', () => {
  assert.deepEqual(draftDifferences({ ...server }, server), []);
  assert.deepEqual(draftDifferences(null, server), []);
});

test('ignores an excluded field even if an older draft somehow held one', () => {
  // A draft written before the exclusion existed must not resurrect an account number.
  const stale = { ...server, bank: { ...server.bank, accountNumber: '99999999999' } };
  assert.deepEqual(draftDifferences(stale, server, ['bank.accountNumber']), []);
});

test('treats blank, null and missing as the same emptiness', () => {
  assert.deepEqual(draftDifferences({ legalName: '' }, { legalName: null }), []);
  assert.deepEqual(draftDifferences({ legalName: 'x' }, { legalName: '' }), ['legalName']);
});

test('keys a draft to the organization, the person and the tab', () => {
  assert.equal(draftKey({ orgId: 'o1', userId: 'u1', tab: 'organization' }), 'usha:settings-draft:o1:u1:organization');
  assert.notEqual(draftKey({ orgId: 'o1', userId: 'u1', tab: 'organization' }), draftKey({ orgId: 'o1', userId: 'u2', tab: 'organization' }));
  assert.notEqual(draftKey({ orgId: 'o1', userId: 'u1', tab: 'organization' }), draftKey({ orgId: 'o2', userId: 'u1', tab: 'organization' }));
  assert.notEqual(draftKey({ orgId: 'o1', userId: 'u1', tab: 'organization' }), draftKey({ orgId: 'o1', userId: 'u1', tab: 'invoice' }));
});
