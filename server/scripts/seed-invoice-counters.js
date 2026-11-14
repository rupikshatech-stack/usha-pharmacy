// Usage: node scripts/seed-invoice-counters.js [--dry-run] [--all] [--org <id>]
//
// Makes certain that every numbering series a configuration can reach has a counter standing at least as high as the
// highest number that series has already issued UNDER ITS OWN FORMAT. It never lowers a counter, never renames one,
// and never touches a document.
//
// WHICH DOCUMENTS COUNT. GST invoice serials are meant to be consecutive within a series and a financial year, so a
// counter that JUMPS is a compliance problem even when nothing collides. A document seeds a counter only if its number
// is exactly what the series would have printed for it, and even then only if it is within 1000 of the number below
// it. Everything else is listed here as NEEDS REVIEW, with its _id, and is never used. The right answer for such a
// document — a demo row, a mistyped import, a genuine gap — is not one a script can know.
//
// This runs the same `seedCounters` the settings screen runs on every save, so the dry run and the real thing cannot
// disagree about what they would do.
//
//   --dry-run   report what would be written, write nothing (run this first)
//   --all       print every document that needs review (by default the first 12 per series, then a count)
//   --org <id>  one organization only
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { seedCounters } from '../services/documentNumbering.service.js';

const dryRun = process.argv.includes('--dry-run');
const showAll = process.argv.includes('--all');
const orgArg = process.argv.indexOf('--org') > -1 ? process.argv[process.argv.indexOf('--org') + 1] : null;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const filter = orgArg ? { _id: new mongoose.Types.ObjectId(orgArg) } : {};
  const orgs = await db.collection('organizations').find(filter).toArray();

  say(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'WRITING'}`);
  say(`${orgs.length} organization(s)\n`);

  let raised = 0;
  let review = 0;
  let gaps = 0;
  for (const org of orgs) {
    const branches = await db.collection('branches').find({ organizationId: org._id }).project({ name: 1 }).toArray();
    const report = await runWithTenant(org._id, () => seedCounters({ orgId: org._id, org, branches, dryRun }));
    const perBranch = Boolean(org.settings?.invoice?.perBranch);

    say('='.repeat(78));
    say(`${org.name}   (per-store numbering ${perBranch ? 'ON' : 'off'})`);
    say('='.repeat(78));

    for (const r of report) {
      say(`\n  ${r.label}  ·  ${r.scope}`);
      say(`    counter key          ${r.key}`);
      say(`    documents in scope   ${r.documents}  (${r.usable} usable, ${r.needsReview.length} need review)`);
      say(`    highest valid        ${r.highestNumber ? `${r.highestNumber}  (sequence ${r.highestIssued})` : 'none'}`);
      say(`    counter now          ${r.counterWas}`);
      say(`    ${r.raised ? `WOULD RAISE  ${r.counterWas} -> ${r.counterNow}   next number becomes ${r.nextNumber}` : `no change needed   next number ${r.nextNumber}`}`);

      if (r.gap > 0) {
        say(`    !! GAP: the counter is ${r.gap} above the highest valid document, so the next number SKIPS ${r.gap} serial(s).`);
        say('       This script never lowers a counter. Decide whether the numbers between are real before changing it by hand.');
        gaps += 1;
      }

      if (r.needsReview.length) {
        say(`\n    NEEDS REVIEW — ${r.needsReview.length} document(s), NOT used for seeding:`);
        const shown = showAll ? r.needsReview : r.needsReview.slice(0, 12);
        for (const d of shown) say(`      ${String(d._id)}  ${d.number}   ${d.reason}`);
        if (shown.length < r.needsReview.length) say(`      … and ${r.needsReview.length - shown.length} more (run with --all to list every one)`);
        review += r.needsReview.length;
      }
      if (r.raised) raised += 1;
    }
    say();
  }

  say('='.repeat(78));
  say(`${dryRun ? `${raised} counter(s) WOULD be raised. Nothing was written.` : `${raised} counter(s) raised.`}`);
  say(`${review} document(s) need review (never used for seeding).${gaps ? `  ${gaps} series with a counter ahead of its documents.` : ''}`);
  say('No document was modified.\n');
} catch (e) {
  exitCode = 1;
  console.error('[seed] FAILED:', e);
} finally {
  await disconnectDb();
  process.exit(exitCode);
}
