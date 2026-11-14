import { z } from 'zod';
import { PERMISSIONS, ROLE_KEY_PATTERN } from '../config/permissions.js';
import { ROLE_SCOPES } from '../models/Role.js';

/**
 * What may be sent to the Roles and Users endpoints.
 *
 * The permission list is checked TWICE on purpose: here, so a typo is a clean 400 with the offending string named,
 * and again in roles.service.js before the write. The second check is not redundant - it is the one that holds when
 * a caller reaches the service by another path, and it is the thing that stops Mongoose quietly dropping an unknown
 * entry from an enum array and reporting success, which is how the settings screens once "saved" nothing at all.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');
const permission = z.enum(PERMISSIONS, { error: (iss) => `"${iss.input}" is not a permission this system has` });

export const roleListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'Give the role a name of at least 2 characters').max(60),
  description: z.string().trim().max(240).optional(),
  scope: z.enum(ROLE_SCOPES).optional(),
  permissions: z.array(permission).max(PERMISSIONS.length).default([]),
  // The key is derived from the name by the server. Accepting one from the client would let two organizations
  // disagree about what a key means, and would let somebody claim a built-in key.
  key: z.undefined({ error: 'The role key is generated from the name; do not send one.' }).optional(),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(240).optional(),
    scope: z.enum(ROLE_SCOPES).optional(),
    permissions: z.array(permission).max(PERMISSIONS.length).optional(),
    key: z.undefined({ error: 'A role key cannot be changed: users refer to the role by it.' }).optional(),
    isSystem: z.undefined({ error: 'Whether a role is built in is not something that can be set.' }).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => v[k] !== undefined), { error: 'Nothing to change.' });

export const userListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.string().trim().regex(ROLE_KEY_PATTERN, 'Not a valid role key').optional(),
  branchId: objectId.optional(),
  active: z.enum(['all', 'active', 'inactive']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Give the person a name of at least 2 characters').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  // The administrator sets an initial password and the person is forced to change it at first sign-in. There is no
  // invite email and no self-service reset here; both are separate work.
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  role: z.string().trim().regex(ROLE_KEY_PATTERN, 'Not a valid role key'),
  branchIds: z.array(objectId).max(100).default([]),
  isActive: z.boolean().optional(),
  permissions: z.undefined({ error: 'Per-user extra permissions are not set here; give the person a role that grants them.' }).optional(),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    role: z.string().trim().regex(ROLE_KEY_PATTERN, 'Not a valid role key').optional(),
    branchIds: z.array(objectId).max(100).optional(),
    isActive: z.boolean().optional(),
    email: z.undefined({ error: 'An email address identifies the account at sign-in and cannot be changed here.' }).optional(),
    password: z.undefined({ error: 'Passwords are not set here.' }).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => v[k] !== undefined), { error: 'Nothing to change.' });
