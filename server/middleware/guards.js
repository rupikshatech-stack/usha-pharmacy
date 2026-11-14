import { authenticate } from './auth.js';
import { requireTenant } from './tenant.js';

/**
 * The standard guard for every tenant-facing route:
 *   authenticate (valid session) -> requireTenant (verified organization context).
 * Use as  router.use(...tenantGuard)  and then add requirePermission(...) per route.
 */
export const tenantGuard = [authenticate, requireTenant];
