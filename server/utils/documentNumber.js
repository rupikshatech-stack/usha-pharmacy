import { financialYearOf } from './financialYear.js';

/**
 * How a document number is built, and how the counter behind it is named.
 *
 * TWO RULES THAT CANNOT BE BROKEN, because breaking either one corrupts records that are already printed, filed and
 * sent to customers:
 *
 *   1. A number that has been issued never changes. These functions only ever build the NEXT number; nothing here
 *      can reach an invoice that already exists. Changing a prefix changes what the next invoice is called and
 *      nothing else.
 *   2. Two invoices never get the same number. The sequence comes from an atomic counter (`nextSeq`), and the
 *      counter's KEY is what decides which invoices share a sequence. Change the key and you start a new sequence —
 *      which is exactly what "reset every financial year" means, and exactly why the key must include everything
 *      that makes a series distinct: the organization, the document type, the branch when numbering is per branch,
 *      and the financial year when it resets.
 *
 * The format itself is a presentation detail: `SWS/25-26/0001` is prefix, financial year, padded sequence, joined by
 * a separator. Nothing downstream parses it — the sequence is kept in the counter, not read back out of the string.
 */

/** The document types this system actually issues. Nothing is configurable for a document that does not exist. */
export const DOCUMENT_SERIES = ['sales', 'salesReturn', 'purchase'];
export const SERIES_LABEL = {
  sales: 'Sales invoice',
  salesReturn: 'Sales return / credit note',
  purchase: 'Purchase order',
};
/** The counter keys this system used before numbering was configurable. The migration carries them forward. */
export const LEGACY_COUNTER_KEY = { sales: 'invoice', salesReturn: 'salesReturn', purchase: 'order' };
/** What each series looked like before anybody could configure it, so an untouched organization keeps its format. */
export const LEGACY_FORMAT = {
  sales: { prefix: 'INV', separator: '-', padding: 5 },
  salesReturn: { prefix: 'SR', separator: '-', padding: 4 },
  purchase: { prefix: 'ORD', separator: '-', padding: 4 },
};

/** A series' settings, filled in with the defaults for anything not set. */
export const seriesDefaults = (series) => ({
  series,
  branchId: null,
  prefix: LEGACY_FORMAT[series]?.prefix || '',
  suffix: '',
  separator: LEGACY_FORMAT[series]?.separator ?? '-',
  padding: LEGACY_FORMAT[series]?.padding ?? 4,
  start: 1,
  includeFinancialYear: false,
  resetEveryFinancialYear: false,
});

/**
 * The settings in force for one series in one branch: a branch's own configuration when it has one, otherwise the
 * organization's. A branch that has never been configured must behave exactly like the organization, not like an
 * empty form.
 */
export function seriesConfig(numbering, series, branchId) {
  const all = numbering?.series || [];
  const forBranch = branchId ? all.find((s) => s.series === series && String(s.branchId || '') === String(branchId)) : null;
  const forOrg = all.find((s) => s.series === series && !s.branchId);
  return { ...seriesDefaults(series), ...(forOrg || {}), ...(forBranch || {}) };
}

/**
 * The counter key for a series. Everything that makes a sequence separate goes in the key, and nothing else does —
 * a key that changed for any other reason would silently restart the numbering mid-year.
 */
export function counterKey({ series, branchId, financialYearKey, perBranch, resetEveryFinancialYear }) {
  /**
   * The base name is the key this system has ALWAYS used for the series ('invoice', 'order', 'salesReturn'), not
   * the new series name. That is deliberate: with the default configuration the key is byte-identical to the one
   * in the database today, so numbering continues from where it is with no migration and no possibility of
   * restarting at 1 and colliding with an invoice that already exists.
   *
   * Turning on per-branch numbering or a yearly reset DOES start a new counter, which is the point — but it also
   * means the new sequence begins at 1. Unless the format also changes (a branch prefix, or the financial year in
   * the number), that would re-issue numbers that are already on paper. Enabling either one therefore has to seed
   * the new counter above what the old sequence has reached; see services/settings.service.js.
   */
  const parts = [LEGACY_COUNTER_KEY[series] || series];
  if (perBranch && branchId) parts.push(`b:${branchId}`);
  if (resetEveryFinancialYear && financialYearKey) parts.push(`fy:${financialYearKey}`);
  return parts.join('|');
}

/**
 * Builds the number itself. The sequence is padded to the configured width, and a sequence that has outgrown its
 * padding is never truncated — 100000 with a padding of 4 prints as 100000, because a wrong number is worse than an
 * unevenly formatted one.
 */
export function formatDocumentNumber(config, seq, { financialYearLabel } = {}) {
  const c = { ...seriesDefaults(config?.series || 'sales'), ...(config || {}) };
  const sep = c.separator ?? '';
  const number = String(Math.max(0, Math.trunc(seq))).padStart(Math.min(Math.max(c.padding ?? 0, 0), 12), '0');
  const parts = [c.prefix, c.includeFinancialYear && financialYearLabel ? financialYearLabel : null, number, c.suffix]
    .map((p) => (p === null || p === undefined ? '' : String(p).trim()))
    .filter((p) => p !== '');
  return parts.join(sep);
}

/**
 * Everything needed to issue the next number in a series: the configuration in force, the counter to increment, and
 * what the result will look like. The caller increments the counter inside its own transaction — this function is
 * pure, so a preview and a real issue cannot disagree about the format.
 */
export function plan({ numbering, series, branchId, org, now = new Date(), tz = 'Asia/Kolkata' }) {
  const config = seriesConfig(numbering, series, branchId);
  const fy = financialYearOf(now, org?.settings?.fiscalYearStartMonth || 4, tz);
  const perBranch = Boolean(numbering?.perBranch);
  return {
    config,
    perBranch,
    financialYear: fy,
    key: counterKey({
      series,
      branchId,
      financialYearKey: fy.key,
      perBranch,
      resetEveryFinancialYear: config.resetEveryFinancialYear,
    }),
    /** What the number will be, given the sequence the counter hands back. */
    format: (seq) => formatDocumentNumber(config, seq, { financialYearLabel: fy.label }),
  };
}

/* ------------------------------------------------------------------ which existing documents may seed a counter */

/**
 * The largest step above the next-highest number that is still believed to be a real consecutive serial. GST invoice
 * serials are meant to run one after another within a series and a financial year, so a number a thousand past its
 * neighbour is not "the latest invoice" — it is something that does not belong (a demo row, an import, a typo), and
 * raising a counter to it would make every later invoice skip hundreds of numbers.
 */
export const MAX_SERIAL_JUMP = 1000;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The sequence in `number` — but ONLY if this series, with this configuration, would have printed exactly this
 * string. Pulling "the digits at the end" out of anything is how EXP-DEMO-090 ended up raising an invoice counter:
 * it ends in 90, but it is not an invoice number of this series, so it says nothing about what has been issued.
 *
 * The check is exact rather than approximate: the number is parsed, then REBUILT with the series' own formatter and
 * compared. That one comparison covers the prefix, the separator, the suffix, the padding, leading zeros, and the
 * financial-year segment together, and it cannot drift from how numbers are actually made because it uses the same
 * function.
 */
export function sequenceIfIssuedBy(config, number, { financialYearLabel } = {}) {
  const text = String(number ?? '').trim();
  if (!text) return null;
  const c = { ...seriesDefaults(config?.series || 'sales'), ...(config || {}) };
  const sep = escapeRe(c.separator ?? '');
  const pieces = [];
  if (String(c.prefix || '').trim()) pieces.push(escapeRe(String(c.prefix).trim()));
  if (c.includeFinancialYear && financialYearLabel) pieces.push(escapeRe(financialYearLabel));
  pieces.push('(\\d+)');
  if (String(c.suffix || '').trim()) pieces.push(escapeRe(String(c.suffix).trim()));
  const m = new RegExp(`^${pieces.join(sep)}$`).exec(text);
  if (!m) return null;
  const seq = Number(m[1]);
  return formatDocumentNumber(c, seq, { financialYearLabel }) === text ? seq : null;
}

/**
 * Sorts a scope's existing documents into the ones that may be used to seed a counter and the ones a person must
 * look at.
 *
 *   USABLE      the number is exactly what this series would have printed (see sequenceIfIssuedBy), and it follows
 *               on from the numbers below it — no more than `maxJump` above the next-highest accepted number.
 *   NEEDS REVIEW everything else: a number in some other format, or one that leaps far above its neighbours. These
 *               are NEVER used for seeding. They are returned with their `_id` so somebody can open the document and
 *               decide what it is, because the right answer (a demo row, a mis-typed import, a legitimate gap) is not
 *               one this code can know.
 *
 * `labelFor(date)` gives the financial-year label a document dated `date` would carry, so a number is compared with
 * what the series would have printed on ITS OWN day, not on today's.
 *
 * Nothing here writes anything; it only classifies.
 */
export function classifyForSeeding({ docs, config, labelFor = () => null, maxJump = MAX_SERIAL_JUMP }) {
  const c = { ...seriesDefaults(config?.series || 'sales'), ...(config || {}) };
  const needsReview = [];
  const matched = [];

  for (const d of docs) {
    const seq = sequenceIfIssuedBy(c, d.number, { financialYearLabel: labelFor(d.date) });
    if (seq === null) {
      needsReview.push({ _id: String(d._id), number: d.number, reason: `is not in this series' format (it would look like ${formatDocumentNumber(c, 1, { financialYearLabel: labelFor(d.date) })})` });
    } else {
      matched.push({ ...d, seq });
    }
  }

  // Walk upwards from where the series starts. A number that leaps too far above the highest accepted so far is set
  // aside and does not move the bar, so one stray row cannot drag everything after it out of range.
  matched.sort((a, b) => a.seq - b.seq);
  const baseline = Math.max(0, (Number(c.start) || 1) - 1);
  let current = baseline;
  let highestAccepted = 0;
  let highestNumber = null;
  for (const d of matched) {
    if (d.seq - current > maxJump) {
      needsReview.push({ _id: String(d._id), number: d.number, reason: `is ${d.seq - current} above the next-highest number (${current}); anything over ${maxJump} is treated as not part of the series` });
      continue;
    }
    current = Math.max(current, d.seq);
    if (d.seq >= highestAccepted) {
      highestAccepted = d.seq;
      highestNumber = d.number;
    }
  }
  return { highest: highestAccepted, highestNumber, usable: matched.length - needsReview.filter((r) => r.reason.includes('above the next-highest')).length, needsReview };
}
