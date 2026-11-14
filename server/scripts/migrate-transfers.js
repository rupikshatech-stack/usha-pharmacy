// Usage: npm run migrate   (runs after migrate-inventory.js)
// Prepares an existing database for stores and inter-store transfers. Idempotent.
//   - every organization gets its default store ("Main Store")
//   - every batch that has no store recorded is assigned to its organization's default store
//   - the batch-number uniqueness rule becomes per store (the old per-medicine index is dropped, new indexes are built)
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { Batch, Branch, Transfer } from '../models/index.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const orgs = db.collection('organizations');
  const branches = db.collection('branches');
  const batches = db.collection('batches');
  const now = new Date();

  let created = 0;
  let assigned = 0;
  for (const org of await orgs.find({}, { projection: { _id: 1 } }).toArray()) {
    let def = await branches.findOne({ organizationId: org._id, isDefault: true });
    if (!def) {
      const doc = { organizationId: org._id, name: 'Main Store', code: 'MAIN', address: '', phone: '', isDefault: true, status: 'active', createdAt: now, updatedAt: now };
      doc._id = (await branches.insertOne(doc)).insertedId;
      def = doc;
      created += 1;
    }
    const r = await batches.updateMany({ organizationId: org._id, $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId: def._id } });
    assigned += r.modifiedCount;
  }
  say(`default stores created: ${created}`);
  say(`batches assigned to their default store: ${assigned}`);

  // The old rule (unique per medicine + batch number) would stop the same lot from existing in two stores.
  try {
    await batches.dropIndex('organizationId_1_medicineId_1_batchNumber_1');
    say('dropped the old per-medicine batch-number index');
  } catch (e) {
    if (!/index not found|ns not found/i.test(e.message)) throw e;
  }
  for (const M of [Batch, Branch, Transfer]) {
    await M.syncIndexes();
    say(`indexes synced: ${M.modelName}`);
  }
  // Transfers made before approval existed: 'pending' (sent) became 'in_transit' (dispatched).
  const transfers = db.collection('transfers');
  const moved = await transfers.updateMany({ status: 'pending' }, { $set: { status: 'in_transit' } });
  for (const [from, to] of [['sentAt', 'dispatchedAt'], ['sentBy', 'dispatchedBy']]) await transfers.updateMany({ [from]: { $exists: true } }, { $rename: { [from]: to } });
  say(`transfers renamed from pending to in transit: ${moved.modifiedCount}`);
  // Transfers dispatched before partial dispatch existed sent every line in full: record that, so each line shows what was sent.
  // (Code also treats a missing dispatchedQuantity this way, so this only makes the stored data explicit.)
  const filled = await transfers.updateMany({ status: { $in: ['in_transit', 'completed'] }, 'items.dispatchedQuantity': { $exists: false } }, [
    { $set: { items: { $map: { input: '$items', as: 'line', in: { $mergeObjects: ['$$line', { dispatchedQuantity: { $ifNull: ['$$line.dispatchedQuantity', '$$line.quantity'] } }] } } } } },
  ]);
  say(`older transfers given explicit dispatched quantities: ${filled.modifiedCount}`);
  say('done');
} catch (e) {
  console.error('[migrate] failed:', e);
  exitCode = 1;
} finally {
  await disconnectDb?.();
  process.exit(exitCode);
}
