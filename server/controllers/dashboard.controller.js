import { ApiError } from '../utils/ApiError.js';
import { parseLocalDate, startOfDay } from '../utils/tz.js';
import { orgTimezone } from '../services/organization.service.js';
import * as dashboard from '../services/dashboard.service.js';

const MAX_RANGE_DAYS = 366 * 5;

/**
 * Turns optional from/to calendar dates (local to the organization's timezone, both inclusive) into
 * a half-open UTC range [from, to). Rejects impossible dates, reversed ranges and absurdly long ranges.
 */
function resolveRange({ from, to }, tz) {
  const start = from ? parseLocalDate(from, tz) : null;
  const toStart = to ? parseLocalDate(to, tz) : null;
  if (from && !start) throw new ApiError(400, `"from" is not a valid date: ${from}`, undefined, 'INVALID_DATE');
  if (to && !toStart) throw new ApiError(400, `"to" is not a valid date: ${to}`, undefined, 'INVALID_DATE');
  const end = toStart ? startOfDay(toStart, tz, 1) : null; // "to" is inclusive of that whole day
  if (start && end && start >= end) throw new ApiError(400, '"from" must not be after "to"', undefined, 'INVALID_RANGE');
  if (start && end && (end - start) / 86400000 > MAX_RANGE_DAYS) throw new ApiError(400, 'Date range is too long (maximum 5 years)', undefined, 'INVALID_RANGE');
  return { from: start, to: end };
}

const org = (req) => req.tenant.organization;
const ok = (res, data) => res.json({ success: true, data });

export async function overview(req, res) {
  const range = resolveRange(req.query, orgTimezone(org(req)));
  ok(res, await dashboard.getOverview(org(req), range));
}

export async function monthlySales(req, res) {
  ok(res, await dashboard.getMonthlySales(org(req), req.query));
}

export async function stockLevels(req, res) {
  ok(res, await dashboard.getStockLevels(req.orgId, req.query));
}

export async function recentActivity(req, res) {
  const { from, to } = resolveRange(req.query, orgTimezone(org(req)));
  ok(res, await dashboard.getRecentActivity(req.orgId, { limit: req.query.limit, from, to }));
}

export async function alerts(req, res) {
  ok(res, await dashboard.getAlerts(req.orgId, req.query, new Date(), org(req)));
}
