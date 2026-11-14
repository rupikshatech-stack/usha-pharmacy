// Suppliers: the records the Orders module already relies on, now with the supplier code people quote and search by. What matters: a code is always given and
// is unique per organization, the search finds a supplier by any of the things printed on an invoice, and one organization never sees another's suppliers.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
/** A supplier with the three things the form always asks for; override anything per test. */
const add = (client, body) => client.post('/suppliers', { name: `Supplier ${++n}`, contactPerson: 'Asha Rao', phone: '9876500000', ...body });
const code = (r) => r.body.code || r.body.error?.code;

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Supplier Org');
  other = await h.makeTenant('Supplier Other Org');
});
after(async () => {
  await h?.stop();
});

describe('The supplier code', () => {
  it('is given by the server when none is typed, counting up per organization', async () => {
    const a = await add(T.client, { name: 'Alpha Distributors' });
    const b = await add(T.client, { name: 'Beta Pharma' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.match(a.data.code, /^SUP-\d{4}$/);
    assert.match(b.data.code, /^SUP-\d{4}$/);
    assert.notEqual(a.data.code, b.data.code, 'each supplier gets its own');
    assert.equal(Number(b.data.code.slice(4)) - Number(a.data.code.slice(4)), 1, 'they count up');
  });

  it('keeps one a person typed, in capitals, and refuses a code that is already used', async () => {
    const mine = await add(T.client, { name: 'Gamma Healthcare', code: 'mfg-77' });
    assert.equal(mine.data.code, 'MFG-77');
    const clash = await add(T.client, { name: 'Delta Labs', code: 'MFG-77' });
    assert.equal(clash.status, 409);
    assert.equal(code(clash), 'DUPLICATE_SUPPLIER');
    assert.deepEqual((clash.body.details || []).map((d) => d.path), ['code']);
    const elsewhere = await add(other.client, { name: 'Delta Labs', code: 'MFG-77' });
    assert.equal(elsewhere.status, 201, 'another organization may use the same code');
  });

  it('refuses a code with punctuation, and still refuses a duplicate name', async () => {
    assert.equal((await add(T.client, { name: 'Epsilon', code: 'A B/C' })).status, 400);
    await add(T.client, { name: 'Zeta Medico' });
    const again = await add(T.client, { name: 'zeta medico' });
    assert.equal(again.status, 409);
    assert.deepEqual((again.body.details || []).map((d) => d.path), ['name'], 'the name clash is reported on the name');
  });
});

describe('Finding a supplier', () => {
  it('searches by company, code, GST, contact person, phone and email', async () => {
    const made = await add(T.client, {
      name: 'Sunrise Medical Agencies', code: 'SUN-01', contactPerson: 'Meera Iyer', phone: '+91 98200 11223', email: 'orders@sunrisemed.test', gstin: '27AAACS1234A1Z5',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    for (const [what, term] of [
      ['company', 'sunrise medical'],
      ['supplier code', 'SUN-01'],
      ['GST number', '27AAACS1234A'],
      ['contact person', 'meera'],
      ['phone', '98200 11223'],
      ['email', 'orders@sunrisemed'],
    ]) {
      const found = await T.client.get(`/suppliers?search=${encodeURIComponent(term)}`);
      assert.equal(found.status, 200);
      assert.deepEqual(found.data.items.map((s) => s.name), ['Sunrise Medical Agencies'], `searched by ${what}`);
    }
    assert.equal((await T.client.get('/suppliers?search=nobody-by-this-name')).data.items.length, 0, 'and finds nothing when there is nothing');
  });

  it('treats a search term as text, not as a pattern', async () => {
    const r = await T.client.get('/suppliers?search=.*');
    assert.equal(r.status, 200);
    assert.equal(r.data.items.length, 0, 'a regular expression in the box matches nothing, it does not list everything');
  });

  it('pages the list and never shows another organization’s suppliers', async () => {
    const page = await T.client.get('/suppliers?page=1&limit=2');
    assert.equal(page.data.items.length, 2);
    assert.equal(page.data.limit, 2);
    assert.ok(page.data.total >= 5);
    assert.ok(page.data.pages >= 3);
    const second = await T.client.get('/suppliers?page=2&limit=2');
    assert.notDeepEqual(second.data.items.map((s) => s._id), page.data.items.map((s) => s._id));

    const theirs = await other.client.get('/suppliers?limit=100');
    assert.deepEqual(theirs.data.items.map((s) => s.name), ['Delta Labs'], 'only their own');
  });
});

describe('What a supplier must have', () => {
  it('asks for the company, the contact person and the phone number, each against its own field', async () => {
    const bare = await T.client.post('/suppliers', {});
    assert.equal(bare.status, 400);
    assert.deepEqual((bare.body.details || []).map((d) => d.path).sort(), ['contactPerson', 'name', 'phone']);
    const noPhone = await T.client.post('/suppliers', { name: 'No Phone Traders', contactPerson: 'Someone' });
    assert.deepEqual((noPhone.body.details || []).map((d) => d.path), ['phone']);
  });

  it('checks the formats it is given, and accepts a supplier with none of them', async () => {
    for (const [field, value, expected] of [
      ['email', 'not-an-email', 'email'],
      ['altEmail', 'also bad', 'altEmail'],
      ['gstin', '27ABCDE1234F1Z', 'gstin'],
      ['pan', 'ABCD1234F', 'pan'],
      ['website', 'sunrise.test', 'website'],
      ['phone', 'call me', 'phone'],
    ]) {
      const r = await add(T.client, { name: `Format ${field} ${++n}`, [field]: value });
      assert.equal(r.status, 400, `${field} should be refused`);
      assert.ok((r.body.details || []).some((d) => d.path === expected), `${field} reported on ${expected}: ${JSON.stringify(r.body.details)}`);
    }
    const pin = await add(T.client, { name: `Pin ${++n}`, address: { line1: '1 Road', pincode: '41100' } });
    assert.equal(pin.status, 400);
    assert.ok((pin.body.details || []).some((d) => d.path === 'address.pincode'), JSON.stringify(pin.body.details));
    const fine = await add(T.client, { name: `Plain ${++n}` });
    assert.equal(fine.status, 201, 'nothing optional is forced');
    assert.equal(fine.data.supplierType, 'distributor');
    assert.equal(fine.data.status, 'active');
    assert.equal(fine.data.isPreferred, false);
  });

  it('keeps the whole form: type, website, PAN, both addresses lines and the procurement block', async () => {
    const r = await add(T.client, {
      name: `Full Record ${++n}`, code: `FULL-${n}`, supplierType: 'manufacturer', website: 'https://example.test', gstin: '27AAACS1234A1Z5', pan: 'ABCDE1234F', isPreferred: true,
      contactPerson: 'Priya Nair', phone: '020-1234567', altPhone: '9876500001', email: 'a@example.test', altEmail: 'b@example.test',
      address: { line1: '5 Industrial Estate', line2: 'Phase II', city: 'Pune', state: 'Maharashtra', pincode: '411001', country: 'India', landmark: 'Near the depot' },
      procurement: { paymentTerms: 'net30', creditPeriodDays: 0, minimumOrderValue: 5000, preferredDeliveryTime: '2-3 days', notes: 'Delivers before noon' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.supplierType, 'manufacturer');
    assert.equal(r.data.typeLabel, 'Manufacturer');
    assert.equal(r.data.pan, 'ABCDE1234F');
    assert.equal(r.data.isPreferred, true);
    assert.equal(r.data.address.landmark, 'Near the depot');
    assert.equal(r.data.procurement.minimumOrderValue, 5000);
    assert.equal(r.data.paymentTermsLabel, '30 days');
    assert.equal(r.data.creditDays, 30, 'the days a term implies are worked out once, on the server');
    assert.match(r.data.addressLine, /5 Industrial Estate.*Phase II.*Near the depot.*Pune, Maharashtra.*411001/);
  });
});

/* ---------------------------------------------------------------- editing, marking, status and deleting */

const uniq = (p) => `${p} ${Date.now()}-${++n}`;
/** A medicine and an order for a supplier, so the usage and statistics tests work against real purchasing records. */
const medicine = async () => {
  const now = new Date();
  const r = await h.models.Medicine.collection.insertOne({ organizationId: T.org._id, medicineName: uniq('Med'), unit: 'Strip', gstPercentage: 12, isActive: true, attributes: [], barcode: '', sku: '', createdAt: now, updatedAt: now });
  return String(r.insertedId);
};
const placeOrder = async (supplierId, { quantity = 10, rate = 10 } = {}) =>
  T.client.post('/orders', { supplierId, status: 'draft', orderDate: '2026-11-01', items: [{ medicineId: await medicine(), quantity, rate, gstPercent: 12 }], charges: {}, payment: { terms: 'credit', advance: 0 } });

describe('Editing a supplier', () => {
  it('saves the changes, records who made them, and leaves earlier orders exactly as they were', async () => {
    const made = (await add(T.client, { name: uniq('Edit Me'), contactPerson: 'First Contact', phone: '9811100001' })).data;
    const order = await placeOrder(made._id);
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const before = (await T.client.get(`/orders/${order.data._id}`)).data;

    const r = await T.client.put(`/suppliers/${made._id}`, { contactPerson: 'Second Contact', phone: '9811100002', supplierType: 'wholesaler', procurement: { paymentTerms: 'net45', minimumOrderValue: 2500 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.contactPerson, 'Second Contact');
    assert.equal(r.data.typeLabel, 'Wholesaler');
    assert.equal(r.data.creditDays, 45);
    assert.equal(r.data.updatedByName, T.user.name, 'who changed it is kept');
    assert.ok(new Date(r.data.updatedAt) >= new Date(made.updatedAt));

    const after = (await T.client.get(`/orders/${order.data._id}`)).data;
    assert.equal(after.supplier.name, before.supplier.name, 'the order keeps the snapshot taken when it was placed');
    assert.equal(after.grandTotal, before.grandTotal);
  });

  it('changes only what was sent: the fields the form left out keep their values', async () => {
    const made = (await add(T.client, {
      name: uniq('Keep Everything'), supplierType: 'manufacturer', website: 'https://keep.test', gstin: '27AAACS1234A1Z5', pan: 'ABCDE1234F', isPreferred: true,
      address: { line1: '9 Old Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', landmark: 'By the bridge' },
      procurement: { paymentTerms: 'net45', minimumOrderValue: 7500, preferredDeliveryTime: 'Mornings', notes: 'Call ahead' },
    })).data;
    const after = (await T.client.put(`/suppliers/${made._id}`, { contactPerson: 'Only This Changed' })).data;
    assert.equal(after.contactPerson, 'Only This Changed');
    assert.equal(after.supplierType, 'manufacturer', 'the type is not reset to the default');
    assert.equal(after.website, 'https://keep.test');
    assert.equal(after.gstin, '27AAACS1234A1Z5');
    assert.equal(after.pan, 'ABCDE1234F');
    assert.equal(after.isPreferred, true);
    assert.equal(after.code, made.code);
    assert.equal(after.address.line1, '9 Old Road');
    assert.equal(after.address.landmark, 'By the bridge');
    assert.equal(after.procurement.paymentTerms, 'net45');
    assert.equal(after.procurement.minimumOrderValue, 7500);
    assert.equal(after.procurement.notes, 'Call ahead');
    assert.equal(after.isActive, true);
  });

  it('refuses a name or code that belongs to another supplier, and a store that is not ours', async () => {
    const a = (await add(T.client, { name: uniq('Keeper'), code: `KEEP-${n}` })).data;
    const b = (await add(T.client, { name: uniq('Other') })).data;
    const name = await T.client.put(`/suppliers/${b._id}`, { name: a.name });
    assert.equal(name.status, 409);
    assert.deepEqual((name.body.details || []).map((d) => d.path), ['name']);
    const codeClash = await T.client.put(`/suppliers/${b._id}`, { code: a.code });
    assert.equal(codeClash.status, 409);
    assert.deepEqual((codeClash.body.details || []).map((d) => d.path), ['code']);

    const theirs = (await other.client.get('/branches')).data;
    const theirBranch = Array.isArray(theirs) ? theirs[0] : theirs.items[0];
    const wrong = await T.client.put(`/suppliers/${b._id}`, { procurement: { defaultBranchId: String(theirBranch._id) } });
    assert.equal(wrong.status, 400);
    assert.equal(code(wrong), 'BRANCH_NOT_FOUND');
  });

  it('is refused for another organization and for staff without the inventory permission', async () => {
    const mine = (await add(T.client, { name: uniq('Mine') })).data;
    assert.equal((await other.client.put(`/suppliers/${mine._id}`, { contactPerson: 'Nope' })).status, 404);
    const staff = h.client();
    const u = await h.makeUser(T.org, { role: 'STAFF' });
    await staff.login(u.email);
    assert.equal((await staff.put(`/suppliers/${mine._id}`, { contactPerson: 'Nope' })).status, 403);
    assert.equal((await staff.get('/suppliers')).status, 200, 'but staff may still look suppliers up, as they always could');
  });
});

describe('Preferred and status', () => {
  it('marks a supplier preferred, lists preferred ones first, and takes the mark away again', async () => {
    const plain = (await add(T.client, { name: `AAA ${uniq('Plain')}` })).data; // sorts first alphabetically
    const star = (await add(T.client, { name: `ZZZ ${uniq('Star')}` })).data;
    assert.equal((await T.client.post(`/suppliers/${star._id}/preferred`, { preferred: true })).data.isPreferred, true);
    const list = await T.client.get('/suppliers?limit=100');
    const names = list.data.items.map((x) => x.name);
    assert.ok(names.indexOf(star.name) < names.indexOf(plain.name), 'preferred suppliers come first');
    assert.equal((await T.client.get('/suppliers?preferred=true&limit=100')).data.items.every((x) => x.isPreferred), true);
    assert.equal((await T.client.post(`/suppliers/${star._id}/preferred`, { preferred: false })).data.isPreferred, false);
  });

  it('deactivates and reactivates, hides inactive suppliers from the default list, and keeps everything they have', async () => {
    const s = (await add(T.client, { name: uniq('Pausable') })).data;
    const off = await T.client.post(`/suppliers/${s._id}/status`, { status: 'inactive' });
    assert.equal(off.status, 200);
    assert.equal(off.data.status, 'inactive');
    assert.equal((await T.client.get(`/suppliers?search=${encodeURIComponent(s.name)}`)).data.items.length, 0, 'left out by default');
    assert.equal((await T.client.get(`/suppliers?active=inactive&search=${encodeURIComponent(s.name)}`)).data.items.length, 1);
    assert.equal((await T.client.get(`/suppliers?active=all&search=${encodeURIComponent(s.name)}`)).data.items.length, 1);
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).status, 200, 'still there, with its details');
    assert.equal((await T.client.post(`/suppliers/${s._id}/status`, { status: 'active' })).data.status, 'active');
  });

  it('will not deactivate a supplier with open orders', async () => {
    const s = (await add(T.client, { name: uniq('Busy') })).data;
    const order = await placeOrder(s._id);
    assert.equal(order.status, 201);
    assert.equal((await T.client.post(`/orders/${order.data._id}/submit`, {})).status, 200, 'the order is now awaiting approval');
    const off = await T.client.post(`/suppliers/${s._id}/status`, { status: 'inactive' });
    assert.equal(off.status, 409);
    assert.equal(code(off), 'SUPPLIER_IN_USE');
    assert.match(off.body.message, /open order/);
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).data.status, 'active', 'unchanged');
  });
});

describe('Deleting a supplier', () => {
  it('removes one that was never used', async () => {
    const s = (await add(T.client, { name: uniq('Unused') })).data;
    const r = await T.client.del(`/suppliers/${s._id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).status, 404);
  });

  it('keeps one with purchase orders, says why, and recommends deactivating — the orders are untouched', async () => {
    const s = (await add(T.client, { name: uniq('Used') })).data;
    const order = await placeOrder(s._id);
    assert.equal(order.status, 201);
    const r = await T.client.del(`/suppliers/${s._id}`);
    assert.equal(r.status, 409);
    assert.equal(code(r), 'IN_USE');
    assert.match(r.body.message, /purchase orders/);
    assert.match(r.body.message, /Deactivate it instead/);
    assert.equal((await T.client.get(`/orders/${order.data._id}`)).status, 200);
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).status, 200);
  });

  it('needs the settings permission, and never reaches another organization', async () => {
    const s = (await add(T.client, { name: uniq('Guarded') })).data;
    const buyer = h.client();
    const u = await h.makeUser(T.org, { role: 'STAFF', permissions: ['inventory:read', 'inventory:write'] });
    await buyer.login(u.email);
    assert.equal((await buyer.post('/suppliers', { name: uniq('Buyer Added'), contactPerson: 'A', phone: '1' })).status, 201, 'they may add');
    assert.equal((await buyer.del(`/suppliers/${s._id}`)).status, 403, 'but not delete');
    assert.equal((await other.client.del(`/suppliers/${s._id}`)).status, 404);
    assert.equal((await T.client.get(`/suppliers/${s._id}`)).status, 200);
  });
});

describe('Supplier statistics', () => {
  it('counts the real orders and money, and reports nothing for a supplier with no history', async () => {
    const fresh = (await add(T.client, { name: uniq('Fresh') })).data;
    const none = (await T.client.get(`/suppliers/${fresh._id}`)).data;
    assert.deepEqual(
      { o: none.totalOrders, open: none.openOrders, amount: none.totalPurchaseAmount, owed: none.outstandingAmount, grn: none.totalGoodsReceipts, last: none.lastPurchaseDate },
      { o: 0, open: 0, amount: 0, owed: 0, grn: 0, last: null },
      'no invented figures',
    );

    const s = (await add(T.client, { name: uniq('Active Buyer') })).data;
    const first = await placeOrder(s._id, { quantity: 10, rate: 100 }); // 1000 + 12% GST
    await placeOrder(s._id, { quantity: 5, rate: 100 }); // left as a draft: not a purchase until it is raised
    assert.equal((await T.client.post(`/orders/${first.data._id}/submit`, {})).status, 200);
    const stats = (await T.client.get(`/suppliers/${s._id}`)).data;
    assert.equal(stats.totalOrders, 1, 'a draft is not an order placed with the supplier (the same rule the supplier list already used)');
    assert.equal(stats.openOrders, 1);
    assert.equal(stats.totalPurchaseAmount, first.data.grandTotal, 'the money comes from the orders themselves');
    assert.equal(stats.totalGoodsReceipts, 0, 'nothing has arrived yet');
    assert.ok(stats.lastPurchaseDate, 'the last order date stands in until a delivery arrives');
  });
});

describe('Sorting, filtering and paging', () => {
  it('sorts by company name both ways, and by when a supplier was added or last changed', async () => {
    const tag = `Sortable-${Date.now()}`;
    const made = [];
    for (const name of [`${tag} Beta`, `${tag} Alpha`, `${tag} Gamma`]) {
      made.push((await add(T.client, { name, supplierType: name.endsWith('Alpha') ? 'manufacturer' : 'stockist' })).data);
      await new Promise((r) => setTimeout(r, 15)); // so "added" and "last changed" really differ
    }
    const names = async (query) => (await T.client.get(`/suppliers?search=${encodeURIComponent(tag)}&active=all&limit=50&${query}`)).data.items.map((x) => x.name);
    assert.deepEqual(await names('sort=name&dir=asc'), [`${tag} Alpha`, `${tag} Beta`, `${tag} Gamma`]);
    assert.deepEqual(await names('sort=name&dir=desc'), [`${tag} Gamma`, `${tag} Beta`, `${tag} Alpha`]);
    assert.deepEqual(await names('sort=createdAt&dir=asc'), [`${tag} Beta`, `${tag} Alpha`, `${tag} Gamma`], 'oldest first');
    assert.deepEqual(await names('sort=createdAt&dir=desc'), [`${tag} Gamma`, `${tag} Alpha`, `${tag} Beta`]);

    // touching one makes it the most recently changed
    assert.equal((await T.client.put(`/suppliers/${made[0]._id}`, { contactPerson: 'Changed Last' })).status, 200);
    assert.equal((await names('sort=updatedAt&dir=desc'))[0], `${tag} Beta`);
    assert.deepEqual(await names('sort=supplierType&dir=asc'), [`${tag} Alpha`, `${tag} Beta`, `${tag} Gamma`], 'manufacturer before stockist, then by name');
    assert.equal((await T.client.get('/suppliers?sort=nonsense')).status, 400, 'only the sorts the module offers');
  });

  it('sorts across the whole set, not just the page it hands back', async () => {
    const tag = `Paged-${Date.now()}`;
    for (const letter of ['D', 'A', 'C', 'B']) await add(T.client, { name: `${tag} ${letter}` });
    const first = await T.client.get(`/suppliers?search=${encodeURIComponent(tag)}&sort=name&dir=asc&page=1&limit=2`);
    const second = await T.client.get(`/suppliers?search=${encodeURIComponent(tag)}&sort=name&dir=asc&page=2&limit=2`);
    assert.deepEqual(first.data.items.map((x) => x.name), [`${tag} A`, `${tag} B`]);
    assert.deepEqual(second.data.items.map((x) => x.name), [`${tag} C`, `${tag} D`]);
    assert.deepEqual({ total: first.data.total, pages: first.data.pages, page: second.data.page, limit: second.data.limit }, { total: 4, pages: 2, page: 2, limit: 2 });
  });

  it('filters by preferred, by not preferred, and by type — together with the search', async () => {
    const tag = `Filter-${Date.now()}`;
    const star = (await add(T.client, { name: `${tag} Starred`, supplierType: 'manufacturer' })).data;
    await add(T.client, { name: `${tag} Plain`, supplierType: 'stockist' });
    await T.client.post(`/suppliers/${star._id}/preferred`, { preferred: true });
    const items = async (query) => (await T.client.get(`/suppliers?search=${encodeURIComponent(tag)}&active=all&limit=50&${query}`)).data.items.map((x) => x.name);
    assert.deepEqual(await items('preferred=true'), [`${tag} Starred`]);
    assert.deepEqual(await items('preferred=false'), [`${tag} Plain`]);
    assert.deepEqual((await items('')).length, 2, 'no filter means all of them');
    assert.deepEqual(await items('type=stockist'), [`${tag} Plain`]);
    assert.deepEqual(await items('type=manufacturer&preferred=true'), [`${tag} Starred`]);
  });

  it('marking preferred changes nothing else about the supplier', async () => {
    const s = (await add(T.client, { name: uniq('Untouched'), procurement: { paymentTerms: 'net15' } })).data;
    const before = (await T.client.get(`/suppliers/${s._id}`)).data;
    await T.client.post(`/suppliers/${s._id}/preferred`, { preferred: true });
    const after = (await T.client.get(`/suppliers/${s._id}`)).data;
    assert.equal(after.isPreferred, true);
    assert.equal(after.isActive, before.isActive, 'the status is left alone');
    assert.equal(after.procurement.paymentTerms, before.procurement.paymentTerms, 'and so are the payment terms');
    assert.equal(after.creditDays, 15);
  });
});

describe('An inactive supplier', () => {
  it('cannot be used for a new purchase order, while the orders they already have stay exactly as they were', async () => {
    const s = (await add(T.client, { name: uniq('Paused Supplier') })).data;
    const earlier = await placeOrder(s._id);
    assert.equal(earlier.status, 201);
    assert.equal((await T.client.post(`/suppliers/${s._id}/status`, { status: 'inactive' })).status, 200);

    const blocked = await placeOrder(s._id);
    assert.equal(blocked.status, 409);
    assert.equal(code(blocked), 'SUPPLIER_INACTIVE');
    assert.match(blocked.body.message, /is inactive/);

    const kept = await T.client.get(`/orders/${earlier.data._id}`);
    assert.equal(kept.status, 200, 'the earlier order is untouched');
    assert.equal(kept.data.grandTotal, earlier.data.grandTotal);
    assert.equal((await T.client.post(`/suppliers/${s._id}/status`, { status: 'active' })).status, 200);
    assert.equal((await placeOrder(s._id)).status, 201, 'usable again once activated');
  });
});

describe('A supplier’s purchase history', () => {
  it('is read from the orders and their goods receipts, with the money and both statuses per order', async () => {
    const s = (await add(T.client, { name: uniq('History Co') })).data;
    const med = await medicine();
    const order = await T.client.post('/orders', { supplierId: s._id, status: 'draft', orderDate: '2026-11-01', expectedDate: '2026-11-10', items: [{ medicineId: med, quantity: 10, rate: 100, gstPercent: 12 }], charges: {}, payment: { terms: 'partial', advance: 400, method: 'UPI' } });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const o = order.data;

    // a draft is not history yet
    assert.equal((await T.client.get(`/suppliers/${s._id}/purchases`)).data.total, 0);

    assert.equal((await T.client.post(`/orders/${o._id}/submit`, {})).status, 200);
    const placed = (await T.client.get(`/suppliers/${s._id}/purchases`)).data;
    assert.equal(placed.total, 1);
    const row = placed.items[0];
    assert.equal(row.orderNo, o.orderNo);
    assert.equal(String(row._id), String(o._id), 'the row carries the order to open');
    assert.equal(row.orderDate.slice(0, 10), '2026-11-01');
    assert.equal(row.expectedDate.slice(0, 10), '2026-11-10');
    assert.equal(row.receivedDate, null, 'nothing has arrived yet');
    assert.equal(row.totalAmount, o.grandTotal);
    assert.equal(row.outstandingAmount, Math.round((o.grandTotal - 400) * 100) / 100, 'what the order itself records as still owed');
    assert.equal(row.paidAmount, 400, 'and what it records as settled — nothing here pays anything');
    assert.equal(row.receiptStatus, 'none');
    assert.equal(row.receiptStatusLabel, 'Not received');
    assert.equal(row.statusLabel, (await T.client.get(`/orders/${o._id}`)).data.statusLabel, 'the status is the order’s own, not a second copy of it');

    // receive part of it: the history follows the real receipts
    // this organization does not require approval, so submitting already approved it
    assert.equal((await T.client.post(`/orders/${o._id}/order`, {})).status, 200);
    const got = await T.client.post(`/orders/${o._id}/receive`, {
      items: [{ medicineId: med, quantity: 4, batchNumber: `HIST-${n}`, expiryDate: '2028-01-31', mrp: 200, sellingPrice: 150 }],
      idempotencyKey: `hist-${Date.now()}-${n}`,
    });
    assert.equal(got.status, 201, JSON.stringify(got.body));
    const after = (await T.client.get(`/suppliers/${s._id}/purchases`)).data.items[0];
    assert.equal(after.receiptStatus, 'partial');
    assert.equal(after.receiptStatusLabel, 'Partially received');
    assert.equal(after.receiptCount, 1);
    assert.ok(after.receivedDate, 'the date of the last delivery comes from the receipt itself');
    assert.ok(after.lastReceiptId, 'the row carries the receipt to open');
    assert.match(after.lastReceiptNo, /^GRN-\d{4}$/);
    assert.equal(after.statusLabel, 'Partially received');
  });

  it('pages, counts only this supplier’s orders, and is refused for another organization', async () => {
    const mine = (await add(T.client, { name: uniq('Paged History') })).data;
    const other2 = (await add(T.client, { name: uniq('Someone Else') })).data;
    for (let i = 0; i < 3; i += 1) {
      const o = await placeOrder(mine._id);
      assert.equal((await T.client.post(`/orders/${o.data._id}/submit`, {})).status, 200);
    }
    const one = await placeOrder(other2._id);
    assert.equal((await T.client.post(`/orders/${one.data._id}/submit`, {})).status, 200);

    const page1 = (await T.client.get(`/suppliers/${mine._id}/purchases?page=1&limit=2`)).data;
    assert.deepEqual({ items: page1.items.length, total: page1.total, pages: page1.pages }, { items: 2, total: 3, pages: 2 });
    const page2 = (await T.client.get(`/suppliers/${mine._id}/purchases?page=2&limit=2`)).data;
    assert.equal(page2.items.length, 1);
    assert.equal((await T.client.get(`/suppliers/${other2._id}/purchases`)).data.total, 1, 'each supplier sees only their own');
    assert.equal((await other.client.get(`/suppliers/${mine._id}/purchases`)).status, 404, 'and not another organization at all');
  });
});
