import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { adjustmentSchema, movementsQuery } from '../validators/stock.validator.js';
import * as ctrl from '../controllers/stock.controller.js';

const router = Router();
router.use(...tenantGuard);

router.post('/adjustments', can('inventory:write'), validate(adjustmentSchema), h(ctrl.adjust));
router.get('/movements', can('inventory:read'), validate(movementsQuery, 'query'), h(ctrl.movements));
router.get('/reconciliation', can('inventory:write'), h(ctrl.reconciliation));

export default router;
