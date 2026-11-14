/**
 * Removing an organization: the logic, separated from the command-line wrapper so the tests run the very same code
 * the script does. There is no second implementation to drift.
 *
 * See scripts/remove-organization.js for what this refuses and why.
 */

/**
 * The collections creating a pharmacy actually produces. Everything here is removable; anything else is evidence
 * the pharmacy has been used, or that this list is stale — and either way the honest answer is to refuse.
 */
export const SAFE_TO_REMOVE = ['users', 'roles', 'auditlogs', 'sessions', 'counters', 'branches'];

/**
 * Everything that belongs to this organization, discovered by walking every collection in the database rather than
 * consulting a list. A collection added after this was written therefore shows up as "not removable" and stops the
 * removal, instead of being silently skipped and left pointing at an organization that no longer exists.
 */
export async function inspect(db, orgId, { session = null } = {}) {
  const org = await db.collection('organizations').findOne({ _id: orgId }, { session });
  if (!org) return null;

  const found = [];
  for (const { name } of await db.listCollections().toArray()) {
    const n = await db.collection(name).countDocuments({ organizationId: orgId }, { session });
    if (n) found.push({ name, n });
  }
  found.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

  const users = await db.collection('users').find({ organizationId: orgId }, { session }).project({ name: 1, email: 1, role: 1 }).toArray();

  return {
    org,
    found,
    users,
    unexpected: found.filter((f) => !SAFE_TO_REMOVE.includes(f.name)),
    total: found.reduce((n, f) => n + f.n, 0),
  };
}

/**
 * Removes the organization, everything that belongs to it, and writes the record of having done so — all in one
 * transaction, so a half-removed organization cannot exist.
 *
 * The guarded collections are counted AGAIN inside that transaction. The dry run and the apply are two separate
 * moments, and a pharmacy that sold something in between must not be erased because a check made a minute earlier
 * said it was empty.
 */
export async function remove(db, client, { orgId, reason, dryRun = true, actor = 'script: remove-organization', now = new Date() }) {
  const report = await inspect(db, orgId);
  if (!report) return { aborted: `No organization with id ${orgId}.` };

  if (report.unexpected.length) {
    return {
      ...report,
      aborted: `This pharmacy has been used: ${report.unexpected.map((u) => `${u.n} ${u.name}`).join(', ')}.`,
      blockedBy: report.unexpected,
    };
  }
  if (!dryRun && !String(reason || '').trim()) {
    return { ...report, aborted: 'A removal needs a reason: it is permanent, and this is the only record of why it happened.' };
  }
  if (dryRun) return { ...report, applied: false };

  const session = client.startSession();
  const deleted = {};
  let aborted = null;
  try {
    await session.withTransaction(async () => {
      for (const { name } of await db.listCollections().toArray()) {
        if (SAFE_TO_REMOVE.includes(name)) continue;
        const n = await db.collection(name).countDocuments({ organizationId: orgId }, { session });
        if (n) {
          aborted = `${n} ${name} appeared for this organization since the check. Nothing was deleted.`;
          throw new Error(aborted);
        }
      }

      for (const name of SAFE_TO_REMOVE) {
        const r = await db.collection(name).deleteMany({ organizationId: orgId }, { session });
        if (r.deletedCount) deleted[name] = r.deletedCount;
      }
      const r = await db.collection('organizations').deleteOne({ _id: orgId }, { session });
      deleted.organizations = r.deletedCount;

      // Platform-level, with no organizationId: the organization it would otherwise belong to is the one being
      // deleted, so an ordinary audit row would be removed by the very deletion it records.
      await db.collection('auditlogs').insertOne(
        {
          isPlatform: true,
          userName: actor,
          action: 'ORGANIZATION_REMOVED',
          entity: 'Organization',
          entityId: orgId,
          message: `Organization "${report.org.name}" (${report.org.slug}) removed: ${String(reason).trim()}`,
          meta: { organizationId: String(orgId), name: report.org.name, slug: report.org.slug, reason: String(reason).trim(), deleted },
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
    });
  } catch (e) {
    if (!aborted) throw e;
  } finally {
    await session.endSession();
  }

  if (aborted) return { ...report, aborted, applied: false };
  return { ...report, applied: true, deleted };
}
