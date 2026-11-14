// Run with: npm test   (Node's built-in test runner; no browser needed)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codeProblem, initialValues, isDirty, serverFieldErrors, toPayload, validateMedicine, gstSplit, packingSummary, unitsPerOuter } from './medicineValidation.js';

const valid = () => ({ ...initialValues(null), medicineName: 'Dolo 650' });

describe('validateMedicine', () => {
  it('accepts a minimal valid medicine', () => assert.deepEqual(validateMedicine(valid()), {}));

  it('requires a medicine name', () => {
    assert.match(validateMedicine({ ...valid(), medicineName: '' }).medicineName, /required/);
    assert.match(validateMedicine({ ...valid(), medicineName: '   ' }).medicineName, /required/);
    assert.match(validateMedicine({ ...valid(), medicineName: 'x'.repeat(151) }).medicineName, /150/);
  });

  it('checks GST percentage', () => {
    assert.match(validateMedicine({ ...valid(), gstPercentage: '' }).gstPercentage, /Enter/);
    assert.match(validateMedicine({ ...valid(), gstPercentage: 'abc' }).gstPercentage, /Enter/);
    assert.match(validateMedicine({ ...valid(), gstPercentage: -1 }).gstPercentage, /0 and 100/);
    assert.match(validateMedicine({ ...valid(), gstPercentage: 101 }).gstPercentage, /0 and 100/);
    assert.match(validateMedicine({ ...valid(), gstPercentage: 12.345 }).gstPercentage, /2 decimal/);
    for (const ok of [0, 5, 12, 18, 28, 12.5, '12', 100]) assert.equal(validateMedicine({ ...valid(), gstPercentage: ok }).gstPercentage, undefined, String(ok));
  });

  it('checks reorder level', () => {
    assert.match(validateMedicine({ ...valid(), reorderLevel: '' }).reorderLevel, /Enter/);
    assert.match(validateMedicine({ ...valid(), reorderLevel: 2.5 }).reorderLevel, /whole/);
    assert.match(validateMedicine({ ...valid(), reorderLevel: -3 }).reorderLevel, /negative/);
    assert.match(validateMedicine({ ...valid(), reorderLevel: 5000000 }).reorderLevel, /large/);
    assert.equal(validateMedicine({ ...valid(), reorderLevel: 0 }).reorderLevel, undefined);
  });

  it('checks the HSN code', () => {
    assert.match(validateMedicine({ ...valid(), hsnCode: '12' }).hsnCode, /4 to 8/);
    assert.match(validateMedicine({ ...valid(), hsnCode: 'ABCD' }).hsnCode, /4 to 8/);
    assert.equal(validateMedicine({ ...valid(), hsnCode: '30049099' }).hsnCode, undefined);
    assert.equal(validateMedicine({ ...valid(), hsnCode: '' }).hsnCode, undefined);
  });

  it('checks SKU and barcode format', () => {
    assert.match(validateMedicine({ ...valid(), sku: 'has space' }).sku, /no spaces/);
    assert.match(validateMedicine({ ...valid(), sku: 'x' }).sku, /at least 2/);
    assert.match(validateMedicine({ ...valid(), barcode: 'bad$' }).barcode, /letters, numbers/);
    assert.equal(validateMedicine({ ...valid(), sku: 'DOLO-650', barcode: '8901234567890' }).sku, undefined);
    assert.equal(codeProblem('', 'SKU'), '');
  });

  it('checks the image link', () => {
    assert.match(validateMedicine({ ...valid(), image: 'photo.png' }).image, /http/);
    assert.match(validateMedicine({ ...valid(), image: 'javascript:alert(1)' }).image, /http/);
    assert.equal(validateMedicine({ ...valid(), image: 'https://x.test/a.png' }).image, undefined);
    assert.equal(validateMedicine({ ...valid(), image: '/uploads/a.png' }).image, undefined);
  });

  it('checks the description length', () => {
    assert.match(validateMedicine({ ...valid(), description: 'd'.repeat(2001) }).description, /2000/);
  });

  it('checks custom attributes (name required, unique, limited)', () => {
    assert.match(validateMedicine({ ...valid(), attributes: [{ key: '', value: 'x' }] }).attributes, /needs a name/);
    assert.match(validateMedicine({ ...valid(), attributes: [{ key: 'Storage', value: 'a' }, { key: 'storage', value: 'b' }] }).attributes, /unique/);
    assert.match(validateMedicine({ ...valid(), attributes: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: '' })) }).attributes, /At most 20/);
    assert.equal(validateMedicine({ ...valid(), attributes: [{ key: '', value: '' }] }).attributes, undefined, 'a blank row is ignored');
    assert.equal(validateMedicine({ ...valid(), attributes: [{ key: 'Storage', value: 'Cool' }] }).attributes, undefined);
  });

  it('reports every problem at once', () => {
    const e = validateMedicine({ ...valid(), medicineName: '', gstPercentage: 200, reorderLevel: -1, hsnCode: '1' });
    assert.deepEqual(Object.keys(e).sort(), ['gstPercentage', 'hsnCode', 'medicineName', 'reorderLevel']);
  });
});

describe('isDirty', () => {
  it('is false for an untouched form and true after any change', () => {
    const a = initialValues(null);
    assert.equal(isDirty(a, structuredClone(a)), false);
    assert.equal(isDirty(a, { ...a, medicineName: 'x' }), true);
    assert.equal(isDirty(a, { ...a, attributes: [{ key: 'k', value: '' }] }), true);
  });
  it('goes back to clean when a change is undone', () => {
    const a = initialValues(null);
    assert.equal(isDirty(a, { ...a, sku: 'AB' }), true);
    assert.equal(isDirty(a, { ...a, sku: '' }), false);
  });
});

describe('toPayload', () => {
  it('trims, converts numbers, and links salt to the compound', () => {
    const p = toPayload({ ...valid(), medicineName: '  Dolo  ', salt: ' Paracetamol ', gstPercentage: '5', reorderLevel: '20', sku: ' AB-1 ' });
    assert.equal(p.medicineName, 'Dolo');
    assert.equal(p.salt, 'Paracetamol');
    assert.equal(p.compoundName, 'Paracetamol');
    assert.equal(p.gstPercentage, 5);
    assert.equal(p.reorderLevel, 20);
    assert.equal(p.sku, 'AB-1');
  });

  it('never sends batch-specific prices or quantities', () => {
    const p = toPayload({ ...valid(), mrp: 100, sellingPrice: 90, purchasePrice: 60, quantity: 5, initialQuantity: 5 });
    for (const k of ['mrp', 'sellingPrice', 'purchasePrice', 'quantity', 'initialQuantity', 'availableQuantity', 'batch']) assert.ok(!(k in p), k);
  });

  it('keeps fields the form does not show (unit) and the archive state when editing', () => {
    const edit = initialValues({ medicineName: 'X', unit: 'Strip', isActive: false });
    const p = toPayload(edit);
    assert.equal(p.unit, 'Strip');
    assert.equal(p.isActive, false);
  });

  it('drops blank custom attributes', () => {
    assert.deepEqual(toPayload({ ...valid(), attributes: [{ key: '', value: '' }, { key: ' A ', value: ' b ' }] }).attributes, [{ key: 'A', value: 'b' }]);
  });
});

describe('initialValues', () => {
  it('fills the form from an existing medicine, showing salt (or compound) in the single Salt / compound field', () => {
    const v = initialValues({ medicineName: 'Dolo', salt: '', compoundName: 'Paracetamol 650', categoryName: 'Tablets', gstPercentage: 5, attributes: [{ key: 'a', value: 'b' }] });
    assert.equal(v.salt, 'Paracetamol 650');
    assert.equal(v.categoryName, 'Tablets');
    assert.equal(v.gstPercentage, 5);
    assert.deepEqual(v.attributes, [{ key: 'a', value: 'b' }]);
    assert.equal(v.sku, '', 'missing fields get their blank value');
  });
});

describe('serverFieldErrors', () => {
  it('places a duplicate SKU / barcode error on its field', () => {
    const r = serverFieldErrors({ message: 'Another medicine already uses this SKU.', details: [{ path: 'sku', message: 'Another medicine already uses this SKU.' }] });
    assert.deepEqual(r.fields, { sku: 'Another medicine already uses this SKU.' });
    assert.equal(r.general, '');
  });
  it('maps nested paths and the compound field', () => {
    const r = serverFieldErrors({ details: [{ path: 'attributes.0.key', message: 'Every custom attribute needs a name' }, { path: 'compoundName', message: 'too long' }, { path: 'gstPercentage', message: 'GST must be between 0 and 100' }] });
    assert.deepEqual(Object.keys(r.fields).sort(), ['attributes', 'gstPercentage', 'salt']);
  });
  it('falls back to a general message when nothing maps to a field', () => {
    assert.deepEqual(serverFieldErrors({ message: 'Cannot reach the server.' }), { fields: {}, general: 'Cannot reach the server.' });
    assert.equal(serverFieldErrors({}).general, 'Something went wrong');
  });
});

describe('how a GST rate is shown', () => {
  it('splits one rate the way a bill charges it, and never stores three numbers', () => {
    assert.deepEqual(gstSplit(12), { cgst: 6, sgst: 6, igst: 12 });
    assert.deepEqual(gstSplit(5), { cgst: 2.5, sgst: 2.5, igst: 5 });
    assert.deepEqual(gstSplit(0), { cgst: 0, sgst: 0, igst: 0 });
    assert.deepEqual(gstSplit(undefined), { cgst: 0, sgst: 0, igst: 0 });
  });
});

describe('how a pack reads', () => {
  it('says the outer and the inner together, and only what was filled in', () => {
    assert.equal(packingSummary({ outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 }), 'Box of 10 × 15 Strips');
    assert.equal(packingSummary({ innerUnit: 'Strip', innerQty: 1 }), '1 Strip', 'one is not "1 Strips"');
    assert.equal(packingSummary({ outerUnit: 'Carton' }), 'Carton');
    assert.equal(packingSummary({}), '');
    assert.equal(packingSummary(), '');
  });

  it('works out the sellable units in an outer pack, only when both halves are known', () => {
    assert.equal(unitsPerOuter({ outerQty: 10, innerQty: 15 }), 150);
    assert.equal(unitsPerOuter({ outerQty: 10 }), null);
    assert.equal(unitsPerOuter({}), null);
  });
});

describe('what the form sends for the new fields', () => {
  it('sends the packing, the company and the defaults, leaving empty numbers out', () => {
    const body = toPayload({ ...initialValues(), medicineName: 'Dolo 650', company: ' Micro Labs ', outerUnit: 'Box', outerQty: '10', innerUnit: 'Strip', innerQty: '15', defaultMrp: '30.5' });
    assert.equal(body.company, 'Micro Labs');
    assert.deepEqual(body.packing, { outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 });
    assert.equal(body.defaultMrp, 30.5);
    assert.equal('defaultPurchasePrice' in body, false, 'an empty price is not sent as zero');
  });

  it('zeroes the GST rate for an exempt or nil-rated product', () => {
    assert.equal(toPayload({ ...initialValues(), medicineName: 'X', taxability: 'exempt', gstPercentage: 12 }).gstPercentage, 0);
    assert.equal(toPayload({ ...initialValues(), medicineName: 'X', taxability: 'nil', gstPercentage: 5 }).gstPercentage, 0);
    assert.equal(toPayload({ ...initialValues(), medicineName: 'X', taxability: 'taxable', gstPercentage: 12 }).gstPercentage, 12);
  });

  it('fills the form back from a saved medicine', () => {
    const f = initialValues({ medicineName: 'Dolo', company: 'Micro Labs', packing: { outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 }, taxability: 'exempt', gstPercentage: 0, defaultMrp: 30.5 });
    assert.deepEqual([f.outerUnit, f.outerQty, f.innerUnit, f.innerQty], ['Box', 10, 'Strip', 15]);
    assert.equal(f.company, 'Micro Labs');
    assert.equal(f.taxability, 'exempt');
    assert.equal(f.defaultMrp, 30.5);
  });
});
