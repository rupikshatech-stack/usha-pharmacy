// Usage:
//   node scripts/migrate-expiry-alerts.js --dry-run      (the default)
//   node scripts/migrate-expiry-alerts.js --apply
//
// Prepares a database for the near-expiry email digest. It is ADDITIVE and touches no existing document.
//
// Being honest about what this does, because a migration that quietly does nothing is worse than no migration:
//
//   * It creates the `expiryalerts` and `alertruns` collections and their UNIQUE indexes. Those indexes are not
//     decoration — they are what makes the job idempotent. (org, kind, runDate) is what stops a second run of the
//     day sending a second digest, and (org, batchId) is what stops a batch being recorded twice.
//   * It BACKFILLS NOTHING. No organization's settings change: `notifications.nearExpiry` already exists with a
//     channel of 'in_app', and switching an organization over to email is a decision somebody makes on the
//     Settings screen, not something a migration should make on their behalf. Running this does not cause a single
//     email to be sent to anybody.
//
// Idempotent: creating an index that already exists is a no-op, so a second run reports the same thing.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { AlertRun, ExpiryAlert } from '../models/index.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');
  await connectDb();
  const db = mongoose.connection.db;

  say(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'APPLYING'}`);

  const existing = (await db.listCollections().toArray()).map((c) => c.name);
  const wanted = [
    { name: 'expiryalerts', model: ExpiryAlert, index: '{ organizationId, batchId } unique' },
    { name: 'alertruns', model: AlertRun, index: '{ organizationId, kind, runDate } unique' },
  ];

  say('');
  for (const w of wanted) {
    const there = existing.includes(w.name);
    say(`  ${w.name.padEnd(14)} ${there ? 'exists' : dryRun ? 'would be created' : 'created'}   index ${w.index}`);
    if (!dryRun) await w.model.init(); // builds the collection and its indexes
  }

  const orgs = await db.collection('organizations').countDocuments();
  say('');
  say(`organizations: ${orgs} — none are modified. 'notifications.nearExpiry' keeps whatever channel it has;`);
  say("switching one to 'email' is done on the Settings screen, never by this script.");
  say('');

  if (!dryRun) {
    for (const w of wanted) {
      const idx = await db.collection(w.name).indexes();
      const unique = idx.filter((i) => i.unique).map((i) => JSON.stringify(i.key));
      say(`  ${w.name}: unique indexes ${unique.join(', ') || '(none!)'}`);
    }
    say('');
  }

  say(dryRun ? 'Nothing was written. Re-run with --apply.' : 'done');
  say('');
} catch (e) {
  exitCode = 1;
  console.error('[migrate-expiry-alerts] FAILED:', e.message);
} finally {
  await disconnectDb().catch(() => {});
  process.exit(exitCode);
}
