// Usage:
//   node scripts/migrate-roles.js --dry-run          (the default; nothing is written)
//   node scripts/migrate-roles.js --apply
//
// Turns the five built-in roles into editable rows, for every organization. Idempotent: it creates a system row that
// is missing and nothing else, so a second run reports "created: 0".
//
// It never touches a user document. A user whose role key the code does not recognise is listed for review; see
// scripts/lib/rolesMigration.js for why repairing that automatically would be the wrong thing.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { seedSystemRoles } from './lib/rolesMigration.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');
  await connectDb();
  const db = mongoose.connection.db;

  say(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'APPLYING'}`);
  const r = await seedSystemRoles(db, { dryRun });
  say(`organizations ${r.organizations}`);
  say('');

  for (const o of r.perOrg) {
    say(`${o.name}  (${o._id})`);
    say(`  system roles already present  ${o.existing.length ? o.existing.join(', ') : 'none'}`);
    say(`  system roles ${dryRun ? 'to create' : 'created'}      ${o.created.length ? o.created.join(', ') : 'none — nothing to do'}`);
  }

  say('');
  if (r.unknownRoles.length) {
    say(`NEEDS REVIEW — ${r.unknownRoles.length} user(s) hold a role key this code does not recognise. They are NOT changed:`);
    for (const u of r.unknownRoles) say(`  ${u.name} <${u.email}> role "${u.role}" in ${u.organization}  (${u._id})`);
    say('');
  }

  say(`total: ${r.created} system role row(s) ${dryRun ? 'would be created' : 'created'}, ${r.existing} already present`);
  if (dryRun) say('Nothing was written. Re-run with --apply to make the change.');
  say('');
} catch (e) {
  exitCode = 1;
  console.error('[migrate-roles] FAILED:', e.message);
} finally {
  await disconnectDb();
  process.exit(exitCode);
}
