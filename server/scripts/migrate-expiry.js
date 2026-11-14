// Usage: npm run migrate   (runs after migrate-analytics.js)
//
// Prepares an existing database for Inventory Expiry Intelligence. IDEMPOTENT: every step either sets a field that is
// missing or builds an index that is not there, so running it twice changes nothing the second time and it is safe to
// re-run after a failure. It reports exactly what it touched.
//
// What it deliberately does NOT do: guess `scheduleCategory` from the free-text details already on a medicine. A wrong
// guess about a Schedule H1 drug is worse than an honest blank, so every medicine starts at '' and someone decides.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;

  // 1. The lot fields the expiry actions write. Only `clearance.flagged` gets a value: a lot nobody has flagged is not
  //    on clearance. The rest stay absent until something actually happens to the lot, so "never disposed of" and
  //    "disposed of at no particular time" can never be confused.
  const flagged = await db.collection('batches').updateMany({ 'clearance.flagged': { $exists: false } }, { $set: { 'clearance.flagged': false } });
  say(`lots given a clearance flag: ${flagged.modifiedCount}`);

  // 2. The drug schedule, left blank for a person to fill in.
  const scheduled = await db.collection('medicines').updateMany({ scheduleCategory: { $exists: false } }, { $set: { scheduleCategory: '' } });
  say(`medicines given a (blank) drug schedule: ${scheduled.modifiedCount}`);

  // 3. Each organization's own thresholds, at the defaults, where it has none.
  const settings = await db.collection('organizations').updateMany(
    { 'settings.expiry': { $exists: false } },
    { $set: { 'settings.expiry': { thresholds: [15, 30, 90], velocityWindowDays: 60, supplierReturnWindowDays: 90, clearanceMaxDiscount: 50 } } },
  );
  say(`organizations given expiry settings: ${settings.modifiedCount}`);

  // 4. The indexes the register and its aggregations rely on. createIndex is itself idempotent.
  let built = 0;
  for (const [collection, index, options] of [
    ['batches', { organizationId: 1, branchId: 1, expiryDate: 1, availableQuantity: 1 }, {}],
    ['batches', { organizationId: 1, expiryDate: 1, availableQuantity: 1, branchId: 1 }, {}],
    ['batches', { organizationId: 1, 'clearance.flagged': 1, expiryDate: 1 }, { partialFilterExpression: { 'clearance.flagged': true } }],
    ['batches', { organizationId: 1, 'supplierReturn.status': 1, expiryDate: 1 }, { partialFilterExpression: { 'supplierReturn.status': { $type: 'string' } } }],
    ['batches', { organizationId: 1, disposedAt: -1 }, { partialFilterExpression: { disposedAt: { $type: 'date' } } }],
    ['medicines', { organizationId: 1, scheduleCategory: 1, medicineName: 1 }, {}],
    // Sales velocity: completed invoices of the window, unwound to their lines.
    ['invoices', { organizationId: 1, status: 1, invoiceDate: 1, branchId: 1 }, {}],
    ['invoices', { organizationId: 1, 'items.medicineId': 1, invoiceDate: -1 }, {}],
  ]) {
    try {
      await db.collection(collection).createIndex(index, options);
      built += 1;
    } catch (e) {
      say(`could not build an index on ${collection}: ${e.message}`);
      exitCode = 1;
    }
  }
  say(`expiry indexes in place: ${built}`);
} catch (e) {
  console.error('[migrate] expiry failed:', e);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
