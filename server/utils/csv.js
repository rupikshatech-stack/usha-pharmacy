/**
 * CSV reading and writing. One place, because every file the system reads or produces has to behave the same way in a
 * spreadsheet: a field containing a comma, a quote or a line break is quoted, and a field that would be read as a
 * FORMULA is defused so the spreadsheet shows the text instead of running it (CSV injection).
 *
 * Rows are joined with CRLF, which is what the format says and what Excel on Windows expects.
 */

/** A file that is not valid CSV — raised by `parseCsv` so callers can tell a bad file from a bug. */
export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * Reads CSV text into rows of cells. Handles quoted fields (with `""` for a literal quote, and commas or line breaks
 * inside them), all three line endings, a leading byte-order mark, and a missing final newline. Empty cells are kept
 * as empty strings, because in a data file "blank" is an answer. A trailing newline does not make a final empty row.
 */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (quoted) throw new CsvError('A quoted value in the file is never closed — check for a stray " character.');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** A plain number is never a formula, however it starts — a negative figure must survive a round trip unchanged. */
const isNumber = (s) => /^-?\d+(\.\d+)?$/.test(s);
/** What a spreadsheet would try to evaluate. */
const isFormula = (s) => /^[=+@\t\r]/.test(s) || (s.startsWith('-') && !isNumber(s));

/** One cell as it is written: defused if it would be read as a formula, quoted if it would otherwise break the row. */
export const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (isFormula(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvRow = (cells) => cells.map(csvCell).join(',');

/** A whole file from rows of cells. */
export const toCsv = (rows) => rows.map(csvRow).join('\r\n');

/** A date and time as a person in the organization's own timezone reads it. */
export const localDateTime = (d, tz) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

/** A calendar day, for a file name: 2026-11-10. */
export const fileStamp = (tz, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(at).replace(/\//g, '-');

/**
 * The block every exported report opens with, so a printed or forwarded copy says exactly what it is a report OF —
 * which organization, which store, which period, and the filters that were in force.
 */
export const exportHeader = ({ title, org, store, period, tz, filters = [], rows }) => [
  [`Usha Pharmacy — ${title}`],
  ['Organization', org?.name || ''],
  ['Store', store],
  // A report with no period is not a report with an empty period: a stock position is true at a moment, and
  // printing a date range over it would invite somebody to read it as covering that range.
  period
    ? ['Period', `${localDateTime(period.start, tz)} to ${localDateTime(new Date(period.end.getTime() - 1), tz)}`]
    : ['Period', 'None — this is a position as at the time of export, not a figure for a date range'],
  ['Timezone', tz],
  ...filters,
  ['Generated', localDateTime(new Date(), tz)],
  ['Rows', String(rows)],
  [],
];
