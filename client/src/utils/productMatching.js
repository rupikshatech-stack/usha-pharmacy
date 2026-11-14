/**
 * Helpers for the product matching screen. They only describe and filter what the server decided; the screen never decides a match. Colours follow the
 * three outcomes: green = matched, orange = needs review, red = unmatched. A "matched" row is still not final until a person confirms it.
 */

export const STATUS_TONE = { matched: 'success', needs_review: 'warning', unmatched: 'danger' };
export const STATUS_TEXT = { matched: 'Matched', needs_review: 'Needs Review', unmatched: 'Unmatched' };
export const FILTERS = [
  ['', 'All'],
  ['matched', 'Matched'],
  ['needs_review', 'Needs Review'],
  ['unmatched', 'Unmatched'],
];
export const MAPPING_SOURCE_TEXT = { automatic: 'Automatic', manual: 'Manual', previously_confirmed: 'Previously confirmed' };

/** The four cards at the top, from the server's summary. */
export function summaryCards(summary) {
  const s = summary || {};
  return [
    { key: 'total', label: 'Total Invoice Items', value: s.total ?? 0, hint: `${s.confirmed ?? 0} confirmed` },
    { key: 'matched', label: 'Matched Products', value: s.matched ?? 0, hint: 'No conflicts found', tone: 'success' },
    { key: 'review', label: 'Needs Review', value: s.needsReview ?? 0, hint: 'A person must check', tone: 'warning' },
    { key: 'unmatched', label: 'Unmatched Products', value: s.unmatched ?? 0, hint: 'No reliable product', tone: 'danger' },
  ];
}

/** Which actions a row offers. Nothing is offered that the server would refuse outright. */
export function rowActions(row) {
  const hasProduct = Boolean(row.product);
  return {
    viewSuggestions: row.suggestions.length > 0 || row.notMatchedYet || row.status !== 'matched',
    selectLabel: hasProduct ? 'Change Match' : 'Select Product',
    confirm: hasProduct && row.confirmation !== 'confirmed' && !row.stale && !row.notMatchedYet,
    markUnmatched: row.confirmation !== 'unmatched',
  };
}

/** A critical conflict (strength, dosage form, active ingredient) — the server never matches these by itself. */
export const criticalConflicts = (conflicts) => (conflicts || []).filter((c) => c.level === 'critical');

/** A score for display: it is a similarity of the attributes both sides state, not a probability, so it is shown as a plain percentage next to the reasons. */
export const scoreText = (s) => (typeof s === 'number' ? `${Math.round(s * 100)}%` : '—');

/** The one-line text for a product. */
export const productLine = (p) => (p ? [p.name, p.strength, p.dosageForm].filter(Boolean).join(' · ') : '');

/** What a row still needs before the invoice is ready for the next phase. */
export function remaining(summary) {
  const s = summary || {};
  return Math.max(0, (s.total ?? 0) - (s.confirmed ?? 0) - (s.markedUnmatched ?? 0)); // a row marked “no matching product” is a decision too
}

/**
 * Puts the confirmed products into the review draft the order form takes (the rows keep their own batch, expiry and prices). Only CONFIRMED rows get a
 * product; everything else stays for the person to choose.
 */
export function withConfirmedProducts(draft, matches) {
  if (!matches) return draft;
  const byId = new Map((matches.items || []).filter((r) => r.confirmation === 'confirmed' && r.product).map((r) => [r.itemId, r.product]));
  return {
    ...draft,
    items: draft.items.map((it, i) => {
      const p = byId.get(it.itemId ?? draft.itemIds?.[i]);
      return p
        ? {
            ...it,
            match: {
              status: 'exact',
              medicineId: p._id,
              candidates: [{ medicineId: p._id, name: p.name, unit: p.unit, sku: p.sku, manufacturer: p.manufacturer, gstPercent: p.gstPercentage ?? 12, score: 1 }],
            },
          }
        : it;
    }),
  };
}
