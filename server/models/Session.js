import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * One row per signed-in browser. The refresh token itself is never stored, only its SHA-256 hash.
 * A session is valid while it is not revoked and has not passed its (absolute) expiry.
 */
const sessionSchema = new Schema(
  {
    organizationId: orgField,
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
