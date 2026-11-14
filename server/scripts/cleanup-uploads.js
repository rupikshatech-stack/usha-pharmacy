// Usage: node scripts/cleanup-uploads.js [--hours 24] [--dry-run]
//
// Sweeps licence scans that were uploaded and then never attached to a licence — a form abandoned, a tab closed, a
// Discard pressed. Every upload in this system is stored the moment it is chosen, so the only thing that tells an
// abandoned file apart from one somebody is still working with is its AGE.
//
// SAFE BY CONSTRUCTION:
//   * a file still referenced by a licence is never touched, whatever its age
//   * a file younger than the grace period (24 hours by default) is never touched, however unreferenced it looks
//   * --dry-run reports exactly what it would delete and deletes nothing
//
// The same sweep runs after each settings save, so this script is only needed for a one-off clear-out or from cron.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { sweepAbandonedDocuments } from '../services/settingsFiles.service.js';
import { getStorage } from '../services/storage/index.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const dryRun = process.argv.includes('--dry-run');
const hours = Number(arg('hours', 24));
const say = (m) => console.log(`[cleanup] ${m}`);
let exitCode = 0;

try {
  if (!Number.isFinite(hours) || hours < 0) throw new Error('--hours must be a number of hours');
  await connectDb();
  const db = mongoose.connection.db;
  const orgs = await db.collection('organizations').find({}, { projection: { _id: 1, name: 1, licenses: 1 } }).toArray();
  const olderThanMs = hours * 3600 * 1000;
  const now = Date.now();
  say(`${orgs.length} organization(s); grace period ${hours}h${dryRun ? ' (DRY RUN — nothing will be deleted)' : ''}`);

  let totalRemoved = 0;
  let totalKept = 0;
  for (const org of orgs) {
    const referenced = new Set((org.licenses || []).map((l) => l?.document?.storageKey).filter(Boolean));
    const files = await getStorage().list(`${org._id}/licenses`);
    if (!files.length) continue;

    const candidates = files.filter((f) => !referenced.has(f.key));
    const old = candidates.filter((f) => now - new Date(f.modifiedAt).getTime() >= olderThanMs);
    const young = candidates.length - old.length;

    for (const f of old) say(`  ${dryRun ? 'would remove' : 'removing'} ${f.key} (${Math.round(f.size / 1024)} KB, last written ${new Date(f.modifiedAt).toISOString()})`);
    if (!dryRun && old.length) {
      const result = await sweepAbandonedDocuments(org._id, org.licenses || [], { now, olderThanMs });
      totalRemoved += result.removed;
      totalKept += result.keptYoung;
    } else {
      totalRemoved += dryRun ? old.length : 0;
      totalKept += young;
    }
    say(`${org.name}: ${files.length} file(s), ${referenced.size} referenced, ${old.length} ${dryRun ? 'would be removed' : 'removed'}, ${young} too recent to touch`);
  }
  say(`done — ${totalRemoved} ${dryRun ? 'would be removed' : 'removed'}, ${totalKept} kept for being younger than ${hours}h`);
} catch (e) {
  exitCode = 1;
  console.error('[cleanup] FAILED:', e);
} finally {
  await disconnectDb();
  process.exit(exitCode);
}
