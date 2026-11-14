import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { compoundBatchQuery, createAttributeSchema, createCompoundSchema, linkMedicinesSchema, listAttributesQuery, listCompoundsQuery, updateAttributeSchema, updateCompoundSchema } from '../validators/catalog.validator.js';
import * as ctrl from '../controllers/catalog.controller.js';

/** Compounds and Attributes (categories, dosage forms, strengths, units …). */
export const compounds = Router();
compounds.use(...tenantGuard);
compounds.get('/', can('inventory:read'), validate(listCompoundsQuery, 'query'), h(ctrl.listCompounds));
compounds.get('/:id', can('inventory:read'), h(ctrl.getCompound));
compounds.get('/:id/batch', can('inventory:read'), validate(compoundBatchQuery, 'query'), h(ctrl.compoundBatch)); // ?quantity=50 — what to weigh for that batch
compounds.post('/', can('inventory:write'), validate(createCompoundSchema), h(ctrl.createCompound));
compounds.post('/:id/medicines', can('inventory:write'), validate(linkMedicinesSchema), h(ctrl.linkMedicines)); // link medicines
compounds.delete('/:id/medicines/:medicineId', can('inventory:write'), h(ctrl.unlinkMedicine)); // unlink one
compounds.put('/:id', can('inventory:write'), validate(updateCompoundSchema), h(ctrl.updateCompound));
compounds.delete('/:id', can('inventory:delete'), h(ctrl.deleteCompound));

export const attributes = Router();
attributes.use(...tenantGuard);
attributes.get('/', can('inventory:read'), validate(listAttributesQuery, 'query'), h(ctrl.listAttributes));
attributes.post('/', can('inventory:write'), validate(createAttributeSchema), h(ctrl.createAttribute));
attributes.put('/:id', can('inventory:write'), validate(updateAttributeSchema), h(ctrl.updateAttribute));
attributes.delete('/:id', can('inventory:delete'), h(ctrl.deleteAttribute));
