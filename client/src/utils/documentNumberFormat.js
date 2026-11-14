/**
 * How a document number will look, for the preview on the settings screen.
 *
 * THE SERVER IS THE AUTHORITY. `server/utils/documentNumber.js` builds the number that actually goes on an invoice,
 * and the sequence comes from its counter — never from here. This exists so the preview can update while somebody
 * is still typing a prefix, before anything is saved. If the two ever disagree, the server is right.
 */

/** The financial year label an Indian business writes on a document: "25-26". */
export function financialYearLabel(date = new Date(), startMonth = 4) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
}

/**
 * Builds the number from a series' settings. A sequence wider than its padding is never truncated: a wrong number
 * is worse than an unevenly formatted one.
 */
export function formatDocumentNumber(config = {}, seq = 1, { financialYearLabel: fy } = {}) {
  const separator = config.separator ?? '-';
  const padding = Math.min(Math.max(Number(config.padding) || 0, 0), 12);
  const number = String(Math.max(0, Math.trunc(Number(seq) || 0))).padStart(padding, '0');
  return [config.prefix, config.includeFinancialYear && fy ? fy : null, number, config.suffix]
    .map((p) => (p === null || p === undefined ? '' : String(p).trim()))
    .filter((p) => p !== '')
    .join(separator);
}
