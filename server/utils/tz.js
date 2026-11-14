// Timezone helpers built on Intl (no dependencies, DST-safe).
// All timestamps are STORED in UTC (MongoDB Dates). A "business day" or "month" is a range of UTC
// instants computed from the organization's IANA timezone (default Asia/Kolkata).

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
const formatter = (tz) => {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
    );
  }
  return fmtCache.get(tz);
};

/** Wall-clock parts of a UTC instant in a timezone. */
export function zonedParts(date, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) if (type !== 'literal') p[type] = Number(value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Offset (ms) of the timezone from UTC at a given instant: local = utc + offset. */
function offsetMs(utcMs, tz) {
  const p = zonedParts(new Date(utcMs), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads the given local date/time. */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = guess - offsetMs(guess, tz);
  utc = guess - offsetMs(utc, tz); // second pass settles DST edges
  return new Date(utc);
}

/** Start (00:00 local) of the local day containing `date`, shifted by `dayDelta` days. */
export function startOfDay(date, tz, dayDelta = 0) {
  const { year, month, day } = zonedParts(date, tz);
  // Date.UTC normalises overflow (day 0 / 32 …), so day arithmetic is calendar-correct.
  const d = new Date(Date.UTC(year, month - 1, day + dayDelta));
  return zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz);
}

/** Start of the local month containing `date`, shifted by `monthDelta` months. */
export function startOfMonth(date, tz, monthDelta = 0) {
  const { year, month } = zonedParts(date, tz);
  const d = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  return zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 }, tz);
}

/** "2026-11" for the local month containing `date`. */
export function monthKey(date, tz) {
  const { year, month } = zonedParts(date, tz);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** "2026-11-06" for the local calendar day containing `date`. */
export function dayKey(date, tz) {
  const { year, month, day } = zonedParts(date, tz);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parses "YYYY-MM-DD" as a LOCAL date in tz -> UTC instant of its start. Returns null if invalid. */
export function parseLocalDate(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return zonedToUtc({ year, month, day }, tz);
}

export const monthLabel = (key, tz = DEFAULT_TIMEZONE) => {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
};
