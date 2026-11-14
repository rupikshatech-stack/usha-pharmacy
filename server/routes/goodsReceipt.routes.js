import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { confirmReceiptBody, createDraftBody, listReceiptsQuery, reverseReceiptBody, updateDraftBody } from '../validators/goodsReceipt.validator.js';
import * as ctrl from '../controllers/goodsReceipt.controller.js';

/**
 * Goods receipts (/api/goods-receipts) and purchase history (/api/purchases). Viewing needs inventory:read; preparing and confirming a receipt needs
 * inventory:write (the people who can receive goods today); taking a confirmed receipt back out needs orders:approve. The stock itself is only ever changed
 * by the order module's receiving service, when a draft is confirmed.
 */
export const goodsReceipts = Router();
goodsReceipts.use(...tenantGuard);
goodsReceipts.get('/', can('inventory:read'), validate(listReceiptsQuery, 'query'), h(ctrl.list));
goodsReceipts.post('/', can('inventory:write'), validate(createDraftBody), h(ctrl.create)); // a draft: nothing is received yet
goodsReceipts.get('/:id', can('inventory:read'), h(ctrl.get));
goodsReceipts.put('/:id', can('inventory:write'), validate(updateDraftBody), h(ctrl.update)); // drafts only
goodsReceipts.post('/:id/confirm', can('inventory:write'), validate(confirmReceiptBody), h(ctrl.confirm)); // adds the accepted units to stock, once
goodsReceipts.post('/:id/reverse', can('orders:approve'), validate(reverseReceiptBody), h(ctrl.reverse)); // posts opposite ledger entries; never edits history

export const purchases = Router();
purchases.use(...tenantGuard);
purchases.get('/:id/history', can('inventory:read'), h(ctrl.history));
