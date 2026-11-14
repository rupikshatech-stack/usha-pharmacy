import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { authenticateAllowPending } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { changePasswordSchema, loginSchema } from '../validators/auth.validator.js';
import * as ctrl from '../controllers/auth.controller.js';

const router = Router();

const limiter = (limit, message) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => env.isTest, // automated tests sign in far more often than any person would
    message: { success: false, message, code: 'RATE_LIMITED' },
  });

// Per-IP limits sit in front of the per-account lockout (which handles distributed guessing).
const loginLimiter = limiter(30, 'Too many sign-in attempts from this network. Try again in a few minutes.');
const refreshLimiter = limiter(120, 'Too many requests. Try again shortly.');
const passwordLimiter = limiter(10, 'Too many password change attempts. Try again later.');

router.post('/login', loginLimiter, validate(loginSchema), h(ctrl.login));
router.post('/refresh', refreshLimiter, h(ctrl.refresh));
router.post('/logout', h(ctrl.logout));
router.get('/me', authenticateAllowPending, requireTenant, h(ctrl.me));
router.post('/change-password', passwordLimiter, authenticateAllowPending, requireTenant, validate(changePasswordSchema), h(ctrl.changePassword));

export default router;
