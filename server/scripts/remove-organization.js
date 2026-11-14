// Usage:
//   node scripts/remove-organization.js --list
//   node scripts/remove-organization.js --org <id>                              (dry run; the default)
//   node scripts/remove-organization.js --org <id> --apply --reason "<why>"
//
// Removes an organization that should never have existed — a test pharmacy, a duplicate, an onboarding typo. It is
// the ONLY way to remove one: there is deliberately no delete endpoint in the API, because deleting a pharmacy that
// has traded is not something a web request should ever be able to do.
//
// WHAT IT REFUSES, AND WHY THAT IS THE POINT:
//
//   * An organization that has TRADED. Invoices, stock movements, batches, medicines, suppliers — anything beyond
//     the rows onboarding itself creates. A pharmacy's records are the product; a script that could erase them
//     because somebody typed the wrong id is a liability, not a convenience. If one exists, this names the
//     collection and stops. Suspending the organization (status: 'suspended') is the answer there: it blocks every
//     sign-in and every request while leaving the history intact.
//   * ANYTHING it does not recognise. The safe list in lib/removeOrganization.js is what creating a pharmacy
//     actually produces. A collection outside it means this script's idea of an organization is out of date, and
//     the honest response is to refuse and be fixed — not to guess, and not to leave orphaned rows behind.
//
// HOW IT DELETES: one transaction across every collection, with the guarded collections counted again INSIDE that
// transaction, so a pharmacy that sold something between the dry run and the apply is not erased on the strength
// of a check made a minute earlier.
//
// TAKE A BACKUP FIRST. This script does not make one for you, and nothing it deletes can be recovered without one.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { SAFE_TO_REMOVE, remove } from './lib/removeOrganization.js';

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
  await connectDb();
  const db = mongoose.connection.db;

  if (process.argv.includes('--list')) {
    say('\nOrganizations on this installation:\n');
    for (const o of await db.collection('organizations').find({}).project({ name: 1, slug: 1, status: 1, createdAt: 1 }).toArray()) {
      const invoices = await db.collection('invoices').countDocuments({ organizationId: o._id });
      say(`  ${String(o._id)}  ${o.name}  (${o.slug})  ${o.status}  invoices: ${invoices}  created ${o.createdAt?.toISOString?.().slice(0, 10) || '?'}`);
    }
    say('');
    await disconnectDb();
    process.exit(0);
  }

  const id = arg('org');
  if (!id) throw new Error('Pass --org <id>. Use --list to see them.');
  if (!mongoose.Types.ObjectId.isValid(id)) throw new Error(`"${id}" is not a valid organization id.`);
  const orgId = new mongoose.Types.ObjectId(id);
  const reason = arg('reason');

  const r = await remove(db, mongoose.connection.getClient(), { orgId, reason, dryRun });

  if (!r.org) throw new Error(r.aborted);

  say(`\n${dryRun ? 'DRY RUN — nothing will be deleted' : 'APPLYING'}`);
  say(`organization  ${r.org.name}  (${r.org.slug})`);
  say(`id            ${r.org._id}`);
  say(`created       ${r.org.createdAt?.toISOString?.() || 'unknown'}`);
  say('');

  say('rows that belong to this organization:');
  if (!r.found.length) say('  (none — only the organization document itself)');
  for (const f of r.found) say(`  ${f.name.padEnd(22)} ${String(f.n).padStart(5)}${SAFE_TO_REMOVE.includes(f.name) ? '' : '   <-- NOT removable'}`);
  say('');

  if (r.users.length) {
    say('accounts that would be deleted:');
    for (const u of r.users) say(`  ${u.role.padEnd(18)} ${u.name} <${u.email}>`);
    say('');
  }

  if (r.aborted) {
    say(`REFUSED — ${r.aborted}`);
    if (r.blockedBy) {
      say('');
      say('Those are business records: deleting them is not something this script will do. If the organization');
      say("should stop working, suspend it instead (status: 'suspended'), which blocks every sign-in and every");
      say('request while leaving its history intact.');
    }
    say('');
    exitCode = 2;
  } else if (r.applied) {
    say('DONE — removed:');
    for (const [name, n] of Object.entries(r.deleted)) say(`  ${name.padEnd(22)} ${n}`);
    say('');
    say('An ORGANIZATION_REMOVED audit row was written at platform level.');
    say('');
  } else {
    say(`Safe to remove: ${r.total} row(s) across ${r.found.length} collection(s), plus the organization itself.`);
    say('Nothing was deleted. Re-run with --apply --reason "<why>" to make the change. TAKE A BACKUP FIRST.');
    say('');
  }
} catch (e) {
  exitCode = 1;
  console.error('[remove-organization] FAILED:', e.message);
} finally {
  await disconnectDb().catch(() => {});
  process.exit(exitCode);
}
