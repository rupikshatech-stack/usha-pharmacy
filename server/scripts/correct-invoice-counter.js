// Usage:
//   node scripts/correct-invoice-counter.js --dry-run [--org <id>] [--series sales] [--to <n>]
//   node scripts/correct-invoice-counter.js --apply --reason "<why>" [--org <id>] [--series sales] [--to <n>]
//
// LOWERS a document counter that stands above every number its series has actually issued. This is the one thing the
// rest of the system never does - a counter only goes up, because lowering one is how a number gets issued twice - so
// it is a separate, deliberate, narrow tool rather than an option on anything else.
//
//   * It is a DRY RUN unless you pass --apply, and --apply needs a --reason.
//   * It checks, in the same transaction that writes, that NO document of the series carries a number above the
//     target - including ones seeding treats as outliers. If any does, it aborts and names them.
//   * It only lowers; a target at or above the counter is refused.
//   * It writes a SETTINGS_COUNTER_CORRECTED audit entry in that same transaction.
//   * --to defaults to the highest number that actually belongs to the series.
//
// TAKE A BACKUP FIRST. This script does not make one for you.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { correctCounter } from '../services/documentNumbering.service.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const apply = process.argv.includes('--apply');
const dryRun = !apply;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');
  const reason = arg('reason');
  if (apply && !String(reason || '').trim()) throw new Error('--apply needs --reason "<why>": a counter correction is a change to the sequence behind real invoice numbers.');

  await connectDb();
  const db = mongoose.connection.db;
  const orgs = await db.collection('organizations').find(arg('org') ? { _id: new mongoose.Types.ObjectId(arg('org')) } : {}).toArray();
  if (orgs.length !== 1) throw new Error(`${orgs.length} organizations found. Pass --org <id> to say which one.`);
  const org = orgs[0];
  const series = arg('series', 'sales');
  const to = arg('to') === null ? undefined : Number(arg('to'));

  say(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'APPLYING'}`);
  say(`organization  ${org.name}  (${org._id})`);

  const report = await runWithTenant(org._id, () =>
    correctCounter({ orgId: org._id, org, series, to, reason, dryRun, actor: 'script: correct-invoice-counter' }),
  );

  say(`series        ${report.series}   counter key ${report.key}`);
  say(`documents     ${report.documents} in scope (${report.needsReview} not in the series' format or out of sequence)`);
  say(`highest valid ${report.highestValid}   highest carrying this series' format ${report.highestOfSeries}`);
  say(`counter now   ${report.counterWas}`);
  say(`target        ${report.target}   (the next number would then be ${report.wouldBeNext})`);
  say('');
  if (report.aborted) {
    say(`ABORTED — ${report.aborted}`);
    exitCode = 2;
  } else if (report.applied) {
    say(`DONE — counter lowered ${report.counterWas} -> ${report.target}. SETTINGS_COUNTER_CORRECTED written.`);
  } else {
    say(`Safe to apply: no document of this series carries a number above ${report.target}.`);
    say('Nothing was written. Re-run with --apply --reason "<why>" to make the change.');
  }
  say();
} catch (e) {
  exitCode = 1;
  console.error('[correct-counter] FAILED:', e.message);
} finally {
  await disconnectDb();
  process.exit(exitCode);
}
