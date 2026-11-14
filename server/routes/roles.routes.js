import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { createRoleSchema, createUserSchema, roleListQuery, updateRoleSchema, updateUserSchema, userListQuery } from '../validators/roles.validator.js';
import * as ctrl from '../controllers/roles.controller.js';

const router = Router();
router.use(...tenantGuard);

/**
 * Roles and users. Everything here needs `users:manage` — including reading, because a list of who works for you and
 * what they may do is not something every cashier should be able to page through. There is no separate `users:read`;
 * one permission for one screen is easier to reason about than two that can disagree.
 *
 * There is NO delete endpoint for a user, by design. A user is deactivated, never removed: invoices, stock movements
 * and audit entries refer to them, and those records have to keep reading correctly for years.
 */
router.get('/roles', can('users:manage'), validate(roleListQuery, 'query'), h(ctrl.listRoles));
router.post('/roles', can('users:manage'), validate(createRoleSchema), h(ctrl.createRole));
router.get('/roles/:id', can('users:manage'), h(ctrl.getRole));
router.patch('/roles/:id', can('users:manage'), validate(updateRoleSchema), h(ctrl.updateRole));
router.delete('/roles/:id', can('users:manage'), h(ctrl.deleteRole));

router.get('/users', can('users:manage'), validate(userListQuery, 'query'), h(ctrl.listUsers));
router.post('/users', can('users:manage'), validate(createUserSchema), h(ctrl.createUser));
router.patch('/users/:id', can('users:manage'), validate(updateUserSchema), h(ctrl.updateUser));
router.post('/users/:id/deactivate', can('users:manage'), h(ctrl.deactivateUser));

export default router;
