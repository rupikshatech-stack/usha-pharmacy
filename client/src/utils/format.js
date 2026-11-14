// Display helpers. The API sends every timestamp in UTC (ISO-8601 with "Z"); these format them in the
// organization's timezone (Asia/Kolkata by default), set once the user signs in.
let displayTimezone = 'Asia/Kolkata';

export const setDisplayTimezone = (tz) => {
  if (tz) displayTimezone = tz;
};
export const getDisplayTimezone = () => displayTimezone;

/**
 * How a calendar date is WRITTEN. Display only: every date in this system is stored as a UTC instant and stays one,
 * so changing this rewrites nothing in the database - it changes the characters on the screen.
 *
 * The default is exactly what every screen has always shown, "06 Nov 2026". When the format is the default the
 * original formatting call is used unchanged, not a re-implementation of it, so an organization that never opens
 * Common Settings sees the very same characters as before.
 */
export const DEFAULT_DATE_FORMAT = 'dd MMM yyyy';
let displayDateFormat = DEFAULT_DATE_FORMAT;
export const setDisplayDateFormat = (fmt) => {
  displayDateFormat = fmt || DEFAULT_DATE_FORMAT;
};
export const getDisplayDateFormat = () => displayDateFormat;

/** Writes `date` in `timeZone` the way `format` says. Only the four formats the settings screen offers. */
export function formatDateAs(date, format, timeZone) {
  const d = new Date(date);
  if (format === DEFAULT_DATE_FORMAT) {
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone });
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  switch (format) {
    case 'dd/MM/yyyy':
      return `${parts.day}/${parts.month}/${parts.year}`;
    case 'dd-MM-yyyy':
      return `${parts.day}-${parts.month}-${parts.year}`;
    case 'yyyy-MM-dd':
      return `${parts.year}-${parts.month}-${parts.day}`;
    default:
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone });
  }
}

export const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0);

/** A moment in time as a calendar date in the organization's timezone, e.g. "06 Nov 2026". */
export const dateFmt = (d) => (d ? formatDateAs(d, displayDateFormat, displayTimezone) : '—');

/** Date + time in the organization's timezone. */
export const dateTimeFmt = (d) => {
  if (!d) return '—';
  // The default is the original call, character for character; any other format writes the date its own way and
  // keeps the original time formatting beside it.
  if (displayDateFormat === DEFAULT_DATE_FORMAT) {
    return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: displayTimezone });
  }
  const time = new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: displayTimezone });
  return `${formatDateAs(d, displayDateFormat, displayTimezone)}, ${time}`;
};

/** A DATE-ONLY value such as a batch expiry (stored as midnight UTC). Formatted in UTC so it never shifts a day. */
export const expiryFmt = (d) => (d ? formatDateAs(d, displayDateFormat, 'UTC') : '—');

/** Random key that identifies one sale attempt, so the server can safely ignore retries of it. */
export const newIdempotencyKey = () =>
  globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

export const timeAgo = (d) => {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
