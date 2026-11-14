import { User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ACCESS_COOKIE } from '../utils/cookies.js';
import { findActiveSession, verifyAccessToken } from '../services/session.service.js';
import { rolePermissionsFor } from '../services/roles.service.js';
import { runWithTenant } from '../utils/tenantContext.js';

/**
 * Authenticates EVERY protected request:
 *   1. a valid, unexpired access token (cookie, or Authorization: Bearer for API clients)
 *   2. its server-side session is still active (not logged out / revoked / expired)
 *   3. the user still exists and is active
 *   4. what their role may do, read fresh from the roles collection
 * Tenant membership is checked next by requireTenant (see tenantGuard). Unless allowPending is set,
 * users who must change their password are blocked from everything else.
 */
const build = (allowPending) =>
  asyncHandler(async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = req.cookies?.[ACCESS_COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) throw new ApiError(401, 'Authentication required', undefined, 'UNAUTHENTICATED');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (e) {
      const expired = e.name === 'TokenExpiredError';
      throw new ApiError(401, expired ? 'Session expired. Please sign in again.' : 'Invalid session', undefined, expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
    }

    const session = await findActiveSession(payload.sid);
    if (!session || String(session.userId) !== payload.sub) {
      throw new ApiError(401, 'Session ended. Please sign in again.', undefined, 'SESSION_ENDED');
    }

    // No tenant context exists yet (we're still establishing who the user is), so this lookup is global by design.
    const user = await User.findById(payload.sub).lean();
    if (!user || !user.isActive) throw new ApiError(401, 'Account unavailable', undefined, 'ACCOUNT_UNAVAILABLE');

    if (user.mustChangePassword && !allowPending) {
      throw new ApiError(403, 'You must change your password before continuing.', undefined, 'PASSWORD_CHANGE_REQUIRED');
    }

    /**
     * What the role grants is read HERE, on every request, next to the user it already re-reads - never from the
     * token. The access token carries only who you are (`sub`) and which session (`sid`); it has never carried
     * permissions and must not start now, because a token is a snapshot and roles are editable. An administrator who
     * takes a permission away from a role takes it away from everyone holding that role on their very next request,
     * without waiting for a token to expire or forcing anybody to sign in again.
     *
     * A missing row means this database has not run the roles migration: `rolePermissions` stays undefined and
     * `effectivePermissions` falls back to the built-in map, which is exactly the old behaviour.
     */
    const rolePermissions = user.organizationId ? await runWithTenant(user.organizationId, () => rolePermissionsFor(user.organizationId, user.role)) : null;
    req.user = rolePermissions ? { ...user, rolePermissions } : user;
    req.session = session;
    next();
  });

export const authenticate = build(false);
/** For the few endpoints a user with a pending password change may still call (me, change-password). */
export const authenticateAllowPending = build(true);

/** Coarse role gate. Prefer requirePermission (middleware/tenant.js) for new routes. */
export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, 'You do not have permission', undefined, 'FORBIDDEN'));
