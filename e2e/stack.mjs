// Starts an isolated copy of the app for browser tests: a throwaway in-memory database with demo data, and the real API on
// port 4100. It never touches the development database. (The web server on port 5200 is started by run.mjs.)
process.env.CLIENT_ORIGIN = 'http://localhost:5200,http://127.0.0.1:5200';
process.env.HARNESS_PORT = '4100';

const { startHarness, PASSWORD, futureDate } = await import('../server/tests/helpers/harness.js');

const h = await startHarness();
export const ADMIN = { email: 'admin@e2e.test', password: PASSWORD };
const T = await h.makeTenant('E2E Pharmacy', { email: ADMIN.email, name: 'Asha Verma' });
// The five built-in roles as rows, exactly as a real organization gets them when it is created.
const { ensureSystemRoles } = await import('../server/services/roles.service.js');
await h.tenant.runWithTenant(T.org._id, () => ensureSystemRoles({ orgId: T.org._id }));
const c = T.client;
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`seed failed: ${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data;
};
const day = 86400000;
// the second person (never the administrator): their credit request is what the Approvals tab reviews
export const STAFF = { email: 'staff@e2e.test', name: 'Rahul Nair' };
// A second, non-administrator account, created up front rather than lazily: the Roles & Users permission check needs
// somebody who CANNOT manage users, and a browser test should not have to seed its own person to find one.
if (!(await h.models.User.collection.findOne({ email: STAFF.email }))) {
  await h.makeUser(T.org, { role: 'STAFF', name: STAFF.name, email: STAFF.email });
}

// a 2x2 PNG: a real image, so the payment proof really loads through the authenticated endpoint
const PNG_PROOF = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4z8DAwMDAAAAPAAE/p1kaAAAAAElFTkSuQmCC', 'base64');
const iso = (d) => new Date(Date.now() + d * day).toISOString().slice(0, 10);

for (const [compoundName, composition] of [['Paracetamol 650 mg', 'Paracetamol IP 650 mg'], ['Amoxicillin 500 mg', 'Amoxicillin trihydrate'], ['Ibuprofen 400 mg', 'Ibuprofen IP 400 mg']]) must(await c.post('/compounds', { compoundName, composition }), compoundName);
must(await c.post('/attributes', { attributeName: 'Dosage forms', attributeType: 'dosage_form', values: ['Tablet', 'Capsule', 'Syrup', 'Injection'] }), 'forms');
must(await c.post('/attributes', { attributeName: 'Strengths', attributeType: 'strength', values: ['250mg', '500mg', '650mg'] }), 'strengths');
must(await c.post('/attributes', { attributeName: 'Units', attributeType: 'unit', values: ['Strip', 'Bottle', 'Box'] }), 'units');
must(await c.post('/attributes', { attributeName: 'Storage condition', attributeType: 'custom', values: ['Room temperature', 'Refrigerate'] }), 'custom');

const names = ['Dolo 650', 'Crocin Advance', 'Calpol 500', 'Azithral 500', 'Augmentin 625', 'Mox 250', 'Brufen 400', 'Combiflam', 'Pantop 40', 'Rantac 150', 'Omez 20', 'Cetzine 10', 'Allegra 120', 'Montair LC', 'Zerodol SP', 'Volini Gel', 'Betadine Ointment', 'Digene Syrup', 'Cyclopam', 'Meftal Spas', 'Glycomet 500', 'Telma 40', 'Amlodac 5', 'Ecosprin 75', 'Becosules', 'Shelcal 500', 'Liv 52', 'ORS Sachet'];
const made = [];
for (const [i, medicineName] of names.entries()) {
  const m = must(
    await c.post('/inventory', {
      medicineName,
      genericName: ['Paracetamol', 'Amoxicillin', 'Ibuprofen', 'Pantoprazole', 'Cetirizine'][i % 5],
      salt: ['Paracetamol 650 mg', 'Amoxicillin 500 mg', 'Ibuprofen 400 mg'][i % 3],
      manufacturer: ['Micro Labs', 'Cipla', 'Sun Pharma', 'Alembic', 'Mankind'][i % 5],
      categoryName: ['Tablets', 'Capsules', 'Syrups', 'Ointments'][i % 4],
      dosageForm: ['Tablet', 'Capsule', 'Syrup'][i % 3],
      strength: ['250mg', '500mg', '650mg'][i % 3],
      sku: `SKU-${String(i + 1).padStart(3, '0')}`,
      barcode: `89012345${String(i + 1).padStart(5, '0')}`,
      reorderLevel: 20,
      gstPercentage: [5, 12, 18][i % 3],
    }),
    medicineName,
  );
  made.push(m);
  const add = async (body) => must(await c.post('/batches', { medicineId: m._id, mrp: 100 + i, sellingPrice: 90 + i, purchasePrice: 60 + i, ...body }), `batch ${medicineName}`);
  if (i % 7 === 6) continue; // no batches: out of stock
  if (i % 7 === 5) await add({ batchNumber: `LOW-${i}`, expiryDate: iso(400), initialQuantity: 4 }); // low stock
  else if (i % 7 === 4) {
    await add({ batchNumber: `SOON-${i}`, expiryDate: iso(20 + (i % 3) * 25), initialQuantity: 60 }); // expiring in 20 / 45 / 70 days
    await add({ batchNumber: `LATE-${i}`, expiryDate: iso(500), initialQuantity: 80 });
  } else await add({ batchNumber: `BT${2400 + i}`, expiryDate: iso(300 + i * 10), initialQuantity: 120 + i });
}
// A couple of batches that have already expired (receiving expired stock is refused by the API, so these are written directly).
for (const idx of [2, 9, 16]) {
  await h.tenant.runWithTenant(T.org._id, async () => {
    const b = await h.models.Batch.create({ medicineId: made[idx]._id, batchNumber: `OLD-${idx}`, manufacturer: 'Cipla', expiryDate: new Date(Date.now() - 10 * day), mrp: 50, sellingPrice: 45, purchasePrice: 30, initialQuantity: 25, availableQuantity: 25 });
    await h.models.StockMovement.create({ medicineId: made[idx]._id, batchId: b._id, type: 'PURCHASE', quantity: 25, balanceAfter: 25, reason: 'Batch received' });
  });
}
for (let k = 0; k < 4; k++) must(await c.post('/invoices', { items: [{ medicineId: made[k]._id, quantity: 2 + k }], idempotencyKey: `seed-invoice-${k}-0000` }), 'invoice');

// Stores and transfers: TRF-0001 draft, TRF-0002 in transit, TRF-0003 completed, TRF-0004 approved (waiting to be dispatched)
const stores = must(await c.get('/branches'), 'stores');
const mainStore = stores.find((s) => s.isDefault);
const north = must(await c.post('/branches', { name: 'North Branch Store', code: 'NORTH', address: '12 North Road' }), 'north store');
const lot = async (search) => must(await c.get(`/batches?search=${search}&limit=1`), 'batch').items[0];
const draftOf = async (batchNo, qty) => must(await c.post('/transfers', { fromBranchId: mainStore._id, toBranchId: north._id, transferDate: iso(0), notes: '', items: [{ batchId: (await lot(batchNo))._id, quantity: qty }] }), 'transfer');
await draftOf('BT2400', 10);
const t2 = await draftOf('BT2401', 8);
must(await c.post(`/transfers/${t2._id}/submit`), 'submit');
must(await c.post(`/transfers/${t2._id}/dispatch`), 'dispatch');
const t3 = await draftOf('BT2402', 6);
must(await c.post(`/transfers/${t3._id}/submit`), 'submit');
must(await c.post(`/transfers/${t3._id}/dispatch`), 'dispatch');
must(await c.post(`/transfers/${t3._id}/receive`), 'receive');
const t4 = await draftOf('BT2403', 4); // approved, waiting to be dispatched
must(await c.post(`/transfers/${t4._id}/submit`), 'submit');

// Sales returns (the page only reads them for now): two completed, one refunded, one pending approval, one refund pending, one rejected.
await h.tenant.runWithTenant(T.org._id, async () => {
  const oid = () => new h.models.Batch.base.Types.ObjectId();
  const ln = (name, quantity, price, restocked, condition = 'good') => ({ medicineId: oid(), batchId: oid(), name, batchNo: 'BT2401', quantity, price, amount: Math.round(quantity * price * 100) / 100, condition, restock: restocked > 0, verified: restocked > 0, restockedQuantity: restocked });
  const rows = [
    ['completed', 'damaged', 'Meera Nair', '9811122233', [ln('Dolo 650', 3, 30, 3)], 0],
    ['refunded', 'expired', 'Ravi Kumar', '9822233344', [ln('Calpol 500', 2, 45.5, 2), ln('Crocin Advance', 1, 22, 0, 'damaged')], 1],
    ['completed', 'wrong_product', 'Asha Verma', '', [ln('Azithral 500', 1, 118, 1)], 2],
    ['pending', 'changed_mind', 'Imran Shaikh', '9833344455', [ln('Cetzine', 2, 20.05, 0)], 3],
    ['refund_pending', 'incorrect_quantity', 'Walk-in Customer', '', [ln('Pan 40', 4, 15.5, 0)], 4],
    ['rejected', 'other', 'Walk-in Customer', '', [ln('Zyrtec', 1, 30, 0)], 5],
  ];
  const invoices = await h.models.Invoice.find({}).sort({ createdAt: 1 }).lean(); // the seeded sales: returns refer to real invoices
  let n = 0;
  for (const [status, reason, name, phone, items, daysAgo] of rows) {
    n += 1;
    const inv = invoices[(n - 1) % invoices.length];
    await h.models.SalesReturn.create({
      returnNo: `SR-${String(n).padStart(4, '0')}`, invoiceId: inv._id, invoiceNo: inv.invoiceNo, customer: { name, phone },
      items, returnValue: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100, refundAmount: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100, refund: { method: 'Cash', status: ['refunded', 'completed'].includes(status) ? 'completed' : 'pending' }, status, reason, notes: status === 'rejected' ? 'Strip was opened' : '',
      history: [{ action: 'CREATED', at: new Date(Date.now() - daysAgo * 86400000), byName: 'Asha Verma', newStatus: status }],
      returnDate: new Date(Date.now() - daysAgo * 86400000), ...(['refunded', 'completed'].includes(status) && { processedAt: new Date() }),
    });
  }
  await h.models.Counter.updateOne({ organizationId: T.org._id, key: 'salesReturn' }, { $set: { seq: n } }, { upsert: true }); // the next real return continues after the seeded ones
});

// Suppliers for the Add Order form
must(await c.post('/suppliers', { name: 'Sun Pharma Distributors', contactPerson: 'Ramesh Gupta', phone: '9811100011', email: 'sales@sunpharma.test', gstin: '27ABCDE1234F1Z5', address: { line1: '12 Market Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' }, procurement: { paymentTerms: 'net30', minimumOrderValue: 1000 } }), 'supplier');
must(await c.post('/suppliers', { name: 'Cipla Wholesale', contactPerson: 'Neha Shah', phone: '9811100012' }), 'supplier');

// Supplier orders (the page only reads them for now): 13 orders so the list has a second page.
await h.tenant.runWithTenant(T.org._id, async () => {
  const line = (m, quantity, receivedQuantity = 0) => ({ medicineId: m._id, name: m.medicineName, unit: 'Strip', quantity, receivedQuantity });
  const suppliers = ['Sun Pharma Distributors', 'Cipla Wholesale', 'Zydus Traders', 'Mankind Stockists', 'Alkem Supplies'];
  const statuses = ['ordered', 'received', 'partially_received', 'draft', 'cancelled'];
  for (let i = 0; i < 13; i += 1) {
    const items = [line(made[i % made.length], 100 + i, i % 5 === 1 ? 100 + i : i % 5 === 2 ? 40 : 0), ...(i % 3 === 0 ? [line(made[(i + 7) % made.length], 25)] : [])];
    await h.models.Order.create({
      orderNo: `ORD-${String(i + 1).padStart(4, '0')}`, supplier: { name: suppliers[i % suppliers.length], phone: '98111000' + String(10 + i) },
      items, status: statuses[i % statuses.length], orderDate: new Date(Date.now() - i * 86400000), /* the open ones are late: */ expectedDate: ['ordered', 'partially_received'].includes(statuses[i % statuses.length]) ? new Date(Date.now() - (i + 2) * 86400000) : undefined, notes: i === 0 ? 'Urgent: stock for the weekend' : undefined,
    });
  }
  await h.models.Counter.updateOne({ organizationId: T.org._id, key: 'order' }, { $set: { seq: 13 } }, { upsert: true }); // the next real order continues after the seeded ones
});

// A stand-in for an invoice-reading service, and a small switch the browser tests use to connect or disconnect it
// (AI_BILLING_URL is read on every request, so flipping it takes effect at once). Off by default: "not connected" is the normal state.
const http = await import('node:http');
let failing = false;
const fakeReader = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (failing) {
      res.statusCode = 500;
      return res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      supplier: { name: 'Sun Pharma Distributors', gstin: '27ABCDE1234F1Z5', address: '12 Market Road, Pune' }, invoiceNo: 'SP/2026/771', invoiceDate: '2026-11-05', confidence: 0.9,
      items: [
        { name: 'Dolo 650', manufacturer: 'Micro Labs', batchNumber: 'DL-4412', manufacturingDate: '2026-08-01', expiryDate: '2028-07-31', quantity: 100, freeQuantity: 10, rate: 25, mrp: 32, discountPercent: 0, gstPercent: 12, confidence: 0.98 },
        { name: 'Crocin Advnce', quantity: 20, rate: 30, gstPercent: 12, confidence: 0.91 },
        { name: 'Mystery Tonic Forte', quantity: 5, rate: 99.5, gstPercent: 5, confidence: 0.6 },
      ],
      totals: { grandTotal: 3544.4, cgst: 10, sgst: 10 },
    }));
  });
});
await new Promise((r) => fakeReader.listen(4101, '127.0.0.1', r));
// A stand-in for Google Document AI (its sign-in endpoint and the processor's :process method), switched by /ocr/on|fail|off like the reader above.
const { generateKeyPairSync } = await import('node:crypto');
const fsx = await import('node:fs');
const osx = await import('node:os');
const pathx = await import('node:path');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPath = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'usha-e2e-key-')), 'service-account.json');
fsx.writeFileSync(keyPath, JSON.stringify({ type: 'service_account', client_email: 'e2e@test.iam.gserviceaccount.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'http://127.0.0.1:4103/token' }));
let googleFails = false;
const googleDoc = () => {
  let text = '';
  const anchor = (t) => {
    const startIndex = text.length;
    text += `${t}\n`;
    return { textSegments: [{ startIndex: String(startIndex), endIndex: String(text.length) }] };
  };
  const line = (t, confidence = 0.98) => ({ layout: { textAnchor: anchor(t), confidence, boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.12 }, { x: 0.1, y: 0.12 }] } } });
  const row = (cells) => ({ cells: cells.map((c) => ({ layout: { textAnchor: anchor(c), confidence: 0.97 } })) });
  const pages = [
    {
      pageNumber: 1, dimension: { width: 595, height: 842, unit: 'pixels' }, layout: { orientation: 'PAGE_UP' },
      lines: [line('SUN PHARMA DISTRIBUTORS'), line('Invoice No: SP/2026/771'), line('Date: 05/11/2026')],
      tables: [{ layout: { confidence: 0.95 }, headerRows: [row(['Medicine', 'Batch', 'Qty', 'Rate'])], bodyRows: [row(['Dolo 650', 'DL-4412', '100', '25.00']), row(['Crocin Advance', 'CR-77', '20', '30.00'])] }],
    },
    { pageNumber: 2, dimension: { width: 595, height: 842, unit: 'pixels' }, layout: { orientation: 'PAGE_RIGHT' }, lines: [line('Terms: payment within 30 days'), line('Faint stamp text', 0.4)], tables: [] },
  ];
  const entity = (type, mentionText, extra = {}) => ({ type, mentionText, confidence: 0.93, ...extra });
  return { text, pages, entities: [entity('supplier_name', 'Sun Pharma Distributors'), entity('invoice_id', 'SP/2026/771'), entity('invoice_date', '05/11/2026', { normalizedValue: { text: '2026-11-05' } })] };
};
const fakeGoogle = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'e2e-token', expires_in: 3600 }));
    if (googleFails) {
      res.statusCode = 503;
      return res.end('{}');
    }
    return setTimeout(() => res.end(JSON.stringify({ document: googleDoc() })), 600); // slow enough for the browser tests to see "Processing"
  });
});
await new Promise((r) => fakeGoogle.listen(4103, '127.0.0.1', r));
const ocrEnv = { GOOGLE_CLOUD_PROJECT_ID: 'e2e-project', GOOGLE_DOCUMENT_AI_LOCATION: 'us', GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'e2e-processor', GOOGLE_APPLICATION_CREDENTIALS: keyPath, GOOGLE_DOCUMENT_AI_ENDPOINT: 'http://127.0.0.1:4103', GOOGLE_DOCUMENT_AI_IMAGE_QUALITY: 'true' };
// A stand-in for the AI model (Gemini's generateContent), switched by /llm/on|fail|off. It answers from the OCR text above, with ONE deliberately
// invented batch number ("CR-99": the document says CR-77) so the browser tests can see it flagged.
let llmFails = false;
let llmRows = 'default';
const fakeLlm = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (llmFails) {
      res.statusCode = 500;
      return setTimeout(() => res.end('{}'), 600); // a failure takes as long as an answer, so the progress shows
    }
    const item = (o) => ({ description: null, manufacturer: null, brand: null, strength: null, dosageForm: null, hsnCode: null, manufacturingDate: null, expiryDate: null, packSize: null, unit: null, freeQuantity: null, receivedQuantity: null, mrp: null, discountPercentage: null, discountAmount: null, taxableAmount: null, gstPercentage: null, cgst: null, sgst: null, igst: null, lineTotal: null, page: 1, ...o });
    const matchRows = [
      item({ medicineName: 'PCM 500 TAB', manufacturer: 'Micro Labs', batchNumber: 'PM-1', expiryDate: '2028-09-30', quantity: 50, purchaseRate: 18, sourceText: 'PCM 500 TAB PM-1 50 18.00' }),
      item({ medicineName: 'Paracetamol 250mg Capsule', batchNumber: 'PM-2', expiryDate: '2028-09-30', quantity: 10, purchaseRate: 12, sourceText: 'Paracetamol 250mg Capsule PM-2 10 12.00' }),
      item({ medicineName: 'Azithromycin 500mg Tablet', manufacturer: 'Alkem', batchNumber: 'PM-3', expiryDate: '2028-09-30', quantity: 5, purchaseRate: 80, sourceText: 'Azithromycin 500mg Tablet PM-3 5 80.00' }),
    ];
    const receiveRows = [
      item({ medicineName: 'Paracetamol 500mg Tablet', manufacturer: 'Micro Labs', batchNumber: 'RC-1', expiryDate: '2029-09-30', quantity: 50, purchaseRate: 18, mrp: 30, gstPercentage: 12, sourceText: 'Paracetamol 500mg Tablet RC-1 50 18.00' }),
      item({ medicineName: 'Azithromycin 500mg Tablet', manufacturer: 'Cipla', batchNumber: 'RC-2', expiryDate: '2029-09-30', quantity: 5, purchaseRate: 80, mrp: 100, gstPercentage: 12, sourceText: 'Azithromycin 500mg Tablet RC-2 5 80.00' }),
    ];
    const invoice = {
      supplier: { name: 'Sun Pharma Distributors', gstin: null, address: null, phone: null, email: null, state: null, stateCode: null },
      invoice: { invoiceNumber: llmRows === 'receive' ? 'RC/2026/001' : llmRows === 'match' ? 'MT/2026/301' : 'AI/2026/101', invoiceDate: '2026-11-05', dueDate: null, purchaseOrderNumber: null, deliveryChallanNumber: null, placeOfSupply: null, paymentTerms: null, currency: null, invoiceType: null },
      items: llmRows === 'match' ? matchRows : llmRows === 'receive' ? receiveRows : [
        item({ medicineName: 'Dolo 650', batchNumber: 'DL-4412', quantity: 100, purchaseRate: 25, sourceText: 'Dolo 650 DL-4412 100 25.00' }),
        item({ medicineName: 'Crocin Advance', batchNumber: 'CR-99', quantity: 20, purchaseRate: 30, sourceText: 'Crocin Advance CR-77 20 30.00' }),
      ],
      totals: { subtotal: null, discount: null, taxableAmount: null, cgst: null, sgst: null, igst: null, otherCharges: null, shippingCharges: null, packagingCharges: null, roundOff: null, grandTotal: null, amountInWords: null, amountPaid: null, balanceDue: null },
      warnings: [],
    };
    res.setHeader('content-type', 'application/json');
    return setTimeout(() => res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(invoice) }] }, finishReason: 'STOP' }], modelVersion: 'gemini-e2e' })), 600);
  });
});
await new Promise((r) => fakeLlm.listen(4104, '127.0.0.1', r));
const llmEnv = { AI_EXTRACTION_PROVIDER: 'gemini', GEMINI_API_KEY: 'e2e-key', GEMINI_ENDPOINT: 'http://127.0.0.1:4104' };
const control = http.createServer(async (req, res) => {
  if (req.url === '/ai/on') {
    process.env.AI_BILLING_URL = 'http://127.0.0.1:4101/read';
    failing = false;
  }
  if (req.url === '/ai/fail') {
    process.env.AI_BILLING_URL = 'http://127.0.0.1:4101/read';
    failing = true;
  }
  if (req.url === '/ai/off') delete process.env.AI_BILLING_URL;
  if (req.url === '/ocr/on' || req.url === '/ocr/fail') {
    Object.assign(process.env, ocrEnv);
    googleFails = req.url === '/ocr/fail';
  }
  if (req.url === '/llm/on' || req.url === '/llm/fail' || req.url === '/llm/match' || req.url === '/llm/receive') {
    Object.assign(process.env, llmEnv);
    llmFails = req.url === '/llm/fail';
    llmRows = req.url === '/llm/match' ? 'match' : req.url === '/llm/receive' ? 'receive' : 'default';
  }
  if (req.url === '/seed/products/on' || req.url === '/seed/products/off') {
    // the test products go, and so does whatever the browser tests received into them (so no batch is left pointing at a product that no longer exists);
    // "on" starts from a clean slate, so a test that failed before cleaning up cannot leave duplicates behind
    const ids = (await h.models.Medicine.collection.find({ description: 'e2e-matching' }).project({ _id: 1 }).toArray()).map((m) => m._id);
    await h.models.Batch.collection.deleteMany({ medicineId: { $in: ids } });
    await h.models.StockMovement.collection.deleteMany({ medicineId: { $in: ids } });
    await h.models.Medicine.collection.deleteMany({ description: 'e2e-matching' });
  }
  if (req.url === '/seed/products/on') {
    const now = new Date();
    const base = { organizationId: T.org._id, unit: 'Strip', gstPercentage: 12, isActive: true, image: '', attributes: [], reorderLevel: 10, barcode: '', sku: '', description: 'e2e-matching', createdAt: now, updatedAt: now };
    await h.models.Medicine.collection.insertMany([
      { ...base, medicineName: 'Paracetamol 500mg Tablet', genericName: 'Paracetamol', strength: '500mg', dosageForm: 'Tablet', manufacturer: 'Micro Labs Ltd', packSize: '10s', hsnCode: '3004' },
      { ...base, medicineName: 'Paracetamol 650mg Tablet', genericName: 'Paracetamol', strength: '650mg', dosageForm: 'Tablet', manufacturer: 'Micro Labs Ltd', packSize: '15s', hsnCode: '3004' },
      { ...base, medicineName: 'Azithromycin 500mg Tablet', genericName: 'Azithromycin', strength: '500mg', dosageForm: 'Tablet', manufacturer: 'Cipla Ltd', packSize: '3s', hsnCode: '3004' },
    ]);
  }
  // a pending credit request from ANOTHER person, with a real stored screenshot, so the administrator in the browser has something to approve
  if (req.url === '/seed/credit-request/on') {
    await h.models.CreditRequest.collection.deleteMany({ organizationId: T.org._id, userEmail: STAFF.email }); // start from a clean slate every time
    const staff = (await h.models.User.collection.findOne({ email: STAFF.email })) || (await h.makeUser(T.org, { role: 'STAFF', name: STAFF.name, email: STAFF.email })).toObject();
    const sc = h.client();
    await sc.login(STAFF.email);
    const made = await sc.post('/credits/requests?amount=2500&fileName=upi-payment.png', PNG_PROOF, { headers: { 'content-type': 'image/png', 'idempotency-key': `e2e-credit-${Date.now()}` } });
    if (made.status >= 300) throw new Error(`seed failed: credit request: ${made.status} ${JSON.stringify(made.body)}`);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ requestNo: made.data.requestNo, userName: staff.name, userId: String(staff._id) }));
  }
  // a medicine of its own for the Selling Point test, so selling it never disturbs the figures the other tests assert
  if (req.url === '/seed/pos/on') {
    const name = 'POS Paracetamol Syrup';
    let med = (await c.get(`/inventory?search=${encodeURIComponent(name)}`)).data.items.find((m) => m.medicineName === name);
    if (!med) med = must(await c.post('/inventory', { medicineName: name, genericName: 'Paracetamol', unit: 'Bottle', gstPercentage: 12, reorderLevel: 0, categoryName: 'Syrups' }), 'pos medicine');
    const batches = (await c.get(`/batches?medicineId=${med._id}&limit=50`)).data.items;
    const stock = batches.reduce((n, b) => n + b.availableQuantity, 0);
    if (stock < 10) must(await c.post('/batches', { medicineId: med._id, batchNumber: `POS-${Date.now()}`, expiryDate: iso(400), mrp: 150, sellingPrice: 112, initialQuantity: 50 }), 'pos batch');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ name, medicineId: String(med._id) }));
  }
  if (req.url === '/llm/off') for (const k of Object.keys(llmEnv)) delete process.env[k];
  if (req.url === '/ocr/off') for (const k of Object.keys(ocrEnv)) delete process.env[k];
  res.end('ok');
});
await new Promise((r) => control.listen(4102, '127.0.0.1', r));

console.log(`READY http://127.0.0.1:4100/api  login ${ADMIN.email}`);
process.on('SIGTERM', async () => {
  await h.stop();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await h.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
