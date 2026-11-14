import express, { Router } from 'express';
import { z } from 'zod';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { pageQuery } from '../validators/common.js';
import { MAX_FILE_BYTES } from '../services/importValidation.js';
import * as ctrl from '../controllers/import.controller.js';

const router = Router();
router.use(...tenantGuard);

// The CSV arrives as plain text. (The global JSON parser ignores text/csv, and its small limit doesn't apply here.)
const csvBody = express.text({ type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'], limit: MAX_FILE_BYTES + 64 * 1024 });

const previewQuery = z.object({ fileName: z.string().trim().min(1, 'File name is required').max(255) });
const confirmBody = z.object({ skipInvalid: z.boolean().optional().default(false) });

// Importing writes to the inventory, so it needs write permission. History and details are readable.
router.get('/inventory/template', can('inventory:write'), h(ctrl.template));
router.get('/inventory/history', can('inventory:read'), validate(pageQuery(10), 'query'), h(ctrl.history));
router.post('/inventory/preview', can('inventory:write'), csvBody, validate(previewQuery, 'query'), h(ctrl.preview));
router.get('/inventory/:id', can('inventory:read'), h(ctrl.get));
router.post('/inventory/:id/confirm', can('inventory:write'), validate(confirmBody), h(ctrl.confirm));
router.post('/inventory/:id/cancel', can('inventory:write'), h(ctrl.cancel));

export default router;
