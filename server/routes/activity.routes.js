import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { listActivityQuery } from '../validators/activity.validator.js';
import * as ctrl from '../controllers/activity.controller.js';

const router = Router();
router.use(...tenantGuard);

router.get('/', can('audit:read'), validate(listActivityQuery, 'query'), h(ctrl.list));

export default router;
