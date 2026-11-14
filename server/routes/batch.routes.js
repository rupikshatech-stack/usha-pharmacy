import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { batchMovementsQuery, createBatchSchema, listBatchesQuery, updateBatchSchema } from '../validators/batch.validator.js';
import * as ctrl from '../controllers/batch.controller.js';

const router = Router();
router.use(...tenantGuard);

router.get('/', can('inventory:read'), validate(listBatchesQuery, 'query'), h(ctrl.list));
router.get('/summary', can('inventory:read'), h(ctrl.summary)); // above '/:id'
router.get('/:id', can('inventory:read'), h(ctrl.get));
router.get('/:id/movements', can('inventory:read'), validate(batchMovementsQuery, 'query'), h(ctrl.movements));
router.post('/', can('inventory:write'), validate(createBatchSchema), h(ctrl.create));
// Identity (batch number, expiry, initial quantity) and stock quantity can't be edited. There is deliberately no DELETE.
router.patch('/:id', can('inventory:write'), validate(updateBatchSchema), h(ctrl.update));

export default router;
