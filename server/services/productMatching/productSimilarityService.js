import { sameBase } from './productNormalizationService.js';

/**
 * Comparing one invoice medicine with one product, attribute by attribute. Pure functions, no database.
 *
 * The result is a SCORE (a weighted similarity of the attributes that both sides state — not a probability: 0.9 does not mean "90% likely correct"), the
 * REASONS that support the match, and the CONFLICTS that count against it:
 *   critical – a different medicine in pharmacy terms: another strength, another dosage form or another active ingredient. A critical conflict can never be
 *              matched automatically, whatever the score.
 *   warning  – something a person should verify: another manufacturer, another pack size, another HSN, an attribute the invoice does not state, a brand mismatch.
 * Attributes that are missing on one side are not scored (they cannot agree or disagree) but are flagged when the product states what the invoice leaves out.
 */

/* ------------------------------------------------------------------------------------------------ string similarity */

/** 1 = identical, 0 = nothing in common: 1 - (edit distance / longer length). */
export function levenshteinRatio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

const bigrams = (s) => {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
  return out;
};
/** Dice coefficient on character pairs. */
export function dice(a, b) {
  const x = String(a).replace(/\s+/g, '');
  const y = String(b).replace(/\s+/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) || 0);
  return (2 * common) / (x.length - 1 + y.length - 1);
}

/** How alike two lists of words are, allowing for spelling slips: each word is paired with its best partner (one-to-one), partners count by their similarity. */
export function tokenSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const used = new Set();
  let total = 0;
  for (const t of a) {
    let best = 0;
    let at = -1;
    b.forEach((u, i) => {
      if (used.has(i)) return;
      const r = t === u ? 1 : levenshteinRatio(t, u);
      if (r > best) {
        best = r;
        at = i;
      }
    });
    if (best >= 0.75) {
      used.add(at);
      total += best;
    }
  }
  return (2 * total) / (a.length + b.length);
}

/** Name similarity of two described medicines (their cores): the better of word-by-word and whole-string comparison. */
export function nameSimilarity(a, b) {
  if (!a.core || !b.core) return 0;
  if (a.core === b.core) return 1;
  return Math.max(tokenSimilarity(a.tokens, b.tokens), 0.95 * dice(a.core, b.core));
}

/* ------------------------------------------------------------------------------------------------ configuration */

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
/**
 * The thresholds and weights. Read from the environment on every call, so they can be tuned without a deployment:
 *   PRODUCT_MATCH_AUTO_THRESHOLD    (0.90) a candidate at or above this, with no conflicts or warnings, is "Matched"
 *   PRODUCT_MATCH_REVIEW_THRESHOLD  (0.55) at or above this (and not critical) it is "Needs review"; below it the item is "Unmatched"
 *   PRODUCT_MATCH_SUGGESTION_FLOOR  (0.35) weaker candidates are not even suggested
 *   PRODUCT_MATCH_MAX_SUGGESTIONS   (5)
 *   PRODUCT_MATCH_AMBIGUITY_MARGIN  (0.04) two acceptable candidates this close make the item "Needs review" (which product?)
 */
export function matchingConfig(env = process.env) {
  const auto = num(env.PRODUCT_MATCH_AUTO_THRESHOLD, 0.9);
  const review = Math.min(num(env.PRODUCT_MATCH_REVIEW_THRESHOLD, 0.55), auto);
  return {
    auto, review, suggestionFloor: Math.min(num(env.PRODUCT_MATCH_SUGGESTION_FLOOR, 0.35), review), maxSuggestions: Math.max(1, Math.min(10, Math.round(num(env.PRODUCT_MATCH_MAX_SUGGESTIONS, 5)))),
    ambiguityMargin: num(env.PRODUCT_MATCH_AMBIGUITY_MARGIN, 0.04),
    weights: { name: 0.5, strength: 0.2, form: 0.15, manufacturer: 0.1, pack: 0.03, hsn: 0.02 },
  };
}

/* ------------------------------------------------------------------------------------------------ comparing attributes */

const numbersOf = (strengths) => strengths.map((s) => s.replace(/mg\/.*$/, '').replace(/[a-z%/].*$/, ''));
const pct = (x) => `${Math.round(x * 100)}%`;
const label = (a) => (a.length ? a.join(' + ') : '—');

/**
 * Compares an invoice line (`inv`, from describe()) with a product (`prod`, from describe(), plus `ingredientPool`: words naming its active ingredients).
 * Returns { score, reasons, conflicts: [{ level, code, message }], compared: [attribute names that were scored] }.
 */
export function compareAttributes(inv, prod, { identifier = false, config = matchingConfig() } = {}) {
  const reasons = [];
  const conflicts = [];
  const parts = [];
  const add = (key, s) => parts.push([key, s]);
  const conflict = (level, code, message) => conflicts.push({ level, code, message });

  // name
  const nameSim = nameSimilarity(inv, prod);
  add('name', nameSim);
  if (nameSim === 1) reasons.push('Exact name match');
  else if (nameSim >= 0.8) reasons.push(`Similar name (${pct(nameSim)})`);
  else if (nameSim >= 0.6) reasons.push(`Partly similar name (${pct(nameSim)})`);
  else conflict('warning', 'NAME_DIFFERS', `The names are quite different (${pct(nameSim)} alike).`);

  // strength: a different strength is a different medicine
  const pn = numbersOf(prod.strengths);
  if (inv.strengths.length && prod.strengths.length) {
    if (label(inv.strengths) === label(prod.strengths)) {
      add('strength', 1);
      reasons.push(`Strength ${label(inv.strengths)} matches`);
    } else {
      add('strength', 0);
      conflict('critical', 'STRENGTH_DIFFERS', `Strength differs: invoice ${label(inv.strengths)}, product ${label(prod.strengths)}.`);
    }
  } else if (inv.implied.length && prod.strengths.length) {
    if (inv.implied.every((n) => pn.includes(n) || prod.numbersInName.includes(n))) {
      add('strength', 1);
      reasons.push(`Strength ${inv.implied.join(' + ')} matches (the invoice gives no unit)`);
    } else {
      add('strength', 0);
      conflict('critical', 'STRENGTH_DIFFERS', `Strength differs: invoice ${inv.implied.join(' + ')}, product ${label(prod.strengths)}.`);
    }
  } else if (inv.implied.length || inv.strengths.length) {
    const wanted = inv.strengths.length ? numbersOf(inv.strengths) : inv.implied;
    if (wanted.every((n) => prod.numbersInName.includes(n))) {
      add('strength', 1);
      reasons.push(`Strength ${wanted.join(' + ')} matches the number in the product name`);
    } else {
      conflict('warning', 'STRENGTH_UNVERIFIED', `The product has no strength recorded, so ${label(inv.strengths.length ? inv.strengths : inv.implied)} on the invoice cannot be checked.`);
    }
  } else if (prod.strengths.length) {
    conflict('warning', 'STRENGTH_MISSING', `The invoice does not state a strength; the product is ${label(prod.strengths)}.`);
  }

  // dosage form: tablets, capsules, syrups, injections are never interchangeable
  if (inv.form && prod.form) {
    if (inv.form === prod.form) {
      add('form', 1);
      reasons.push(`Dosage form ${inv.form.replace('_', ' ')} matches`);
    } else {
      add('form', 0);
      conflict('critical', 'FORM_DIFFERS', `Dosage form differs: invoice ${inv.form.replace('_', ' ')}, product ${prod.form.replace('_', ' ')}.`);
    }
  } else if (prod.form) conflict('warning', 'FORM_MISSING', `The invoice does not state a dosage form; the product is a ${prod.form.replace('_', ' ')}.`);
  else if (inv.form) conflict('warning', 'FORM_UNVERIFIED', `The product has no dosage form recorded, so ${inv.form.replace('_', ' ')} on the invoice cannot be checked.`);

  // active ingredient
  if (inv.ingredients.length && prod.ingredientPool?.length) {
    const shared = inv.ingredients.filter((i) => prod.ingredientPool.some((p) => p === i || levenshteinRatio(p, i) >= 0.85));
    if (shared.length) reasons.push(`Active ingredient ${shared.join(', ')} matches`);
    else conflict('critical', 'INGREDIENT_DIFFERS', `Active ingredient differs: the invoice names ${inv.ingredients.join(', ')}, the product is ${prod.ingredientPool.slice(0, 4).join(', ')}.`);
  }

  // manufacturer
  if (inv.manufacturer && prod.manufacturer) {
    const m = Math.max(tokenSimilarity(inv.manufacturer.split(' '), prod.manufacturer.split(' ')), dice(inv.manufacturer, prod.manufacturer));
    if (m >= 0.8) {
      add('manufacturer', 1);
      reasons.push('Manufacturer matches');
    } else if (m >= 0.5) {
      add('manufacturer', m);
      conflict('warning', 'MANUFACTURER_SIMILAR', `Manufacturer is similar but not identical: invoice “${inv.manufacturerRaw}”, product “${prod.manufacturerRaw}”.`);
    } else {
      add('manufacturer', 0);
      conflict('warning', 'MANUFACTURER_DIFFERS', `Manufacturer differs: invoice “${inv.manufacturerRaw}”, product “${prod.manufacturerRaw}”.`);
    }
  }

  // pack size: visible, never decisive on its own
  if (inv.pack && prod.pack) {
    if (sameBase(inv.pack, prod.pack)) {
      add('pack', 1);
      reasons.push(`Pack size ${prod.pack.raw} matches`);
    } else {
      add('pack', 0);
      conflict('warning', 'PACK_DIFFERS', `Pack size differs: invoice ${inv.pack.raw}, product ${prod.pack.raw}.`);
    }
  }

  // HSN
  if (inv.hsn.length >= 4 && prod.hsn.length >= 4) {
    if (inv.hsn.slice(0, 4) === prod.hsn.slice(0, 4)) {
      add('hsn', 1);
      reasons.push('HSN code matches');
    } else {
      add('hsn', 0);
      conflict('warning', 'HSN_DIFFERS', `HSN differs: invoice ${inv.hsn}, product ${prod.hsn}.`);
    }
  }

  // brand
  if (inv.brand) {
    const b = Math.max(tokenSimilarity(inv.brand.toLowerCase().split(/\s+/), prod.tokens), prod.brand ? dice(inv.brand.toLowerCase(), prod.brand.toLowerCase()) : 0);
    if (b >= 0.8) reasons.push('Brand matches');
    else if (prod.tokens.length && b < 0.5) conflict('warning', 'BRAND_DIFFERS', `Brand differs: invoice “${inv.brand}”.`);
  }

  // A SKU or barcode on the line identifies the product itself, so details the invoice leaves out are no longer worth a warning (real conflicts stay).
  if (identifier) for (let i = conflicts.length - 1; i >= 0; i -= 1) if (/_MISSING$/.test(conflicts[i].code)) conflicts.splice(i, 1);
  const w = config.weights;
  const weight = parts.reduce((a, [k]) => a + w[k], 0);
  let score = weight ? parts.reduce((a, [k, s]) => a + w[k] * s, 0) / weight : 0;
  if (identifier) {
    reasons.unshift('SKU or barcode appears on the invoice line');
    score = Math.max(score, 0.98);
  }
  return { score: Math.round(score * 1000) / 1000, reasons, conflicts, compared: parts.map(([k]) => k) };
}
