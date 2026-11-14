import { Branch, Role, Session, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { passwordProblem } from '../utils/password.js';
import { audit } from './audit.service.js';
import { hashPassword } from './auth.service.js';
import { holdersOfUsersManage } from '../scripts/lib/rolesMigration.js';
import { ROLE_PERMISSIONS, SYSTEM_ROLE_KEYS, hasPermission } from '../config/permissions.js';

/**
 * Users: who exists, what role they hold, which stores they work in, and whether they are still with you.
 *
 * NOBODY IS EVER DELETED. Deactivating sets `isActive: false` and ends their sessions; the document stays exactly
 * where it is. Every invoice, stock movement, transfer and audit entry refers to a user by id and by the name
 * captured at the time, and all of that must keep reading correctly years later - a pharmacy's records are the point.
 * There is deliberately no delete endpoint at all, so nobody can reach for one by accident.
 *
 * The lockout guard applies here as much as to roles: moving the last administrator to another role, or deactivating
 * them, locks the organization out of its own administration just as surely as editing the role did.
 */

const SELF = 'You cannot do that to your own account.';

/** Role rows plus the built-ins, so a user's role always resolves to something a screen can show. */
async function roleIndex(orgId) {
  const rows = await Role.find({ organizationId: orgId }).select('key name permissions isSystem').lean();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const key of SYSTEM_ROLE_KEYS) {
    if (!byKey[key]) byKey[key] = { key, name: key, permissions: ROLE_PERMISSIONS[key] || [], isSystem: true, missingRow: true };
  }
  return byKey;
}

function present(u, { roles, branches, actor }) {
  const role = roles[u.role];
  const mayManage = hasPermission(actor, 'users:manage');
  const isSelf = String(u._id) === String(actor._id);
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    roleName: role?.name || u.role,
    roleMissing: Boolean(role?.missingRow) && !SYSTEM_ROLE_KEYS.includes(u.role),
    branchIds: (u.branchIds || []).map(String),
    branchNames: (u.branchIds || []).map((id) => branches[String(id)] || 'Unknown store'),
    permissions: u.permissions || [],
    isActive: u.isActive !== false,
    mustChangePassword: Boolean(u.mustChangePassword),
    lastLoginAt: u.lastLoginAt || null,
    isSelf,
    // Same principle as roles: the screen is told what it may do, so it never offers a button that would be refused.
    canEdit: mayManage,
    canDeactivate: mayManage && !isSelf && u.isActive !== false,
    cannotDeactivateReason: isSelf ? 'You cannot deactivate your own account.' : u.isActive === false ? 'Already inactive.' : null,
  };
}

export async function listUsers(req, { search, role, branchId, active, page = 1, limit = 10 } = {}) {
  const orgId = req.orgId;
  const filter = { organizationId: orgId };
  if (active === 'inactive') filter.isActive = false;
  else if (active === 'active') filter.isActive = true;
  if (role) filter.role = role;
  if (branchId) filter.branchIds = branchId;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const [rows, total, roles, branchRows] = await Promise.all([
    User.find(filter).collation({ locale: 'en', strength: 2 }).sort({ isActive: -1, name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
    roleIndex(orgId),
    Branch.find({ organizationId: orgId }).select('name').lean(),
  ]);
  const branches = Object.fromEntries(branchRows.map((b) => [String(b._id), b.name]));

  return {
    ...paginated(rows.map((u) => present(u, { roles, branches, actor: req.user })), { page, limit, total }),
    // The filter dropdowns, so the client holds no copy of either list.
    roles: Object.values(roles).map((r) => ({ key: r.key, name: r.name })),
    branches: branchRows.map((b) => ({ id: String(b._id), name: b.name })),
    canCreate: hasPermission(req.user, 'users:manage'),
  };
}

/** Throws unless the role key names a role this organization actually has (or a built-in). */
async function assertRoleExists(orgId, key) {
  if (SYSTEM_ROLE_KEYS.includes(key)) return;
  const row = await Role.findOne({ organizationId: orgId, key }).select('_id').lean();
  if (!row) throw new ApiError(400, `There is no role with the key "${key}" in this organization.`, [{ path: 'role', message: 'Unknown role' }], 'ROLE_NOT_FOUND');
}

/** Throws if `change` would leave nobody active holding users:manage. */
async function assertNotLastAdmin(orgId, change, what) {
  const [users, roles] = await Promise.all([
    User.find({ organizationId: orgId }).select('role permissions isActive').lean(),
    Role.find({ organizationId: orgId }).select('key permissions').lean(),
  ]);
  if (holdersOfUsersManage({ users, roles, change }).length) return;
  throw new ApiError(
    409,
    `${what} would leave this organization with nobody who can manage users and roles, and nobody inside the product could undo that. Give someone else that permission first.`,
    undefined,
    'ROLE_LAST_ADMIN',
  );
}

/** Throws unless every branch id belongs to this organization. */
async function assertBranches(orgId, branchIds) {
  if (!branchIds?.length) return [];
  const found = await Branch.find({ organizationId: orgId, _id: { $in: branchIds } }).select('_id').lean();
  if (found.length !== new Set(branchIds.map(String)).size) {
    throw new ApiError(400, 'One of those stores does not belong to this organization.', [{ path: 'branchIds', message: 'Unknown store' }], 'BRANCH_NOT_FOUND');
  }
  return branchIds;
}

export async function createUser(req, body) {
  const orgId = req.orgId;
  const email = String(body.email || '').trim().toLowerCase();
  const problem = passwordProblem(body.password);
  if (problem) throw new ApiError(400, problem, [{ path: 'password', message: problem }], 'WEAK_PASSWORD');

  await assertRoleExists(orgId, body.role);
  await assertBranches(orgId, body.branchIds || []);

  // Email identifies the tenant at sign-in, so it is unique across the whole system, not just this organization.
  if (await User.findOne({ email }).select('_id').lean()) {
    throw new ApiError(409, 'Somebody already uses that email address.', [{ path: 'email', message: 'That email is taken' }], 'EMAIL_TAKEN');
  }

  const user = await User.create({
    organizationId: orgId,
    name: String(body.name).trim(),
    email,
    passwordHash: await hashPassword(body.password),
    role: body.role,
    branchIds: body.branchIds || [],
    isActive: body.isActive !== false,
    // The administrator typed this password, so the person must choose their own before doing anything else. This is
    // the existing change-password flow, not an invite or an email - neither of those is in scope here.
    mustChangePassword: true,
  });

  await audit(req, {
    action: 'USER_CREATED',
    entity: 'User',
    entityId: user._id,
    message: `User "${user.name}" <${email}> created as ${body.role}`,
    meta: { email, role: body.role, branchIds: (body.branchIds || []).map(String), isActive: user.isActive },
  });

  const [roles, branchRows] = await Promise.all([roleIndex(orgId), Branch.find({ organizationId: orgId }).select('name').lean()]);
  return present(user.toObject(), { roles, branches: Object.fromEntries(branchRows.map((b) => [String(b._id), b.name])), actor: req.user });
}

export async function updateUser(req, id, body) {
  const orgId = req.orgId;
  const user = await User.findOne({ _id: id, organizationId: orgId }).lean();
  if (!user) throw new ApiError(404, 'That user no longer exists.', undefined, 'USER_NOT_FOUND');
  const isSelf = String(user._id) === String(req.user._id);

  const changes = [];
  const set = {};

  if (body.name !== undefined && String(body.name).trim() !== user.name) {
    set.name = String(body.name).trim();
    changes.push({ field: 'name', from: user.name, to: set.name });
  }

  if (body.role !== undefined && body.role !== user.role) {
    await assertRoleExists(orgId, body.role);
    await assertNotLastAdmin(orgId, { userId: user._id, role: body.role }, `Moving ${user.name} to another role`);
    set.role = body.role;
    changes.push({ field: 'role', from: user.role, to: body.role });
  }

  if (body.branchIds !== undefined) {
    const next = await assertBranches(orgId, body.branchIds);
    if (JSON.stringify(next.map(String)) !== JSON.stringify((user.branchIds || []).map(String))) {
      set.branchIds = next;
      changes.push({ field: 'branchIds', from: (user.branchIds || []).map(String), to: next.map(String) });
    }
  }

  if (body.isActive !== undefined && body.isActive !== (user.isActive !== false)) {
    if (isSelf) throw new ApiError(409, SELF, undefined, 'USER_SELF');
    if (!body.isActive) await assertNotLastAdmin(orgId, { userId: user._id, isActive: false }, `Deactivating ${user.name}`);
    set.isActive = body.isActive;
    changes.push({ field: 'isActive', from: user.isActive !== false, to: body.isActive });
  }

  if (!changes.length) return { changed: 0 };

  await User.updateOne({ _id: user._id, organizationId: orgId }, { $set: set });

  // Someone who has just been deactivated should not keep browsing on the session they already hold. Their role
  // changing does NOT need this: permissions are read fresh on every request, so the next one already reflects it.
  if (set.isActive === false) await Session.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });

  await audit(req, {
    action: set.isActive === false ? 'USER_DEACTIVATED' : set.isActive === true ? 'USER_REACTIVATED' : 'USER_UPDATED',
    entity: 'User',
    entityId: user._id,
    message: `User "${user.name}" updated: ${changes.map((c) => c.field).join(', ')}`,
    meta: { email: user.email, changes },
  });

  const [fresh, roles, branchRows] = await Promise.all([User.findById(user._id).lean(), roleIndex(orgId), Branch.find({ organizationId: orgId }).select('name').lean()]);
  return { ...present(fresh, { roles, branches: Object.fromEntries(branchRows.map((b) => [String(b._id), b.name])), actor: req.user }), changed: changes.length };
}

/** Deactivation is its own endpoint because it is the one people look for, and it is NOT a delete. */
export const deactivateUser = (req, id) => updateUser(req, id, { isActive: false });
