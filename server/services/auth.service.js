import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { effectivePermissions } from '../config/permissions.js';
import { AuditLog, Organization, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { audit } from './audit.service.js';
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

// Audit rows belong to the user's organization, so write them inside that tenant's context.
const logEvent = (user, action, message, ip) =>
  runWithTenant(user.organizationId, () =>
    AuditLog.create({
      userId: user._id,
      userName: user.name,
      action,
      entity: 'User',
      entityId: user._id,
      message,
      ip,
    }),
  );

const minutesLeft = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60000));

/**
 * Verifies credentials and opens a session. Wrong email and wrong password give the same 401 so
 * accounts can't be enumerated. Repeated failures lock the account for a while.
 * Sign-in is the one place the user is found by email BEFORE a tenant is known; everything after
 * the lookup runs inside that user's own tenant.
 */
export async function login({ email, password, rememberMe, ip, userAgent }) {
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

  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } });
  await logEvent(user, 'AUTH_LOGIN', `${user.name} signed in`, ip);

  const tokens = await runWithTenant(user.organizationId, () => createSession(user, { rememberMe, ip, userAgent }));
  return { user, org, ...tokens };
}

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
  await audit(req, { action: 'AUTH_PASSWORD_CHANGED', entity: 'User', entityId: user._id, message: `${user.name} changed their password` });
}
