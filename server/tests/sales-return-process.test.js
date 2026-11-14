// Processing a new sales return: finding the invoice, returnable quantities, amounts, the reason / restocking / refund rules,
// stock and ledger effects, duplicate and racing requests, rollback on failure, permissions and organization isolation.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { futureDate, startHarness } from './helpers/harness.js';

let h;
let T;
let other;
let n = 0;
const uniq = (p) => `${p}-${++n}`;

const medicine = async (client = T.client, extra = {}) => {
  const r = await client.post('/inventory', { medicineName: uniq('Return Med'), reorderLevel: 1, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
const stock = async (medicineId, quantity, price = 100, client = T.client) => {
  const r = await client.post('/batches', { medicineId, batchNumber: uniq('LOT'), expiryDate: futureDate(2), mrp: price, sellingPrice: price, purchasePrice: 60, initialQuantity: quantity });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
};
/** Sells `qty` units of a fresh medicine (price per unit) and returns the invoice with its single line. */
const sale = async ({ qty = 5, price = 100, discount, client = T.client, customer } = {}) => {
  const m = await medicine(client);
  const b = await stock(m._id, 50, price, client);
  const r = await client.post('/invoices', { customer: customer || { name: 'Meera Nair', phone: '9811122233' }, items: [{ medicineId: m._id, quantity: qty }], ...(discount && { discount }), paymentType: 'UPI' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { m, b, inv: r.data };
};
const batchOf = async (id, client = T.client) => (await client.get(`/batches/${id}`)).data;
const reconciled = async () => (await T.client.get('/stock/reconciliation')).data.consistent;
const key = () => `rk-${++n}-${Date.now()}`;

const body = (inv, lines, over = {}) => ({
  invoiceId: inv._id,
  reason: 'changed_mind',
  notes: '',
  items: lines.map(([quantity, extra = {}]) => ({ medicineId: inv.items[0].medicineId, batchId: inv.items[0].batchId, quantity, condition: 'good', restock: false, verified: false, ...extra })),
  refund: { method: 'Cash', amount: 0, status: 'pending', reference: '', remarks: '' },
  idempotencyKey: key(),
  ...over,
});
/** A return whose refund equals the value of the units (unit price = the invoice's price). */
const ret = (inv, lines, over = {}, price) => {
  const qty = lines.reduce((s, [q]) => s + q, 0);
  const b = body(inv, lines, over);
  if (over.refund === undefined) b.refund.amount = price !== undefined ? price * qty : Math.round(inv.items[0].price * qty * 100) / 100;
  return b;
};
const post = (b, client = T.client) => client.post('/sales-returns', b);
const asRole = async (role) => {
  const u = await h.makeUser(T.org, { role });
  const c = h.client();
  assert.equal((await c.login(u.email)).status, 200);
  return c;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Return Process Org');
  other = await h.makeTenant('Return Process Other Org');
});
after(async () => {
  await h?.stop();
});

describe('Finding the original invoice', () => {
  it('searches completed invoices by number, customer name or phone', async () => {
    const { inv } = await sale({ customer: { name: 'Zainab Qureshi', phone: '9000011122' } });
    for (const q of [inv.invoiceNo, 'zainab', '9000011122']) {
      const r = (await T.client.get(`/sales-returns/invoices?search=${encodeURIComponent(q)}`)).data;
      assert.ok(r.some((x) => x._id === inv._id), q);
    }
    const hit = (await T.client.get(`/sales-returns/invoices?search=${inv.invoiceNo}`)).data[0];
    for (const k of ['invoiceNo', 'invoiceDate', 'customer', 'total', 'paymentType', 'returnableUnits']) assert.ok(k in hit, k);
    assert.equal(hit.returnableUnits, 5);
    assert.equal((await T.client.get('/sales-returns/invoices?search=.*nothing')).data.length, 0, 'text, not a pattern');
  });

  it('returns the lines with what was bought, already returned and still returnable, at what the customer paid', async () => {
    const { inv, b } = await sale({ qty: 5, price: 100, discount: { type: 'percent', value: 10 } });
    const r = (await T.client.get(`/sales-returns/invoices/${inv._id}`)).data;
    assert.equal(r.invoiceNo, inv.invoiceNo);
    assert.equal(r.customer.name, 'Meera Nair');
    assert.equal(r.total, 450);
    assert.equal(r.paymentType, 'UPI');
    const l = r.lines[0];
    assert.equal(l.batchNo, b.batchNumber);
    assert.deepEqual([l.originalQuantity, l.previouslyReturned, l.returnableQuantity], [5, 0, 5]);
    assert.equal(l.unitPrice, 90, '₹100 less the 10% bill discount');
    assert.equal(l.lineTotalPaise, 45000);
    assert.equal(l.canRestock, true);
    assert.ok(l.expiryDate);
  });

  it('refuses invoices of other organizations, unknown ones and ones that are not completed sales', async () => {
    const { inv } = await sale();
    assert.equal((await other.client.get(`/sales-returns/invoices/${inv._id}`)).status, 404);
    assert.equal((await other.client.get(`/sales-returns/invoices?search=${inv.invoiceNo}`)).data.length, 0);
    assert.equal((await T.client.get('/sales-returns/invoices/not-an-id')).status, 404);
    await h.models.Invoice.collection.updateOne({ _id: new h.models.Invoice.base.Types.ObjectId(inv._id) }, { $set: { status: 'cancelled' } });
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).status, 409);
    assert.equal((await post(ret(inv, [[1]]))).status, 409);
    assert.equal((await T.client.get(`/sales-returns/invoices?search=${inv.invoiceNo}`)).data.length, 0, 'cancelled sales are not offered');
  });
});

describe('Recording a return', () => {
  it('records the return against the invoice without touching stock, and computes the amount itself', async () => {
    const { inv, b } = await sale({ qty: 5, price: 100 });
    const before = (await batchOf(b._id)).availableQuantity;
    const r = await post(ret(inv, [[2]]));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.data;
    assert.match(d.returnNo, /^SR-\d{4}$/);
    assert.equal(d.invoiceNo, inv.invoiceNo);
    assert.equal(d.customer.phone, '9811122233');
    assert.equal(d.returnValue, 200);
    assert.equal(d.refundAmount, 200);
    assert.equal(d.originalPaymentMethod, 'UPI');
    assert.deepEqual([d.items[0].originalQuantity, d.items[0].previouslyReturned, d.items[0].quantity], [5, 0, 2]);
    assert.equal(d.items[0].restockedQuantity, 0, 'nothing is restocked unless staff choose to');
    assert.equal((await batchOf(b._id)).availableQuantity, before, 'stock is untouched');
    assert.equal(d.status, 'refund_pending');
    assert.equal(d.refund.status, 'pending');
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].returnableQuantity, 3);
    assert.ok((await T.client.get('/activity?limit=20')).data.items.some((x) => x.action === 'SALES_RETURN_CREATE' && x.message.includes(d.returnNo)), 'audited');
    assert.equal(await reconciled(), true);
  });

  it('ignores any client attempt to set the amount, organization, status or numbers', async () => {
    const { inv } = await sale({ qty: 4, price: 50 });
    const b = ret(inv, [[2]]);
    Object.assign(b, { organizationId: other.org._id, status: 'completed', returnNo: 'SR-9999', returnValue: 1, createdBy: other.user._id });
    const r = await post(b);
    assert.equal(r.status, 201);
    assert.equal(r.data.returnValue, 100);
    assert.notEqual(r.data.returnNo, 'SR-9999');
    assert.equal(r.data.status, 'refund_pending');
    assert.equal(String(r.data.organizationId), String(T.org._id));
    assert.equal(String(r.data.createdBy), String(T.user._id));
    assert.equal((await other.client.get(`/sales-returns/${r.data._id}`)).status, 404);
  });

  it('values the units at what the customer really paid, so a full return equals the invoice total', async () => {
    const { inv } = await sale({ qty: 7, price: 33.33, discount: { type: 'percent', value: 15 } });
    const lines = (await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines;
    const r = await post(ret(inv, [[7]], { refund: { method: 'Cash', amount: 0, status: 'pending' } }));
    assert.equal(r.status, 400, 'a zero refund is allowed only with remarks');
    const full = await post(ret(inv, [[7]], { refund: { method: 'Cash', amount: lines[0].lineTotalPaise / 100, status: 'completed' } }));
    assert.equal(full.status, 201, JSON.stringify(full.body));
    assert.equal(full.data.returnValue, inv.total);
    assert.equal(full.data.returnValue, lines[0].lineTotalPaise / 100);
  });

  it('can return a part now and the rest later, but never more than was bought', async () => {
    const { inv } = await sale({ qty: 5, price: 20 });
    assert.equal((await post(ret(inv, [[2]]))).status, 201);
    const tooMany = await post(ret(inv, [[4]]));
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.details[0].path, 'items.0.quantity');
    assert.match(tooMany.body.details[0].message, /Only 3 units .* can still be returned \(bought 5, already returned 2\)/);
    assert.equal((await post(ret(inv, [[3]]))).status, 201);
    const again = await post(ret(inv, [[1]]));
    assert.equal(again.status, 400);
    assert.match(again.body.details[0].message, /already been returned in full/);
    assert.equal((await post(ret(inv, [[6]]))).status, 400);
    assert.equal((await post(ret(inv, [[0]]))).status, 400);
    assert.equal((await post(ret(inv, [[1.5]]))).status, 400);
  });

  it('only products from that invoice can be returned, each once', async () => {
    const { inv } = await sale();
    const stranger = await sale();
    const foreign = ret(inv, [[1]]);
    foreign.items[0].batchId = stranger.inv.items[0].batchId;
    foreign.items[0].medicineId = stranger.inv.items[0].medicineId;
    const r = await post(foreign);
    assert.equal(r.status, 400);
    assert.match(r.body.details[0].message, /not on the selected invoice/);
    const dup = ret(inv, [[1], [1]]);
    const d = await post(dup);
    assert.equal(d.status, 400);
    assert.match(d.body.details[0].message, /listed twice/);
    assert.equal((await post(body(inv, []))).status, 400, 'at least one product');
  });

  it('refuses another organization’s invoice', async () => {
    const { inv } = await sale();
    const r = await post(ret(inv, [[1]]), other.client);
    assert.equal(r.status, 404);
  });
});

describe('Reason and restocking: never automatic', () => {
  it('restocks only units staff marked as good AND verified, into the same batch, with a ledger entry', async () => {
    const { m, inv, b } = await sale({ qty: 6, price: 40 });
    const before = (await batchOf(b._id)).availableQuantity;
    const r = await post(ret(inv, [[4, { restock: true, verified: true }]]));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.data.items[0].restockedQuantity, 4);
    const after = await batchOf(b._id);
    assert.equal(after.availableQuantity, before + 4);
    assert.equal(after.batchNumber, b.batchNumber, 'same batch number');
    assert.equal(after.expiryDate, b.expiryDate, 'same expiry date');
    const mv = (await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.find((x) => x.type === 'SALE_RETURN');
    assert.equal(mv.quantity, 4);
    assert.equal(mv.refType, 'SalesReturn');
    assert.equal(mv.balanceAfter, before + 4);
    assert.ok(mv.createdAt && mv.batchId);
    assert.equal(await reconciled(), true, 'ledger and stock agree');
    assert.equal(new Date(r.data.items[0].expiryDate).getTime(), new Date(b.expiryDate).getTime(), 'expiry is kept with the return');
  });

  it('a good, approved return is NOT restocked unless staff choose it', async () => {
    const { inv, b } = await sale({ qty: 3 });
    const before = (await batchOf(b._id)).availableQuantity;
    const r = await post(ret(inv, [[3, { condition: 'good', restock: false, verified: true }]], { refund: { method: 'Cash', amount: 300, status: 'completed' } }));
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'completed');
    assert.equal((await batchOf(b._id)).availableQuantity, before);
  });

  it('refuses restocking without verification, for damaged / expired / opened units, and for expired or damaged reasons', async () => {
    const { inv, b } = await sale({ qty: 8 });
    const before = (await batchOf(b._id)).availableQuantity;
    const unverified = await post(ret(inv, [[1, { restock: true, verified: false }]]));
    assert.equal(unverified.status, 400);
    assert.equal(unverified.body.details[0].path, 'items.0.verified');
    for (const condition of ['damaged', 'expired', 'compromised']) {
      const r = await post(ret(inv, [[1, { restock: true, verified: true, condition }]]));
      assert.equal(r.status, 400, condition);
      assert.match(r.body.details[0].message, /only units in good condition/i);
    }
    for (const reason of ['expired', 'damaged']) {
      const r = await post(ret(inv, [[1, { restock: true, verified: true }]], { reason }));
      assert.equal(r.status, 400, reason);
      assert.match(r.body.details[0].message, /can never be added back/);
    }
    assert.equal((await batchOf(b._id)).availableQuantity, before, 'nothing was added to sellable stock');
    // …but the same returns are fine when nothing is restocked
    assert.equal((await post(ret(inv, [[1, { condition: 'damaged' }]], { reason: 'damaged' }))).status, 201);
    assert.equal((await batchOf(b._id)).availableQuantity, before);
  });

  it('refuses to restock into a batch that has expired, is quarantined or recalled — and records nothing', async () => {
    for (const how of ['expired', 'quarantined']) {
      const { inv, b } = await sale({ qty: 4 });
      const id = new h.models.Batch.base.Types.ObjectId(b._id);
      if (how === 'expired') await h.models.Batch.collection.updateOne({ _id: id }, { $set: { expiryDate: new Date(Date.now() - 86400000) } });
      else await h.models.Batch.collection.updateOne({ _id: id }, { $set: { status: 'quarantined' } });
      const available = (await h.models.Batch.collection.findOne({ _id: id })).availableQuantity;
      const info = (await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0];
      assert.equal(info.canRestock, false, how);
      const r = await post(ret(inv, [[2, { restock: true, verified: true }]]));
      assert.equal(r.status, 400, how);
      assert.equal((await h.models.Batch.collection.findOne({ _id: id })).availableQuantity, available);
      assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].previouslyReturned, 0, 'the whole attempt rolled back');
      assert.equal((await post(ret(inv, [[2]]))).status, 201, 'returning without restocking is still fine');
    }
  });
});

describe('Refund information', () => {
  it('records method, status, reference and remarks, and the return status follows the refund status', async () => {
    const { inv } = await sale({ qty: 10, price: 10 });
    const cases = [
      ['pending', 'refund_pending'],
      ['processing', 'refund_pending'],
      ['completed', 'completed'],
      ['failed', 'approved'],
    ];
    for (const [status, expected] of cases) {
      const r = await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 10, status, reference: '', remarks: '' } }));
      assert.equal(r.status, 201, status);
      assert.equal(r.data.status, expected, status);
      assert.equal(r.data.refund.status, status);
      assert.equal(Boolean(r.data.refund.paidAt), status === 'completed', 'only a completed refund has a paid time');
    }
    const upi = await post(ret(inv, [[1]], { refund: { method: 'UPI', amount: 10, status: 'completed', reference: 'UPI-8842', remarks: 'Paid by customer app' } }));
    assert.equal(upi.data.refund.reference, 'UPI-8842');
    assert.equal(upi.data.refund.remarks, 'Paid by customer app');
    for (const method of ['Card', 'Bank Transfer', 'Store Credit']) assert.equal((await post(ret(inv, [[1]], { refund: { method, amount: 10, status: 'pending' } }))).status, 201, method);
  });

  it('is only ever recorded: no payment is made, and rules protect the numbers', async () => {
    const { inv } = await sale({ qty: 10, price: 10 });
    const over = await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 10.01, status: 'pending' } }));
    assert.equal(over.status, 400);
    assert.equal(over.body.details[0].path, 'refund.amount');
    const less = await post(ret(inv, [[2]], { refund: { method: 'Cash', amount: 15, status: 'pending', remarks: '' } }));
    assert.equal(less.status, 400);
    assert.equal(less.body.details[0].path, 'refund.remarks');
    assert.equal((await post(ret(inv, [[2]], { refund: { method: 'Cash', amount: 15, status: 'pending', remarks: 'Opened strip, partial refund' } }))).data.refundAmount, 15);
    for (const method of ['UPI', 'Card', 'Bank Transfer']) {
      const r = await post(ret(inv, [[1]], { refund: { method, amount: 10, status: 'completed', reference: '' } }));
      assert.equal(r.status, 400, method);
      assert.equal(r.body.details[0].path, 'refund.reference');
    }
    assert.equal((await post(ret(inv, [[1]], { refund: { method: 'Cheque', amount: 10, status: 'pending' } }))).status, 400);
    assert.equal((await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 10, status: 'done' } }))).status, 400);
    assert.equal((await post(ret(inv, [[1]], { reason: 'because' }))).status, 400);
    assert.equal((await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: -5, status: 'pending' } }))).status, 400);
  });
});

describe('Dashboard cards', () => {
  it('count the new return: refunded money, processed returns, restocked units and money still owed', async () => {
    const { inv } = await sale({ qty: 4, price: 25 });
    const s0 = (await T.client.get('/sales-returns/summary')).data;
    assert.equal((await post(ret(inv, [[2, { restock: true, verified: true }]], { refund: { method: 'Cash', amount: 50, status: 'completed' } }))).status, 201);
    assert.equal((await post(ret(inv, [[1]], { refund: { method: 'Cash', amount: 25, status: 'pending' } }))).status, 201);
    const s1 = (await T.client.get('/sales-returns/summary')).data;
    assert.equal(Math.round((s1.totalRefunded - s0.totalRefunded) * 100) / 100, 50);
    assert.equal(s1.returnsProcessed - s0.returnsProcessed, 1);
    assert.equal(s1.itemsRestocked - s0.itemsRestocked, 2);
    assert.equal(Math.round((s1.pendingRefunds - s0.pendingRefunds) * 100) / 100, 25);
    const list = (await T.client.get(`/sales-returns?search=${inv.invoiceNo}`)).data.items;
    assert.equal(list.length, 2);
    assert.ok(list.every((x) => x.returnValue > 0 && x.reasonLabel === 'Customer Changed Mind'));
  });
});

describe('Duplicate and racing requests', () => {
  it('the same idempotency key records one return and restocks once', async () => {
    const { m, inv, b } = await sale({ qty: 5 });
    const before = (await batchOf(b._id)).availableQuantity;
    const payload = ret(inv, [[2, { restock: true, verified: true }]]);
    const a = await post(payload);
    const again = await post(payload);
    assert.equal(a.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.data._id, a.data._id);
    assert.equal((await batchOf(b._id)).availableQuantity, before + 2);
    assert.equal((await T.client.get(`/sales-returns?search=${inv.invoiceNo}`)).data.total, 1);
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.filter((x) => x.type === 'SALE_RETURN').length, 1);
  });

  it('two different returns racing for the same last units: exactly one wins, stock changes once', async () => {
    const { inv, b } = await sale({ qty: 3 });
    const before = (await batchOf(b._id)).availableQuantity;
    const [x, y] = await Promise.all([post(ret(inv, [[3, { restock: true, verified: true }]])), post(ret(inv, [[3, { restock: true, verified: true }]]))]);
    assert.deepEqual([x.status, y.status].sort(), [201, 409].sort().length === 2 ? [x.status, y.status].sort() : []);
    assert.equal([x.status, y.status].filter((s) => s === 201).length, 1, `one winner (${x.status}, ${y.status})`);
    assert.equal((await batchOf(b._id)).availableQuantity, before + 3, 'restocked once');
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].returnableQuantity, 0);
    assert.equal(await reconciled(), true);
  });
});

describe('Failure leaves nothing behind', () => {
  it('a failure part-way through rolls back the invoice claim, the stock, the ledger, the return and its number', async () => {
    const { m, inv, b } = await sale({ qty: 4 });
    const before = (await batchOf(b._id)).availableQuantity;
    const original = h.models.StockMovement.create.bind(h.models.StockMovement);
    h.models.StockMovement.create = async () => {
      throw new Error('simulated database failure');
    };
    let r;
    try {
      r = await post(ret(inv, [[2, { restock: true, verified: true }]]));
    } finally {
      h.models.StockMovement.create = original;
    }
    assert.ok(r.status >= 500, `a failed return is an error (${r.status})`);
    assert.equal((await batchOf(b._id)).availableQuantity, before, 'stock rolled back');
    assert.equal((await T.client.get(`/sales-returns/invoices/${inv._id}`)).data.lines[0].previouslyReturned, 0, 'the claim on the invoice rolled back');
    assert.equal((await T.client.get(`/sales-returns?search=${inv.invoiceNo}`)).data.total, 0, 'no return was saved');
    assert.equal((await T.client.get(`/stock/movements?medicineId=${m._id}&limit=20`)).data.items.filter((x) => x.type === 'SALE_RETURN').length, 0);
    const ok = await post(ret(inv, [[2, { restock: true, verified: true }]]));
    assert.equal(ok.status, 201, 'a retry works');
    assert.equal(await reconciled(), true);
  });
});

describe('Who may process returns', () => {
  it('needs billing access to process; viewers cannot; everyone must be signed in', async () => {
    const { inv } = await sale({ qty: 2 });
    assert.equal((await h.client().post('/sales-returns', ret(inv, [[1]]))).status, 401);
    assert.equal((await h.client().get('/sales-returns/invoices')).status, 401);
    const staff = await asRole('STAFF');
    assert.equal((await post(ret(inv, [[1]]), staff)).status, 403);
    assert.equal((await staff.get('/sales-returns/invoices')).status, 403);
    assert.equal((await staff.get(`/sales-returns/invoices/${inv._id}`)).status, 403);
    const billing = await asRole('BILLING_STAFF');
    assert.equal((await post(ret(inv, [[1]]), billing)).status, 201);
  });

  it('exposes the choices for the form (reasons, conditions, refund methods and statuses)', async () => {
    const m = (await T.client.get('/sales-returns/meta')).data;
    assert.deepEqual(m.reasons.map((r) => r.label), ['Expired Medicine', 'Damaged Product', 'Wrong Product Delivered', 'Incorrect Quantity', 'Customer Changed Mind', 'Quality Issue', 'Other']);
    assert.deepEqual(m.refundMethods, ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Store Credit']);
    assert.deepEqual(m.refundStatuses.map((s) => s.label), ['Pending', 'Processing', 'Completed', 'Failed']);
    assert.equal(m.conditions.length, 4);
    assert.deepEqual(m.noRestockReasons, ['expired', 'damaged']);
  });
});
