import mongoose from 'mongoose';
import { Schema, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';
import { PERMISSIONS, ROLE_KEY_PATTERN, ROLES } from '../config/permissions.js';

export { ROLES };

const userSchema = new Schema(
  {
    // Required for every role except the platform-level SUPER_ADMIN.
    organizationId: { ...orgField, required: function () { return this.role !== 'SUPER_ADMIN'; } },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    /**
     * The KEY of a role in the `roles` collection - not its display name, so renaming a role cannot orphan anybody.
     *
     * This was an enum of the five built-in roles. It can no longer be, because an organization may define its own;
     * what replaces the enum is not nothing, though. The shape is still checked here (a typo like "stafff" is still
     * refused at the model), and roles.service.js checks that the key names a role this organization actually has
     * before it ever reaches a user document. The built-in keys stay valid whether or not the rows were seeded.
     */
    role: {
      type: String,
      default: 'STAFF',
      uppercase: true,
      trim: true,
      validate: {
        validator: (v) => ROLES.includes(v) || ROLE_KEY_PATTERN.test(v),
        message: (p) => `"${p.value}" is not a valid role key (A-Z, 0-9 and underscores, starting with a letter).`,
      },
    },
    // Extra permissions on top of the role's defaults (see config/permissions.js).
    // Stores this person works in. Empty = every store (ORG_ADMIN always sees every store). Enforced on transfers by the server.
    branchIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    permissions: { type: [{ type: String, enum: PERMISSIONS }], default: [] },
    isActive: { type: Boolean, default: true },
    // Credits this person holds. It is changed ONLY together with a CreditTransaction ledger entry, inside one database transaction (see services/credit.service.js).
    creditBalance: { type: Number, default: 0, min: 0 },
    // Forces the user through the change-password screen before anything else.
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: Date,
    // Brute-force protection
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
  },
  timestamps,
);

// Login looks users up by email before any tenant is known, so this collection is scoped only while a
// tenant context is active (all tenant-facing user queries) and unscoped during sign-in.
userSchema.plugin(tenantScope, { strict: false });

// Email is globally unique because sign-in identifies the tenant FROM the email.
userSchema.index({ organizationId: 1, role: 1 });
userSchema.index({ organizationId: 1, isActive: 1 });

export const User = mongoose.model('User', userSchema);
