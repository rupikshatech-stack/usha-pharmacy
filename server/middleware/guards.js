import { authenticate } from './auth.js';
import { requirePlatformAdmin, requireTenant } from './tenant.js';

/**
 * The standard guard for every tenant-facing route:
 *   authenticate (valid session) -> requireTenant (verified organization context).
 * Use as  router.use(...tenantGuard)  and then add requirePermission(...) per route.
 */
export const tenantGuard = [authenticate, requireTenant];

/**
 * The guard for every platform route: a valid session, and proof it is a platform one.
 * There is deliberately no requireTenant here — platform routes belong to no organization.
 */
export const platformGuard = [authenticate, requirePlatformAdmin];
