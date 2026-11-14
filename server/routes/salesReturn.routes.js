import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { approveBody, createReturnBody, listReturnsQuery, refundBody, rejectBody, searchInvoicesQuery, summaryQuery, updateBody } from '../validators/salesReturn.validator.js';
import * as ctrl from '../controllers/salesReturn.controller.js';

/** Sales returns: GET /api/sales-returns, /meta, /summary, /:id (billing:read); POST / and GET /invoices[/:id] to process one (billing:create). */
const router = Router();
router.use(...tenantGuard);
router.get('/meta', can('billing:read'), h(ctrl.meta));
router.get('/invoices', can('billing:create'), validate(searchInvoicesQuery, 'query'), h(ctrl.searchInvoices)); // find the original invoice
router.get('/invoices/:id', can('billing:create'), h(ctrl.returnableInvoice)); // its lines with returnable quantities
router.post('/', can('billing:create'), validate(createReturnBody), h(ctrl.create)); // process a new return
router.get('/summary', can('billing:read'), validate(summaryQuery, 'query'), h(ctrl.summary)); // fixed path stays above '/:id'
router.get('/', can('billing:read'), validate(listReturnsQuery, 'query'), h(ctrl.list));
router.get('/:id', can('billing:read'), h(ctrl.get));
router.patch('/:id', can('billing:create'), validate(updateBody), h(ctrl.update)); // notes and refund method / remarks of an open return
router.post('/:id/approve', can('returns:approve'), validate(approveBody), h(ctrl.approve));
router.post('/:id/reject', can('returns:approve'), validate(rejectBody), h(ctrl.reject));
router.post('/:id/refund', can('returns:refund'), validate(refundBody), h(ctrl.refund)); // record refund progress; never moves money

export default router;
