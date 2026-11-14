import express, { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { batchSchema, createMedicineSchema, duplicatesQuery, listMedicinesQuery, updateBatchSchema, updateMedicineSchema } from '../validators/medicine.validator.js';
import * as ctrl from '../controllers/medicine.controller.js';
import { IMAGE_TYPES, maxBytes } from '../services/productImage.service.js';

const router = Router();
router.use(...tenantGuard);

router.get('/', can('inventory:read'), validate(listMedicinesQuery, 'query'), h(ctrl.list));
router.get('/facets', can('inventory:read'), h(ctrl.facets)); // must stay above '/:id'
router.get('/duplicates', can('inventory:read'), validate(duplicatesQuery, 'query'), h(ctrl.duplicates)); // live SKU / barcode check
// Product photographs. The image itself is the request body; the server names the file and serves it back only to this
// organization. Both paths stay above '/:id' so a file name is never mistaken for a medicine id.
router.post('/images', can('inventory:write'), express.raw({ type: IMAGE_TYPES, limit: maxBytes() + 64 * 1024 }), h(ctrl.uploadImage));
router.get('/images/:file', can('inventory:read'), h(ctrl.getImage));
router.get('/:id', can('inventory:read'), h(ctrl.get));
router.post('/', can('inventory:write'), validate(createMedicineSchema), h(ctrl.create));
router.put('/:id', can('inventory:write'), validate(updateMedicineSchema), h(ctrl.update));
router.delete('/:id', can('inventory:delete'), h(ctrl.remove));
router.post('/:id/restore', can('inventory:delete'), h(ctrl.restore));

// Batches. There is deliberately NO delete: batches are permanent history (archive them instead).
router.get('/:id/batches', can('inventory:read'), h(ctrl.listBatches));
router.post('/:id/batches', can('inventory:write'), validate(batchSchema), h(ctrl.addBatch));
router.patch('/:id/batches/:batchId', can('inventory:write'), validate(updateBatchSchema), h(ctrl.updateBatch));

export default router;
