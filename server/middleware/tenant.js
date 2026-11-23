import { Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { enterTenant } from '../utils/tenantContext.js';
import { hasPermission } from '../config/permissions.js';

/**
 * Establishes the tenant for a request. Must run AFTER authenticate.
 *
 * The organization comes ONLY from the authenticated user's database record. Nothing the client
 * sends (body, query, params, headers, token claims) can choose or change it.
 *
 * It then:
 *   1. rejects users with no organization membership (including the platform-level SUPER_ADMIN)
 *   2. rejects users whose organization no longer exists or is suspended
 *   3. attaches the verified context (req.tenant, req.orgId)
 *   4. runs the rest of the request inside the tenant context, which makes the Mongoose tenant
 *      plugin force every read/write on business data to that organization
 */
export const requireTenant = asyncHandler(async (req, _res, next) => {
  const user = req.user;
  if (!user) throw new ApiError(401, 'Authentication required', undefined, 'UNAUTHENTICATED');

  if (user.role === 'SUPER_ADMIN') {
    throw new ApiError(403, 'Platform administrators cannot access organization data from here.', undefined, 'TENANT_FORBIDDEN');
  }
  if (!user.organizationId) {
    throw new ApiError(403, 'Your account is not a member of any organization.', undefined, 'NO_ORGANIZATION');
  }
  // The session must belong to the same organization as the user (defends against tampered session rows).
  if (req.session && String(req.session.organizationId) !== String(user.organizationId)) {
    throw new ApiError(401, 'Session ended. Please sign in again.', undefined, 'SESSION_ENDED');
  }

  const organization = await Organization.findById(user.organizationId).lean();
  if (!organization) throw new ApiError(403, 'Your organization no longer exists.', undefined, 'TENANT_NOT_FOUND');
  if (organization.status !== 'active') {
    throw new ApiError(403, 'Your organization is suspended. Contact support.', undefined, 'TENANT_SUSPENDED');
  }

  req.tenant = Object.freeze({ organizationId: organization._id, organization });
  req.orgId = organization._id;
  enterTenant(organization._id, next);
});

/** Allows the request only if the user's role (plus any extra grants) includes the permission. */
export const requirePermission = (...permissions) => (req, _res, next) =>
  permissions.every((p) => hasPermission(req.user, p))
    ? next()
    : next(new ApiError(403, 'You do not have permission to do that.', undefined, 'FORBIDDEN'));

/** Allows the request if the user holds AT LEAST ONE of the permissions (requirePermission demands all of them). */
export const requireAnyPermission = (...permissions) => (req, _res, next) =>
  permissions.some((p) => hasPermission(req.user, p))
    ? next()
    : next(new ApiError(403, 'You do not have permission to do that.', undefined, 'FORBIDDEN'));

/**
 * The platform door's guard. Runs after `authenticate`, and demands TWO things:
 *
 *   the account is a platform administrator, and
 *   the SESSION it is using is a platform session.
 *
 * The second is not redundant. Without it, any session belonging to a platform account would open these routes —
 * including one minted by some future code path that forgot the distinction. A session is the thing presented on
 * each request, so a session is what has to be marked.
 *
 * Note what this guard does NOT do: it never enters a tenant context. Platform routes have no organization, so the
 * Mongoose tenant plugin stays unscoped-and-strict for them, and any accidental read of tenant data throws rather
 * than quietly returning somebody's invoices.
 */
export const requirePlatformAdmin = (req, _res, next) => {
  if (req.user?.role !== 'SUPER_ADMIN' || req.user?.organizationId) {
    return next(new ApiError(403, 'This area is for platform administrators.', undefined, 'PLATFORM_FORBIDDEN'));
  }
  if (!req.session?.isPlatform) {
    return next(new ApiError(403, 'Sign in at the platform sign-in page to use this area.', undefined, 'PLATFORM_SESSION_REQUIRED'));
  }
  return next();
};
