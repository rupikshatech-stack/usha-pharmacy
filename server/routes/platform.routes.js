import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { authenticate, authenticateAllowPending } from '../middleware/auth.js';
import { requirePlatformAdmin } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { changePasswordSchema, loginSchema } from '../validators/auth.validator.js';
import { createOrganizationSchema, organizationListQuery } from '../validators/platform.validator.js';
import { platformGuard } from '../middleware/guards.js';
import * as ctrl from '../controllers/platform.controller.js';

const router = Router();

// The same per-IP limit the workspace door uses. A platform account is a more valuable target than any single
// pharmacy's, so it certainly does not deserve a looser one.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { success: false, message: 'Too many sign-in attempts from this network. Try again in a few minutes.', code: 'RATE_LIMITED' },
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  message: { success: false, message: 'Too many password change attempts. Try again later.', code: 'RATE_LIMITED' },
});

/**
 * The platform area: creating pharmacies and their first administrator. It is NOT part of any organization, so it
 * does not use tenantGuard and never enters a tenant context.
 *
 * Sign-in is rate-limited by the same limiter as the workspace door, because it is the same kind of target.
 *
 * A platform account created by scripts/create-platform-admin.js has `mustChangePassword` set, and `authenticate`
 * refuses such an account on every other route. Change-password therefore uses `authenticateAllowPending`, exactly
 * as the workspace side does: the one thing a new platform administrator can do is choose their own password.
 */
router.post('/auth/login', loginLimiter, validate(loginSchema), h(ctrl.login));
router.get('/auth/me', authenticate, requirePlatformAdmin, h(ctrl.me));
router.post('/auth/change-password', passwordLimiter, authenticateAllowPending, requirePlatformAdmin, validate(changePasswordSchema), h(ctrl.changePassword));
router.post('/auth/logout', h(ctrl.logout));

// Onboarding. Behind the full platform guard: a platform account, on a platform session, past any forced password
// change. There is no route here that reads inside an organization — creating one is the whole surface.
router.get('/organizations', ...platformGuard, validate(organizationListQuery, 'query'), h(ctrl.listOrganizations));
router.post('/organizations', ...platformGuard, validate(createOrganizationSchema), h(ctrl.createOrganization));

export default router;
