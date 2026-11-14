import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { IMAGE_TYPES, maxBytes } from '../services/credit.service.js';
import { approveBody, balanceQuery, creditSettingsBody, listCreditRequestsQuery, listCreditTransactionsQuery, rejectBody, summaryQuery } from '../validators/credit.validator.js';
import * as ctrl from '../controllers/credit.controller.js';

/**
 * Credit requests (/api/credits). Any signed-in member of the organization can ask for credits and see their own requests, balance and ledger entries; an
 * administrator (settings:manage) can also see everyone's, set the conversion rate, and approve or reject requests. The screenshot is the request body and is
 * checked by its real contents.
 */
const router = Router();
router.use(...tenantGuard);

const screenshotBody = express.raw({ type: IMAGE_TYPES, limit: maxBytes() + 64 * 1024 });
// submitting is limited per person: payment proofs are reviewed by hand
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: () => Number(process.env.CREDIT_RATE_LIMIT) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.orgId}:${req.user?._id}`,
  skip: () => env.isTest && !process.env.FORCE_RATE_LIMIT,
  message: { success: false, message: 'You have submitted a lot of requests. Wait a few minutes and try again.', code: 'RATE_LIMITED' },
  validate: { keyGeneratorIpFallback: false },
});

router.get('/settings', h(ctrl.settings)); // the conversion rate and the upload limits
router.put('/settings', can('settings:manage'), validate(creditSettingsBody), h(ctrl.updateSettings));
router.post('/requests', submitLimiter, screenshotBody, h(ctrl.submit)); // ?amount=&fileName= ; the image is the body; Idempotency-Key header
router.get('/requests', validate(listCreditRequestsQuery, 'query'), h(ctrl.list));
router.get('/summary', validate(summaryQuery, 'query'), h(ctrl.summary)); // credits awarded and request counts, worked out from the requests
router.get('/balance', validate(balanceQuery, 'query'), h(ctrl.balance)); // own balance; ?userId= for administrators
router.get('/transactions', validate(listCreditTransactionsQuery, 'query'), h(ctrl.transactions)); // the credit ledger
router.get('/notifications', h(ctrl.notifications)); // own decided requests, for the notification menu
router.get('/requests/:id', h(ctrl.get));
router.post('/requests/:id/approve', can('settings:manage'), validate(approveBody), h(ctrl.approve)); // the server works out the credits
router.post('/requests/:id/reject', can('settings:manage'), validate(rejectBody), h(ctrl.reject));
router.get('/requests/:id/screenshot', h(ctrl.screenshot));

export default router;
