import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { updateOrganizationSchema } from '../validators/organization.validator.js';
import * as ctrl from '../controllers/organization.controller.js';

const router = Router();
router.use(...tenantGuard);

// There is no :id — the organization is always the caller's own.
router.get('/', can('settings:read'), h(ctrl.get));
router.put('/', can('settings:manage'), validate(updateOrganizationSchema), h(ctrl.update));

export default router;
