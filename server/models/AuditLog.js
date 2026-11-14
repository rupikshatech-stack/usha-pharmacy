import mongoose from 'mongoose';
import { Schema, Types, orgField } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

/**
 * The audit trail is **append-only**: entries are written by services/audit.service.js and after that nothing — no user, no administrator, no other service —
 * can change or remove one. Reading it needs `audit:read` (ORG_ADMIN and BRANCH_MANAGER by default, never plain staff) and there is no API that writes to it.
 */
class AuditImmutableError extends Error {
  constructor() {
    super('Audit entries cannot be changed or deleted.');
    this.name = 'AuditImmutableError';
    this.status = 409;
  }
}

const auditSchema = new Schema(
  {
    /**
     * Required for every organization event, and omitted only for a platform one - exactly the shape Session uses,
     * and for the same reason: a platform administrator belongs to no organization, but their actions (signing in,
     * creating a pharmacy) are the ones most worth keeping a record of, so they must be writable somewhere.
     *
     * As on Session, the condition is the explicit `isPlatform` flag and never "the organization happens to be
     * missing", so a dropped organizationId stays a loud validation failure instead of silently producing an
     * unscoped audit row.
     */
    organizationId: { ...orgField, required: function () { return !this.isPlatform; } },
    // A platform-level event, belonging to no organization. Never returned by an organization's activity log.
    isPlatform: { type: Boolean, default: false },
    userId: { type: Types.ObjectId, ref: 'User' },
    userName: String,
    action: { type: String, required: true },
    entity: String,
    entityId: Types.ObjectId,
    message: String,
    meta: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
auditSchema.pre(BLOCKED, function () {
  throw new AuditImmutableError();
});
auditSchema.pre('save', function () {
  if (!this.isNew) throw new AuditImmutableError();
});
auditSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new AuditImmutableError();
});

auditSchema.index({ organizationId: 1, createdAt: -1 });
auditSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
auditSchema.index({ organizationId: 1, action: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
