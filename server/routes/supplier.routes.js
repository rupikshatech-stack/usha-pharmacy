import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { createSupplierBody, listSuppliersQuery, preferredBody, statusBody, supplierPurchasesQuery, updateSupplierBody } from '../validators/supplier.validator.js';
import * as ctrl from '../controllers/supplier.controller.js';

/**
 * Suppliers (/api/suppliers). Reading needs `inventory:read`; adding, editing, marking preferred and activating or deactivating need `inventory:write`.
 * Deleting is kept for `settings:manage` — and even then only for a supplier with no purchasing history (the service refuses the rest; deactivate instead).
 */
const router = Router();
router.use(...tenantGuard);
router.get('/', can('inventory:read'), validate(listSuppliersQuery, 'query'), h(ctrl.list));
router.get('/:id', can('inventory:read'), h(ctrl.get)); // details, with the statistics worked out from orders and receipts
router.get('/:id/purchases', can('inventory:read'), validate(supplierPurchasesQuery, 'query'), h(ctrl.purchases)); // their purchase history, read from the orders and goods receipts themselves
router.post('/', can('inventory:write'), validate(createSupplierBody), h(ctrl.create));
router.put('/:id', can('inventory:write'), validate(updateSupplierBody), h(ctrl.update));
router.post('/:id/preferred', can('inventory:write'), validate(preferredBody), h(ctrl.preferred));
router.post('/:id/status', can('inventory:write'), validate(statusBody), h(ctrl.status));
router.delete('/:id', can('settings:manage'), h(ctrl.remove));

export default router;
