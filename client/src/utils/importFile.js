// Browser-side helpers for the CSV import page. The browser only checks the basics early (type, size) for a quick
// message; the server validates the file and every row again and is the source of truth.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 2000;
const CSV_TYPES = new Set(['', 'text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']); // browsers report .csv in several ways

/** Returns an error message for a file that can't be imported, or '' if it looks fine. */
export function checkFile(file) {
  if (!file) return 'Choose a CSV file.';
  if (!/\.csv$/i.test(file.name)) return 'Only .csv files can be imported. In Excel, use “Save As → CSV (Comma delimited)”.';
  if (!CSV_TYPES.has(file.type)) return `This file looks like ${file.type}, not a CSV text file.`;
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_FILE_BYTES) return `The file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1048576} MB.`;
  return '';
}

export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // never let a spreadsheet run a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

/** The “fix these and upload again” file: one line per row that needs attention, with what is wrong. */
export function errorReportCsv(rows) {
  const bad = rows.filter((r) => r.status === 'invalid' || r.status === 'failed');
  return toCsv([
    ['row', 'status', 'medicineName', 'sku', 'barcode', 'batchNumber', 'problems'],
    ...bad.map((r) => [r.row, r.status, r.medicineName, r.sku, r.barcode, r.batchNumber, (r.errors?.length ? r.errors.map((e) => `${e.field}: ${e.message}`).join(' | ') : r.message) || '']),
  ]);
}

/** Row filter tabs, in order, with the number of rows in each. */
export function rowTabs(rows) {
  const n = (...statuses) => rows.filter((r) => statuses.includes(r.status)).length;
  return [
    { key: 'all', label: 'All', count: rows.length, match: () => true },
    { key: 'ok', label: 'Valid / imported', count: n('valid', 'imported'), match: (r) => r.status === 'valid' || r.status === 'imported' },
    { key: 'invalid', label: 'Errors', count: n('invalid', 'failed'), match: (r) => r.status === 'invalid' || r.status === 'failed' },
    { key: 'skipped', label: 'Skipped', count: n('skipped'), match: (r) => r.status === 'skipped' },
  ];
}

/** Counts shown on the summary, whichever stage the import is in. */
export function summaryCards(summary, finished) {
  const cards = [
    { key: 'total', label: 'Total rows', value: summary.total, tone: 'neutral' },
    { key: 'valid', label: 'Valid rows', value: summary.valid, tone: 'success' },
    { key: 'invalid', label: 'Invalid rows', value: summary.invalid, tone: summary.invalid ? 'danger' : 'neutral' },
  ];
  if (finished) cards.push({ key: 'imported', label: 'Successfully imported', value: summary.imported, tone: 'success' });
  cards.push({ key: 'skipped', label: 'Skipped rows', value: summary.skipped, tone: summary.skipped ? 'warning' : 'neutral' });
  if (finished && summary.failed) cards.push({ key: 'failed', label: 'Failed (rolled back)', value: summary.failed, tone: 'danger' });
  return cards;
}

export const confirmLabel = (summary) => {
  if (summary.valid === 0) return 'Nothing to import';
  const base = `Import ${summary.valid} valid row${summary.valid === 1 ? '' : 's'}`;
  return summary.invalid ? `${base} and skip ${summary.invalid} with errors` : base;
};
