import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiFieldErrors, attributePayload, compoundPayload, hasValues, parseValues, validateAttribute, validateCompound } from './catalogValidation.js';

describe('parseValues', () => {
  it('splits on commas, semicolons and new lines, trims and drops blanks', () => {
    assert.deepEqual(parseValues('Tablet, Capsule;Syrup\n  Injection ,, '), ['Tablet', 'Capsule', 'Syrup', 'Injection']);
  });
  it('drops case-insensitive duplicates, also against values already added', () => {
    assert.deepEqual(parseValues('a, A, b', ['B', 'c']), ['a']);
    assert.deepEqual(parseValues('', ['x']), []);
    assert.deepEqual(parseValues(null), []);
  });
});

describe('validateCompound', () => {
  const ok = { compoundName: 'Paracetamol 650 mg', composition: '', description: '' };
  it('needs a name', () => {
    assert.deepEqual(validateCompound(ok), {});
    assert.match(validateCompound({ ...ok, compoundName: '   ' }).compoundName, /required/);
    assert.match(validateCompound({ ...ok, compoundName: 'x'.repeat(151) }).compoundName, /150/);
  });
  it('limits composition and description', () => {
    assert.match(validateCompound({ ...ok, composition: 'x'.repeat(501) }).composition, /500/);
    assert.match(validateCompound({ ...ok, description: 'x'.repeat(2001) }).description, /2000/);
  });
  it('builds a trimmed payload, and says there are no ingredients so a label stays a label', () => {
    assert.deepEqual(compoundPayload({ compoundName: ' A ', composition: ' b ', description: '', status: 'active' }), { compoundName: 'A', composition: 'b', description: '', status: 'active', ingredients: [] });
  });

  it('sends the whole recipe once the compound is prepared in-house', () => {
    const body = compoundPayload({
      compoundName: 'Ketamine / Gabapentin Cream', composition: '', description: '', status: 'active',
      isPreparation: true, dosageForm: 'Cream', totalQuantity: '100', totalUnit: 'g',
      ingredients: [
        { name: ' Ketamine HCl ', role: 'active', quantity: '10', unit: '%', medicineId: '', notes: '' },
        { name: 'VersaBase', role: 'base', quantity: '', unit: 'qs', medicineId: '', notes: '' },
      ],
      instructions: ' Levigate ', requiresUnguator: true, lightSensitive: false, sig: ' Apply twice daily ', budValue: '180', budUnit: 'days',
    });
    assert.equal(body.totalQuantity, 100);
    assert.deepEqual(body.ingredients[0], { name: 'Ketamine HCl', role: 'active', unit: '%', quantity: 10, notes: '' });
    assert.deepEqual(body.ingredients[1], { name: 'VersaBase', role: 'base', unit: 'qs', notes: '' }, 'a qs ingredient carries no quantity');
    assert.equal(body.instructions, 'Levigate');
    assert.equal(body.sig, 'Apply twice daily');
    assert.equal(body.budValue, 180);
    assert.equal(body.requiresUnguator, true);
  });

  it('checks the recipe only when the compound is prepared in-house', () => {
    const label = { compoundName: 'Paracetamol 650 mg', composition: '', description: '', status: 'active' };
    assert.deepEqual(validateCompound(label), {}, 'a plain formulation label has no recipe to check');

    const prep = { ...label, isPreparation: true, totalQuantity: '', ingredients: [{ name: '', role: 'active', quantity: '', unit: '%' }, { name: 'Base', role: 'base', quantity: '5', unit: 'qs' }] };
    const e = validateCompound(prep);
    assert.equal(e.totalQuantity, 'Enter how much this makes');
    assert.equal(e['ingredients.0.name'], 'Name the ingredient');
    assert.equal(e['ingredients.0.quantity'], 'How much?');
    assert.match(e['ingredients.1.quantity'], /takes no quantity/);
  });
});

describe('validateAttribute', () => {
  const base = { attributeName: 'Dosage forms', attributeType: 'dosage_form', values: ['Tablet'], status: 'active' };
  it('accepts a valid list', () => assert.deepEqual(validateAttribute(base), {}));
  it('needs a name and a type', () => {
    assert.match(validateAttribute({ ...base, attributeName: '' }).attributeName, /required/);
    assert.match(validateAttribute({ ...base, attributeType: '' }).attributeType, /type/);
  });
  it('a dosage form / strength / unit list needs values, a custom attribute may have none (free text)', () => {
    assert.match(validateAttribute({ ...base, values: [] }).values, /Add at least one value/);
    assert.equal(validateAttribute({ ...base, attributeType: 'custom', values: [] }).values, undefined);
  });
  it('a category has no value list', () => {
    assert.equal(hasValues('category'), false);
    assert.deepEqual(validateAttribute({ ...base, attributeType: 'category', values: [] }), {});
  });
  it('limits the number and length of values', () => {
    assert.match(validateAttribute({ ...base, values: Array.from({ length: 201 }, (_, i) => `v${i}`) }).values, /200/);
    assert.match(validateAttribute({ ...base, values: ['x'.repeat(101)] }).values, /100/);
  });
});

describe('attributePayload', () => {
  const original = { attributeName: 'Units', attributeType: 'unit', values: ['Strip'], status: 'active' };
  it('a new attribute sends everything, including the type', () => {
    assert.deepEqual(attributePayload({ ...original, attributeName: ' Units ' }), { attributeName: 'Units', values: ['Strip'], status: 'active', attributeType: 'unit' });
  });
  it('an edit sends only what changed and never the type', () => {
    assert.deepEqual(attributePayload({ ...original }, original), {});
    assert.deepEqual(attributePayload({ ...original, values: ['Strip', 'Bottle'], status: 'inactive', attributeType: 'custom' }, original), { values: ['Strip', 'Bottle'], status: 'inactive' });
  });
  it('a category never sends values', () => {
    assert.deepEqual(attributePayload({ attributeName: 'Tablets', attributeType: 'category', values: ['x'], status: 'active' }).values, []);
  });
});

describe('apiFieldErrors', () => {
  it('places server errors on their fields (nested paths too)', () => {
    const r = apiFieldErrors({ details: [{ path: 'values.3', message: 'Too long' }, { path: 'attributeName', message: 'Exists' }] });
    assert.deepEqual(r.fields, { values: 'Too long', attributeName: 'Exists' });
    assert.equal(r.general, '');
  });
  it('falls back to a general message', () => {
    assert.equal(apiFieldErrors({ message: 'Offline' }).general, 'Offline');
  });
});
