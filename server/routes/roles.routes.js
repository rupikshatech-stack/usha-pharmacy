import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { createRoleSchema, createUserSchema, roleListQuery, updateRoleSchema, updateUserSchema, userListQuery } from '../validators/roles.validator.js';
import * as ctrl from '../controllers/roles.controller.js';

// Two routers, mounted at /roles and /users respectively. They are NOT one router mounted at '/': a router mounted
// at the root runs its `router.use` middleware for every request that reaches it, which would put the tenant guard
// in front of routes that must not have a tenant at all (the platform area), and run it twice for those that do.
const roles = Router();
const users = Router();
roles.use(...tenantGuard);
users.use(...tenantGuard);

/**
 * Roles and users. Everything here needs `users:manage` — including reading, because a list of who works for you and
 * what they may do is not something every cashier should be able to page through. There is no separate `users:read`;
 * one permission for one screen is easier to reason about than two that can disagree.
 *
 * There is NO delete endpoint for a user, by design. A user is deactivated, never removed: invoices, stock movements
 * and audit entries refer to them, and those records have to keep reading correctly for years.
 */
roles.get('/', can('users:manage'), validate(roleListQuery, 'query'), h(ctrl.listRoles));
roles.post('/', can('users:manage'), validate(createRoleSchema), h(ctrl.createRole));
roles.get('/:id', can('users:manage'), h(ctrl.getRole));
roles.patch('/:id', can('users:manage'), validate(updateRoleSchema), h(ctrl.updateRole));
roles.delete('/:id', can('users:manage'), h(ctrl.deleteRole));

users.get('/', can('users:manage'), validate(userListQuery, 'query'), h(ctrl.listUsers));
users.post('/', can('users:manage'), validate(createUserSchema), h(ctrl.createUser));
users.patch('/:id', can('users:manage'), validate(updateUserSchema), h(ctrl.updateUser));
users.post('/:id/deactivate', can('users:manage'), h(ctrl.deactivateUser));

export { roles, users };
