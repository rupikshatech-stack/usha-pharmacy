// Usage: npm run migrate   (runs after migrate-tenancy.js)
// Upgrades existing data for dashboard analytics. Idempotent.
//   - invoices: adds invoiceDate (= createdAt) and renames the old "returned" status to "reversed"
//   - organizations: adds timezone (Asia/Kolkata) and reporting settings (Indian fiscal year)
//   - syncs indexes
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { Batch, Invoice, Organization } from '../models/index.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;

  // ---- invoices: invoiceDate defaults to the creation time (when the sale was recorded)
  const invoices = db.collection('invoices');
  const dated = await invoices.updateMany({ invoiceDate: { $exists: false } }, [{ $set: { invoiceDate: '$createdAt' } }]);
  say(`invoices given an invoiceDate: ${dated.modifiedCount}`);

  // ---- invoices: the old "returned" status is now "reversed"
  const reversed = await invoices.updateMany({ status: 'returned' }, [{ $set: { status: 'reversed', reversedAt: { $ifNull: ['$reversedAt', '$updatedAt'] } } }]);
  say(`invoices renamed returned -> reversed: ${reversed.modifiedCount}`);

  // ---- organizations: timezone + reporting settings
  const orgs = db.collection('organizations');
  const tz = await orgs.updateMany({ timezone: { $exists: false } }, { $set: { timezone: 'Asia/Kolkata' } });
  const rp = await orgs.updateMany({ 'settings.reportingPeriod': { $exists: false } }, { $set: { 'settings.reportingPeriod': 'fiscal_year' } });
  const fy = await orgs.updateMany({ 'settings.fiscalYearStartMonth': { $exists: false } }, { $set: { 'settings.fiscalYearStartMonth': 4 } });
  say(`organizations updated: timezone ${tz.modifiedCount}, reportingPeriod ${rp.modifiedCount}, fiscalYearStartMonth ${fy.modifiedCount}`);

  for (const M of [Organization, Invoice, Batch]) {
    await M.syncIndexes();
    say(`indexes synced: ${M.modelName}`);
  }
  say('done');
} catch (err) {
  console.error(`[migrate] Failed: ${err.message}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
