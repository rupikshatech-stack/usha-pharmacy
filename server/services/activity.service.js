import { AuditLog } from '../models/index.js';
import { paginated } from '../utils/pagination.js';

/**
 * Security-noise events (someone mistyping a password) belong in the full audit log for admins,
 * not in the activity feed every team member sees on the dashboard.
 */
const FEED_EXCLUDED = ['AUTH_LOGIN_FAILED', 'AUTH_LOCKED', 'CREDIT_PROOF_UPLOAD']; // the proof upload is kept in the audit trail, but the feed already shows the request it belongs to

const createdAtRange = (from, to) => (from || to ? { createdAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } } : {});

const publicEvent = (a) => ({
  id: a._id,
  action: a.action,
  entity: a.entity,
  message: a.message,
  userName: a.userName,
  createdAt: a.createdAt, // ISO-8601 in UTC
});

/** Latest events for the dashboard feed (organization-scoped, newest first). */
export async function recentActivity(orgId, { limit = 10, from, to } = {}) {
  const rows = await AuditLog.find({ organizationId: orgId, action: { $nin: FEED_EXCLUDED }, ...createdAtRange(from, to) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return rows.map(publicEvent);
}

/** Full audit log, paginated (requires audit:read at the route). */
export async function listActivity(orgId, { page, limit }) {
  const filter = { organizationId: orgId };
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return paginated(items, { page, limit, total });
}
