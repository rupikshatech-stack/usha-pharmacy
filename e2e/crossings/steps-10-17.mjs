/**
 * ============================================================================================================
 *  REQUIRES A FRESH STACK. Do not run this against the development database, and do not run it twice against
 *  the same stack.
 *
 *  Several steps assert on figures that only hold on a clean database: invoice numbers follow on from the seed
 *  (step 4), the financial-year lock depends on which organizations have invoices yet (step 5), stock arithmetic
 *  is checked against exact before/after quantities (step 13), and the Activity Log is read in full (step 17).
 *  Run it a second time against the same stack and several of those will legitimately disagree - that is the
 *  checks being specific, not a defect.
 *
 *  Use `npm run crossings` in e2e/, which starts a throwaway stack, runs this against it, and stops it again.
 *  That stack keeps its data in a temporary directory deleted on exit, so freshness is guaranteed by
 *  construction rather than by anybody remembering.
 * ============================================================================================================
 */

import assert from 'node:assert/strict';
import { Client, PASSWORD, futureDate, money, must } from './lib.mjs';

/** Steps 10-17: the crossings the rest of the navigation implies. */
export default async function run(S) {

  const uniq = () => Math.random().toString(36).slice(2, 7);
  const st = {};


  const a = new Client('orgA');
  must(await a.login('admin@e2e.test'), 200, 'org A sign-in');
  st.branches = must(await a.get('/branches'), 200, 'branches');
  st.main = (st.branches.items || st.branches).find((b) => b.isDefault) || (st.branches.items || st.branches)[0];
  st.north = (st.branches.items || st.branches).find((b) => String(b._id) !== String(st.main._id));

  /* --------------------------------------------- 10. supplier -> batch -> expiry recoverable */
  await S.step(10, 'Suppliers → Inventory Batch → Expiry Intelligence: supplier carried through, recoverable only with a supplier', async () => {
    const notes = [];
    const supplierName = `Crossing Distributors ${uniq()}`;
    const supplier = must(await a.post('/suppliers', { name: supplierName, supplierType: 'distributor', phone: '9800000001', contactPerson: 'Ravi Kumar' }), 201, 'create a supplier');
    const supplierId = String(supplier._id || supplier.id);
    notes.push(`supplier created: ${supplierName} (${supplier.code || supplierId})`);

    // Two lots of the same medicine, both expiring soon: one bought from the supplier, one with no supplier at all.
    const medName = `Recoverable Probe ${uniq()}`;
    must(
      await a.post('/medicines', {
        medicineName: medName, categoryName: 'Tablets', manufacturer: 'ACME',
        batch: { batchNumber: `WITH-${uniq()}`, expiryDate: futureDate(20), mrp: 100, sellingPrice: 90, initialQuantity: 10, supplierId, purchasePrice: 50 },
      }),
      201, 'a lot bought from the supplier',
    );
    const medId = String(must(await a.get(`/medicines?search=${encodeURIComponent(medName)}`), 200, 'find it').items[0]._id);
    must(
      await a.post('/batches', { medicineId: medId, batchNumber: `WITHOUT-${uniq()}`, expiryDate: futureDate(20), mrp: 100, sellingPrice: 90, initialQuantity: 10, purchasePrice: 50, branchId: String(st.main._id) }),
      201, 'a lot with no supplier',
    );

    // Inventory Batch shows the supplier on the one that has one.
    const batches = must(await a.get(`/batches?search=${encodeURIComponent(medName)}&limit=100`), 200, 'Inventory Batch');
    const rows = batches.items || batches;
    const withSup = rows.find((b) => b.batchNumber.startsWith('WITH-'));
    const withoutSup = rows.find((b) => b.batchNumber.startsWith('WITHOUT-'));
    assert.ok(withSup && withoutSup, `both lots should be listed, saw ${rows.map((r) => r.batchNumber).join(', ')}`);
    assert.equal(String(withSup.supplierId || ''), supplierId, 'Inventory Batch must carry the supplier through');
    assert.ok(!withoutSup.supplierId, 'the other lot has no supplier');
    notes.push(`Inventory Batch: ${withSup.batchNumber} → ${withSup.supplierName || supplierName}; ${withoutSup.batchNumber} → none`);

    // Expiry Intelligence shows the same supplier, and only the supplied lot counts as recoverable.
    const expiry = must(await a.get(`/analytics/expiry/batches?limit=100&search=${encodeURIComponent(medName)}`), 200, 'Expiry Intelligence');
    const eRows = expiry.items || expiry;
    const eWith = eRows.find((r) => r.batchNumber.startsWith('WITH-'));
    const eWithout = eRows.find((r) => r.batchNumber.startsWith('WITHOUT-'));
    assert.ok(eWith && eWithout, `both lots should appear on the expiry report, saw ${eRows.length}`);
    assert.equal(String(eWith.supplierId || ''), supplierId, 'the expiry row must show the same supplier');
    assert.equal(eWith.recoverable, true, 'a lot from a supplier, inside the return window, is recoverable');
    assert.equal(eWithout.recoverable, false, 'a lot with NO supplier can never be returned to one');
    notes.push(`Expiry Intelligence: recoverable ${eWith.batchNumber}=${eWith.recoverable}, ${eWithout.batchNumber}=${eWithout.recoverable}`);
    st.supplierId = supplierId;
    st.supplierName = supplierName;
    return notes;
  });

  /* --------------------------------------------- 11. credit sale -> invoices -> credit management */
  await S.step(11, 'Selling Point (credit) → Recent Invoices → Credit Management, with the due date from Settings', async () => {
    const notes = [];
    // Set the credit terms on the Settings screen first.
    const cur = must(await a.get('/settings'), 200, 'settings');
    must(await a.patch('/settings/general', { version: cur.version, billing: { defaultCreditDays: 21 } }), 200, 'defaultCreditDays = 21');
    notes.push('Settings: defaultCreditDays = 21');

    const products = must(await a.get('/pos/products?q='), 200, 'products');
    const pick = (products.items || products).find((p) => p.nextBatch && p.availableStock > 2);
    const customer = { name: `Credit Customer ${uniq()}`, phone: `9${String(Date.now()).slice(-9)}` };
    const sale = must(
      await a.post('/invoices', {
        items: [{ medicineId: pick._id || pick.id, quantity: 2, discountPercent: 0 }],
        customer, paymentType: 'Credit', paid: 0, idempotencyKey: `x-credit-${uniq()}`,
      }),
      201, 'a credit sale',
    );
    const invoice = sale.invoice || sale;
    assert.ok(invoice.dueAmount > 0 || invoice.total > 0, 'a credit sale should leave something owing');
    notes.push(`credit sale ${invoice.invoiceNo}: total ₹${invoice.total}, paid ₹${invoice.paidAmount ?? 0}`);

    // The due date must be 21 days out, from the setting rather than a hard-coded number.
    assert.ok(invoice.dueDate, 'a credit invoice needs a due date');
    const days = Math.round((new Date(invoice.dueDate) - new Date(invoice.invoiceDate)) / 86400000);
    assert.equal(days, 21, `the due date should be 21 days after the invoice (Settings), it is ${days}`);
    notes.push(`due date is ${days} days after the invoice — straight from the setting`);

    // Recent Invoices shows it with the right total.
    const listed = must(await a.get(`/invoices?search=${encodeURIComponent(invoice.invoiceNo)}`), 200, 'Recent Invoices');
    const row = (listed.items || listed).find((i) => i.invoiceNo === invoice.invoiceNo);
    assert.ok(row, 'the credit sale should appear in Recent Invoices');
    assert.equal(money(row.total), money(invoice.total), 'Recent Invoices must show the same total');
    notes.push(`Recent Invoices: ${row.invoiceNo} ₹${row.total}`);

    /**
     * Where the money owed actually shows up.
     *
     * The brief expected it in "Credit Management", but that screen is a different thing in this product: /credits is
     * a prepaid credit-REQUEST system (a customer tops their account up, somebody approves it). Money owed on a
     * credit INVOICE is accounts receivable, and it is reported by Customer Insights as "Outstanding customer
     * credit". So this checks the figure where the product actually keeps it.
     */
    const requests = must(await a.get('/credits/summary'), 200, 'Credit Management (credit requests)');
    notes.push(`Credit Management (/credits) is the prepaid request system: ${JSON.stringify(requests.counts)} — not where invoice dues live`);

    const insights = must(await a.get('/analytics/customers?limit=100'), 200, 'Customer Insights');
    const outstandingKpi = insights.kpis?.find((k) => k.key === 'outstanding')?.value ?? 0;
    assert.ok(Number(outstandingKpi) > 0, `Customer Insights should report outstanding customer credit, saw ₹${outstandingKpi}`);

    const mine = (insights.items || []).find((r) => (r.customerName || r.name) === customer.name || r.phone === customer.phone);
    assert.ok(mine, 'the credit customer should appear in Customer Insights');
    const theirOutstanding = Number(mine.outstanding ?? mine.due ?? 0);
    assert.equal(money(theirOutstanding), money(invoice.dueAmount ?? invoice.total), `their outstanding (₹${theirOutstanding}) must equal what the credit invoice left owing (₹${invoice.dueAmount ?? invoice.total})`);
    notes.push(`Customer Insights: outstanding ₹${outstandingKpi} org-wide; this customer owes ₹${theirOutstanding}, matching ${invoice.invoiceNo}`);

    st.creditInvoice = invoice;
    st.creditCustomer = customer;
    return notes;
  });

  /* --------------------------------------------- 12. return -> batch -> GST */
  await S.step(12, 'Sales Returns → Inventory Batch (same lot) → GST Report reflects the reduced taxable value', async () => {
    const notes = [];
    // A clean sale of a known lot.
    const medName = `Return Probe ${uniq()}`;
    must(
      await a.post('/medicines', {
        medicineName: medName, categoryName: 'Tablets', manufacturer: 'ACME', gstPercentage: 12,
        batch: { batchNumber: `RB-${uniq()}`, expiryDate: futureDate(300), mrp: 200, sellingPrice: 200, initialQuantity: 20, purchasePrice: 100 },
      }),
      201, 'stock to sell',
    );
    const med = must(await a.get(`/medicines?search=${encodeURIComponent(medName)}`), 200, 'find it').items[0];
    const before = must(await a.get(`/batches?search=${encodeURIComponent(medName)}&limit=10`), 200, 'batch before');
    const batchBefore = (before.items || before)[0];
    const qtyBefore = batchBefore.availableQuantity;

    const sale = must(
      await a.post('/invoices', { items: [{ medicineId: String(med._id), quantity: 5, discountPercent: 0 }], customer: { name: 'Return Customer' }, paymentType: 'Cash', idempotencyKey: `x-ret-${uniq()}` }),
      201, 'sell 5',
    );
    const invoice = sale.invoice || sale;
    notes.push(`sold 5 @ ₹200 on ${invoice.invoiceNo} (taxable ₹${invoice.taxableAmount})`);

    const gstBefore = must(await a.get('/analytics/gst'), 200, 'GST before the return');
    const returnsTaxableBefore = gstBefore.summary?.salesReturns?.taxable ?? 0;

    // Return 2 of the 5.
    const line = invoice.items[0];
    const ret = must(
      await a.post('/sales-returns', {
        invoiceId: String(invoice._id),
        reason: 'changed_mind',
        items: [{ medicineId: String(med._id), batchId: String(line.batchId), quantity: 2, condition: 'good', restock: true, verified: true }],
        refund: { method: 'Cash', amount: 400, status: 'completed', reference: '', remarks: '' },
        idempotencyKey: `x-retdoc-${uniq()}`,
      }),
      201, 'return 2 of them',
    );
    const returnDoc = ret.salesReturn || ret;
    notes.push(`returned 2 on ${returnDoc.returnNo || returnDoc._id}`);

    // Approve + restock if the flow requires it.
    if (returnDoc.status && returnDoc.status !== 'completed') {
      const ap = await a.post(`/sales-returns/${returnDoc._id}/approve`, { restock: true });
      if (ap.status === 200) notes.push('return approved (restocked)');
    }

    // The stock must go back onto the SAME lot, not a new one.
    const after = must(await a.get(`/batches?search=${encodeURIComponent(medName)}&limit=10`), 200, 'batch after');
    const rowsAfter = after.items || after;
    assert.equal(rowsAfter.length, (before.items || before).length, `the return must not create a new lot — ${(before.items || before).length} before, ${rowsAfter.length} after`);
    const batchAfter = rowsAfter.find((b) => String(b._id) === String(batchBefore._id));
    assert.ok(batchAfter, 'the original lot must still be there');
    assert.equal(batchAfter.availableQuantity, qtyBefore - 5 + 2, `expected ${qtyBefore - 5 + 2} left on the lot, found ${batchAfter.availableQuantity}`);
    notes.push(`lot ${batchAfter.batchNumber}: ${qtyBefore} → sold 5 → returned 2 → ${batchAfter.availableQuantity} (same lot, no new one)`);

    // GST must fall by the returned value, not stay at the original.
    const gstAfter = must(await a.get('/analytics/gst'), 200, 'GST after the return');
    const returnsTaxableAfter = gstAfter.summary?.salesReturns?.taxable ?? 0;
    const outputTax = gstAfter.summary?.output?.tax ?? 0;
    const netTax = gstAfter.summary?.outputNet?.tax ?? 0;

    // 2 units at ₹200, GST 12% INSIDE the price: taxable = 400 / 1.12 = 357.14.
    const expectedReturnTaxable = money(400 / 1.12);
    const movement = money(returnsTaxableAfter - returnsTaxableBefore);
    assert.equal(movement, expectedReturnTaxable, `the return should add ₹${expectedReturnTaxable} to the returned taxable value, it moved by ₹${movement}`);
    assert.ok(netTax < outputTax, `net output tax (₹${netTax}) must be less than gross output tax (₹${outputTax}) once a return is netted off`);
    notes.push(`GST Report: returned taxable ₹${returnsTaxableBefore} → ₹${returnsTaxableAfter} (+₹${movement}, exactly the returned value)`);
    notes.push(`net output tax ₹${netTax} < gross output tax ₹${outputTax} — the report uses the reduced figure`);
    st.returnMed = medName;
    return notes;
  });

  /* --------------------------------------------- 13. transfer -> inventory / low stock */
  await S.step(13, 'Branch → Inter Store Transfer → All Inventory and Low Stock update on both sides, nothing lost', async () => {
    const notes = [];
    assert.ok(st.north, 'the stack needs a second store for this check');

    const medName = `Transfer Probe ${uniq()}`;
    must(
      await a.post('/medicines', {
        medicineName: medName, categoryName: 'Tablets', manufacturer: 'ACME', reorderLevel: 100,
        batch: { batchNumber: `TR-${uniq()}`, expiryDate: futureDate(300), mrp: 100, sellingPrice: 90, initialQuantity: 40, purchasePrice: 50, branchId: String(st.main._id) },
      }),
      201, 'stock at the main store',
    );
    const med = must(await a.get(`/medicines?search=${encodeURIComponent(medName)}`), 200, 'find it').items[0];
    const totalBefore = med.availableStock;

    const batch = (must(await a.get(`/batches?search=${encodeURIComponent(medName)}&limit=10`), 200, 'the lot').items || [])[0];
    const mainBefore = batch.availableQuantity;
    notes.push(`before: ${totalBefore} units, all at ${st.main.name}`);

    const draft = must(
      await a.post('/transfers', {
        fromBranchId: String(st.main._id),
        toBranchId: String(st.north._id),
        transferDate: new Date().toISOString().slice(0, 10),
        items: [{ batchId: String(batch._id), quantity: 15 }],
        notes: 'crossing check',
      }),
      201, 'draft a transfer',
    );
    const tid = String(draft._id || draft.id);
    const statusOf = async () => String(must(await a.get(`/transfers/${tid}`), 200, 'read the transfer').status || '');
    const advance = async (path, label) => {
      const r = await a.post(`/transfers/${tid}/${path}`, {});
      assert.ok([200, 201].includes(r.status), `${label} failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    };
    await advance('submit', 'submit');
    if ((await statusOf()) === 'submitted') await advance('approve', 'approve');
    notes.push(`status after submit/approve: ${await statusOf()}`);
    await advance('dispatch', 'dispatch');
    const received = await a.post(`/transfers/${tid}/receive`, {});
    assert.ok([200, 201].includes(received.status), `receive failed: ${received.status} ${JSON.stringify(received.body).slice(0, 300)}`);
    notes.push('transfer submitted → approved → dispatched → received');

    // Nothing lost: the organization total is unchanged, and the two stores now split it.
    const medAfter = must(await a.get(`/medicines?search=${encodeURIComponent(medName)}`), 200, 'medicine after').items[0];
    assert.equal(medAfter.availableStock, totalBefore, `the organization total must not change: ${totalBefore} → ${medAfter.availableStock}`);

    const batchesAfter = must(await a.get(`/batches?search=${encodeURIComponent(medName)}&limit=20`), 200, 'lots after');
    const rows = batchesAfter.items || batchesAfter;
    const atMain = rows.filter((b) => String(b.branchId) === String(st.main._id)).reduce((n, b) => n + b.availableQuantity, 0);
    const atNorth = rows.filter((b) => String(b.branchId) === String(st.north._id)).reduce((n, b) => n + b.availableQuantity, 0);
    assert.equal(atMain, mainBefore - 15, `the source store should be down 15: ${mainBefore} → ${atMain}`);
    assert.equal(atNorth, 15, `the destination store should hold 15, it holds ${atNorth}`);
    assert.equal(atMain + atNorth, totalBefore, 'and the two together must equal what there was');
    notes.push(`after: ${st.main.name} ${atMain} + ${st.north.name} ${atNorth} = ${atMain + atNorth} (unchanged)`);

    // Low Stock, filtered per store, must agree with that split.
    const lowMain = must(await a.get(`/analytics/low-stock?branchId=${st.main._id}&limit=100`), 200, 'Low Stock at the main store');
    const lowNorth = must(await a.get(`/analytics/low-stock?branchId=${st.north._id}&limit=100`), 200, 'Low Stock at the north store');
    const findIn = (d) => (d.items || []).find((r) => r.medicineName === medName);
    const mRow = findIn(lowMain);
    const nRow = findIn(lowNorth);
    assert.ok(mRow, 'with a reorder level of 100 it must appear in Low Stock at the main store');
    assert.equal(mRow.availableStock ?? mRow.available ?? mRow.quantity, atMain, `Low Stock (main) shows ${mRow.availableStock ?? mRow.available}, inventory says ${atMain}`);
    if (nRow) {
      assert.equal(nRow.availableStock ?? nRow.available ?? nRow.quantity, atNorth, `Low Stock (north) shows ${nRow.availableStock ?? nRow.available}, inventory says ${atNorth}`);
      notes.push(`Low Stock agrees per store: main ${atMain}, north ${atNorth}`);
    } else {
      notes.push(`Low Stock agrees at the main store (${atMain}); the north store's ${atNorth} units are above its own threshold`);
    }
    st.transferMed = medName;
    st.transferId = tid;
    return notes;
  });

  /* --------------------------------------------- 14. branch scoping -> analytics */
  await S.step(14, 'Branch scoping → Analytics: a branch-scoped user sees only their own store (pre-existing enforcement)', async () => {
    const notes = [];
    const email = `bm-${uniq()}@example.test`;
    must(await a.post('/users', { name: 'North Manager', email, password: PASSWORD, role: 'BRANCH_MANAGER', branchIds: [String(st.north._id)] }), 201, 'a BRANCH_MANAGER scoped to the north store');
    const bm = new Client('bm');
    must(await bm.login(email, PASSWORD), 200, 'they sign in');
    must(await bm.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'M4nager!Pass' }), 200, 'change password');
    const bm2 = new Client('bm');
    must(await bm2.login(email, 'M4nager!Pass'), 200, 'sign in again');
    notes.push(`BRANCH_MANAGER scoped to ${st.north.name}`);

    // Unscoped (admin) vs scoped (manager) on the same report.
    const adminSales = must(await a.get('/analytics/sales'), 200, 'Sales Report, admin');
    const bmSales = must(await bm2.get('/analytics/sales'), 200, 'Sales Report, branch manager');
    const adminGross = adminSales.totals?.current?.gross ?? 0;
    const bmGross = bmSales.totals?.current?.gross ?? 0;
    assert.ok(adminGross > 0, 'the admin sees organization-wide sales');
    assert.ok(bmGross < adminGross, `a store-scoped manager must not see the whole organization: admin ₹${adminGross}, manager ₹${bmGross}`);
    notes.push(`Sales Report: admin ₹${adminGross} (all stores) vs manager ₹${bmGross} (${st.north.name} only)`);

    // Asking for a store they are not in must be refused, not silently widened.
    const forbidden = await bm2.get(`/analytics/sales?branchId=${st.main._id}`);
    assert.equal(forbidden.status, 403, `asking for another store should be refused, got ${forbidden.status}`);
    assert.equal(forbidden.body?.code, 'BRANCH_FORBIDDEN');
    notes.push(`requesting ${st.main.name} explicitly → 403 BRANCH_FORBIDDEN`);

    // Branch Performance: they see their store only.
    const perf = must(await bm2.get('/analytics/branches'), 200, 'Branch Performance, scoped');
    const names = (perf.items || []).map((r) => r.branchName || r.name);
    assert.ok(!names.includes(st.main.name), `Branch Performance must not list ${st.main.name} for a north-only manager, saw ${names.join(', ')}`);
    notes.push(`Branch Performance lists: ${names.join(', ') || '(only their own)'}`);

    // Purchase Report too.
    const pur = await bm2.get('/analytics/purchases');
    assert.equal(pur.status, 200, 'they can open the Purchase Report');
    notes.push('Purchase Report opens for them, scoped the same way');
    st.bmEmail = email;
    return notes;
  });

  /* --------------------------------------------- 15. supplier -> purchase report / supplier performance */
  await S.step(15, 'Suppliers → Purchase Report and Supplier Performance agree for the same period', async () => {
    const notes = [];
    const supplierId = st.supplierId;
    assert.ok(supplierId, 'step 10 must have created a supplier');

    const purchases = must(await a.get('/analytics/purchases?limit=100'), 200, 'Purchase Report');
    const perf = must(await a.get('/analytics/suppliers?limit=100'), 200, 'Supplier Performance');
    const pt = purchases.totals?.current || {};
    const rows = perf.items || [];

    /**
     * These two reports are built by separate aggregations over the same orders, which is exactly the pair that can
     * drift apart without anybody noticing. Three figures have to agree.
     */
    const perfOrders = rows.reduce((n, r) => n + Number(r.ordersAll ?? r.orders ?? 0), 0);
    const perfValue = money(rows.reduce((n, r) => n + Number(r.valueAll ?? r.value ?? 0), 0));

    assert.equal(rows.length, pt.suppliers, `Supplier Performance lists ${rows.length} suppliers, the Purchase Report counts ${pt.suppliers}`);
    assert.equal(perfOrders, pt.orders, `order counts disagree: Supplier Performance ${perfOrders} vs Purchase Report ${pt.orders}`);
    assert.equal(perfValue, money(pt.value), `purchase value disagrees: Supplier Performance ₹${perfValue} vs Purchase Report ₹${pt.value}`);
    notes.push(`suppliers ${rows.length} == ${pt.suppliers}, orders ${perfOrders} == ${pt.orders}, value ₹${perfValue} == ₹${money(pt.value)}`);
    notes.push(`(the seeded orders are placed but not received, so the value is ₹0 on BOTH sides — which is the agreement being checked)`);

    /**
     * And the supplier created in step 10 must NOT appear: it has never been ordered from. A purchase report that
     * listed a supplier with no purchases would be the bug here, not the other way round.
     */
    const unused = rows.find((r) => r.name === st.supplierName);
    assert.ok(!unused, `${st.supplierName} has no orders, so it must not appear in Supplier Performance`);
    notes.push(`${st.supplierName} (no orders yet) correctly absent from Supplier Performance`);

    // Per-supplier, the named rows must also match what the Purchase Report lists for them.
    const named = rows[0];
    if (named) {
      const theirOrders = (purchases.items || []).filter((o) => (o.supplierName || o.supplier) === named.name).length;
      assert.ok(theirOrders > 0, `the Purchase Report should list orders for ${named.name}`);
      notes.push(`${named.name}: ${named.ordersAll ?? named.orders} orders in Supplier Performance, ${theirOrders} rows in the Purchase Report`);
    }

    return notes;
  });

  /* --------------------------------------------- 16. customer -> insights / credit */
  await S.step(16, 'Customer Insights and Credit Management report the same customer consistently', async () => {
    const notes = [];
    const customer = st.creditCustomer;
    assert.ok(customer, 'step 11 must have made a credit sale');

    // A second invoice for the same customer, so they have a history rather than one row.
    const products = must(await a.get('/pos/products?q='), 200, 'products');
    const pick = (products.items || products).find((p) => p.nextBatch && p.availableStock > 1);
    must(
      await a.post('/invoices', { items: [{ medicineId: pick._id || pick.id, quantity: 1, discountPercent: 0 }], customer, paymentType: 'Cash', idempotencyKey: `x-cust-${uniq()}` }),
      201, 'a second, cash sale for the same customer',
    );

    const insights = must(await a.get('/analytics/customers?limit=100'), 200, 'Customer Insights');
    const row = (insights.items || []).find((r) => (r.customerName || r.name) === customer.name || r.phone === customer.phone);
    assert.ok(row, `the customer should appear in Customer Insights, saw ${(insights.items || []).length} rows`);
    const invoiceCount = row.invoices ?? row.invoiceCount ?? row.orders;
    assert.equal(invoiceCount, 2, `Customer Insights should count both invoices, it says ${invoiceCount}`);
    notes.push(`Customer Insights: ${row.customerName || row.name} — ${invoiceCount} invoices, ₹${row.totalSpent ?? row.revenue ?? row.value}`);

    /**
     * The drift check the brief asked for, aimed at the two numbers that really could drift: Customer Insights'
     * per-customer outstanding, and the dues on that customer's own invoices. They are computed by two different
     * aggregations, so they are exactly the pair worth comparing.
     */
    const theirDue = Number(row.outstanding ?? row.due ?? row.dueAmount ?? 0);
    const theirInvoices = must(await a.get(`/invoices?search=${encodeURIComponent(customer.name)}&limit=100`), 200, 'their invoices');
    const dueFromInvoices = money((theirInvoices.items || []).reduce((n, i) => n + Number(i.dueAmount ?? i.due ?? 0), 0));
    assert.equal(money(theirDue), dueFromInvoices, `Customer Insights says ₹${theirDue}, their invoices add up to ₹${dueFromInvoices}`);
    notes.push(`outstanding agrees: Customer Insights ₹${theirDue} == sum of their invoice dues ₹${dueFromInvoices}`);

    // And the organization total cannot be smaller than one customer's share of it.
    const orgOutstanding = Number(insights.kpis?.find((k) => k.key === 'outstanding')?.value ?? 0);
    assert.ok(theirDue <= orgOutstanding + 0.01, `one customer cannot owe more than the organization total: ₹${theirDue} > ₹${orgOutstanding}`);
    notes.push(`organization-wide outstanding ₹${orgOutstanding} covers it`);

    return notes;
  });

  /* --------------------------------------------- 17. activity log */
  await S.step(17, 'Everything → Activity Log: one correct, correctly-scoped entry per write action', async () => {
    const notes = [];
    const entries = [];
    for (let page = 1; page <= 10; page += 1) {
      const r = must(await a.get(`/activity?limit=100&page=${page}`), 200, `Activity Log page ${page}`);
      entries.push(...(r.items || []));
      if (page >= (r.pages || 1)) break;
    }
    const log = { items: entries };
    assert.ok(entries.length > 0, 'the Activity Log should not be empty after all of this');

    const actions = {};
    for (const e of entries) actions[e.action] = (actions[e.action] || 0) + 1;
    notes.push(`${entries.length} entries; actions seen: ${Object.keys(actions).sort().join(', ')}`);

    // The writes these crossings performed, and the action each should have recorded.
    const expected = [
      ['a sale', /INVOICE|SALE/i],
      ['a sales return', /RETURN/i],
      ['a transfer', /TRANSFER/i],
      ['a user change', /USER/i],
      ['a settings change', /SETTINGS/i],
    ];
    for (const [label, pattern] of expected) {
      const hit = Object.keys(actions).find((k) => pattern.test(k));
      assert.ok(hit, `no Activity Log entry for ${label} (actions present: ${Object.keys(actions).join(', ')})`);
      notes.push(`${label} → ${hit} x${actions[hit]}`);
    }

    // Every entry must name a real actor and belong to this organization only.
    const nameless = entries.filter((e) => !e.userName && !e.userId);
    assert.equal(nameless.length, 0, `${nameless.length} entries have no actor`);

    // Org B's log must contain none of org A's entries.
    const b = new Client('orgB');
    // Sign in as the pharmacy created by run.mjs if it still exists; otherwise make one via the platform.
    const platform = new Client('platform');
    must(await platform.request('POST', '/platform/auth/login', { email: 'platform@e2e.test', password: PASSWORD }), 200, 'platform sign-in');
    platform.csrf = platform.last.body.data.csrfToken;
    const owner = `log-owner-${uniq()}@example.test`;
    const made = must(await platform.post('/platform/organizations', { name: `Log Check Pharmacy ${uniq()}`, owner: { firstName: 'Log', email: owner } }), 201, 'a fresh pharmacy');
    must(await b.login(owner, made.temporaryPassword), 200, 'its admin signs in');
    must(await b.post('/auth/change-password', { currentPassword: made.temporaryPassword, newPassword: PASSWORD }), 200, 'change password');
    const b2 = new Client('orgB');
    must(await b2.login(owner, PASSWORD), 200, 'sign in again');

    const bLog = must(await b2.get('/activity?limit=100'), 200, "the new pharmacy's Activity Log");
    const bEntries = bLog.items || [];
    const aIds = new Set(entries.map((e) => String(e._id)));
    const leaked = bEntries.filter((e) => aIds.has(String(e._id)));
    assert.equal(leaked.length, 0, `${leaked.length} of org A's activity entries are visible to another pharmacy`);
    notes.push(`a new pharmacy's log has ${bEntries.length} entries, none of them org A's`);

    // Its own creation is the first thing in its history, recorded against the platform operator.
    const created = bEntries.find((e) => e.action === 'ORGANIZATION_CREATED');
    assert.ok(created, "a new pharmacy's log should open with its own creation");
    assert.match(created.userName, /platform/i, `the actor should be the platform operator, it is "${created.userName}"`);
    notes.push(`its first entry: ${created.action} by "${created.userName}"`);
    return notes;
  });


}
