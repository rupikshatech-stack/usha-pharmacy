import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '../../config/permissions.js';

/**
 * Turns the five built-in roles into rows, for every organization.
 *
 * IDEMPOTENT, AND DELIBERATELY TIMID. It creates a system row that is missing and does nothing else. In particular it
 * never rewrites the permissions of a row that already exists, because by the second run those may be what somebody
 * chose on purpose, and a migration that quietly puts a permission back is indistinguishable from a bug. Running it
 * twice therefore reports "created: 0" the second time, which is the proof we want.
 *
 * It also never touches a user. A user whose `role` names something the code has never heard of is REPORTED, not
 * repaired: we cannot know whether it was a typo or a role a developer meant to add, and guessing either way is how a
 * person silently gains or loses access. Until somebody decides, that user keeps exactly the permissions they had
 * (`effectivePermissions` falls back to the built-in map, and an unknown key there grants nothing new).
 */
export async function seedSystemRoles(db, { dryRun = true, now = new Date() } = {}) {
  const orgs = await db.collection('organizations').find({}, { projection: { _id: 1, name: 1 } }).toArray();
  const report = { organizations: orgs.length, created: 0, existing: 0, perOrg: [], unknownRoles: [] };

  for (const org of orgs) {
    const rows = await db.collection('roles').find({ organizationId: org._id }).project({ key: 1, isSystem: 1 }).toArray();
    const have = new Set(rows.map((r) => r.key));
    const missing = SYSTEM_ROLES.filter((r) => !have.has(r.key));

    const docs = missing.map((r) => ({
      organizationId: org._id,
      key: r.key,
      name: r.name,
      description: r.description,
      scope: 'organization',
      // Exactly what the code granted this role before roles were rows, so nobody's access changes on migration day.
      permissions: [...(ROLE_PERMISSIONS[r.key] || [])],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    }));
    if (docs.length && !dryRun) await db.collection('roles').insertMany(docs);

    report.created += docs.length;
    report.existing += have.size;
    report.perOrg.push({ _id: org._id, name: org.name, created: docs.map((d) => d.key), existing: [...have] });

    // Anyone pointing at a role key that is neither built-in nor a row in this organization.
    const known = new Set([...have, ...SYSTEM_ROLES.map((r) => r.key), 'SUPER_ADMIN']);
    const users = await db.collection('users').find({ organizationId: org._id }).project({ name: 1, email: 1, role: 1 }).toArray();
    for (const u of users) {
      if (!known.has(u.role)) report.unknownRoles.push({ _id: u._id, name: u.name, email: u.email, role: u.role, organization: org.name });
    }
  }
  return report;
}

/**
 * Who in an organization would still hold `users:manage` if `change` were applied - the question behind every lockout
 * guard. Pure, so the service and the migration ask it the same way and the tests can ask it directly.
 *
 * `change` describes one pending edit, none of which has been written yet:
 *   { roleKey, permissions }  a role's permission list is about to become this
 *   { userId, role }          this user is about to be moved to that role
 *   { userId, isActive }      this user is about to be activated or deactivated
 *   { userId, permissions }   this user's personal extras are about to become this
 */
export function holdersOfUsersManage({ users, roles, change = {} }) {
  const permsFor = (key) => {
    if (change.roleKey && change.roleKey === key) return change.permissions || [];
    const row = roles.find((r) => r.key === key);
    return row ? row.permissions || [] : ROLE_PERMISSIONS[key] || [];
  };
  return users
    .map((u) => ({
      ...u,
      role: change.userId && String(change.userId) === String(u._id) && change.role !== undefined ? change.role : u.role,
      isActive: change.userId && String(change.userId) === String(u._id) && change.isActive !== undefined ? change.isActive : u.isActive,
      permissions: change.userId && String(change.userId) === String(u._id) && change.permissions !== undefined ? change.permissions : u.permissions || [],
    }))
    .filter((u) => u.isActive && [...permsFor(u.role), ...u.permissions].includes('users:manage'));
}
