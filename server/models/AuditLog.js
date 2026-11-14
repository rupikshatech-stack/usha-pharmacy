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
    organizationId: orgField,
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
