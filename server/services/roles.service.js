import { Role, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';
import { holdersOfUsersManage } from '../scripts/lib/rolesMigration.js';
import { CATALOGUE_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS, ROLE_KEY_PATTERN, ROLE_PERMISSIONS, SYSTEM_ROLE_KEYS, SYSTEM_ROLES, hasPermission } from '../config/permissions.js';

/**
 * Roles: what an organization may define, and the four things it may not do.
 *
 * Every refusal here is a 409 with a code and a message that says what to do instead, because each one stands between
 * somebody and a door they cannot reopen themselves:
 *
 *   ROLE_IN_USE        deleting a role that people hold would leave those users pointing at nothing.
 *   ROLE_SYSTEM        renaming or deleting a built-in would orphan users and the fallback defaults behind them.
 *   ROLE_LAST_ADMIN    the edit would leave this organization with nobody who can manage users and roles. That is
 *                      unrecoverable from inside the product: there would be no one left who could undo it.
 *   ROLE_EXISTS        two roles with one name, or one key, in the same organization.
 *
 * And one 400: ROLE_PERMISSION_UNKNOWN, for a permission string that is not in the catalogue. Mongoose would drop an
 * unknown entry from an enum array on some write paths and report success, so this is checked before the write and
 * names the offender. It is the same failure the settings paths had, caught in the same way.
 */

const KEY_MAX = 40;

/** A key from a display name: "Finance Lead" -> "FINANCE_LEAD". Suffixed with a number if that key is taken. */
export function keyFromName(name, taken = new Set()) {
  let base = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, KEY_MAX);
  if (!/^[A-Z]/.test(base)) base = `ROLE_${base}`.slice(0, KEY_MAX);
  base = base.replace(/_+$/g, '') || 'ROLE';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffixed = `${base.slice(0, KEY_MAX - String(n).length - 1)}_${n}`;
    if (!taken.has(suffixed)) return suffixed;
  }
  throw new ApiError(409, 'Too many roles share that name. Give this one a more specific name.', undefined, 'ROLE_EXISTS');
}

/** Refuses a permission list containing anything the catalogue does not define, naming every offender. */
function assertKnownPermissions(permissions) {
  const unknown = [...new Set(permissions || [])].filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length) {
    throw new ApiError(
      400,
      `${unknown.length === 1 ? 'This is not a permission' : 'These are not permissions'} this system has: ${unknown.join(', ')}. Nothing was saved.`,
      unknown.map((p) => ({ path: 'permissions', message: `Unknown permission "${p}"` })),
      'ROLE_PERMISSION_UNKNOWN',
    );
  }
  // Store them in catalogue order, so two roles with the same permissions read identically in the audit log.
  return CATALOGUE_PERMISSIONS.filter((p) => (permissions || []).includes(p));
}

/** The catalogue the dialog renders, shaped for the client. */
export const permissionCatalogue = () =>
  PERMISSION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    permissions: g.permissions.map(([key, label, description]) => ({ key, label, description })),
  }));

/**
 * Every active user's role and extras for this organization, plus every role row: the inputs the lockout guard needs.
 * Read once per write so one guard cannot see a different picture from the next.
 */
async function lockoutInputs(orgId) {
  const [users, roles] = await Promise.all([
    User.find({ organizationId: orgId }).select('name email role permissions isActive').lean(),
    Role.find({ organizationId: orgId }).select('key permissions').lean(),
  ]);
  return { users, roles };
}

/** Throws if `change` would leave nobody active holding users:manage. */
async function assertNotLastAdmin(orgId, change, what) {
  const { users, roles } = await lockoutInputs(orgId);
  if (holdersOfUsersManage({ users, roles, change }).length) return;
  throw new ApiError(
    409,
    `${what} would leave this organization with nobody who can manage users and roles, and nobody inside the product could undo that. Give someone else that permission first.`,
    undefined,
    'ROLE_LAST_ADMIN',
  );
}

/** How many users hold each of these role keys. */
async function userCounts(orgId, keys) {
  const rows = await User.aggregate([{ $match: { organizationId: orgId, role: { $in: keys } } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/**
 * A role as the client sees it, including whether this particular request may edit or delete it.
 *
 * `canEdit`/`canDelete` exist so the screen never offers a button that would fail. The reference product we were shown
 * renders every action for everybody and answers with a stack of "Not authorized" toasts; deciding it here, where the
 * rules actually live, means the client cannot drift from them.
 */
function present(role, { counts = {}, actor }) {
  const users = counts[role.key] || 0;
  const mayManage = hasPermission(actor, 'users:manage');
  return {
    id: String(role._id),
    key: role.key,
    name: role.name,
    description: role.description || '',
    scope: role.scope,
    permissions: role.permissions || [],
    permissionCount: (role.permissions || []).length,
    isSystem: Boolean(role.isSystem),
    userCount: users,
    canEdit: mayManage,
    // A built-in may not be deleted, nor may a role somebody still holds.
    canDelete: mayManage && !role.isSystem && users === 0,
    cannotDeleteReason: role.isSystem
      ? 'Built-in roles cannot be deleted.'
      : users > 0
        ? `${users} ${users === 1 ? 'user holds' : 'users hold'} this role.`
        : null,
    updatedAt: role.updatedAt,
  };
}

export async function listRoles(req, { search, page = 1, limit = 10 } = {}) {
  const orgId = req.orgId;
  const filter = { organizationId: orgId };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { key: rx }, { description: rx }];
  }
  const [rows, total] = await Promise.all([
    Role.find(filter).collation({ locale: 'en', strength: 2 }).sort({ isSystem: -1, name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Role.countDocuments(filter),
  ]);
  const counts = await userCounts(orgId, rows.map((r) => r.key));
  return {
    ...paginated(rows.map((r) => present(r, { counts, actor: req.user })), { page, limit, total }),
    // Sent with the list so the dialog needs no second request, and cannot hold a stale copy of the catalogue.
    catalogue: permissionCatalogue(),
    canCreate: hasPermission(req.user, 'users:manage'),
    scopeNote: 'Branch scope is informational for now and does not yet restrict data access.',
  };
}

export async function getRole(req, id) {
  const role = await Role.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!role) throw new ApiError(404, 'That role no longer exists.', undefined, 'ROLE_NOT_FOUND');
  const counts = await userCounts(req.orgId, [role.key]);
  return present(role, { counts, actor: req.user });
}

export async function createRole(req, body) {
  const orgId = req.orgId;
  const permissions = assertKnownPermissions(body.permissions);
  const name = String(body.name || '').trim();

  const existing = await Role.find({ organizationId: orgId }).select('key name').lean();
  if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, `This organization already has a role called "${name}".`, [{ path: 'name', message: 'That name is taken' }], 'ROLE_EXISTS');
  }
  const key = keyFromName(name, new Set([...existing.map((r) => r.key), ...SYSTEM_ROLE_KEYS]));

  const role = await Role.create({
    organizationId: orgId,
    key,
    name,
    description: String(body.description || '').trim(),
    scope: body.scope || 'organization',
    permissions,
    isSystem: false,
  });

  await audit(req, {
    action: 'ROLE_CREATED',
    entity: 'Role',
    entityId: role._id,
    message: `Role "${name}" created with ${permissions.length} permission${permissions.length === 1 ? '' : 's'}`,
    meta: { key, name, scope: role.scope, permissions },
  });
  return present(role.toObject(), { counts: {}, actor: req.user });
}

export async function updateRole(req, id, body) {
  const orgId = req.orgId;
  const role = await Role.findOne({ _id: id, organizationId: orgId }).lean();
  if (!role) throw new ApiError(404, 'That role no longer exists.', undefined, 'ROLE_NOT_FOUND');

  const changes = [];
  const set = {};

  if (body.permissions !== undefined) {
    const permissions = assertKnownPermissions(body.permissions);
    if (JSON.stringify(permissions) !== JSON.stringify(role.permissions || [])) {
      // The one edit that can lock an organization out of its own administration.
      if ((role.permissions || []).includes('users:manage') && !permissions.includes('users:manage')) {
        await assertNotLastAdmin(orgId, { roleKey: role.key, permissions }, `Taking "Manage users and roles" away from ${role.name}`);
      }
      set.permissions = permissions;
      changes.push({ field: 'permissions', from: role.permissions || [], to: permissions });
    }
  }

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name !== role.name) {
      if (role.isSystem) {
        throw new ApiError(409, `"${role.name}" is a built-in role, so it cannot be renamed — users and the system's own defaults refer to it by name. You can still change what it may do.`, [{ path: 'name', message: 'Built-in roles cannot be renamed' }], 'ROLE_SYSTEM');
      }
      const clash = await Role.findOne({ organizationId: orgId, _id: { $ne: role._id }, name }).collation({ locale: 'en', strength: 2 }).lean();
      if (clash) throw new ApiError(409, `This organization already has a role called "${name}".`, [{ path: 'name', message: 'That name is taken' }], 'ROLE_EXISTS');
      set.name = name;
      changes.push({ field: 'name', from: role.name, to: name });
    }
  }

  for (const field of ['description', 'scope']) {
    if (body[field] !== undefined) {
      const next = field === 'description' ? String(body[field]).trim() : body[field];
      if (next !== (role[field] || (field === 'description' ? '' : 'organization'))) {
        set[field] = next;
        changes.push({ field, from: role[field] ?? null, to: next });
      }
    }
  }

  if (!changes.length) return { ...present(role, { counts: await userCounts(orgId, [role.key]), actor: req.user }), changed: 0 };

  await Role.updateOne({ _id: role._id, organizationId: orgId }, { $set: set });
  await audit(req, {
    action: 'ROLE_UPDATED',
    entity: 'Role',
    entityId: role._id,
    message: `Role "${role.name}" updated: ${changes.map((c) => c.field).join(', ')}`,
    meta: { key: role.key, changes },
  });

  const updated = await Role.findById(role._id).lean();
  return { ...present(updated, { counts: await userCounts(orgId, [updated.key]), actor: req.user }), changed: changes.length };
}

export async function deleteRole(req, id) {
  const orgId = req.orgId;
  const role = await Role.findOne({ _id: id, organizationId: orgId }).lean();
  if (!role) throw new ApiError(404, 'That role no longer exists.', undefined, 'ROLE_NOT_FOUND');

  if (role.isSystem) {
    throw new ApiError(409, `"${role.name}" is a built-in role and cannot be deleted. You can change what it may do instead.`, undefined, 'ROLE_SYSTEM');
  }
  const counts = await userCounts(orgId, [role.key]);
  const held = counts[role.key] || 0;
  if (held) {
    throw new ApiError(
      409,
      `${held} ${held === 1 ? 'user still holds' : 'users still hold'} the role "${role.name}". Move ${held === 1 ? 'them' : 'them all'} to another role first — deleting it would leave ${held === 1 ? 'that account' : 'those accounts'} pointing at a role that no longer exists.`,
      undefined,
      'ROLE_IN_USE',
    );
  }

  await Role.deleteOne({ _id: role._id, organizationId: orgId });
  await audit(req, {
    action: 'ROLE_DELETED',
    entity: 'Role',
    entityId: role._id,
    message: `Role "${role.name}" deleted`,
    meta: { key: role.key, name: role.name, permissions: role.permissions || [] },
  });
  return { deleted: true, name: role.name };
}

/**
 * The permissions a role grants RIGHT NOW, for the authentication middleware.
 *
 * Returns null when this organization has no row for the key, which is the signal to fall back to the built-in map -
 * a database that has not run the roles migration must behave exactly as it did before.
 */
export async function rolePermissionsFor(orgId, key) {
  if (!orgId || !key) return null;
  const row = await Role.findOne({ organizationId: orgId, key }).select('permissions').lean();
  return row ? row.permissions || [] : null;
}

/**
 * Gives an organization the five built-in roles. Called when an organization is CREATED, so that a fresh install has
 * the same rows a migrated one does - without this, a brand-new organization would open the Roles screen and find it
 * empty, even though its administrator is signing in happily on the built-in fallback.
 *
 * Idempotent, and written the same way the migration is: only a missing row is created, never an existing one
 * rewritten. Pass the session when this runs inside the transaction that creates the organization, so an organization
 * and its roles are born together or not at all.
 */
export async function ensureSystemRoles({ orgId, session = null }) {
  const existing = await Role.find({ organizationId: orgId }).select('key').session(session).lean();
  const have = new Set(existing.map((r) => r.key));
  const missing = SYSTEM_ROLES.filter((r) => !have.has(r.key));
  if (!missing.length) return { created: [] };

  await Role.create(
    missing.map((r) => ({
      organizationId: orgId,
      key: r.key,
      name: r.name,
      description: r.description,
      scope: 'organization',
      permissions: [...(ROLE_PERMISSIONS[r.key] || [])],
      isSystem: true,
    })),
    { session, ordered: true },
  );
  return { created: missing.map((r) => r.key) };
}

/** The built-in defaults, for seeding and for tests that check a seeded row matches what the code always granted. */
export const builtInPermissions = (key) => [...(ROLE_PERMISSIONS[key] || [])];
export { SYSTEM_ROLES, ROLE_KEY_PATTERN };
