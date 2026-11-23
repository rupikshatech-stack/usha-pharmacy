import express, { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requireAnyPermission, requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { generalSettingsSchema, invoiceSettingsSchema, organizationSettingsSchema, previewNumberQuery, resetInvoiceSchema } from '../validators/settings.validator.js';
import * as ctrl from '../controllers/settings.controller.js';
import { DOCUMENT_TYPES, IMAGE_TYPES, documentMaxBytes, logoMaxBytes } from '../services/settingsFiles.service.js';

const router = Router();
router.use(...tenantGuard);

/**
 * Settings. Reading needs `settings:read`, which most roles have; changing needs `settings:manage`, which they do
 * not. There is no `settings:write` in this system — these are the two permissions that already exist, and adding a
 * third name for the same privilege is how two of them end up disagreeing.
 */
router.get('/', can('settings:read'), h(ctrl.get));
router.get('/invoice/preview-number', can('settings:read'), validate(previewNumberQuery, 'query'), h(ctrl.previewNumber));

router.patch('/organization', can('settings:manage'), validate(organizationSettingsSchema), h(ctrl.saveOrganization));
router.patch('/invoice', can('settings:manage'), validate(invoiceSettingsSchema), h(ctrl.saveInvoice));
router.patch('/general', can('settings:manage'), validate(generalSettingsSchema), h(ctrl.saveGeneral));
router.post('/invoice/reset', can('settings:manage'), validate(resetInvoiceSchema), h(ctrl.resetInvoice));

/**
 * Files. The image itself is the request body — there is no multipart parser in this project and none is needed:
 * one file per request, parsed by express.raw, with the real type decided from the bytes. The limit is a little
 * above the allowed size so an oversized upload is answered with a clear 413 rather than a truncated stream.
 */
router.post('/logo', can('settings:manage'), express.raw({ type: IMAGE_TYPES, limit: logoMaxBytes() + 64 * 1024 }), h(ctrl.uploadLogo));
router.delete('/logo', can('settings:manage'), h(ctrl.deleteLogo));
// The logo is printed on every invoice, so anyone who can see or issue an invoice may fetch it (a billing-only user's print would otherwise
// have a broken image where the logo goes).
router.get('/logo/:file', requireAnyPermission('settings:read', 'billing:read', 'billing:create'), h(ctrl.getLogo));

router.post('/documents', can('settings:manage'), express.raw({ type: DOCUMENT_TYPES, limit: documentMaxBytes() + 64 * 1024 }), h(ctrl.uploadDocument));
router.get('/documents/:file', can('settings:read'), h(ctrl.getDocument));

export default router;
