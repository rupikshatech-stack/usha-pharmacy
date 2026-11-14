import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { FILE_TYPES, MAX_FILE_BYTES } from '../services/aiBilling.service.js';
import { confirmMatchBody, draftBody, extractedBody, matchesQuery, matchProductsBody, selectProductBody, suggestionsQuery, unmatchedBody, extractedQuery, listUploadsQuery, matchBody } from '../validators/aiBilling.validator.js';
import { createPurchaseOrderBody, finalReviewBody, linkPurchaseOrderBody, purchaseOrderOptionsQuery } from '../validators/goodsReceipt.validator.js';
import * as ctrl from '../controllers/aiBilling.controller.js';
import * as purchasing from '../controllers/goodsReceipt.controller.js';

/**
 * AI Billing (/api/ai-billing): upload a supplier invoice, scan it, review it, save a draft order. Nothing here changes stock. Uploaded invoices carry a
 * supplier's financial details, so everything except the status needs inventory:write (the people who can create orders).
 */
const router = Router();
const invoiceFile = express.raw({ type: FILE_TYPES, limit: MAX_FILE_BYTES + 64 * 1024 }); // the invoice itself is the request body
router.use(...tenantGuard);

// Reading a document costs money and time (the provider charges per page), so starting it is limited per person. Automated tests start far more than any person would.
const ocrLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: () => Number(process.env.OCR_RATE_LIMIT) || 30, // read on every request so it can be tuned (and tested) without a restart
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.orgId}:${req.user?._id}`,
  skip: () => env.isTest && !process.env.FORCE_RATE_LIMIT,
  message: { success: false, message: 'You have started a lot of scans. Wait a few minutes and try again.', code: 'RATE_LIMITED' },
  validate: { keyGeneratorIpFallback: false },
});

router.get('/status', can('inventory:read'), h(ctrl.status)); // which reading service is chosen, and is it ready?
router.get('/uploads', can('inventory:write'), validate(listUploadsQuery, 'query'), h(ctrl.list));
router.post('/uploads', can('inventory:write'), invoiceFile, h(ctrl.upload)); // ?fileName= ; the file is the body
router.get('/uploads/:id', can('inventory:write'), h(ctrl.get)); // the upload, its status and what was read
router.get('/uploads/:id/file', can('inventory:write'), h(ctrl.file)); // the stored file (authenticated)
router.post('/uploads/:id/scan', can('inventory:write'), ocrLimiter, h(ctrl.scan)); // 202: reading continues in the background; follow the status (same as /:id/extract)
router.post('/uploads/:id/draft', can('inventory:write'), validate(draftBody), h(ctrl.draft)); // the reviewed invoice becomes a DRAFT order
router.delete('/uploads/:id', can('inventory:write'), h(ctrl.remove)); // removes the file for good
// The same upload, addressed directly (the record id or the public UP-… id): start OCR, follow it, read the result, read it again
router.post('/:id/extract', can('inventory:write'), ocrLimiter, h(ctrl.scan));
router.get('/:id/status', can('inventory:write'), h(ctrl.processingStatus));
router.get('/:id/ocr', can('inventory:write'), h(ctrl.ocr));
router.post('/:id/reprocess', can('inventory:write'), ocrLimiter, h(ctrl.reprocess));
// AI structured extraction (Phase 3): needs the OCR scan to be completed first
router.post('/:id/ai-extract', can('inventory:write'), ocrLimiter, h(ctrl.aiExtract));
router.post('/:id/reprocess-ai', can('inventory:write'), ocrLimiter, h(ctrl.aiReprocess));
router.get('/:id/extraction-status', can('inventory:write'), h(ctrl.aiStatus));
router.get('/:id/extracted', can('inventory:write'), validate(extractedQuery, 'query'), h(ctrl.extracted));
router.put('/:id/extracted', can('inventory:write'), validate(extractedBody), h(ctrl.aiUpdate));
router.post('/:id/validate', can('inventory:write'), h(ctrl.aiValidate));
// Product matching (Phase 4): extracted medicines against the existing products. Nothing here creates a product, an order or stock.
router.post('/:id/match-products', can('inventory:write'), validate(matchProductsBody), h(ctrl.matchProducts));
router.get('/:id/product-matches', can('inventory:write'), validate(matchesQuery, 'query'), h(ctrl.productMatches));
router.post('/:id/product-matches/confirm-all', can('inventory:write'), h(ctrl.confirmAllMatches));
router.get('/:id/verified-lines', can('inventory:write'), h(ctrl.verifiedLines));
router.get('/:id/product-matches/:itemId/suggestions', can('inventory:write'), validate(suggestionsQuery, 'query'), h(ctrl.suggestions));
router.put('/:id/product-matches/:itemId', can('inventory:write'), validate(selectProductBody), h(ctrl.selectProduct));
router.post('/:id/product-matches/:itemId/confirm', can('inventory:write'), validate(confirmMatchBody), h(ctrl.confirmMatch));
router.post('/:id/product-matches/:itemId/mark-unmatched', can('inventory:write'), validate(unmatchedBody), h(ctrl.markUnmatched));
// Purchasing (Phase 5): final review, then create or link the purchase order. Receiving the goods is /api/goods-receipts.
router.get('/:id/final-review', can('inventory:write'), h(purchasing.finalReview));
router.post('/:id/final-review', can('inventory:write'), validate(finalReviewBody), h(purchasing.verify)); // the person verifies the invoice as it stands
router.get('/:id/purchase-order-options', can('inventory:write'), validate(purchaseOrderOptionsQuery, 'query'), h(purchasing.orderOptions));
router.post('/:id/create-purchase-order', can('inventory:write'), validate(createPurchaseOrderBody), h(purchasing.createPurchaseOrder));
router.post('/:id/link-purchase-order', can('inventory:write'), validate(linkPurchaseOrderBody), h(purchasing.linkPurchaseOrder));
router.post('/match', can('inventory:write'), validate(matchBody), h(ctrl.match)); // matches typed or corrected lines against the products

export default router;
