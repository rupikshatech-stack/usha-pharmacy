/**
 * What a compounding formula actually weighs out. Pharmacists write a formula in a mixture of units — a percentage of
 * the finished preparation, an absolute weight, or `qs` ("enough to make the total up") — and the person at the bench
 * needs the real amount of each one for the batch size being made.
 *
 *   10 % of 100 g  -> 10 g        a percentage is per cent weight-in-weight of the FINISHED preparation
 *   250 mg         -> 0.25 g      milligrams are converted to the formula's own unit where they are compatible
 *   qs             -> the rest    what is left once everything measured has been taken off the total
 *
 * This is the browser's copy of server/utils/compoundMath.js — the same function and the same test vectors — so the
 * form can show the batch as it is typed. The SERVER works it out again before anything is saved, and refuses a
 * formula that cannot be made; nothing here decides what reaches the bench.
 *
 * Everything is worked out in the formula's total unit, in thousandths, so a batch of 100 g never ends up as 99.999 g.
 * Volumes (mL) and weights (g) are deliberately NOT converted into one another: that depends on density, which a
 * formula does not state, so a mixture of the two is reported as something the pharmacist must reconcile.
 */
const MASS = { g: 1, mg: 0.001 };
const VOLUME = { ml: 1 };
const round3 = (n) => Math.round(n * 1000) / 1000;
const familyOf = (unit) => {
  const u = String(unit || '').toLowerCase();
  if (u in MASS) return 'mass';
  if (u in VOLUME) return 'volume';
  return null;
};

/** An ingredient's amount in the formula's own unit, or null when it cannot be stated as a number. */
export function amountIn(ingredient, totalQuantity, totalUnit) {
  const unit = String(ingredient.unit || '').toLowerCase();
  const qty = Number(ingredient.quantity);
  if (unit === 'qs') return null; // decided by what is left
  if (!Number.isFinite(qty) || qty < 0) return null;
  if (unit === '%') return round3((Number(totalQuantity) * qty) / 100);
  const from = familyOf(unit);
  const to = familyOf(totalUnit);
  if (!from || !to || from !== to) return null; // drops, or a weight in a volume formula: not ours to guess
  const factor = from === 'mass' ? MASS[unit] / MASS[String(totalUnit).toLowerCase()] : VOLUME[unit] / VOLUME[String(totalUnit).toLowerCase()];
  return round3(qty * factor);
}

/**
 * The whole formula worked out for one batch:
 *   lines     — each ingredient with the amount to weigh out (null when it cannot be stated)
 *   measured  — everything that could be stated, added up
 *   qsAmount  — what the `qs` ingredient makes up (null when there isn't one)
 *   problems  — what a person must look at: more measured than the batch holds, two `qs` lines, an unusable unit
 */
export function computeFormula({ totalQuantity, totalUnit, ingredients = [] } = {}) {
  const total = Number(totalQuantity) || 0;
  const lines = ingredients.map((i) => {
    const amount = amountIn(i, total, totalUnit);
    return { ...i, amount, unstated: amount === null && String(i.unit).toLowerCase() !== 'qs' };
  });
  const measured = round3(lines.reduce((n, l) => n + (l.amount || 0), 0));
  const qsLines = lines.filter((l) => String(l.unit).toLowerCase() === 'qs');
  const qsAmount = qsLines.length === 1 ? round3(total - measured) : null;

  const problems = [];
  if (qsLines.length > 1) problems.push('Only one ingredient can be "qs" — the rest need a quantity.');
  if (total > 0 && measured > total + 0.0005) problems.push(`The ingredients come to ${round3(measured)} ${totalUnit}, which is more than the ${round3(total)} ${totalUnit} this formula makes.`);
  if (qsLines.length === 1 && qsAmount !== null && qsAmount < 0) problems.push('There is nothing left for the "qs" ingredient to make up.');
  for (const l of lines.filter((x) => x.unstated)) problems.push(`${l.name || 'An ingredient'} is in ${l.unit}, which cannot be worked out against a formula made in ${totalUnit}. Weigh it by hand.`);

  return {
    lines,
    measured,
    qsAmount,
    // what the batch adds up to once the qs ingredient fills it: the declared total, unless nothing fills it
    accountedFor: qsLines.length === 1 && qsAmount !== null && qsAmount >= 0 ? round3(total) : measured,
    shortfall: qsLines.length === 0 ? round3(total - measured) : 0, // what is unaccounted for when nothing is "qs"
    problems,
  };
}

/** The same formula for a different batch size: percentages follow, absolute amounts are scaled by the same factor. */
export function scaleFormula(formula, batchQuantity) {
  const factor = Number(batchQuantity) / Number(formula.totalQuantity);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return computeFormula({
    totalQuantity: Number(batchQuantity),
    totalUnit: formula.totalUnit,
    ingredients: formula.ingredients.map((i) => (String(i.unit).toLowerCase() === '%' || String(i.unit).toLowerCase() === 'qs' ? i : { ...i, quantity: round3(Number(i.quantity) * factor) })),
  });
}
