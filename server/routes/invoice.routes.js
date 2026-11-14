import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { createInvoiceSchema, listInvoicesQuery } from '../validators/invoice.validator.js';
import * as ctrl from '../controllers/invoice.controller.js';

const router = Router();
router.use(...tenantGuard);

router.post('/', can('billing:create'), validate(createInvoiceSchema), h(ctrl.create));
router.get('/', can('billing:read'), validate(listInvoicesQuery, 'query'), h(ctrl.list));
router.get('/:id', can('billing:read'), h(ctrl.get));

export default router;
