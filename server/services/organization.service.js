import { DEFAULT_TIMEZONE, startOfDay, zonedParts, zonedToUtc } from '../utils/tz.js';

export const orgTimezone = (org) => org?.timezone || DEFAULT_TIMEZONE;

/**
 * The organization's configured reporting period containing `now`, as a half-open UTC range
 * [start, end). `start`/`end` are null for "all time".
 *   fiscal_year   – starts on settings.fiscalYearStartMonth (default April, the Indian FY)
 *   calendar_year – January to December
 *   all_time      – no bounds
 * Boundaries are local midnights in the organization's timezone.
 */
export function reportingPeriod(org, now = new Date()) {
  const tz = orgTimezone(org);
  const type = org?.settings?.reportingPeriod || 'fiscal_year';
  const { year, month } = zonedParts(now, tz);

  if (type === 'all_time') return { type, label: 'All time', start: null, end: null };

  const startMonth = type === 'calendar_year' ? 1 : org?.settings?.fiscalYearStartMonth || 4;
  const startYear = month >= startMonth ? year : year - 1;
  const start = zonedToUtc({ year: startYear, month: startMonth, day: 1 }, tz);
  const end = zonedToUtc({ year: startYear + 1, month: startMonth, day: 1 }, tz);
  const label = startMonth === 1 ? String(startYear) : `FY ${startYear}-${String(startYear + 1).slice(2)}`;
  return { type, label, start, end };
}

/** "Today" for reports: [00:00 local today, 00:00 local tomorrow) in UTC instants. */
export function businessDay(org, now = new Date(), dayDelta = 0) {
  const tz = orgTimezone(org);
  return { start: startOfDay(now, tz, dayDelta), end: startOfDay(now, tz, dayDelta + 1) };
}
