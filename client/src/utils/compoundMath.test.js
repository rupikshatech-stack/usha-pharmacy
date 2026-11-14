// The browser's copy of the compounding arithmetic — the same vectors the server checks, so the form and the bench never disagree.
// What a compounding formula weighs out. Percentages are of the finished preparation, "qs" is whatever is left, and a
// unit that cannot be reconciled (drops, or millilitres in a formula made by weight) is reported rather than guessed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { amountIn, computeFormula, scaleFormula } from './compoundMath.js';

const cream = (over = {}) => ({
  totalQuantity: 100,
  totalUnit: 'g',
  ingredients: [
    { name: 'Ketamine HCl', role: 'active', quantity: 10, unit: '%' },
    { name: 'Gabapentin', role: 'active', quantity: 5, unit: '%' },
    { name: 'VersaBase Cream', role: 'base', unit: 'qs' },
  ],
  ...over,
});

describe('One ingredient at a time', () => {
  it('reads a percentage as per cent of the finished preparation', () => {
    assert.equal(amountIn({ quantity: 10, unit: '%' }, 100, 'g'), 10);
    assert.equal(amountIn({ quantity: 2.5, unit: '%' }, 60, 'g'), 1.5);
    assert.equal(amountIn({ quantity: 10, unit: '%' }, 120, 'mL'), 12, 'and the same by volume');
  });

  it('converts between compatible units and refuses the rest', () => {
    assert.equal(amountIn({ quantity: 250, unit: 'mg' }, 100, 'g'), 0.25);
    assert.equal(amountIn({ quantity: 2, unit: 'g' }, 100, 'g'), 2);
    assert.equal(amountIn({ quantity: 5, unit: 'mL' }, 100, 'g'), null, 'a volume in a formula made by weight needs a density nobody stated');
    assert.equal(amountIn({ quantity: 3, unit: 'drops' }, 100, 'g'), null);
    assert.equal(amountIn({ unit: 'qs' }, 100, 'g'), null, 'qs has no number of its own');
    assert.equal(amountIn({ quantity: -1, unit: 'g' }, 100, 'g'), null);
  });
});

describe('A whole formula', () => {
  it('works out the batch and what the base makes up', () => {
    const r = computeFormula(cream());
    assert.deepEqual(r.lines.map((l) => l.amount), [10, 5, null]);
    assert.equal(r.measured, 15);
    assert.equal(r.qsAmount, 85, 'the base fills the rest of the 100 g');
    assert.equal(r.accountedFor, 100);
    assert.deepEqual(r.problems, []);
  });

  it('says so when the ingredients do not fit the batch', () => {
    const r = computeFormula(cream({ ingredients: [{ name: 'A', quantity: 80, unit: '%' }, { name: 'B', quantity: 40, unit: '%' }] }));
    assert.equal(r.measured, 120);
    assert.match(r.problems[0], /120 g, which is more than the 100 g/);
  });

  it('refuses two "qs" ingredients, because only one thing can make up the rest', () => {
    const r = computeFormula(cream({ ingredients: [{ name: 'Base A', unit: 'qs' }, { name: 'Base B', unit: 'qs' }] }));
    assert.match(r.problems[0], /Only one ingredient can be "qs"/);
    assert.equal(r.qsAmount, null);
  });

  it('reports an ingredient it cannot weigh instead of inventing a figure', () => {
    const r = computeFormula(cream({ ingredients: [{ name: 'Peppermint oil', quantity: 3, unit: 'drops' }, { name: 'Base', unit: 'qs' }] }));
    assert.equal(r.lines[0].amount, null);
    assert.match(r.problems[0], /Peppermint oil is in drops.*Weigh it by hand/);
    assert.equal(r.qsAmount, 100, 'and the base still fills what is accounted for');
  });

  it('says what is unaccounted for when nothing is "qs"', () => {
    const r = computeFormula(cream({ ingredients: [{ name: 'A', quantity: 30, unit: 'g' }] }));
    assert.equal(r.qsAmount, null);
    assert.equal(r.shortfall, 70);
    assert.deepEqual(r.problems, [], 'an incomplete formula is not an error — the pharmacist may be mid-way through writing it');
  });

  it('handles an empty formula without inventing anything', () => {
    const r = computeFormula({ totalQuantity: 100, totalUnit: 'g', ingredients: [] });
    assert.deepEqual({ measured: r.measured, qs: r.qsAmount, problems: r.problems.length }, { measured: 0, qs: null, problems: 0 });
  });
});

describe('Making a different batch size', () => {
  it('keeps percentages and scales absolute amounts', () => {
    const r = scaleFormula({ ...cream(), ingredients: [{ name: 'Ketamine HCl', quantity: 10, unit: '%' }, { name: 'Menthol', quantity: 2, unit: 'g' }, { name: 'Base', unit: 'qs' }] }, 50);
    assert.deepEqual(r.lines.map((l) => l.amount), [5, 1, null], 'half the batch: the percentage still gives 10%, the 2 g becomes 1 g');
    assert.equal(r.qsAmount, 44);
    assert.equal(r.accountedFor, 50);
  });

  it('refuses a batch size that makes no sense', () => {
    assert.equal(scaleFormula(cream(), 0), null);
    assert.equal(scaleFormula(cream(), -5), null);
    assert.equal(scaleFormula(cream(), 'lots'), null);
  });
});
