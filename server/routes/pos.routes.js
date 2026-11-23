import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { posQuery } from '../validators/medicine.validator.js';
import * as ctrl from '../controllers/pos.controller.js';

const router = Router();
router.use(...tenantGuard);

router.get('/products', can('billing:create'), validate(posQuery, 'query'), h(ctrl.products));
router.get('/context', can('billing:create'), h(ctrl.context));

export default router;
