/**
 * How the Expiry Intelligence screen SAYS things.
 *
 * Every business figure on that screen is worked out by the server (see server/services/expiryRisk.js) — nothing here
 * recalculates a risk score, a projected loss or a discount. What lives here is presentation: which colour a risk band
 * wears, how a countdown reads in English, and how the filters travel in the URL so a view can be bookmarked and sent
 * to a colleague.
 */

/** The risk bands, worst first, with the tone each wears. Tones are the ones `Badge` already knows. */
export const RISK_TONE = { critical: 'danger', high: 'orange', medium: 'warning', low: 'info', safe: 'success' };
export const RISK_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', safe: 'Safe' };
export const RISK_ORDER = ['critical', 'high', 'medium', 'low', 'safe'];

/** The colour a countdown chip wears, which is about the DATE alone — the risk badge next to it carries the judgement. */
export function expiryTone(days) {
  if (days === null || days === undefined) return 'neutral';
  if (days <= 0) return 'danger';
  if (days <= 15) return 'danger';
  if (days <= 30) return 'orange';
  if (days <= 90) return 'warning';
  return 'success';
}

/**
 * A countdown in the words a person would use. "Expired 45 days ago" and "45 days left" are very different facts and
 * should not look alike, so the past tense is spelled out rather than shown as a minus sign.
 */
export function countdownLabel(days) {
  if (days === null || days === undefined) return 'No expiry recorded';
  if (days === 0) return 'Expires today';
  if (days < 0) {
    const n = Math.abs(days);
    if (n === 1) return 'Expired yesterday';
    if (n < 30) return `Expired ${n} days ago`;
    if (n < 365) return `Expired ${Math.round(n / 30)} months ago`;
    return `Expired over ${Math.floor(n / 365)} year${n >= 730 ? 's' : ''} ago`;
  }
  if (days === 1) return '1 day left';
  if (days < 60) return `${days} days left`;
  if (days < 365) return `${Math.round(days / 30)} months left`;
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)} years left`;
}

/**
 * How far through its life a lot is, 0–100, for the little bar in the Expiry timeline column.
 * Measured from when the lot was received to when it expires, because that is the window the pharmacy actually had to
 * sell it in. With no received date to go on it falls back to a year, and a lot past its date always reads as full.
 */
export function shelfLifeUsed(receivedAt, expiryDate, now = new Date()) {
  if (!expiryDate) return 0;
  const end = new Date(expiryDate).getTime();
  const nowMs = new Date(now).getTime();
  if (nowMs >= end) return 100;
  const start = receivedAt ? new Date(receivedAt).getTime() : end - 365 * 86400000;
  if (!(start < end)) return 100;
  return Math.round(Math.min(100, Math.max(0, ((nowMs - start) / (end - start)) * 100)));
}

/** A whole-unit count with Indian grouping: "1,400 tablets". */
export const units = (n, unit = 'units') => `${Number(n || 0).toLocaleString('en-IN')} ${unit}`;

/* ------------------------------------------------------------------ the URL */

/**
 * The filters that travel in the address bar. Keeping them there is what makes a view shareable: "look at the Critical
 * Schedule-H stock in the Andheri store" is a link, not a list of instructions.
 *
 * Only values that differ from the default are written, so a plain visit has a clean URL.
 */
export const URL_KEYS = ['status', 'search', 'categoryId', 'manufacturer', 'supplierId', 'scheduleCategory', 'riskLevel', 'minValue', 'expiryFrom', 'expiryTo', 'groupBy', 'sortBy', 'sortDir', 'branchId', 'view', 'page', 'limit'];

export const DEFAULTS = {
  status: 'all',
  search: '',
  categoryId: '',
  manufacturer: '',
  supplierId: '',
  scheduleCategory: '',
  riskLevel: '',
  minValue: '',
  expiryFrom: '',
  expiryTo: '',
  groupBy: 'none',
  sortBy: 'risk',
  sortDir: 'desc',
  branchId: '',
  view: 'table',
  page: 1,
  limit: 25,
};

/** Reads the screen's state out of the address bar, falling back to the defaults. */
export function stateFromSearch(search) {
  const p = new URLSearchParams(search);
  const out = { ...DEFAULTS };
  for (const key of URL_KEYS) {
    const v = p.get(key);
    if (v === null || v === '') continue;
    out[key] = key === 'page' || key === 'limit' ? Math.max(1, Number(v) || DEFAULTS[key]) : v;
  }
  return out;
}

/** Writes the state back, leaving out anything still at its default so the URL stays readable. */
export function searchFromState(state) {
  const p = new URLSearchParams();
  for (const key of URL_KEYS) {
    const v = state[key];
    if (v === undefined || v === null || v === '' || String(v) === String(DEFAULTS[key])) continue;
    p.set(key, String(v));
  }
  return p.toString();
}

/** The query the server is asked, which is the state minus the things only the browser cares about. */
export function queryFromState(state) {
  const q = {};
  for (const key of URL_KEYS) {
    if (key === 'view') continue; // table or calendar is a client-side choice
    const v = state[key];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    q[key] = v;
  }
  return q;
}

/** How many filters are narrowing the view, for the "clear filters" button to count. */
export const activeFilterCount = (state) =>
  ['status', 'search', 'categoryId', 'manufacturer', 'supplierId', 'scheduleCategory', 'riskLevel', 'minValue', 'expiryFrom', 'expiryTo'].filter(
    (k) => state[k] && String(state[k]) !== String(DEFAULTS[k]),
  ).length;

/* ------------------------------------------------------------------ actions */

/** What each action is called, and what it warns about before it is done. */
export const ACTION_LABEL = {
  dispose: 'Write off',
  clearance: 'Mark for clearance',
  clearanceClear: 'Take off clearance',
  returnRequest: 'Request supplier return',
  returnSettle: 'Close supplier return',
};

/**
 * Which actions make sense for a lot as it stands. Offering an action that the server will refuse is a small lie, so
 * the row only shows what would actually work.
 */
export function availableActions(row) {
  if (!row) return [];
  if (row.status === 'disposed') return [];
  const open = row.supplierReturnStatus === 'requested';
  const gone = row.supplierReturnStatus === 'returned';
  if (gone) return [];
  if (open) return ['returnSettle']; // the lot is quarantined: settle it before anything else
  const out = [];
  if (row.supplierId) out.push('returnRequest');
  out.push(row.clearanceFlagged ? 'clearanceClear' : 'clearance');
  out.push('dispose');
  return out;
}

/** Which actions can sensibly be done to a whole selection at once. */
export function bulkActions(rows) {
  if (!rows.length) return [];
  const per = rows.map(availableActions);
  return ['returnRequest', 'clearance', 'dispose', 'returnSettle'].filter((a) => per.every((list) => list.includes(a)));
}
