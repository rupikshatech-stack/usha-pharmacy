// The /api/inventory endpoints behind the All Inventory page: list (search, filters, sort, server-side
// paging), stock status calculated from batch data, create / read / update, and soft delete.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers/harness.js';

let h;
let M;
let T;
let other;
const day = 86400000;
const future = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);

const create = async (client, body, batches = []) => {
  const r = await client.post('/inventory', { reorderLevel: 10, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const b of batches) {
    const br = await client.post(`/inventory/${r.data._id}/batches`, { mrp: 100, sellingPrice: 90, expiryDate: future(400), ...b });
    assert.equal(br.status, 201, JSON.stringify(br.body));
  }
  return r.data;
};
const expiredBatch = (org, medicineId, number, qty) =>
  h.tenant.runWithTenant(org._id, async () => {
    const b = await M.Batch.create({ medicineId, batchNumber: number, expiryDate: new Date(Date.now() - 2 * day), mrp: 10, sellingPrice: 9, initialQuantity: qty, availableQuantity: qty });
    await M.StockMovement.create({ medicineId, batchId: b._id, type: 'PURCHASE', quantity: qty, balanceAfter: qty });
  });
const list = async (client, qs = '') => (await client.get(`/inventory?${qs}`)).data;
const names = (page) => page.items.map((m) => m.medicineName);

before(async () => {
  h = await startHarness();
  M = h.models;
  T = await h.makeTenant('Inventory Page Org');
  other = await h.makeTenant('Inventory Page Other');

  // A catalogue with every stock status
  await create(T.client, { medicineName: 'Alpha Plenty', genericName: 'Paracetamol', salt: 'Paracetamol 500 mg', manufacturer: 'Acme Labs', categoryName: 'Tablets', sku: 'SKU-ALPHA', barcode: '1111111111111' }, [{ batchNumber: 'A1', initialQuantity: 100 }]);
  await create(T.client, { medicineName: 'Beta Low', genericName: 'Ibuprofen', salt: 'Ibuprofen 400 mg', manufacturer: 'Zenith Pharma', categoryName: 'Tablets', sku: 'SKU-BETA', barcode: '2222222222222' }, [{ batchNumber: 'B1', initialQuantity: 4 }]);
  await create(T.client, { medicineName: 'Gamma Out', genericName: 'Cetirizine', manufacturer: 'Acme Labs', categoryName: 'Syrups', sku: 'SKU-GAMMA' }); // no batches
  const delta = await create(T.client, { medicineName: 'Delta Expired', genericName: 'Amoxicillin', manufacturer: 'Zenith Pharma', categoryName: 'Capsules' });
  await expiredBatch(T.org, delta._id, 'D-OLD', 30);
  await create(T.client, { medicineName: 'Epsilon Mixed', genericName: 'Zinc', manufacturer: 'Acme Labs', categoryName: 'Capsules' }, [{ batchNumber: 'E1', initialQuantity: 50 }]);
  // Epsilon also has an expired batch with units: sellable 50 -> in stock, but 7 expired units are flagged
  const eps = (await list(T.client, 'search=Epsilon')).items[0];
  await expiredBatch(T.org, eps._id, 'E-OLD', 7);

  await create(other.client, { medicineName: 'Alpha Plenty', manufacturer: 'Other Maker' }, [{ batchNumber: 'X1', initialQuantity: 5 }]);
});

after(async () => {
  await h?.stop();
});

describe('GET /api/inventory — stock status is calculated from batch data', () => {
  it('returns In Stock, Low Stock, Out of Stock and Expired by the business rules', async () => {
    const r = await list(T.client, 'limit=50');
    const by = Object.fromEntries(r.items.map((m) => [m.medicineName, m]));
    assert.equal(by['Alpha Plenty'].stockStatus, 'in_stock'); // 100 sellable, reorder 10
    assert.equal(by['Beta Low'].stockStatus, 'low_stock'); // 4 sellable < 10
    assert.equal(by['Gamma Out'].stockStatus, 'out_of_stock'); // nothing at all
    assert.equal(by['Delta Expired'].stockStatus, 'expired'); // units on hand, but all expired
    assert.equal(by['Epsilon Mixed'].stockStatus, 'in_stock'); // has sellable stock too
  });

  it('exposes the calculated figures: total on hand, sellable, expired and batch count', async () => {
    const r = await list(T.client, 'limit=50');
    const by = Object.fromEntries(r.items.map((m) => [m.medicineName, m]));
    const pick = (m) => [m.totalStock, m.availableStock, m.expiredStock, m.batchCount];
    assert.deepEqual(pick(by['Alpha Plenty']), [100, 100, 0, 1]);
    assert.deepEqual(pick(by['Delta Expired']), [30, 0, 30, 1]);
    assert.deepEqual(pick(by['Epsilon Mixed']), [57, 50, 7, 2], 'total includes expired units; sellable does not');
    assert.deepEqual(pick(by['Gamma Out']), [0, 0, 0, 0]);
  });

  it('the status follows the data: a sale that crosses the reorder level changes it', async () => {
    const m = await create(T.client, { medicineName: 'Zeta Moving', reorderLevel: 10 }, [{ batchNumber: 'Z1', initialQuantity: 12 }]);
    const status = async () => (await list(T.client, 'search=Zeta Moving')).items[0].stockStatus;
    assert.equal(await status(), 'in_stock');
    await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 3 }] }); // 9 left < 10
    assert.equal(await status(), 'low_stock');
    await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 9 }] }); // 0 left
    assert.equal(await status(), 'out_of_stock');
  });

  it('archived and quarantined stock never counts as sellable', async () => {
    const m = await create(T.client, { medicineName: 'Eta Quarantine' }, [{ batchNumber: 'Q1', initialQuantity: 40 }]);
    const batch = (await T.client.get(`/inventory/${m._id}`)).data.batches[0];
    await T.client.patch(`/inventory/${m._id}/batches/${batch._id}`, { status: 'quarantined' });
    const row = (await list(T.client, 'search=Eta Quarantine')).items[0];
    assert.deepEqual([row.totalStock, row.availableStock, row.stockStatus], [40, 0, 'out_of_stock']);
  });

  it('the detail endpoint reports the same status and figures', async () => {
    const r = await list(T.client, 'search=Delta Expired');
    const d = (await T.client.get(`/inventory/${r.items[0]._id}`)).data;
    assert.deepEqual([d.stockStatus, d.totalStock, d.availableStock, d.expiredStock], ['expired', 30, 0, 30]);
  });
});

describe('GET /api/inventory — search', () => {
  const find = async (q) => names(await list(T.client, `search=${encodeURIComponent(q)}&limit=50`)).sort();

  it('by medicine name', async () => assert.deepEqual(await find('Alpha'), ['Alpha Plenty']));
  it('by salt', async () => assert.deepEqual(await find('Ibuprofen 400'), ['Beta Low']));
  it('by generic name', async () => assert.deepEqual(await find('Cetirizine'), ['Gamma Out']));
  it('by manufacturer', async () => assert.deepEqual(await find('Zenith'), ['Beta Low', 'Delta Expired']));
  it('by SKU', async () => assert.deepEqual(await find('SKU-GAMMA'), ['Gamma Out']));
  it('by barcode', async () => assert.deepEqual(await find('2222222222222'), ['Beta Low']));
  it('by batch number', async () => assert.deepEqual(await find('D-OLD'), ['Delta Expired']));
  it('is case-insensitive and treats regex characters literally', async () => {
    assert.deepEqual(await find('alpha plenty'), ['Alpha Plenty']);
    assert.deepEqual(await find('.*'), [], 'a regex wildcard is just text, not a pattern');
    assert.deepEqual(await find('(Alpha'), []);
  });
});

describe('GET /api/inventory — filters', () => {
  it('by category', async () => {
    const cats = (await T.client.get('/inventory/facets')).data.categories;
    const caps = cats.find((c) => c.name === 'Capsules');
    assert.deepEqual(names(await list(T.client, `categoryId=${caps.id}&limit=50`)).sort(), ['Delta Expired', 'Epsilon Mixed']);
  });

  it('by manufacturer', async () => {
    assert.deepEqual(names(await list(T.client, 'manufacturer=Zenith Pharma&limit=50')).sort(), ['Beta Low', 'Delta Expired']);
  });

  it('by each stock status', async () => {
    const f = async (s) => names(await list(T.client, `stock=${s}&limit=50`));
    assert.ok((await f('in_stock')).includes('Alpha Plenty'));
    assert.deepEqual(await f('low_stock'), ['Beta Low']);
    assert.ok((await f('out_of_stock')).includes('Gamma Out'));
    assert.deepEqual(await f('expired'), ['Delta Expired']);
  });

  it('accepts the older short status names too', async () => {
    assert.deepEqual(names(await list(T.client, 'stock=low')), ['Beta Low']);
  });

  it('combines filters and search', async () => {
    assert.deepEqual(names(await list(T.client, 'manufacturer=Acme Labs&stock=in_stock&search=Epsilon')), ['Epsilon Mixed']);
    assert.deepEqual(names(await list(T.client, 'manufacturer=Acme Labs&stock=low_stock')), []);
  });

  it('rejects an unknown status, sort key or direction', async () => {
    assert.equal((await T.client.get('/inventory?stock=plenty')).status, 400);
    assert.equal((await T.client.get('/inventory?sortBy=passwordHash')).status, 400);
    assert.equal((await T.client.get('/inventory?sortDir=sideways')).status, 400);
    assert.equal((await T.client.get('/inventory?categoryId=not-an-id')).status, 400);
  });
});

describe('GET /api/inventory — sorting and server-side pagination', () => {
  it('sorts by medicine name, both directions', async () => {
    const asc = names(await list(T.client, 'sortBy=medicineName&sortDir=asc&limit=50'));
    assert.deepEqual(asc, [...asc].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(names(await list(T.client, 'sortBy=medicineName&sortDir=desc&limit=50')), [...asc].reverse());
  });

  it('sorts by total stock', async () => {
    const desc = (await list(T.client, 'sortBy=totalStock&sortDir=desc&limit=50')).items.map((m) => m.totalStock);
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
    assert.equal(desc[0], 100);
  });

  it('sorts by stock status, most urgent first', async () => {
    const order = (await list(T.client, 'sortBy=stockStatus&sortDir=asc&limit=50')).items.map((m) => m.stockStatus);
    const rank = { out_of_stock: 0, expired: 1, low_stock: 2, in_stock: 3 };
    assert.deepEqual(order.map((s) => rank[s]), order.map((s) => rank[s]).sort((a, b) => a - b));
  });

  it('sorts by category name and manufacturer', async () => {
    const cats = (await list(T.client, 'sortBy=categoryName&sortDir=asc&limit=50')).items.map((m) => m.categoryName);
    assert.deepEqual(cats, [...cats].sort((a, b) => a.localeCompare(b)));
    const mf = (await list(T.client, 'sortBy=manufacturer&limit=50')).items.map((m) => m.manufacturer);
    assert.deepEqual(mf, [...mf].sort((a, b) => a.localeCompare(b)));
  });

  it('pages on the server: page size, totals and page count, with no overlap or gaps', async () => {
    const all = await list(T.client, 'limit=100');
    const total = all.total;
    assert.ok(total >= 5, `expected at least 5 medicines, got ${total}`);
    const p1 = await list(T.client, 'limit=2&page=1');
    const p2 = await list(T.client, 'limit=2&page=2');
    const last = await list(T.client, `limit=2&page=${Math.ceil(total / 2)}`);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.total, total);
    assert.equal(p1.pages, Math.ceil(total / 2));
    assert.equal(p2.page, 2);
    assert.equal(last.items.length, total - 2 * (Math.ceil(total / 2) - 1));
    const seen = [];
    for (let p = 1; p <= p1.pages; p++) seen.push(...names(await list(T.client, `limit=2&page=${p}`)));
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'no medicine appears twice');
    assert.deepEqual(seen, names(all), 'pages concatenate to the full ordered list');
    assert.equal((await list(T.client, 'limit=2&page=999')).items.length, 0);
    assert.equal((await T.client.get('/inventory?limit=0')).status, 400);
    assert.equal((await T.client.get('/inventory?limit=101')).status, 400);
    assert.equal((await T.client.get('/inventory?page=0')).status, 400);
  });

  it('returns the columns the page shows', async () => {
    const m = (await list(T.client, 'search=Alpha Plenty')).items[0];
    for (const k of ['medicineName', 'genericName', 'salt', 'manufacturer', 'categoryName', 'totalStock', 'availableStock', 'reorderLevel', 'stockStatus', 'isActive', 'batchCount']) assert.ok(k in m, `missing ${k}`);
    assert.equal(m.categoryName, 'Tablets');
  });
});

describe('POST / GET / PUT /api/inventory', () => {
  it('creates, reads and updates a medicine', async () => {
    const c = await T.client.post('/inventory', { medicineName: 'Theta CRUD', genericName: 'Thetamol', manufacturer: 'Crud Co', categoryName: 'Tablets', reorderLevel: 5, gstPercentage: 5 });
    assert.equal(c.status, 201);
    const g = await T.client.get(`/inventory/${c.data._id}`);
    assert.equal(g.status, 200);
    assert.equal(g.data.medicineName, 'Theta CRUD');
    assert.equal(g.data.categoryName, 'Tablets');
    assert.equal(g.data.stockStatus, 'out_of_stock');
    const u = await T.client.put(`/inventory/${c.data._id}`, { medicineName: 'Theta CRUD v2', genericName: 'Thetamol', manufacturer: 'Crud Co', categoryName: 'Syrups', reorderLevel: 8, gstPercentage: 12 });
    assert.equal(u.status, 200);
    const again = (await T.client.get(`/inventory/${c.data._id}`)).data;
    assert.deepEqual([again.medicineName, again.categoryName, again.reorderLevel, again.gstPercentage], ['Theta CRUD v2', 'Syrups', 8, 12]);
  });

  it('/api/medicines is the same API under its older name', async () => {
    const a = await list(T.client, 'limit=100');
    const b = (await T.client.get('/medicines?limit=100')).data;
    assert.deepEqual(names(a), names(b));
  });

  it('GET /api/inventory/:id returns 404 for unknown and malformed ids', async () => {
    assert.equal((await T.client.get(`/inventory/${new h.mongoose.Types.ObjectId()}`)).status, 404);
    assert.equal((await T.client.get('/inventory/not-an-id')).status, 400);
  });
});

describe('DELETE /api/inventory/:id — soft delete', () => {
  it('archives a medicine that has history, hides it from the default list, and keeps every record', async () => {
    const m = await create(T.client, { medicineName: 'Iota Archive' }, [{ batchNumber: 'I1', initialQuantity: 10 }]);
    await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 2 }] });
    const del = await T.client.del(`/inventory/${m._id}`);
    assert.deepEqual(del.data, { deleted: false, archived: true });

    assert.ok(!names(await list(T.client, 'limit=100')).includes('Iota Archive'), 'hidden by default');
    assert.deepEqual(names(await list(T.client, 'archived=only&search=Iota')), ['Iota Archive']);
    assert.ok(names(await list(T.client, 'archived=include&limit=100')).includes('Iota Archive'));

    const kept = (await T.client.get(`/inventory/${m._id}`)).data;
    assert.equal(kept.isActive, false);
    assert.equal(kept.batches[0].availableQuantity, 8, 'stock history intact');
    assert.equal((await T.client.get('/invoices')).data.items.length > 0, true, 'invoices untouched');
    assert.equal((await T.client.get('/stock/reconciliation')).data.consistent, true);
  });

  it('an archived medicine cannot be sold; deleting it again is harmless', async () => {
    const m = await create(T.client, { medicineName: 'Kappa Archive' }, [{ batchNumber: 'K1', initialQuantity: 10 }]);
    await T.client.del(`/inventory/${m._id}`);
    assert.equal((await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 1 }] })).status, 409);
    assert.deepEqual((await T.client.del(`/inventory/${m._id}`)).data, { deleted: false, archived: true });
  });

  it('can be restored', async () => {
    const m = await create(T.client, { medicineName: 'Lambda Restore' }, [{ batchNumber: 'L1', initialQuantity: 10 }]);
    await T.client.del(`/inventory/${m._id}`);
    const r = await T.client.post(`/inventory/${m._id}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.data.isActive, true);
    assert.ok(names(await list(T.client, 'search=Lambda')).includes('Lambda Restore'));
    assert.equal((await T.client.post('/invoices', { items: [{ medicineId: m._id, quantity: 1 }] })).status, 201);
    assert.equal((await T.client.post(`/inventory/${m._id}/restore`)).body.code, 'NOT_ARCHIVED', 'it is no longer archived');
  });

  it('permanently deletes only a medicine that never had any history', async () => {
    const m = await create(T.client, { medicineName: 'Mu Never Used' });
    assert.deepEqual((await T.client.del(`/inventory/${m._id}`)).data, { deleted: true, archived: false });
    assert.equal((await T.client.get(`/inventory/${m._id}`)).status, 404);
  });

  it('archiving and restoring are audited', async () => {
    const m = await create(T.client, { medicineName: 'Nu Audited' }, [{ batchNumber: 'N1', initialQuantity: 3 }]);
    await T.client.del(`/inventory/${m._id}`);
    await T.client.post(`/inventory/${m._id}/restore`);
    const log = (await T.client.get('/activity?limit=100')).data.items.filter((e) => String(e.entityId) === m._id).map((e) => e.action);
    assert.ok(log.includes('MEDICINE_ARCHIVE') && log.includes('MEDICINE_RESTORE'));
  });

  it('is permission-protected', async () => {
    const m = await create(T.client, { medicineName: 'Xi Protected' });
    const staff = h.client();
    await staff.login((await h.makeUser(T.org, { role: 'STAFF', email: `staff-${Date.now()}@example.test` })).email);
    assert.equal((await staff.get('/inventory')).status, 200);
    assert.equal((await staff.post('/inventory', { medicineName: 'Nope' })).status, 403);
    assert.equal((await staff.put(`/inventory/${m._id}`, { medicineName: 'Nope' })).status, 403);
    assert.equal((await staff.del(`/inventory/${m._id}`)).status, 403);
    assert.equal((await staff.post(`/inventory/${m._id}/restore`)).status, 403);
  });
});

describe('Organization scoping of /api/inventory', () => {
  it('lists, reads, updates, archives and restores only the caller\'s own medicines', async () => {
    const mine = (await list(T.client, 'search=Alpha Plenty')).items[0];
    const theirs = (await list(other.client, 'search=Alpha Plenty')).items[0];
    assert.notEqual(mine._id, theirs._id);
    assert.equal(theirs.manufacturer, 'Other Maker');
    assert.deepEqual(names(await list(other.client, 'limit=100')), ['Alpha Plenty'], 'the other organization sees only its own');

    assert.equal((await other.client.get(`/inventory/${mine._id}`)).status, 404);
    assert.equal((await other.client.put(`/inventory/${mine._id}`, { medicineName: 'HIJACK' })).status, 404);
    assert.equal((await other.client.del(`/inventory/${mine._id}`)).status, 404);
    assert.equal((await other.client.post(`/inventory/${mine._id}/restore`)).status, 404);
    assert.equal((await other.client.get(`/inventory/${mine._id}/batches`)).data.length, 0, 'batch list is scoped too');
    assert.equal((await T.client.get(`/inventory/${mine._id}`)).data.medicineName, 'Alpha Plenty');
  });

  it('search and filters never reach across organizations', async () => {
    assert.deepEqual(names(await list(other.client, 'search=Zenith')), []);
    assert.deepEqual(names(await list(other.client, 'search=SKU-ALPHA')), []);
    const mineCat = (await T.client.get('/inventory/facets')).data.categories[0];
    assert.deepEqual(names(await list(other.client, `categoryId=${mineCat.id}`)), [], "another organization's category id matches nothing");
    assert.equal((await other.client.get('/inventory/facets')).data.manufacturers.join(), 'Other Maker');
  });

  it('every inventory endpoint requires authentication', async () => {
    const anon = h.client();
    for (const p of ['/inventory', '/inventory/facets', `/inventory/${new h.mongoose.Types.ObjectId()}`]) assert.equal((await anon.get(p)).status, 401, p);
    assert.equal((await anon.post('/inventory', { medicineName: 'x' })).status, 401);
  });
});

describe('A product as the Create Product form describes it', () => {
  let seq = 0;
  const uniq = (p) => `${p} ${Date.now()}-${++seq}`;

  it('keeps the company, the packing and the price defaults, and writes the pack size from the packing', async () => {
    const r = await T.client.post('/inventory', {
      medicineName: uniq('Packed Med'), unit: 'Strip', company: 'Micro Labs Marketing', gstPercentage: 12,
      packing: { outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 },
      defaultMrp: 30.5, defaultPurchasePrice: 21,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.company, 'Micro Labs Marketing');
    assert.deepEqual({ ...r.data.packing }, { outerUnit: 'Box', outerQty: 10, innerUnit: 'Strip', innerQty: 15 });
    assert.equal(r.data.packSize, '15 Strips', 'the printed pack follows the packing, so the two cannot disagree');
    assert.deepEqual([r.data.defaultMrp, r.data.defaultPurchasePrice], [30.5, 21]);
    assert.equal(r.data.taxability, 'taxable');
  });

  it('carries no GST when the product is exempt or nil rated, whatever rate was typed', async () => {
    const exempt = await T.client.post('/inventory', { medicineName: uniq('Exempt Med'), unit: 'Bottle', taxability: 'exempt', gstPercentage: 12 });
    assert.equal(exempt.status, 201, JSON.stringify(exempt.body));
    assert.equal(exempt.data.gstPercentage, 0, 'the server zeroes it, not the browser');
    assert.equal(exempt.data.taxability, 'exempt');

    const back = await T.client.put(`/inventory/${exempt.data._id}`, { medicineName: exempt.data.medicineName, unit: 'Bottle', taxability: 'taxable', gstPercentage: 5 });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.data.gstPercentage, 5, 'and it comes back when it is taxable again');
  });

  it('refuses packing that makes no sense', async () => {
    const bad = await T.client.post('/inventory', { medicineName: uniq('Bad Pack'), unit: 'Strip', packing: { outerUnit: 'Box', outerQty: 0, innerUnit: 'Strip', innerQty: 15 } });
    assert.equal(bad.status, 400);
    assert.ok((bad.body.details || []).some((d) => /outerQty/.test(d.path)), JSON.stringify(bad.body.details));
    const fraction = await T.client.post('/inventory', { medicineName: uniq('Fraction Pack'), unit: 'Strip', packing: { innerUnit: 'Strip', innerQty: 2.5 } });
    assert.equal(fraction.status, 400);
  });

  it('offers the companies already in use as suggestions', async () => {
    await T.client.post('/inventory', { medicineName: uniq('Suggest Med'), unit: 'Strip', company: 'Zed Pharma Marketing' });
    const facets = await T.client.get('/inventory/facets');
    assert.equal(facets.status, 200, JSON.stringify(facets.body));
    assert.ok(facets.data.companies.includes('Zed Pharma Marketing'));
  });
});

describe('Product photographs', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DAwMDAAAAPAAE/p1kaAAAAAElFTkSuQmCC', 'base64');
  const put = (client, body, type = 'image/png') => client.post('/inventory/images', body, { headers: { 'content-type': type } });

  it('stores a picture under a name the server chose, and gives back the address to keep on the medicine', async () => {
    const r = await put(T.client, PNG);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.data.url, /^\/api\/inventory\/images\/[a-f0-9]{24}\.png$/);
    assert.equal(r.data.mimeType, 'image/png');
    assert.equal(r.data.size, PNG.length);
    assert.equal(r.data.url.includes('..'), false);

    const got = await T.client.get(r.data.url.replace('/api', ''));
    assert.equal(got.status, 200, 'and it reads back');
  });

  it('judges the file by its contents, not by what it is called', async () => {
    const pdf = await put(T.client, Buffer.from('%PDF-1.7\n%âãÏÓ\nnot an image at all'), 'image/png');
    assert.equal(pdf.status, 415, 'a PDF renamed as a PNG is refused');
    const lying = await put(T.client, PNG, 'image/jpeg');
    assert.equal(lying.status, 400, 'a PNG labelled as a JPEG is refused');
    const wrongType = await put(T.client, PNG, 'application/pdf');
    assert.equal(wrongType.status, 415);
    assert.equal((await put(T.client, Buffer.alloc(0))).status >= 400, true, 'and so is nothing at all');
  });

  it('is never readable by another organization, and a made-up name is simply not found', async () => {
    const mine = await put(T.client, PNG);
    const other = await h.makeTenant('Image Other Org');
    assert.equal((await other.client.get(mine.data.url.replace('/api', ''))).status, 404);
    assert.equal((await T.client.get('/inventory/images/not-a-real-name.png')).status, 404);
    assert.equal((await T.client.get('/inventory/images/..%2F..%2Fsecret.png')).status, 404, 'and a path cannot be climbed');
  });

  it('needs permission to add one, while anyone who may read inventory can see it', async () => {
    const saved = await put(T.client, PNG);
    const staff = h.client();
    const u = await h.makeUser(T.org, { role: 'STAFF' }); // inventory:read only
    await staff.login(u.email);
    assert.equal((await put(staff, PNG)).status, 403);
    assert.equal((await staff.get(saved.data.url.replace('/api', ''))).status, 200);
  });

  it('keeps the address on the medicine, so the picture survives an edit', async () => {
    const saved = await put(T.client, PNG);
    const med = await T.client.post('/inventory', { medicineName: `Pictured ${Date.now()}`, unit: 'Strip', image: saved.data.url });
    assert.equal(med.status, 201, JSON.stringify(med.body));
    assert.equal(med.data.image, saved.data.url);
    const edited = await T.client.put(`/inventory/${med.data._id}`, { medicineName: med.data.medicineName, unit: 'Strip', image: saved.data.url });
    assert.equal(edited.data.image, saved.data.url);
  });
});
