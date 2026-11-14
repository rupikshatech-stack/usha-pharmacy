import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * One row per signed-in browser. The refresh token itself is never stored, only its SHA-256 hash.
 * A session is valid while it is not revoked and has not passed its (absolute) expiry.
 */
const sessionSchema = new Schema(
  {
    /**
     * Required for every ordinary session, and omitted only for a platform administrator, who belongs to no
     * organization (the same shape `User.organizationId` already uses for SUPER_ADMIN).
     *
     * The condition is `isPlatform`, NOT "organizationId happens to be missing". That distinction is the whole
     * safety of this field: if absence alone were allowed to mean "platform", then any bug that dropped the
     * organization — a typo, a refactor, a forgotten argument — would quietly mint a session that the tenant
     * plugin cannot scope, instead of failing loudly at validation. Omitting the organization has to be something
     * the caller asks for in as many words.
     */
    organizationId: { ...orgField, required: function () { return !this.isPlatform; } },
    // A platform (SUPER_ADMIN) session. It can reach /platform routes and nothing else: requireTenant refuses it,
    // so no organization's data is reachable with it.
    isPlatform: { type: Boolean, default: false },
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    refreshHash: { type: String, required: true, index: true },
    prevRefreshHash: { type: String, index: true }, // previous token, kept only to detect reuse
    rememberMe: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
    lastUsedAt: Date,
    ip: String,
    userAgent: String,
  },
  { timestamps: true },
);
// Sessions are found by opaque token/id before a tenant is known, so this collection is scoped only
// while a tenant context is active.
sessionSchema.plugin(tenantScope, { strict: false });

sessionSchema.index({ organizationId: 1, userId: 1 });
// MongoDB deletes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
