// Compounds and Attributes: CRUD, search, archive/delete rules, linking compounds to medicines, configurable
// organization-specific attributes with allowed values, and tenant isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p} ${++n}`;

const medicine = async (client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Med'), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const compound = async (client, body = {}) => {
  const r = await client.post('/compounds', { compoundName: uniq('Compound'), ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const attribute = async (client, body = {}) => {
  const r = await client.post('/attributes', { attributeName: uniq('Attr'), attributeType: 'custom', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Catalog Org');
  other = await h.makeTenant('Catalog Other Org');
});

after(async () => {
  await h?.stop();
});

describe('Compounds', () => {
  it('adds and edits a compound', async () => {
    const c = await compound(T.client, { compoundName: 'Paracetamol 650 mg', composition: 'Paracetamol IP 650 mg' });
    assert.equal(c.status, 'active');
    const r = await T.client.put(`/compounds/${c._id}`, { composition: 'Paracetamol IP 650 mg (film coated)', description: 'Analgesic' });
    assert.equal(r.status, 200);
    assert.equal(r.data.composition, 'Paracetamol IP 650 mg (film coated)');
    assert.equal(r.data.compoundName, 'Paracetamol 650 mg', 'untouched fields stay');
  });

  it('validates input and refuses a duplicate name (any case) with a message on the field', async () => {
    const empty = await T.client.post('/compounds', { compoundName: '  ' });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.details.some((d) => d.path === 'compoundName'));
    await compound(T.client, { compoundName: 'Ibuprofen 400' });
    const dup = await T.client.post('/compounds', { compoundName: 'IBUPROFEN 400' });
    assert.equal(dup.status, 409);
    assert.ok(dup.body.details.some((d) => d.path === 'compoundName'));
    const c2 = await compound(T.client, { compoundName: 'Other Name' });
    const clash = await T.client.put(`/compounds/${c2._id}`, { compoundName: 'ibuprofen 400' });
    assert.equal(clash.status, 409);
    assert.equal((await T.client.put(`/compounds/${c2._id}`, {})).status, 400, 'nothing to update');
  });

  it('allows the same name in another organization', async () => {
    await compound(other.client, { compoundName: 'Ibuprofen 400' });
  });

  it('searches by name or composition and filters by status', async () => {
    await compound(T.client, { compoundName: 'Amoxicillin 500', composition: 'Amoxicillin trihydrate' });
    const arch = await compound(T.client, { compoundName: 'Old Formula', composition: 'legacy' });
    await T.client.put(`/compounds/${arch._id}`, { status: 'inactive' });
    const names = async (q) => (await T.client.get(`/compounds?${q}`)).data.items.map((c) => c.compoundName);
    assert.deepEqual(await names('search=amoxi'), ['Amoxicillin 500']);
    assert.deepEqual(await names('search=TRIHYDRATE'), ['Amoxicillin 500'], 'composition is searched too');
    assert.deepEqual(await names('status=inactive'), ['Old Formula']);
    assert.deepEqual(await names('search=.*'), [], 'search text is literal');
  });

  it('is paginated and shows how many medicines use each compound', async () => {
    const c = await compound(T.client, { compoundName: 'Counted Compound' });
    await medicine(T.client, { compoundName: 'Counted Compound' });
    await medicine(T.client, { compoundName: 'Counted Compound' });
    const r = await T.client.get('/compounds?search=Counted');
    assert.equal(r.data.items[0].medicineCount, 2);
    assert.equal(r.data.items[0]._id, c._id);
    const page = await T.client.get('/compounds?limit=2&page=1');
    assert.equal(page.data.items.length, 2);
    assert.ok(page.data.pages >= 2);
  });

  it('links medicines to a compound, fills a blank salt, and unlinks', async () => {
    const c = await compound(T.client, { compoundName: 'Linkable Salt' });
    const m1 = await medicine(T.client);
    const m2 = await medicine(T.client, { salt: 'Custom salt text' });
    const linked = await T.client.post(`/compounds/${c._id}/medicines`, { medicineIds: [m1._id, m2._id] });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.data.medicineCount, 2);
    assert.deepEqual(linked.data.medicines.map((m) => m._id).sort(), [m1._id, m2._id].sort());
    const a = (await T.client.get(`/inventory/${m1._id}`)).data;
    const b = (await T.client.get(`/inventory/${m2._id}`)).data;
    assert.equal(a.compoundName, 'Linkable Salt');
    assert.equal(a.salt, 'Linkable Salt', 'blank salt takes the compound name');
    assert.equal(b.salt, 'Custom salt text', 'an existing salt is not overwritten');

    const un = await T.client.del(`/compounds/${c._id}/medicines/${m1._id}`);
    assert.equal(un.status, 200);
    assert.equal(un.data.medicineCount, 1);
    assert.equal((await T.client.del(`/compounds/${c._id}/medicines/${m1._id}`)).status, 404, 'already unlinked');
  });

  it('refuses to link unknown medicines, other organizations’ medicines, or to an archived compound', async () => {
    const c = await compound(T.client);
    assert.equal((await T.client.post(`/compounds/${c._id}/medicines`, { medicineIds: [] })).status, 400);
    assert.equal((await T.client.post(`/compounds/${c._id}/medicines`, { medicineIds: ['0'.repeat(24)] })).status, 404);
    const theirs = await medicine(other.client);
    assert.equal((await T.client.post(`/compounds/${c._id}/medicines`, { medicineIds: [theirs._id] })).status, 404);
    await T.client.put(`/compounds/${c._id}`, { status: 'inactive' });
    const mine = await medicine(T.client);
    const r = await T.client.post(`/compounds/${c._id}/medicines`, { medicineIds: [mine._id] });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'COMPOUND_INACTIVE');
  });

  it('deletes an unused compound but only lets a used one be archived', async () => {
    const unused = await compound(T.client);
    assert.equal((await T.client.del(`/compounds/${unused._id}`)).status, 200);
    assert.equal((await T.client.get(`/compounds/${unused._id}`)).status, 404);

    const used = await compound(T.client);
    const m = await medicine(T.client);
    await T.client.post(`/compounds/${used._id}/medicines`, { medicineIds: [m._id] });
    const blocked = await T.client.del(`/compounds/${used._id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'IN_USE');
    const archived = await T.client.put(`/compounds/${used._id}`, { status: 'inactive' });
    assert.equal(archived.data.status, 'inactive');
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.compoundName, used.compoundName, 'linked medicines keep their compound');
    // unlinking the last medicine makes it deletable again
    await T.client.del(`/compounds/${used._id}/medicines/${m._id}`);
    assert.equal((await T.client.del(`/compounds/${used._id}`)).status, 200);
  });

  it('keeps each organization’s compounds private', async () => {
    const c = await compound(T.client);
    assert.equal((await other.client.get(`/compounds/${c._id}`)).status, 404);
    assert.equal((await other.client.put(`/compounds/${c._id}`, { description: 'x' })).status, 404);
    assert.equal((await other.client.del(`/compounds/${c._id}`)).status, 404);
    assert.equal((await T.client.get('/compounds/not-an-id')).status, 404);
    const theirList = (await other.client.get('/compounds?limit=100')).data.items.map((x) => x._id);
    assert.ok(!theirList.includes(c._id));
  });

  it('records changes in the activity log', async () => {
    const log = JSON.stringify((await T.client.get('/activity?limit=50')).body);
    assert.match(log, /Compound added/);
    assert.match(log, /linked to compound/);
  });
});

describe('Attributes', () => {
  it('adds the kinds of list the pharmacy needs (dosage forms, strengths, units)', async () => {
    const forms = await attribute(T.client, { attributeName: 'Dosage forms', attributeType: 'dosage_form', values: ['Tablet', 'Capsule', 'Syrup', 'Injection'] });
    const strengths = await attribute(T.client, { attributeName: 'Strengths', attributeType: 'strength', values: ['250mg', '500mg', '650mg'] });
    const units = await attribute(T.client, { attributeName: 'Units', attributeType: 'unit', values: ['Strip', 'Bottle', 'Box'] });
    assert.deepEqual(forms.values, ['Tablet', 'Capsule', 'Syrup', 'Injection']);
    assert.deepEqual(strengths.values, ['250mg', '500mg', '650mg']);
    assert.deepEqual(units.values, ['Strip', 'Bottle', 'Box']);
    const facets = (await T.client.get('/inventory/facets')).data;
    assert.ok(facets.dosageForms.includes('Capsule'));
    assert.ok(facets.strengths.includes('650mg'));
    assert.ok(facets.units.includes('Bottle'), 'configured values feed the medicine form’s dropdowns');
  });

  it('treats empty filter values (what the page sends for "Any") as no filter — regression: it used to answer 400', async () => {
    const all = await T.client.get('/attributes?type=&search=&status=&page=1&limit=10');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.data.total > 0);
    assert.equal((await T.client.get('/attributes?type=&search=Storage')).status, 200);
    assert.equal((await T.client.get('/attributes?type=not-a-type')).status, 400, 'a wrong type is still refused');
    // every list the UI shows sends its filters as empty strings when nothing is chosen
    for (const url of [
      '/compounds?search=&status=&page=1&limit=10',
      '/inventory?search=&categoryId=&manufacturer=&stock=&archived=&sortBy=medicineName&sortDir=asc&page=1&limit=10',
      '/inventory?search=&categoryId=&manufacturer=&stock=&archived=exclude&sortBy=medicineName&sortDir=asc&page=1&limit=10',
      '/batches?search=&medicineId=&manufacturer=&expiry=&stock=&archived=exclude&sortBy=expiryDate&sortDir=asc&page=1&limit=10',
      '/stock/movements?medicineId=&batchId=&type=&from=&to=&page=1&limit=10',
      '/activity?search=&page=1&limit=10',
      '/invoices?search=&page=1&limit=10',
    ]) {
      const r = await T.client.get(url);
      assert.ok(r.status === 200 || r.status === 403, `${url} -> ${r.status} ${r.body?.message}`);
    }
  });

  it('validates names, types and values', async () => {
    const bad = async (body, field) => {
      const r = await T.client.post('/attributes', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.details.some((d) => d.path === field), `${field}: ${JSON.stringify(r.body.details)}`);
    };
    await bad({ attributeName: '', attributeType: 'custom' }, 'attributeName');
    await bad({ attributeName: 'X', attributeType: 'weird' }, 'attributeType');
    await bad({ attributeName: 'X', attributeType: 'custom', values: ['a', 'A'] }, 'values');
    await bad({ attributeName: 'X', attributeType: 'custom', values: [''] }, 'values.0');
  });

  it('refuses a duplicate name within a type, allows it across types and organizations', async () => {
    await attribute(T.client, { attributeName: 'Storage', attributeType: 'custom' });
    const dup = await T.client.post('/attributes', { attributeName: 'STORAGE', attributeType: 'custom' });
    assert.equal(dup.status, 409);
    assert.ok(dup.body.details.some((d) => d.path === 'attributeName'));
    assert.equal((await T.client.post('/attributes', { attributeName: 'Storage', attributeType: 'unit' })).status, 201);
    assert.equal((await other.client.post('/attributes', { attributeName: 'Storage', attributeType: 'custom' })).status, 201);
  });

  it('edits name and allowed values, but never the type', async () => {
    const a = await attribute(T.client, { attributeName: 'Editable', values: ['one'] });
    const r = await T.client.put(`/attributes/${a._id}`, { attributeName: 'Editable 2', values: ['one', 'two', 'three'], attributeType: 'unit' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.values, ['one', 'two', 'three']);
    assert.equal(r.data.attributeName, 'Editable 2');
    assert.equal(r.data.attributeType, 'custom', 'type is fixed');
  });

  it('enables and disables, and filters by type, status and search (names and values)', async () => {
    const a = await attribute(T.client, { attributeName: 'Toggle Me', attributeType: 'strength', values: ['1000mg'] });
    await T.client.put(`/attributes/${a._id}`, { status: 'inactive' });
    const ids = async (q) => (await T.client.get(`/attributes?limit=100&${q}`)).data.items.map((x) => x._id);
    assert.ok((await ids('status=inactive')).includes(a._id));
    assert.ok(!(await ids('status=active')).includes(a._id));
    assert.ok((await ids('type=strength')).includes(a._id));
    assert.ok(!(await ids('type=unit')).includes(a._id));
    assert.ok((await ids('search=1000')).includes(a._id), 'search also looks inside the allowed values');
    assert.ok((await ids('search=toggle')).includes(a._id));
    await T.client.put(`/attributes/${a._id}`, { status: 'active' });
    assert.ok((await ids('status=active')).includes(a._id));
  });

  it('a disabled list stops feeding the form’s dropdowns', async () => {
    const a = await attribute(T.client, { attributeName: 'Temp units', attributeType: 'unit', values: ['Sachet-Temp'] });
    assert.ok((await T.client.get('/inventory/facets')).data.units.includes('Sachet-Temp'));
    await T.client.put(`/attributes/${a._id}`, { status: 'inactive' });
    assert.ok(!(await T.client.get('/inventory/facets')).data.units.includes('Sachet-Temp'));
  });

  it('shows how many medicines use a category, list or custom attribute', async () => {
    await attribute(T.client, { attributeName: 'Forms used', attributeType: 'dosage_form', values: ['Lozenge'] });
    await medicine(T.client, { dosageForm: 'Lozenge' });
    await medicine(T.client, { dosageForm: 'Lozenge' });
    await medicine(T.client, { categoryName: 'Counted Cat' });
    const count = async (type, name) => (await T.client.get(`/attributes?type=${type}&search=${encodeURIComponent(name)}`)).data.items.find((x) => x.attributeName === name).medicineCount;
    assert.equal(await count('dosage_form', 'Forms used'), 2);
    assert.equal(await count('category', 'Counted Cat'), 1);
  });

  it('deletes unused attributes; used categories and custom attributes must be disabled instead', async () => {
    const free = await attribute(T.client);
    assert.equal((await T.client.del(`/attributes/${free._id}`)).status, 200);

    const m = await medicine(T.client, { categoryName: 'Protected Cat' });
    const cat = (await T.client.get('/attributes?type=category&search=Protected')).data.items[0];
    const blocked = await T.client.del(`/attributes/${cat._id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'IN_USE');
    assert.equal((await T.client.put(`/attributes/${cat._id}`, { status: 'inactive' })).status, 200);

    const def = await attribute(T.client, { attributeName: 'Schedule type' });
    await T.client.put(`/inventory/${m._id}`, { medicineName: m.medicineName, categoryName: 'Protected Cat', attributes: [{ key: 'Schedule type', value: 'H' }] });
    const used = await T.client.del(`/attributes/${def._id}`);
    assert.equal(used.status, 409);
    assert.equal(used.body.code, 'IN_USE');
  });

  it('keeps each organization’s attributes private', async () => {
    const a = await attribute(T.client);
    assert.equal((await other.client.put(`/attributes/${a._id}`, { status: 'inactive' })).status, 404);
    assert.equal((await other.client.del(`/attributes/${a._id}`)).status, 404);
    const theirs = (await other.client.get('/attributes?limit=100')).data.items.map((x) => x._id);
    assert.ok(!theirs.includes(a._id));
    const facets = (await other.client.get('/inventory/facets')).data;
    assert.ok(!facets.attributeDefs.some((d) => d.id === a._id));
  });
});

describe('Attaching attributes to medicines', () => {
  let storage;
  before(async () => {
    storage = await attribute(T.client, { attributeName: 'Storage condition', values: ['Room temperature', 'Refrigerate', 'Freezer'] });
    await attribute(T.client, { attributeName: 'Free note' }); // no allowed values = free text
  });

  it('offers the organization’s active attribute definitions to the medicine form', async () => {
    const defs = (await T.client.get('/inventory/facets')).data.attributeDefs;
    const d = defs.find((x) => x.name === 'Storage condition');
    assert.deepEqual(d.values, ['Room temperature', 'Refrigerate', 'Freezer']);
    assert.ok(defs.some((x) => x.name === 'Free note' && x.values.length === 0));
  });

  it('accepts an allowed value (any case) and stores it on the medicine', async () => {
    const m = await medicine(T.client, { attributes: [{ key: 'storage condition', value: 'refrigerate' }, { key: 'Free note', value: 'anything goes' }] });
    const got = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.equal(got.attributes.length, 2);
  });

  it('rejects a value that is not allowed, naming the allowed ones', async () => {
    const r = await T.client.post('/inventory', { medicineName: uniq('Bad'), attributes: [{ key: 'Storage condition', value: 'On the roof' }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_ATTRIBUTE_VALUE');
    assert.match(r.body.details[0].message, /Room temperature, Refrigerate, Freezer/);
    assert.equal(r.body.details[0].path, 'attributes.0.value');
    const m = await medicine(T.client);
    const upd = await T.client.put(`/inventory/${m._id}`, { medicineName: m.medicineName, attributes: [{ key: 'Storage condition', value: 'On the roof' }] });
    assert.equal(upd.status, 400, 'editing is checked the same way');
  });

  it('leaves unknown names free-form', async () => {
    const m = await medicine(T.client, { attributes: [{ key: 'Something new', value: 'whatever' }] });
    assert.equal((await T.client.get(`/inventory/${m._id}`)).data.attributes[0].value, 'whatever');
  });

  it('stops enforcing a definition once it is disabled', async () => {
    const def = await attribute(T.client, { attributeName: 'Toggle rule', values: ['A', 'B'] });
    const bad = { medicineName: uniq('Rule'), attributes: [{ key: 'Toggle rule', value: 'Z' }] };
    assert.equal((await T.client.post('/inventory', bad)).status, 400);
    await T.client.put(`/attributes/${def._id}`, { status: 'inactive' });
    assert.equal((await T.client.post('/inventory', { ...bad, medicineName: uniq('Rule') })).status, 201);
    assert.ok(!(await T.client.get('/inventory/facets')).data.attributeDefs.some((d) => d.name === 'Toggle rule'), 'and it is no longer offered');
  });

  it('renaming an attribute renames it on the medicines that carry it', async () => {
    const def = await attribute(T.client, { attributeName: 'Old key name' });
    const m = await medicine(T.client, { attributes: [{ key: 'Old key name', value: 'v' }, { key: 'Other', value: 'o' }] });
    assert.equal((await T.client.put(`/attributes/${def._id}`, { attributeName: 'New key name' })).status, 200);
    const got = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.deepEqual(got.attributes.map((a) => a.key).sort(), ['New key name', 'Other']);
  });

  it('definitions of one organization never apply to another', async () => {
    const r = await other.client.post('/inventory', { medicineName: uniq('Other'), attributes: [{ key: 'Storage condition', value: 'On the roof' }] });
    assert.equal(r.status, 201, 'the other organization has no such definition');
    assert.ok(storage._id);
  });
});

describe('Permissions', () => {
  it('needs a signed-in user', async () => {
    const anon = h.client();
    assert.equal((await anon.get('/compounds')).status, 401);
    assert.equal((await anon.get('/attributes')).status, 401);
    assert.equal((await anon.post('/compounds/' + '0'.repeat(24) + '/medicines', { medicineIds: [] })).status, 401);
  });
});

/* ---------------------------------------------------------------- a compound that is a preparation the pharmacy makes */

describe('A compound written out as a preparation', () => {
  let seq = 0;
  const uniq = (p) => `${p} ${Date.now()}-${++seq}`;
  const errCode = (r) => r.body.code || r.body.error?.code;
  /** The worked example from the reference: a 100 g cream, two actives by percentage, base to make up. */
  const cream = (over = {}) => ({
    compoundName: uniq('Ketamine / Gabapentin Cream'),
    dosageForm: 'Cream',
    totalQuantity: 100,
    totalUnit: 'g',
    ingredients: [
      { name: 'Ketamine HCl', role: 'active', quantity: 10, unit: '%' },
      { name: 'Gabapentin', role: 'active', quantity: 5, unit: '%' },
      { name: 'VersaBase Cream', role: 'base', unit: 'qs' },
    ],
    instructions: 'Levigate the actives with a little base, then incorporate the rest geometrically.',
    requiresUnguator: true,
    sig: 'Apply 1-2 pumps to the affected area up to four times daily as needed.',
    budValue: 180,
    budUnit: 'days',
    ...over,
  });

  it('keeps the recipe and works out what to weigh for the batch', async () => {
    const r = await T.client.post('/compounds', cream());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.data;
    assert.equal(c.isPreparation, true);
    assert.equal(c.summary, '100 g cream');
    assert.equal(c.activeCount, 2);
    assert.deepEqual(c.ingredients.map((i) => i.amount), [10, 5, null], '10% and 5% of 100 g; the base has no figure of its own');
    assert.equal(c.batch.qsAmount, 85, 'the base makes the rest of the 100 g up');
    assert.deepEqual(c.batch.problems, []);
    assert.equal(c.requiresUnguator, true);
    assert.equal(c.budValue, 180);
    assert.equal(c.createdByName, T.user.name);
  });

  it('leaves a plain formulation label exactly as it was', async () => {
    const r = await T.client.post('/compounds', { compoundName: uniq('Paracetamol 650 mg'), composition: 'Paracetamol IP 650 mg' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.isPreparation, false, 'no ingredients means it is just a label medicines are grouped under');
    assert.equal(r.data.batch, null);
    assert.equal(r.data.composition, 'Paracetamol IP 650 mg');
  });

  it('refuses a preparation that cannot be made', async () => {
    const tooMuch = await T.client.post('/compounds', cream({ ingredients: [{ name: 'A', role: 'active', quantity: 80, unit: '%' }, { name: 'B', role: 'active', quantity: 40, unit: '%' }] }));
    assert.equal(tooMuch.status, 400);
    assert.equal(errCode(tooMuch), 'FORMULA_NOT_MAKEABLE');
    assert.match(tooMuch.body.message, /more than the 100 g this formula makes/);

    const twoBases = await T.client.post('/compounds', cream({ ingredients: [{ name: 'Base A', role: 'base', unit: 'qs' }, { name: 'Base B', role: 'base', unit: 'qs' }] }));
    assert.equal(twoBases.status, 400);
    assert.match(twoBases.body.message, /Only one ingredient can be "qs"/);

    const noSize = await T.client.post('/compounds', cream({ totalQuantity: undefined, totalUnit: undefined }));
    assert.equal(noSize.status, 400);
    assert.equal(errCode(noSize), 'FORMULA_INCOMPLETE');
  });

  it('insists an ingredient says how much, unless it is the one that makes up the rest', async () => {
    const noQty = await T.client.post('/compounds', cream({ ingredients: [{ name: 'Ketamine HCl', role: 'active', unit: 'g' }] }));
    assert.equal(noQty.status, 400);
    assert.ok((noQty.body.details || []).some((d) => /quantity/.test(d.path)), JSON.stringify(noQty.body.details));
    assert.equal((await T.client.post('/compounds', cream({ ingredients: [{ name: 'Base', role: 'base', quantity: 85, unit: 'qs' }] }))).status, 400, 'a qs ingredient takes no number');
    assert.equal((await T.client.post('/compounds', cream({ ingredients: [{ name: 'A', role: 'active', quantity: 120, unit: '%' }] }))).status, 400, 'and a percentage cannot exceed the whole');
  });

  it('only lets an ingredient point at this organization own stock', async () => {
    const mine = (await T.client.post('/inventory', { medicineName: uniq('Ketamine HCl powder'), unit: 'g' })).data;
    const ok = await T.client.post('/compounds', cream({ ingredients: [{ name: 'Ketamine HCl', role: 'active', quantity: 10, unit: '%', medicineId: mine._id }, { name: 'Base', role: 'base', unit: 'qs' }] }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(String(ok.data.ingredients[0].medicineId), String(mine._id), 'so a batch can take it out of stock later');

    const theirs = (await other.client.post('/inventory', { medicineName: uniq('Their powder'), unit: 'g' })).data;
    const wrong = await T.client.post('/compounds', cream({ ingredients: [{ name: 'Theirs', role: 'active', quantity: 10, unit: '%', medicineId: theirs._id }, { name: 'Base', role: 'base', unit: 'qs' }] }));
    assert.equal(wrong.status, 400);
    assert.equal(errCode(wrong), 'UNKNOWN_INGREDIENT');
  });

  it('works the same preparation out for another batch size', async () => {
    const c = (await T.client.post('/compounds', cream({ ingredients: [{ name: 'Ketamine HCl', role: 'active', quantity: 10, unit: '%' }, { name: 'Menthol', role: 'active', quantity: 2, unit: 'g' }, { name: 'Base', role: 'base', unit: 'qs' }] }))).data;
    const half = await T.client.get(`/compounds/${c._id}/batch?quantity=50`);
    assert.equal(half.status, 200, JSON.stringify(half.body));
    assert.deepEqual(half.data.lines.map((l) => l.amount), [5, 1, null], 'the percentage still gives 10%, the 2 g becomes 1 g');
    assert.equal(half.data.qsAmount, 44);
    assert.equal((await T.client.get(`/compounds/${c._id}/batch?quantity=0`)).status, 400);

    const label = (await T.client.post('/compounds', { compoundName: uniq('Just a label') })).data;
    const no = await T.client.get(`/compounds/${label._id}/batch?quantity=50`);
    assert.equal(no.status, 400);
    assert.equal(errCode(no), 'NOT_A_PREPARATION');
  });

  it('re-checks that it can still be made when it is edited, and changes only what was sent', async () => {
    const c = (await T.client.post('/compounds', cream({ ingredients: [{ name: 'Ketamine HCl', role: 'active', quantity: 10, unit: 'g' }, { name: 'Gabapentin', role: 'active', quantity: 5, unit: 'g' }, { name: 'Base', role: 'base', unit: 'qs' }] }))).data;
    const edited = await T.client.put(`/compounds/${c._id}`, { sig: 'Apply sparingly twice daily.' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.data.sig, 'Apply sparingly twice daily.');
    assert.equal(edited.data.ingredients.length, 3, 'what was not sent is untouched');
    assert.equal(edited.data.requiresUnguator, true);
    assert.equal(edited.data.updatedByName, T.user.name);

    const broken = await T.client.put(`/compounds/${c._id}`, { totalQuantity: 10 });
    assert.equal(broken.status, 400, '15 g of actives no longer fit a 10 g batch');
    assert.equal((await T.client.get(`/compounds/${c._id}`)).data.totalQuantity, 100, 'and nothing was changed');
  });
});
