import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { createBranchSchema, listBranchesQuery, PAGING_KEYS, updateBranchSchema } from '../validators/branch.validator.js';
import { cancelBody, dispatchBody, eventsQuery, listTransfersQuery, receiveBody, rejectBody, settingsBody, transferBody } from '../validators/transfer.validator.js';
import * as ctrl from '../controllers/transfer.controller.js';

/** Inter-store transfers: GET/POST /api/transfers, /summary, /:id, and /:id/{submit,approve,reject,dispatch,receive,cancel}. */
export const transfers = Router();
transfers.use(...tenantGuard);
transfers.get('/', can('transfer:view'), validate(listTransfersQuery, 'query'), h(ctrl.list));
transfers.get('/in-transit', can('transfer:view'), h(ctrl.inTransit)); // these fixed paths stay above '/:id'
transfers.get('/summary', can('transfer:view'), h(ctrl.summary));
transfers.get('/notifications', can('transfer:view'), h(ctrl.notifications));
transfers.get('/settings', can('inventory:read'), h(ctrl.getSettings));
transfers.put('/settings', can('settings:manage'), validate(settingsBody), h(ctrl.putSettings));
transfers.get('/:id', can('transfer:view'), h(ctrl.get));
transfers.post('/', can('transfer:create'), validate(transferBody), h(ctrl.create));
transfers.put('/:id', can('transfer:edit'), validate(transferBody), h(ctrl.update)); // drafts only
transfers.delete('/:id', can('transfer:edit'), h(ctrl.remove)); // drafts only
transfers.post('/:id/submit', can('transfer:submit'), h(ctrl.submit));
transfers.post('/:id/approve', can('transfer:approve'), h(ctrl.approve));
transfers.post('/:id/reject', can('transfer:reject'), validate(rejectBody), h(ctrl.reject));
transfers.post('/:id/dispatch', can('transfer:dispatch'), validate(dispatchBody), h(ctrl.dispatch));
transfers.post('/:id/receive', can('transfer:receive'), validate(receiveBody), h(ctrl.receive));
transfers.get('/:id/events', can('transfer:view'), validate(eventsQuery, 'query'), h(ctrl.events)); // the complete history of one transfer
transfers.get('/:id/history', can('transfer:view'), validate(eventsQuery, 'query'), h(ctrl.events)); // alias of /events
transfers.get('/:id/print', can('transfer:print'), h(ctrl.print)); // print-ready document data (the browser renders/prints it)
transfers.post('/:id/cancel', can('transfer:cancel'), validate(cancelBody), h(ctrl.cancel));

/** Stores (branches): anyone who can read inventory sees them; managing them is a settings permission. */
export const stores = Router();
stores.use(...tenantGuard);
// no query = every store (what the transfer / order / batch screens use); any of page, limit, search, status = one page of them
const pagedWhenAsked = (req, res, next) => (PAGING_KEYS.some((k) => req.query[k] !== undefined) ? validate(listBranchesQuery, 'query')(req, res, (e) => { if (!e) req.query.__paged = true; next(e); }) : next());
stores.get('/', can('inventory:read'), pagedWhenAsked, h(ctrl.listStores));
stores.get('/:id', can('inventory:read'), h(ctrl.getStore));
stores.post('/', can('settings:manage'), validate(createBranchSchema), h(ctrl.createStore));
stores.put('/:id', can('settings:manage'), validate(updateBranchSchema), h(ctrl.updateStore));
stores.delete('/:id', can('settings:manage'), h(ctrl.deleteStore));
