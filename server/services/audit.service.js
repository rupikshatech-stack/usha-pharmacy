import { AuditLog } from '../models/index.js';

/** Records an audit entry for the current tenant. Pass a session to make it part of a transaction. */
export async function audit(req, { action, entity, entityId, message, meta }, session) {
  await AuditLog.create(
    [
      {
        organizationId: req.orgId,
        userId: req.user._id,
        userName: req.user.name,
        action,
        entity,
        entityId,
        message,
        meta,
        ip: req.ip,
      },
    ],
    { session },
  );
}
