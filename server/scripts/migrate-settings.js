// Usage: npm run migrate   (runs after migrate-expiry.js)
//
// Prepares an existing database for Settings & Configuration. IDEMPOTENT: every step either fills in a field that is
// missing or raises a counter that is behind, so running it twice changes nothing the second time. It reports exactly
// what it touched.
//
// What it deliberately does NOT do:
//   * It does not write invoice numbering series. The defaults in utils/documentNumber.js already reproduce the
//     format this system has always used (INV-00001, ORD-0001, SR-0001), so an organization that never opens the
//     settings screen keeps numbering exactly as before. Storing a copy of the defaults would only create something
//     that can drift from them.
//   * It does not guess an owner, a bank account or a drug licence. A wrong licence number on an invoice is worse
//     than a blank one, and somebody has to type those in.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { applySettingsDefaults } from './lib/settingsMigration.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { seedCounters } from '../services/documentNumbering.service.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const orgs = await db.collection('organizations').find({}, { projection: { _id: 1, gstin: 1, name: 1 } }).toArray();
  say(`organizations: ${orgs.length}`);

  // 1 + 2. The settings blocks at their defaults wherever they are missing, the one-off default correction, and the
  //        PAN read out of each GSTIN. All of it lives in scripts/lib/settingsMigration.js so the test that proves a
  //        migrated organization bills like a legacy one runs the very same code.
  const r = await applySettingsDefaults(db);
  say(`default settings fields filled in: ${r.filled}`);
  say(`invoice print toggles set: ${r.toggles}`);
  say(`notification preferences created: ${r.notifications}`);
  say(`defaults corrected to match what the system already did: ${r.corrected}`);
  say(`PANs derived from existing GSTINs: ${r.pans}`);

  /**
   * 3. The counters — raised only from documents that ARE of the series, never from anything that merely ends in a
   *    number. The first version of this step read the trailing digits off every document, and so raised a sales
   *    counter from 7 to 90 because of a demo row called EXP-DEMO-090; the next invoice would then have skipped
   *    eighty-three serials, which for GST invoices is a compliance problem even though nothing collided.
   *
   *    It now runs exactly the rule the settings screen runs on every save (`seedCounters`): a number must be what
   *    the series would have printed, and must follow on from the numbers below it. Anything else is listed here for a
   *    person to look at and is never used. It still only RAISES; it never lowers a counter, so it is safe to re-run.
   */
  for (const org of orgs) {
    const full = await db.collection('organizations').findOne({ _id: org._id });
    const branches = await db.collection('branches').find({ organizationId: org._id }).project({ name: 1 }).toArray();
    const report = await runWithTenant(org._id, () => seedCounters({ orgId: org._id, org: full, branches }));
    for (const r of report) {
      if (r.raised) say(`  ${org.name}: ${r.label} counter raised ${r.counterWas} -> ${r.counterNow} (highest valid number ${r.highestNumber})`);
      if (r.gap) say(`  ${org.name}: ${r.label} counter is ${r.gap} ABOVE its highest valid document — left alone; run scripts/seed-invoice-counters.js --dry-run to review`);
      if (r.needsReview.length) say(`  ${org.name}: ${r.needsReview.length} ${r.label.toLowerCase()} document(s) not in the series' format or out of sequence — not used (list them with scripts/seed-invoice-counters.js --dry-run --all)`);
    }
  }

  say('done');
} catch (e) {
  exitCode = 1;
  console.error('[migrate] FAILED:', e);
} finally {
  await disconnectDb();
  process.exit(exitCode);
}
