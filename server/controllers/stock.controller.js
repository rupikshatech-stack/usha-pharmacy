import { adjustStock } from '../services/batch.service.js';
import { listMovements, reconcileStock } from '../services/ledger.service.js';
import { ApiError } from '../utils/ApiError.js';
import { parseLocalDate, startOfDay } from '../utils/tz.js';
import { orgTimezone } from '../services/organization.service.js';

export async function adjust(req, res) {
  res.status(201).json({ success: true, data: await adjustStock(req, req.body) });
}

export async function movements(req, res) {
  const tz = orgTimezone(req.tenant.organization);
  const { from, to, ...rest } = req.query;
  const start = from ? parseLocalDate(from, tz) : undefined;
  const toStart = to ? parseLocalDate(to, tz) : undefined;
  if ((from && !start) || (to && !toStart)) throw new ApiError(400, 'Not a valid date', undefined, 'INVALID_DATE');
  const end = toStart ? startOfDay(toStart, tz, 1) : undefined; // "to" includes that whole day
  res.json({ success: true, data: await listMovements(req.orgId, { ...rest, from: start, to: end }) });
}

export async function reconciliation(req, res) {
  res.json({ success: true, data: await reconcileStock(req.orgId) });
}
