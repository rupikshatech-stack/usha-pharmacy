// Usage: npm run migrate   (runs after migrate-suppliers.js)
// Prepares an existing database for branch-level reporting. Idempotent.
//   - every invoice made before sales recorded their store is attributed to the organization's default store,
//     which is where the Selling Point always sold from
//   - the indexes the analytics aggregations rely on are built
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const invoices = db.collection('invoices');
  const branches = db.collection('branches');

  let attributed = 0;
  for (const organizationId of await invoices.distinct('organizationId')) {
    const def = await branches.findOne({ organizationId, isDefault: true }, { projection: { _id: 1, name: 1 } });
    if (!def) {
      say(`no default store for organization ${organizationId}; its invoices keep no store`);
      continue;
    }
    const r = await invoices.updateMany(
      { organizationId, $or: [{ branchId: { $exists: false } }, { branchId: null }] },
      { $set: { branchId: def._id, branchName: def.name } },
    );
    attributed += r.modifiedCount;
  }
  say(`invoices attributed to their default store: ${attributed}`);

  for (const [collection, index] of [
    ['invoices', { organizationId: 1, branchId: 1, invoiceDate: -1 }],
    ['invoices', { organizationId: 1, status: 1, invoiceDate: -1 }],
    ['orders', { organizationId: 1, status: 1, orderDate: -1 }],
    ['salesreturns', { organizationId: 1, status: 1, createdAt: -1 }],
    ['batches', { organizationId: 1, expiryDate: 1, availableQuantity: -1 }],
    ['salesreturns', { organizationId: 1, status: 1, returnDate: -1 }],
    ['goodsreceiptreversals', { organizationId: 1, reversedAt: -1 }], // purchase returns in the transaction ledger
    ['transfers', { organizationId: 1, transferDate: -1 }],
  ]) {
    try {
      await db.collection(collection).createIndex(index);
    } catch (e) {
      say(`could not build an index on ${collection}: ${e.message}`);
      exitCode = 1;
    }
  }
  say('reporting indexes are in place');
} catch (e) {
  console.error('[migrate] analytics failed:', e);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
