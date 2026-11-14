import mongoose from 'mongoose';
import { Schema, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';
import { PERMISSIONS, ROLE_KEY_PATTERN, SYSTEM_ROLES } from '../config/permissions.js';

export { SYSTEM_ROLES };

export const ROLE_SCOPES = ['organization', 'branch'];

/**
 * A role: a named set of permissions an organization can edit.
 *
 * Roles used to be five words in config/permissions.js. They are rows now, so that an organization can say what its
 * own "Branch Manager" may do without a developer. Three things make that safe:
 *
 *   THE KEY IS THE LINK, NOT THE NAME. `User.role` stores `key`, never the display name, so renaming a custom role
 *     cannot orphan the people in it. A system role's key is one of the five the code has always known, which is why
 *     a system role may not be renamed or deleted: existing users point at it, and so do the fallback defaults.
 *   PERMISSIONS ARE CLOSED. Every entry must be in the PERMISSIONS catalogue. Mongoose would silently drop an unknown
 *     one from an enum array on some paths, so the service refuses the save outright and names the offender - the
 *     same lesson as the settings paths that saved "successfully" and stored nothing.
 *   SCOPE IS A LABEL, FOR NOW. `scope` records intent ("this role is meant for one store") and is shown on the
 *     screen, but NOTHING reads it when answering a query: no list is narrowed, no record hidden. The UI says so in
 *     as many words, because a permission control that looks enforced and is not is worse than one that is absent.
 */
const roleSchema = new Schema(
  {
    organizationId: orgField,
    // What User.role stores. Uppercase, underscore-separated; generated from the name for a custom role.
    key: { type: String, required: true, trim: true, uppercase: true, match: [ROLE_KEY_PATTERN, 'A role key must be 2-40 characters: A-Z, 0-9 and underscores, starting with a letter'] },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 240, default: '' },
    scope: { type: String, enum: ROLE_SCOPES, default: 'organization' },
    permissions: { type: [{ type: String, enum: PERMISSIONS }], default: [] },
    // One of the five the code ships with. Its permissions are editable; its name and existence are not.
    isSystem: { type: Boolean, default: false },
  },
  timestamps,
);

roleSchema.plugin(tenantScope);

// One role per key per organization - the uniqueness the whole design leans on, enforced by the database rather than
// by a check that two concurrent requests could both pass.
roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });
// Two roles in one organization may not share a display name either; case-insensitively, because "Finance" and
// "finance" in the same list is a support call waiting to happen.
roleSchema.index({ organizationId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const Role = mongoose.model('Role', roleSchema);
