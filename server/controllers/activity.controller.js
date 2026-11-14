import { listActivity } from '../services/activity.service.js';

export async function list(req, res) {
  res.json({ success: true, data: await listActivity(req.orgId, req.query) });
}
