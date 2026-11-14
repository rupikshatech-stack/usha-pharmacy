import { zonedParts, zonedToUtc } from './tz.js';

/**
 * Which financial year a moment falls in, written once.
 *
 * The Indian financial year runs 1 April to 31 March, but an organization can set its own start month, so the rule
 * lives here and both the reporting period and the invoice numbering read it. Two definitions of "which year is
 * this" would eventually disagree, and the day they disagreed would be the day an invoice number collided with one
 * from last year.
 *
 * Boundaries are local midnights in the organization's timezone: a sale rung up at 11 pm on 31 March belongs to the
 * year that is ending, wherever the server happens to be.
 */
export function financialYearOf(date, startMonth = 4, tz = 'Asia/Kolkata') {
  const month = Math.min(Math.max(Number(startMonth) || 4, 1), 12);
  const { year, month: m } = zonedParts(date, tz);
  const startYear = m >= month ? year : year - 1;
  const endYear = startYear + 1;
  return {
    startYear,
    endYear,
    startMonth: month,
    start: zonedToUtc({ year: startYear, month, day: 1 }, tz),
    end: zonedToUtc({ year: endYear, month, day: 1 }, tz),
    /** Stable and sortable, for counter keys: "2025-26". Never shown to anybody. */
    key: `${startYear}-${String(endYear).slice(2)}`,
    /** What people write on an invoice: "25-26". */
    label: `${String(startYear).slice(2)}-${String(endYear).slice(2)}`,
    /** A financial year that starts in January is just a calendar year, and saying "2025-26" would be wrong. */
    isCalendarYear: month === 1,
  };
}
