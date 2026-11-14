// Add / edit medicine: backend validation, duplicate SKU & barcode protection (case-insensitive, per organization),
// the live duplicate check, and that editing preserves what the form doesn't show.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}-${Date.now().toString(36)}`;

const post = (body, client = T.client) => client.post('/inventory', { medicineName: uniq('Med'), ...body });
const ok = async (body, client) => {
  const r = await post(body, client);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Medicine Form Org');
  other = await h.makeTenant('Medicine Form Other');
});

after(async () => {
  await h?.stop();
});

describe('Backend validation', () => {
  const bad = async (body, field, fragment) => {
    const r = await post(body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} should be rejected`);
    const detail = (r.body.details || []).find((d) => d.path === field);
    assert.ok(detail, `expected an error on "${field}", got ${JSON.stringify(r.body.details)}`);
    if (fragment) assert.match(detail.message, fragment);
  };

  it('requires a medicine name and limits its length', async () => {
    await bad({ medicineName: '' }, 'medicineName', /required/i);
    await bad({ medicineName: '   ' }, 'medicineName', /required/i);
    await bad({ medicineName: 'x'.repeat(151) }, 'medicineName', /150/);
  });

  it('validates GST percentage', async () => {
    await bad({ gstPercentage: -1 }, 'gstPercentage', /0 and 100/);
    await bad({ gstPercentage: 100.5 }, 'gstPercentage', /0 and 100/);
    await bad({ gstPercentage: 'abc' }, 'gstPercentage', /number/i);
    await bad({ gstPercentage: 12.345 }, 'gstPercentage', /2 decimal/);
    assert.equal((await ok({ gstPercentage: 5 })).gstPercentage, 5);
    assert.equal((await ok({ gstPercentage: 0 })).gstPercentage, 0);
    assert.equal((await ok({ gstPercentage: 12.5 })).gstPercentage, 12.5);
  });

  it('validates reorder level', async () => {
    await bad({ reorderLevel: -1 }, 'reorderLevel', /negative/);
    await bad({ reorderLevel: 2.5 }, 'reorderLevel', /whole/);
    await bad({ reorderLevel: 'lots' }, 'reorderLevel', /number/i);
    await bad({ reorderLevel: 99999999 }, 'reorderLevel', /large/);
    assert.equal((await ok({ reorderLevel: 0 })).reorderLevel, 0);
  });

  it('validates the HSN code (4–8 digits)', async () => {
    await bad({ hsnCode: '12' }, 'hsnCode', /4 to 8 digits/);
    await bad({ hsnCode: 'ABCD1234' }, 'hsnCode', /digits/);
    await bad({ hsnCode: '123456789' }, 'hsnCode', /digits/);
    assert.equal((await ok({ hsnCode: '3004' })).hsnCode, '3004');
    assert.equal((await ok({ hsnCode: '30049099' })).hsnCode, '30049099');
    assert.equal((await ok({ hsnCode: '' })).hsnCode, '');
  });

  it('validates SKU and barcode format', async () => {
    await bad({ sku: 'has space' }, 'sku', /no spaces/);
    await bad({ sku: 'bad$char' }, 'sku', /letters, numbers/);
    await bad({ sku: 'x' }, 'sku', /at least 2/);
    await bad({ barcode: 'a'.repeat(61) }, 'barcode', /60/);
    await bad({ barcode: '12 34' }, 'barcode', /no spaces/);
    assert.equal((await ok({ sku: 'AB-12_3.4/5' })).sku, 'AB-12_3.4/5');
  });

  it('validates the image link', async () => {
    await bad({ image: 'javascript:alert(1)' }, 'image', /http\(s\)/);
    await bad({ image: 'ftp://host/x.png' }, 'image', /http\(s\)/);
    await bad({ image: 'photo.png' }, 'image', /http\(s\)/);
    assert.equal((await ok({ image: 'https://cdn.example/x.png' })).image, 'https://cdn.example/x.png');
    assert.equal((await ok({ image: '/uploads/x.png' })).image, '/uploads/x.png');
  });

  it('validates text lengths', async () => {
    await bad({ genericName: 'g'.repeat(201) }, 'genericName', /200/);
    await bad({ salt: 's'.repeat(201) }, 'salt', /200/);
    await bad({ manufacturer: 'm'.repeat(121) }, 'manufacturer', /120/);
    await bad({ dosageForm: 'd'.repeat(61) }, 'dosageForm', /60/);
    await bad({ strength: 's'.repeat(61) }, 'strength', /60/);
    await bad({ packSize: 'p'.repeat(61) }, 'packSize', /60/);
    await bad({ description: 'd'.repeat(2001) }, 'description', /2000/);
  });

  it('validates custom attributes', async () => {
    const r = await post({ attributes: [{ key: 'Storage', value: 'Cool' }, { key: 'storage', value: 'Dry' }] });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body.details), /unique/i);
    assert.equal((await post({ attributes: [{ key: '', value: 'x' }] })).status, 400);
    assert.equal((await post({ attributes: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, value: 'v' })) })).status, 400);
    const good = await ok({ attributes: [{ key: ' Storage ', value: ' Cool place ' }] });
    assert.deepEqual(good.attributes.map((a) => [a.key, a.value]), [['Storage', 'Cool place']], 'trimmed');
  });

  it('trims text and ignores fields it does not know (including organizationId)', async () => {
    const m = await ok({ medicineName: '  Spacey  ', manufacturer: '  Acme  ', organizationId: String(other.org._id), evil: 'x' });
    assert.equal(m.medicineName, 'Spacey');
    assert.equal(m.manufacturer, 'Acme');
    assert.equal(m.organizationId, String(T.org._id));
    assert.ok(!('evil' in m));
  });

  it('batch prices and quantities do not belong on a medicine: they are not accepted or stored', async () => {
    const m = await ok({ mrp: 99, sellingPrice: 80, purchasePrice: 50, quantity: 500, availableQuantity: 500, stock: 500 });
    for (const k of ['mrp', 'sellingPrice', 'purchasePrice', 'quantity', 'availableQuantity', 'stock']) assert.ok(!(k in m), `${k} must not be stored on a medicine`);
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.batches.length, 0, 'and no stock appeared');
  });

  it('applies the same rules when editing', async () => {
    const m = await ok({});
    const put = (body) => T.client.put(`/inventory/${m._id}`, { medicineName: m.medicineName, ...body });
    assert.equal((await put({ gstPercentage: 150 })).status, 400);
    assert.equal((await put({ medicineName: '' })).status, 400);
    assert.equal((await put({ hsnCode: '9' })).status, 400);
    assert.equal((await put({ sku: 'no spaces allowed' })).status, 400);
    assert.equal((await put({ image: 'nope' })).status, 400);
    assert.equal((await put({ gstPercentage: 18 })).status, 200);
  });
});

describe('Duplicate SKU and barcode protection', () => {
  it('rejects a duplicate SKU in the same organization, with the error on the sku field', async () => {
    const sku = uniq('SKU');
    await ok({ sku });
    const r = await post({ sku });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'DUPLICATE_SKU');
    assert.deepEqual(r.body.details, [{ path: 'sku', message: 'Another medicine already uses this SKU.' }]);
  });

  it('rejects a duplicate barcode in the same organization, with the error on the barcode field', async () => {
    const barcode = uniq('BC');
    await ok({ barcode });
    const r = await post({ barcode });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'DUPLICATE_BARCODE');
    assert.equal(r.body.details[0].path, 'barcode');
  });

  it('is case-insensitive', async () => {
    const sku = uniq('Case');
    await ok({ sku, barcode: `${sku}-bc` });
    assert.equal((await post({ sku: sku.toUpperCase() })).body.code, 'DUPLICATE_SKU');
    assert.equal((await post({ sku: sku.toLowerCase() })).body.code, 'DUPLICATE_SKU');
    assert.equal((await post({ barcode: `${sku}-BC` })).body.code, 'DUPLICATE_BARCODE');
  });

  it('only applies within one organization: another organization may reuse the same codes', async () => {
    const sku = uniq('Shared');
    const barcode = uniq('SharedBC');
    await ok({ sku, barcode });
    const theirs = await post({ sku, barcode }, other.client);
    assert.equal(theirs.status, 201);
  });

  it('an empty SKU or barcode is never a duplicate', async () => {
    await ok({ sku: '', barcode: '' });
    await ok({ sku: '', barcode: '' });
    await ok({});
  });

  it('blocks changing a medicine to another medicine\'s SKU or barcode, but allows keeping its own', async () => {
    const a = await ok({ sku: uniq('A'), barcode: uniq('ABC') });
    const b = await ok({ sku: uniq('B'), barcode: uniq('BBC') });
    const put = (m, body) => T.client.put(`/inventory/${m._id}`, { medicineName: m.medicineName, ...body });
    assert.equal((await put(b, { sku: a.sku })).body.code, 'DUPLICATE_SKU');
    assert.equal((await put(b, { barcode: a.barcode })).body.code, 'DUPLICATE_BARCODE');
    assert.equal((await put(a, { sku: a.sku, barcode: a.barcode, gstPercentage: 5 })).status, 200, 'saving a medicine with its own codes is fine');
    assert.equal((await T.client.get(`/inventory/${b._id}`)).data.sku, b.sku, 'the rejected edit changed nothing');
  });

  it('archived medicines still hold their codes', async () => {
    const sku = uniq('Arch');
    const m = await ok({ sku });
    await T.client.post(`/inventory/${m._id}/batches`, { batchNumber: 'X1', expiryDate: '2099-01-01', mrp: 10, sellingPrice: 9, initialQuantity: 1 });
    await T.client.del(`/inventory/${m._id}`);
    assert.equal((await post({ sku })).body.code, 'DUPLICATE_SKU');
  });
});

describe('Live duplicate check (GET /api/inventory/duplicates)', () => {
  it('reports which medicine already uses a SKU or barcode', async () => {
    const sku = uniq('Live');
    const barcode = uniq('LiveBC');
    const m = await ok({ medicineName: 'Live Dup Original', sku, barcode });
    const r = await T.client.get(`/inventory/duplicates?sku=${sku}&barcode=${barcode}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.sku.name, 'Live Dup Original');
    assert.equal(r.data.sku.id, m._id);
    assert.equal(r.data.barcode.name, 'Live Dup Original');
    assert.equal(r.data.sku.archived, false);
  });

  it('returns null when the code is free, empty, or only different in nothing but case of another record', async () => {
    const r = await T.client.get(`/inventory/duplicates?sku=${uniq('Free')}&barcode=`);
    assert.deepEqual(r.data, { sku: null, barcode: null });
    const sku = uniq('CaseLive');
    await ok({ sku });
    assert.ok((await T.client.get(`/inventory/duplicates?sku=${sku.toUpperCase()}`)).data.sku, 'case-insensitive');
  });

  it('ignores the medicine being edited (excludeId)', async () => {
    const sku = uniq('Excl');
    const m = await ok({ sku });
    assert.ok((await T.client.get(`/inventory/duplicates?sku=${sku}`)).data.sku);
    assert.equal((await T.client.get(`/inventory/duplicates?sku=${sku}&excludeId=${m._id}`)).data.sku, null);
  });

  it('only looks inside the caller\'s own organization', async () => {
    const sku = uniq('Private');
    await ok({ sku, medicineName: 'Secret Name' });
    const theirs = await other.client.get(`/inventory/duplicates?sku=${sku}`);
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.data, { sku: null, barcode: null }, 'no information leaks across organizations');
  });

  it('needs authentication and the inventory:read permission', async () => {
    assert.equal((await h.client().get('/inventory/duplicates?sku=x')).status, 401);
    assert.equal((await T.client.get('/inventory/duplicates?excludeId=not-an-id')).status, 400);
  });
});

describe('Editing an existing medicine', () => {
  it('updates the fields and reports success; the response and detail reflect the change', async () => {
    const m = await ok({ medicineName: 'Edit Me', genericName: 'Old generic', manufacturer: 'Old Maker', categoryName: 'Old Cat', gstPercentage: 12, reorderLevel: 10 });
    const r = await T.client.put(`/inventory/${m._id}`, {
      medicineName: 'Edit Me v2', genericName: 'New generic', salt: 'New salt', manufacturer: 'New Maker', categoryName: 'New Cat',
      dosageForm: 'Capsule', strength: '250 mg', packSize: '10 caps', sku: uniq('E'), barcode: uniq('EB'), hsnCode: '30049099',
      gstPercentage: 5, reorderLevel: 25, description: 'Updated', image: 'https://cdn.example/e.png', attributes: [{ key: 'Storage', value: 'Cool' }],
    });
    assert.equal(r.status, 200);
    const d = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.deepEqual([d.medicineName, d.genericName, d.salt, d.manufacturer, d.categoryName, d.dosageForm, d.strength, d.packSize, d.gstPercentage, d.reorderLevel, d.description], ['Edit Me v2', 'New generic', 'New salt', 'New Maker', 'New Cat', 'Capsule', '250 mg', '10 caps', 5, 25, 'Updated']);
    assert.deepEqual(d.attributes.map((a) => [a.key, a.value]), [['Storage', 'Cool']]);
  });

  it('keeps stock, batches and archive state: editing a medicine never touches its inventory', async () => {
    const m = await ok({ medicineName: 'Edit Keeps Stock' });
    await T.client.post(`/inventory/${m._id}/batches`, { batchNumber: 'KEEP1', expiryDate: '2099-01-01', mrp: 100, sellingPrice: 90, purchasePrice: 60, initialQuantity: 25 });
    await T.client.put(`/inventory/${m._id}`, { medicineName: 'Edit Keeps Stock v2', gstPercentage: 18 });
    const d = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.equal(d.batches.length, 1);
    assert.deepEqual([d.batches[0].availableQuantity, d.batches[0].sellingPrice, d.batches[0].mrp, d.batches[0].purchasePrice], [25, 90, 100, 60]);
    assert.equal(d.totalStock, 25);
  });

  it('category and compound names are found-or-created, and clearing them works', async () => {
    const m = await ok({ categoryName: 'Cat One', compoundName: 'Comp One' });
    assert.ok(m.categoryId && m.compoundId);
    const c = await T.client.put(`/inventory/${m._id}`, { medicineName: m.medicineName, categoryName: '', compoundName: '' });
    assert.equal(c.status, 200);
    const d = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.equal(d.categoryName, '');
    assert.equal(d.compoundName, '');
  });

  it('is audited and organization-scoped', async () => {
    const m = await ok({ medicineName: 'Edit Audited' });
    await T.client.put(`/inventory/${m._id}`, { medicineName: 'Edit Audited v2' });
    const log = (await T.client.get('/activity?limit=100')).data.items.map((e) => e.message).join(' | ');
    assert.match(log, /Medicine updated — Edit Audited v2/);
    assert.equal((await other.client.put(`/inventory/${m._id}`, { medicineName: 'Hijack' })).status, 404);
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.medicineName, 'Edit Audited v2');
  });

  it('needs inventory:write', async () => {
    const staff = h.client();
    await staff.login((await h.makeUser(T.org, { role: 'STAFF', email: `st-${Date.now()}@example.test` })).email);
    const m = await ok({});
    assert.equal((await staff.post('/inventory', { medicineName: 'x' })).status, 403);
    assert.equal((await staff.put(`/inventory/${m._id}`, { medicineName: 'x' })).status, 403);
    assert.equal((await staff.get('/inventory/duplicates?sku=abc')).status, 200, 'staff may still run the check');
  });
});
