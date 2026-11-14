import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { statusBody, createOrderBody, updateOrderBody, listOrdersQuery, orderCancelBody, orderRejectBody, orderSettingsBody, productsQuery, receiptsQuery, receiveBody } from '../validators/order.validator.js';
import * as ctrl from '../controllers/order.controller.js';

/** Supplier orders: list, details, create, and the workflow steps submit / approve / reject / order / receive / cancel. Reading needs inventory:read; changing stock-related things needs inventory:write; approving needs orders:approve. */
const router = Router();
router.use(...tenantGuard);
router.get('/', can('inventory:read'), validate(listOrdersQuery, 'query'), h(ctrl.list));
router.get('/summary', can('inventory:read'), h(ctrl.summary)); // the order figures (fixed paths stay above '/:id')
router.get('/meta', can('inventory:read'), h(ctrl.meta));
router.get('/products', can('inventory:read'), validate(productsQuery, 'query'), h(ctrl.products)); // the order form's product search (fixed paths stay above '/:id')
router.post('/', can('inventory:write'), validate(createOrderBody), h(ctrl.create));
router.get('/settings', can('inventory:read'), h(ctrl.getSettings));
router.put('/settings', can('settings:manage'), validate(orderSettingsBody), h(ctrl.putSettings));
router.get('/receipts', can('inventory:read'), validate(receiptsQuery, 'query'), h(ctrl.receipts)); // the goods received history
router.get('/:id', can('inventory:read'), h(ctrl.get));
router.put('/:id', can('inventory:write'), validate(updateOrderBody), h(ctrl.update)); // drafts only
router.delete('/:id', can('inventory:write'), h(ctrl.remove)); // drafts only
router.patch('/:id/status', can('inventory:read'), validate(statusBody), h(ctrl.setStatus)); // a status by name; the permission depends on the step and is checked inside
router.get('/:id/print', can('inventory:read'), h(ctrl.print)); // print-ready order data (the browser prints it or saves it as a PDF)
router.get('/:id/receivable', can('inventory:read'), h(ctrl.receivable)); // the goods received form's data
router.post('/:id/submit', can('inventory:write'), h(ctrl.submit));
router.post('/:id/approve', can('orders:approve'), h(ctrl.approve));
router.post('/:id/reject', can('orders:approve'), validate(orderRejectBody), h(ctrl.reject));
router.post('/:id/order', can('inventory:write'), h(ctrl.markOrdered)); // mark as ordered: it has been sent to the supplier
router.post('/:id/receive', can('inventory:write'), validate(receiveBody), h(ctrl.receive));
router.post('/:id/cancel', can('inventory:write'), validate(orderCancelBody), h(ctrl.cancel));

export default router;
