import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { effectivePermissions } from '../config/permissions.js';
import { AuditLog, Organization, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { runWithTenant, unscoped } from '../utils/tenantContext.js';
import { audit } from './audit.service.js';
import { withRolePermissions } from './roles.service.js';
import { createSession, revokeUserSessions } from './session.service.js';

const BCRYPT_ROUNDS = 12;

// Pre-computed hash so unknown emails take the same time as wrong passwords (no timing leak).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);

export const toPublicUser = (u, org) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  permissions: effectivePermissions(u),
  mustChangePassword: Boolean(u.mustChangePassword),
  // `dateFormat` is display only: it tells the screens how to WRITE a date. Dates themselves are stored as UTC instants.
  organization: org ? { id: org._id, name: org.name, slug: org.slug, timezone: org.timezone || 'Asia/Kolkata', logo: org.logo || '', dateFormat: org.settings?.general?.dateFormat || 'dd MMM yyyy' } : undefined,
});

/**
 * The user as the browser is handed it by sign-in and by token refresh: what the role grants is looked up, exactly as the
 * authentication middleware does for every other request (and so for /auth/me). `toPublicUser` on its own reads only the
 * built-in role map, so a custom role came back from sign-in with `permissions: []` and the app opened nearly empty
 * until a reload made it ask /auth/me. Always go through here with a user that came straight from the database.
 */
export async function presentUser(user, org) {
  return toPublicUser(await withRolePermissions(user), org);
}

/**
 * Audit rows belong to the user's organization, so they are written inside that tenant's context.
 *
 * A platform administrator has no organization. Their sign-ins are written as platform rows instead - unscoped, and
 * flagged, so they never appear in any pharmacy's activity log. Dropping the record instead would mean the one
 * account that can create organizations is also the one account whose sign-ins leave no trace, which is backwards.
 */
const logEvent = (user, action, message, ip) => {
  const row = { userId: user._id, userName: user.name, action, entity: 'User', entityId: user._id, message, ip };
  if (!user.organizationId) return unscoped(() => AuditLog.create({ ...row, isPlatform: true }));
  return runWithTenant(user.organizationId, () => AuditLog.create(row));
};

const minutesLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60000));

/**
 * Verifies credentials and opens a session. Wrong email and wrong password give the same 401 so
 * accounts can't be enumerated. Repeated failures lock the account for a while.
 * Sign-in is the one place the user is found by email BEFORE a tenant is known; everything after
 * the lookup runs inside that user's own tenant.
 */
/**
 * Everything that happens BEFORE a sign-in knows which door it is opening: find the account, honour an existing
 * lockout, compare the password in constant-ish time, and count or punish a failure.
 *
 * It is shared by the workspace sign-in and the platform sign-in deliberately. This is where the properties that
 * actually matter live - a wrong email and a wrong password are indistinguishable, every attempt costs a bcrypt
 * comparison whether or not the account exists, and repeated failures lock the account - and a second copy of it
 * for the platform door would be a second place for those properties to rot.
 *
 * It returns the user when the credentials are right, and throws otherwise. What the caller does next (which
 * accounts it will admit, and what kind of session it opens) is the caller's business.
 */
async function verifyCredentials({ email, password, ip }) {
  const user = await User.findOne({ email }).select('+passwordHash');

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new ApiError(429, `Too many failed attempts. Try again in ${minutesLeft(user.lockedUntil)} minute(s).`, undefined, 'ACCOUNT_LOCKED');
  }

  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);

  if (!user || !ok) {
    if (user) {
      const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginCount: 1 } }, { returnDocument: 'after' });
      if (updated.failedLoginCount >= env.auth.maxFailedLogins) {
        const lockedUntil = new Date(Date.now() + env.auth.lockoutMs);
        await User.updateOne({ _id: user._id }, { $set: { lockedUntil, failedLoginCount: 0 } });
        await logEvent(user, 'AUTH_LOCKED', `Account locked after ${env.auth.maxFailedLogins} failed sign-ins`, ip);
        throw new ApiError(429, `Too many failed attempts. Try again in ${minutesLeft(lockedUntil)} minute(s).`, undefined, 'ACCOUNT_LOCKED');
      }
      await logEvent(user, 'AUTH_LOGIN_FAILED', 'Failed sign-in attempt', ip);
    }
    throw new ApiError(401, 'Invalid email or password');
  }
  return user;
}

/** Clears the failure count and stamps the sign-in. Shared by both doors for the same reason as the check above. */
async function recordSuccessfulLogin(user, ip) {
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } });
  await logEvent(user, 'AUTH_LOGIN', `${user.name} signed in`, ip);
}

export async function login({ email, password, rememberMe, ip, userAgent }) {
  const user = await verifyCredentials({ email, password, ip });

  // Credentials are right; only now reveal account state.
  if (!user.isActive) {
    throw new ApiError(403, 'This account has been deactivated. Contact your administrator.', undefined, 'ACCOUNT_DISABLED');
  }
  if (user.role === 'SUPER_ADMIN' || !user.organizationId) {
    throw new ApiError(403, 'This account cannot sign in to an organization workspace.', undefined, 'NO_ORGANIZATION');
  }
  const org = await Organization.findById(user.organizationId).lean();
  if (!org || org.status !== 'active') {
    throw new ApiError(403, 'This organization is suspended. Contact support.', undefined, 'ORG_SUSPENDED');
  }

  await recordSuccessfulLogin(user, ip);

  const tokens = await runWithTenant(user.organizationId, () => createSession(user, { rememberMe, ip, userAgent }));
  return { user, org, ...tokens };
}

/**
 * The platform door. Same credential check, different admissions policy: only a SUPER_ADMIN gets through, and what
 * it opens is a session with no organization at all.
 *
 * The refusal for everybody else is `401 Invalid email or password`, the same answer a wrong password gives. An
 * ordinary user who finds this URL learns nothing from it - not whether their password was right, and not that
 * platform accounts exist. (The workspace door is free to be more helpful, because by then the account is known to
 * belong to somebody who is allowed through SOME door.)
 */
export async function platformLogin({ email, password, ip, userAgent }) {
  const user = await verifyCredentials({ email, password, ip });

  if (user.role !== 'SUPER_ADMIN' || user.organizationId) {
    await logEvent(user, 'AUTH_LOGIN_FAILED', 'Sign-in refused at the platform door: not a platform account', ip);
    throw new ApiError(401, 'Invalid email or password');
  }
  if (!user.isActive) {
    throw new ApiError(403, 'This account has been deactivated.', undefined, 'ACCOUNT_DISABLED');
  }

  await recordSuccessfulLogin(user, ip);

  // No runWithTenant: there is no tenant. `platform: true` is what lets the session exist without one.
  const tokens = await createSession(user, { rememberMe: false, ip, userAgent, platform: true });
  return { user, ...tokens };
}

/** What the platform screens know about the signed-in administrator. Deliberately thin: there is no organization. */
export const toPlatformUser = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, mustChangePassword: Boolean(u.mustChangePassword) });

/** Changes the caller's password, ends all their other sessions, and clears the first-login flag. */
export async function changePassword(req, { currentPassword, newPassword }) {
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    // 400, not 401: the session itself is fine and the client must not treat this as "signed out".
    throw new ApiError(400, 'Current password is incorrect', undefined, 'WRONG_PASSWORD');
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new ApiError(400, 'Choose a password different from your current one', undefined, 'SAME_PASSWORD');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date();
  user.failedLoginCount = 0;
  await user.save();

  await revokeUserSessions(user._id, req.session._id);

  // A platform administrator has no organization to audit against, so the event is written as a platform row - the
  // same shape their sign-in uses. Everyone else is audited into their own organization exactly as before.
  if (!req.user.organizationId) {
    await unscoped(() =>
      AuditLog.create({
        isPlatform: true,
        userId: user._id,
        userName: user.name,
        action: 'AUTH_PASSWORD_CHANGED',
        entity: 'User',
        entityId: user._id,
        message: `${user.name} changed their password`,
        ip: req.ip,
      }),
    );
    return;
  }
  await audit(req, { action: 'AUTH_PASSWORD_CHANGED', entity: 'User', entityId: user._id, message: `${user.name} changed their password` });
}
