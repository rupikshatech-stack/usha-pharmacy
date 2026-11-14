import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountProblem, conversionNote, creditWord, creditsFor, estimate, signedCredits, fileProblem, fileSize, rupees, serverErrors } from './credit.js';

const file = (over = {}) => ({ name: 'pay.png', type: 'image/png', size: 2048, ...over });

describe('the amount', () => {
  it('must be a positive number with at most two decimals', () => {
    assert.equal(amountProblem('500'), '');
    assert.equal(amountProblem('499.50'), '');
    assert.equal(amountProblem(' 12.5 '), '');
    assert.equal(amountProblem(''), 'Enter the payment amount');
    assert.equal(amountProblem('   '), 'Enter the payment amount');
    assert.equal(amountProblem('0'), 'The amount must be greater than zero');
    assert.equal(amountProblem('0.00'), 'The amount must be greater than zero');
    assert.equal(amountProblem('-5'), 'The amount cannot be negative');
    for (const bad of ['abc', '1e3', '12.345', '5,00', '1.', '.5', '12 000']) assert.match(amountProblem(bad), /valid amount/, bad);
    assert.match(amountProblem('1000001'), /cannot be more than ₹10,00,000/);
    assert.equal(amountProblem('1000000'), '');
  });
});

describe('the screenshot', () => {
  it('accepts JPG, JPEG, PNG and WEBP up to the limit', () => {
    for (const [name, type] of [
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.png', 'image/png'],
      ['a.webp', 'image/webp'],
    ])
      assert.equal(fileProblem(file({ name, type })), '', name);
    assert.equal(fileProblem(file({ type: '', name: 'photo.JPG' })), '', 'the extension counts when the browser does not say');
  });
  it('refuses other types, empty files, too-large files, and no file', () => {
    assert.equal(fileProblem(null), 'Choose the payment screenshot');
    assert.match(fileProblem(file({ type: 'image/gif', name: 'a.gif' })), /JPG, JPEG, PNG or WEBP/);
    assert.match(fileProblem(file({ type: 'application/pdf', name: 'a.pdf' })), /JPG, JPEG, PNG or WEBP/);
    assert.match(fileProblem(file({ type: 'image/png', name: 'a.pdf' })), /^$|JPG/);
    assert.equal(fileProblem(file({ size: 0 })), 'That file is empty');
    assert.match(fileProblem(file({ size: 6 * 1048576 })), /Use a file up to 5 MB \(this one is 6\.0 MB\)/);
    assert.equal(fileProblem(file({ size: 3 * 1048576 }), { maxMB: 2 }) !== '', true);
  });
  it('shows sizes plainly', () => {
    assert.equal(fileSize(100), '1 KB');
    assert.equal(fileSize(2048), '2 KB');
    assert.equal(fileSize(1572864), '1.5 MB');
  });
});

describe('words and numbers', () => {
  it('builds the note from the rate it is given', () => {
    assert.equal(
      conversionNote(5),
      'Note: The current conversion rate is 1 Credit = ₹5. The final approved credits will be calculated by the administrator based on your payment amount.',
    );
    assert.match(conversionNote(4.5), /1 Credit = ₹4\.50\./);
  });
  it('shows rupees without needless decimals, and estimates credits', () => {
    assert.deepEqual([rupees(5), rupees(499.5), rupees(1250), rupees(null)], ['₹5', '₹499.50', '₹1,250', '—']);
    assert.equal(estimate(500, 5), 100);
    assert.equal(estimate(499.5, 5), 99, 'whole credits, rounded down');
    assert.equal(estimate(0, 5), null);
    assert.equal(estimate(100, 0), null);
  });
  it('maps server errors onto fields', () => {
    assert.deepEqual(
      serverErrors([
        { path: 'amount', message: 'Too big' },
        { path: '', message: 'x' },
      ]),
      { amount: 'Too big' },
    );
    assert.deepEqual(serverErrors(undefined), {});
  });
});

describe('the credit calculation (the server decides; this only shows it)', () => {
  it('is whole credits rounded down, with the leftover', () => {
    assert.deepEqual([creditsFor(500, 5), creditsFor(1000, 5), creditsFor(2500, 5)], [{ credits: 100, remainder: 0 }, { credits: 200, remainder: 0 }, { credits: 500, remainder: 0 }]);
    assert.deepEqual(creditsFor(499.5, 5), { credits: 99, remainder: 4.5 });
    assert.deepEqual(creditsFor(0.3, 0.1), { credits: 3, remainder: 0 });
    assert.deepEqual(creditsFor(0, 5), { credits: 0, remainder: 0 });
  });
});

describe('wording of a ledger entry', () => {
  it('spells out the sign and the word credit', () => {
    assert.deepEqual([signedCredits(100), signedCredits(0), signedCredits(-20)], ['+100', '+0', '−20']);
    assert.deepEqual([creditWord(1), creditWord(2), creditWord(0)], ['1 credit', '2 credits', '0 credits']);
  });
});
