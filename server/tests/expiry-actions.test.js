// The actions the Expiry Intelligence register offers. These move real stock, so what they are checked for is not
// "did the endpoint answer 200" but "is the ledger still true afterwards".
//
// The invariant that matters, and that every stock-moving case below asserts: the sum of a batch's stock-movement
// entries equals the quantity on hand. If an action can break that, the whole inventory system stops being trustworthy.
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { startHarness } from './helpers/harness.js';

let h;
let org;
let client;
let branch;
let other;
let models;
let supplier;

const DAY = 86400000;
const expiryIn = (days) => {
  const d = new Date(Date.now() + days * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const inOrg = (orgId, fn) => h.tenant.runWithTenant(orgId, fn);

let seq = 0;
async function makeLot({ days = 30, qty = 100, cost = 10, withSupplier = true, branchId, ...extra } = {}) {
  const n = ++seq;
  const medicine = await inOrg(org._id, () => models.Medicine.create({ organizationId: org._id, medicineName: `Action Med ${n}`, manufacturer: 'ACME' }));
  const batch = await inOrg(org._id, () =>
    models.Batch.create({
      organizationId: org._id,
      medicineId: medicine._id,
      batchNumber: `ACT-${n}`,
      expiryDate: expiryIn(days),
      purchasePrice: cost,
      sellingPrice: 20,
      mrp: 25,
      initialQuantity: qty,
      availableQuantity: qty,
      branchId: branchId || branch._id,
      supplierId: withSupplier ? supplier._id : undefined,
      ...extra,
    }),
  );
  // Opening the ledger the way a real receipt would, so the balance check below has something to check against.
  if (qty > 0) {
    await inOrg(org._id, () =>
      models.StockMovement.create({ organizationId: org._id, medicineId: medicine._id, batchId: batch._id, type: 'OPENING', quantity: qty, balanceAfter: qty, branchId: batch.branchId }),
    );
  }
  return { medicine, batch };
}

const reload = (id) => inOrg(org._id, () => models.Batch.findById(id).lean());

/** The invariant: what the ledger says a lot holds is what the lot says it holds. */
async function assertLedgerBalances(batchId, expected) {
  const moves = await inOrg(org._id, () => models.StockMovement.find({ batchId }).lean());
  const fromLedger = moves.reduce((n, m) => n + m.quantity, 0);
  const batch = await reload(batchId);
  assert.equal(fromLedger, batch.availableQuantity, `the ledger sums to ${fromLedger} but the lot holds ${batch.availableQuantity}`);
  if (expected !== undefined) assert.equal(batch.availableQuantity, expected);
}

const act = (body, c = client) => c.post('/analytics/expiry/actions', body);

before(async () => {
  h = await startHarness();
  models = h.models;
  const tenant = await h.makeTenant('Actions Co');
  org = tenant.org;
  client = tenant.client;
  branch = await inOrg(org._id, () => models.Branch.create({ organizationId: org._id, name: 'Main Store', code: 'MAIN', isDefault: true }));
  other = await inOrg(org._id, () => models.Branch.create({ organizationId: org._id, name: 'Second Store', code: 'SEC' }));
  supplier = await inOrg(org._id, () => models.Supplier.create({ organizationId: org._id, name: 'Medilink' }));
});
after(async () => h?.stop());

describe('writing stock off', () => {
  test('removes the stock through the ledger and records who, when and why', async () => {
    const { batch } = await makeLot({ qty: 150, cost: 20 });
    const r = await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired on the shelf' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.units, 150);
    assert.equal(r.data.value, 3000);

    const after_ = await reload(batch._id);
    assert.equal(after_.availableQuantity, 0, 'the stock is gone');
    assert.equal(after_.status, 'archived');
    assert.ok(after_.disposedAt, 'and the lot records when');
    assert.equal(after_.disposalReason, 'Expired on the shelf');
    await assertLedgerBalances(batch._id, 0);

    const moves = await inOrg(org._id, () => models.StockMovement.find({ batchId: batch._id, type: 'WRITE_OFF' }).lean());
    assert.equal(moves.length, 1);
    assert.equal(moves[0].quantity, -150, 'the ledger entry is signed negative, as a removal');
    assert.match(moves[0].reason, /Expired on the shelf/);
  });

  test('writes an audit entry naming the person', async () => {
    const { batch } = await makeLot({ qty: 10 });
    await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Damaged in storage' });
    const entries = await inOrg(org._id, () => models.AuditLog.find({ entity: 'Batch', entityId: batch._id, action: 'EXPIRY_DISPOSE' }).lean());
    assert.equal(entries.length, 1);
    assert.match(entries[0].message, /Damaged in storage/);
    assert.ok(entries[0].userName, 'the trail says who did it');
  });

  test('needs permission to delete inventory, not merely to edit it', async () => {
    const { batch } = await makeLot({ qty: 10 });
    // A branch manager may write stock but may not delete it.
    const manager = await h.makeUser(org, { role: 'BRANCH_MANAGER' });
    const c = h.client();
    await c.login(manager.email);

    const r = await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Trying it on' }, c);
    assert.equal(r.status, 403);
    assert.equal((await reload(batch._id)).availableQuantity, 10, 'and nothing was written off');

    // The same person may still flag the lot for clearance.
    assert.equal((await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 20 }, c)).status, 200);
  });

  test('refuses without a reason', async () => {
    const { batch } = await makeLot();
    assert.equal((await act({ action: 'dispose', batchIds: [String(batch._id)] })).status, 400);
    assert.equal((await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'x' })).status, 400);
  });

  test('refuses while units are reserved for an order', async () => {
    const { batch } = await makeLot({ qty: 50 });
    await inOrg(org._id, () => models.Batch.updateOne({ _id: batch._id }, { $set: { reservedQuantity: 10 } }));
    const r = await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired' });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /reserved/i);
    await assertLedgerBalances(batch._id, 50);
  });

  test('a lot already written off cannot be written off twice', async () => {
    const { batch } = await makeLot({ qty: 20 });
    assert.equal((await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired' })).status, 200);
    const again = await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired again' });
    assert.equal(again.status, 409);
    await assertLedgerBalances(batch._id, 0);
  });

  test('a bulk disposal is all or nothing', async () => {
    const good = await makeLot({ qty: 30 });
    const alsoGood = await makeLot({ qty: 40 });
    const reserved = await makeLot({ qty: 50 });
    await inOrg(org._id, () => models.Batch.updateOne({ _id: reserved.batch._id }, { $set: { reservedQuantity: 5 } }));

    const r = await act({ action: 'dispose', batchIds: [good.batch._id, alsoGood.batch._id, reserved.batch._id].map(String), reason: 'Stock take' });
    assert.equal(r.status, 409);
    assert.equal((await reload(good.batch._id)).availableQuantity, 30, 'the sound lots were left alone');
    assert.equal((await reload(alsoGood.batch._id)).availableQuantity, 40);
    await assertLedgerBalances(good.batch._id, 30);
  });

  test('disposes many lots in one go when they are all sound', async () => {
    const a = await makeLot({ qty: 10, cost: 5 });
    const b = await makeLot({ qty: 20, cost: 5 });
    const r = await act({ action: 'dispose', batchIds: [a.batch._id, b.batch._id].map(String), reason: 'Quarterly expiry clear-out' });
    assert.equal(r.status, 200);
    assert.equal(r.data.batches, 2);
    assert.equal(r.data.units, 30);
    assert.equal(r.data.value, 150);
    await assertLedgerBalances(a.batch._id, 0);
    await assertLedgerBalances(b.batch._id, 0);
  });
});

describe('clearance', () => {
  test('records the suggested discount and NEVER changes the selling price', async () => {
    const { batch } = await makeLot({ qty: 100 });
    const before = (await reload(batch._id)).sellingPrice;

    const r = await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 25, note: 'Push it at the counter' });
    assert.equal(r.status, 200);

    const after_ = await reload(batch._id);
    assert.equal(after_.clearance.flagged, true);
    assert.equal(after_.clearance.discountPercent, 25);
    assert.equal(after_.sellingPrice, before, 'the price is for a person to change, not this report');
    assert.equal(after_.availableQuantity, 100, 'and no stock moved');
    assert.equal(after_.status, 'active', 'a flagged lot is still on sale');
  });

  test('is capped by the organization’s own ceiling', async () => {
    const { batch } = await makeLot();
    const r = await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 70 });
    assert.equal(r.status, 400, 'the default ceiling is 50%');
    assert.equal((await reload(batch._id)).clearance?.flagged, false);
  });

  test('can be taken off again', async () => {
    const { batch } = await makeLot();
    await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 15 });
    assert.equal((await act({ action: 'clearanceClear', batchIds: [String(batch._id)] })).status, 200);
    const after_ = await reload(batch._id);
    assert.equal(after_.clearance.flagged, false);
    assert.equal(after_.clearance.discountPercent, undefined);
  });
});

describe('supplier returns', () => {
  test('requesting one quarantines the stock but does not remove it', async () => {
    const { batch } = await makeLot({ qty: 80, cost: 15 });
    const r = await act({ action: 'returnRequest', batchIds: [String(batch._id)], note: 'Short dated on arrival' });
    assert.equal(r.status, 200);
    assert.equal(r.data.units, 80);
    assert.equal(r.data.value, 1200);

    const after_ = await reload(batch._id);
    assert.equal(after_.status, 'quarantined', 'it cannot be sold while the supplier decides');
    assert.equal(after_.availableQuantity, 80, 'but the units are still ours and still on the books');
    assert.equal(after_.supplierReturn.status, 'requested');
    await assertLedgerBalances(batch._id, 80);
  });

  test('a lot with no supplier cannot be sent back to one', async () => {
    const { batch } = await makeLot({ withSupplier: false });
    const r = await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /no supplier/i);
    assert.equal((await reload(batch._id)).status, 'active', 'and it was not quarantined');
  });

  test('the same lot cannot be requested twice', async () => {
    const { batch } = await makeLot();
    assert.equal((await act({ action: 'returnRequest', batchIds: [String(batch._id)] })).status, 200);
    assert.equal((await act({ action: 'returnRequest', batchIds: [String(batch._id)] })).status, 409);
  });

  test('"returned" is the only outcome that removes the stock', async () => {
    const { batch } = await makeLot({ qty: 60, cost: 12 });
    await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    const r = await act({ action: 'returnSettle', batchIds: [String(batch._id)], outcome: 'returned', note: 'Collected by the rep' });
    assert.equal(r.status, 200);
    assert.equal(r.data.units, 60);
    assert.equal(r.data.value, 720);

    const after_ = await reload(batch._id);
    assert.equal(after_.availableQuantity, 0);
    assert.equal(after_.status, 'archived');
    assert.equal(after_.supplierReturn.status, 'returned');
    await assertLedgerBalances(batch._id, 0);
    const moves = await inOrg(org._id, () => models.StockMovement.find({ batchId: batch._id, refType: 'SupplierReturn' }).lean());
    assert.equal(moves.length, 1);
    assert.equal(moves[0].quantity, -60);
  });

  test('a refusal puts the stock back on sale and moves nothing', async () => {
    const { batch } = await makeLot({ qty: 45 });
    await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    assert.equal((await reload(batch._id)).status, 'quarantined');

    const r = await act({ action: 'returnSettle', batchIds: [String(batch._id)], outcome: 'rejected', note: 'Past their window' });
    assert.equal(r.status, 200);
    assert.equal(r.data.units, 0, 'nothing left the building');

    const after_ = await reload(batch._id);
    assert.equal(after_.status, 'active', 'the lot is sellable again');
    assert.equal(after_.availableQuantity, 45);
    assert.equal(after_.supplierReturn.status, 'rejected');
    await assertLedgerBalances(batch._id, 45);
  });

  test('cancelling a request un-quarantines the lot — the door swings both ways', async () => {
    const { batch } = await makeLot({ qty: 70 });
    await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    const r = await act({ action: 'returnSettle', batchIds: [String(batch._id)], outcome: 'cancelled', note: 'Set aside the wrong lot' });
    assert.equal(r.status, 200);

    const after_ = await reload(batch._id);
    assert.equal(after_.status, 'active');
    assert.equal(after_.availableQuantity, 70);
    assert.equal(after_.supplierReturn.status, 'cancelled');
    await assertLedgerBalances(batch._id, 70);

    // And having cancelled, it can be requested again.
    assert.equal((await act({ action: 'returnRequest', batchIds: [String(batch._id)] })).status, 200);
  });

  test('a lot with no open request cannot be settled', async () => {
    const { batch } = await makeLot();
    const r = await act({ action: 'returnSettle', batchIds: [String(batch._id)], outcome: 'returned' });
    assert.equal(r.status, 409);
    await assertLedgerBalances(batch._id, 100);
  });

  test('an unknown outcome is refused', async () => {
    const { batch } = await makeLot();
    await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    assert.equal((await act({ action: 'returnSettle', batchIds: [String(batch._id)], outcome: 'maybe' })).status, 400);
  });
});

describe('what the register shows afterwards', () => {
  test('a disposed lot leaves the live figures but is still findable', async () => {
    const { batch } = await makeLot({ qty: 90, cost: 10, days: 5 });
    const before = await client.get('/analytics/expiry/batches?limit=100');
    assert.ok(before.data.items.some((r) => r.id === String(batch._id)));

    await act({ action: 'dispose', batchIds: [String(batch._id)], reason: 'Expired' });

    const after_ = await client.get('/analytics/expiry/batches?limit=100');
    assert.ok(!after_.data.items.some((r) => r.id === String(batch._id)), 'gone from the default view');
    const disposed = await client.get('/analytics/expiry/batches?status=disposed&limit=100');
    assert.ok(disposed.data.items.some((r) => r.id === String(batch._id)), 'but there when asked for by name');
    assert.equal(disposed.data.items.find((r) => r.id === String(batch._id)).quantity, 0);
  });

  test('a quarantined lot is shown as quarantined and can be filtered to', async () => {
    const { batch } = await makeLot({ qty: 30, days: 10 });
    await act({ action: 'returnRequest', batchIds: [String(batch._id)] });
    const r = await client.get('/analytics/expiry/batches?status=quarantined&limit=100');
    const row = r.data.items.find((x) => x.id === String(batch._id));
    assert.ok(row, 'it is in the quarantined view');
    assert.equal(row.status, 'quarantined');
    assert.equal(row.supplierReturnStatus, 'requested');
  });

  test('a lot on clearance shows its suggested discount', async () => {
    const { batch } = await makeLot({ qty: 30, days: 12 });
    await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 30 });
    const r = await client.get('/analytics/expiry/batches?status=clearance&limit=100');
    const row = r.data.items.find((x) => x.id === String(batch._id));
    assert.equal(row.clearanceFlagged, true);
    assert.equal(row.clearanceDiscount, 30);
  });
});

describe('one lot in detail', () => {
  test('the drawer carries the lot, its ledger and its audit trail', async () => {
    const { batch } = await makeLot({ qty: 40, days: 20 });
    await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 10, note: 'Counter push' });

    const r = await client.get(`/analytics/expiry/batches/${batch._id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.batchNumber, batch.batchNumber);
    assert.equal(r.data.quantity, 40);
    assert.ok(r.data.medicine.medicineName);
    assert.equal(r.data.supplier.name, 'Medilink');
    assert.equal(r.data.branchName, 'Main Store');
    assert.ok(r.data.movements.length >= 1, 'the stock ledger is there');
    assert.ok(r.data.auditTrail.some((a) => a.action === 'EXPIRY_CLEARANCE_FLAG'), 'and so is what people did');
    assert.equal(r.data.clearance.discountPercent, 10);
  });

  test('a lot in another organization is not found', async () => {
    const rival = await h.makeTenant('Rival Co');
    const rivalBranch = await inOrg(rival.org._id, () => models.Branch.create({ organizationId: rival.org._id, name: 'Theirs', code: 'T1', isDefault: true }));
    const med = await inOrg(rival.org._id, () => models.Medicine.create({ organizationId: rival.org._id, medicineName: 'Theirs' }));
    const theirBatch = await inOrg(rival.org._id, () =>
      models.Batch.create({ organizationId: rival.org._id, medicineId: med._id, batchNumber: 'X1', expiryDate: expiryIn(10), sellingPrice: 5, mrp: 6, initialQuantity: 10, availableQuantity: 10, branchId: rivalBranch._id }),
    );

    assert.equal((await client.get(`/analytics/expiry/batches/${theirBatch._id}`)).status, 404);
    const r = await act({ action: 'dispose', batchIds: [String(theirBatch._id)], reason: 'Not mine to destroy' });
    assert.equal(r.status, 404, 'and it certainly cannot be written off');
    assert.equal((await inOrg(rival.org._id, () => models.Batch.findById(theirBatch._id).lean())).availableQuantity, 10);
  });
});

describe('where to move it instead', () => {
  test('suggests the store that actually sells the medicine', async () => {
    const { medicine, batch } = await makeLot({ qty: 200, days: 25 });
    // The second store sells it; the store holding the lot does not.
    await inOrg(org._id, () =>
      models.Invoice.insertMany(
        Array.from({ length: 30 }, (_, i) => ({
          organizationId: org._id,
          invoiceNo: `MOVE-${i}`,
          branchId: other._id,
          items: [{ medicineId: medicine._id, batchId: batch._id, quantity: 4, price: 20, amount: 80 }],
          subTotal: 80,
          total: 80,
          status: 'completed',
          invoiceDate: new Date(Date.now() - (i + 1) * DAY),
        })),
      ),
    );

    const r = await client.get(`/analytics/expiry/batches/${batch._id}/transfer-suggestion`);
    assert.equal(r.status, 200);
    assert.equal(r.data.best.branchName, 'Second Store');
    assert.ok(r.data.best.avgDailySales > 0);
    assert.ok(r.data.best.daysToClear > 0);
    assert.match(r.data.note, /advice only|nothing has been moved/i);
  });

  test('says so plainly when there is nowhere obvious to send it', async () => {
    const { batch } = await makeLot({ qty: 10, days: 15 });
    const r = await client.get(`/analytics/expiry/batches/${batch._id}/transfer-suggestion`);
    assert.equal(r.status, 200);
    assert.equal(r.data.best, null);
    assert.match(r.data.note, /no other store/i);
  });
});

describe('guards', () => {
  test('reading the report does not let you act on it', async () => {
    const { batch } = await makeLot();
    const staff = await h.makeUser(org, { role: 'BILLING_STAFF' });
    const c = h.client();
    await c.login(staff.email);
    assert.equal((await act({ action: 'clearance', batchIds: [String(batch._id)], discountPercent: 10 }, c)).status, 403);
  });

  test('an unknown action is refused', async () => {
    const { batch } = await makeLot();
    assert.equal((await act({ action: 'incinerate', batchIds: [String(batch._id)] })).status, 400);
  });

  test('an empty or oversized list of lots is refused', async () => {
    assert.equal((await act({ action: 'clearance', batchIds: [], discountPercent: 10 })).status, 400);
    assert.equal((await act({ action: 'clearance', batchIds: Array.from({ length: 201 }, () => '0'.repeat(24)), discountPercent: 10 })).status, 400);
  });

  test('a lot that does not exist is refused before anything is written', async () => {
    const { batch } = await makeLot({ qty: 25 });
    const r = await act({ action: 'dispose', batchIds: [String(batch._id), '0'.repeat(24)], reason: 'Mixed list' });
    assert.equal(r.status, 404);
    assert.equal((await reload(batch._id)).availableQuantity, 25, 'the real lot in the list was untouched');
  });
});
