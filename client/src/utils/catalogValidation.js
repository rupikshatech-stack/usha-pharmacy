// Pure helpers for the Compounds and Attributes pages. They mirror the server's rules (validators/catalog.validator.js).

export const ATTRIBUTE_TYPES = [
  { value: 'category', label: 'Category', plural: 'Categories', help: 'A product category. Each category is its own record that medicines are filed under.', examples: [] },
  { value: 'dosage_form', label: 'Dosage form', plural: 'Dosage forms', help: 'The allowed dosage forms, offered in the medicine form.', examples: ['Tablet', 'Capsule', 'Syrup', 'Injection'] },
  { value: 'strength', label: 'Strength', plural: 'Strengths', help: 'Common strengths, offered in the medicine form.', examples: ['250mg', '500mg', '650mg'] },
  { value: 'unit', label: 'Unit', plural: 'Units', help: 'How a medicine is counted or packed.', examples: ['Strip', 'Bottle', 'Box'] },
  { value: 'custom', label: 'Custom attribute', plural: 'Custom attributes', help: 'An extra field you add to medicine records (for example Storage condition). With allowed values, only those can be chosen; without, any text is accepted.', examples: [] },
];
export const typeLabel = (t) => ATTRIBUTE_TYPES.find((x) => x.value === t)?.label || t;
/** Types that carry a list of values (a category is one record, with no list). */
export const hasValues = (type) => type !== 'category';

export const LIMITS = { compoundName: 150, composition: 500, description: 2000, attributeName: 100, value: 100, values: 200 };

/** "a, b\nc" -> ['a','b','c']: split on commas, semicolons and new lines, trim, drop blanks and case-insensitive duplicates. */
export function parseValues(text, existing = []) {
  const seen = new Set(existing.map((v) => v.toLowerCase()));
  const out = [];
  for (const raw of String(text ?? '').split(/[,;\n]/)) {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

export function validateCompound(c) {
  const e = {};
  const name = c.compoundName.trim();
  if (!name) e.compoundName = 'Compound name is required';
  else if (name.length > LIMITS.compoundName) e.compoundName = `Compound name must be ${LIMITS.compoundName} characters or fewer`;
  if (c.composition.length > LIMITS.composition) e.composition = `Composition must be ${LIMITS.composition} characters or fewer`;
  if (c.description.length > LIMITS.description) e.description = `Description must be ${LIMITS.description} characters or fewer`;
  if (!c.isPreparation) return e;

  // the preparation half: only checked once someone says the pharmacy makes this itself
  const total = Number(c.totalQuantity);
  if (!String(c.totalQuantity ?? '').trim()) e.totalQuantity = 'Enter how much this makes';
  else if (!Number.isFinite(total) || total <= 0) e.totalQuantity = 'Enter a quantity greater than zero';
  (c.ingredients || []).forEach((i, n) => {
    const qty = String(i.quantity ?? '').trim();
    if (!String(i.name || '').trim()) e[`ingredients.${n}.name`] = 'Name the ingredient';
    if (i.unit === 'qs') {
      if (qty) e[`ingredients.${n}.quantity`] = 'A "qs" ingredient makes the total up, so it takes no quantity';
    } else if (!qty) e[`ingredients.${n}.quantity`] = 'How much?';
    else if (!(Number(qty) > 0)) e[`ingredients.${n}.quantity`] = 'More than zero';
    else if (i.unit === '%' && Number(qty) > 100) e[`ingredients.${n}.quantity`] = 'At most 100%';
  });
  if (String(c.budValue ?? '').trim() && !(Number(c.budValue) > 0 && Number.isInteger(Number(c.budValue)))) e.budValue = 'Whole days or months';
  return e;
}

export function validateAttribute(a) {
  const e = {};
  const name = a.attributeName.trim();
  if (!name) e.attributeName = 'Attribute name is required';
  else if (name.length > LIMITS.attributeName) e.attributeName = `Attribute name must be ${LIMITS.attributeName} characters or fewer`;
  if (!a.attributeType) e.attributeType = 'Choose a type';
  if (hasValues(a.attributeType)) {
    if (a.values.length > LIMITS.values) e.values = `At most ${LIMITS.values} values`;
    else if (a.values.some((v) => v.length > LIMITS.value)) e.values = `A value is longer than ${LIMITS.value} characters`;
    else if (a.attributeType !== 'custom' && a.values.length === 0) e.values = 'Add at least one value, for example ' + (ATTRIBUTE_TYPES.find((t) => t.value === a.attributeType)?.examples.slice(0, 3).join(', ') || 'one value');
  }
  return e;
}

/** Only what changed, ready for PUT. The type is never sent (it can't change). */
export function attributePayload(a, original) {
  const next = { attributeName: a.attributeName.trim(), values: hasValues(a.attributeType) ? a.values : [], status: a.status };
  if (!original) return { ...next, attributeType: a.attributeType };
  const changed = {};
  if (next.attributeName !== original.attributeName) changed.attributeName = next.attributeName;
  if (JSON.stringify(next.values) !== JSON.stringify(original.values || [])) changed.values = next.values;
  if (next.status !== original.status) changed.status = next.status;
  return changed;
}

/**
 * What the API is sent. A compound that is not prepared in-house sends an empty ingredient list, which is how the
 * server knows it is a plain formulation label — so unticking the box really does turn a preparation back into one.
 */
export const compoundPayload = (c) => {
  const t = (v) => String(v ?? '').trim();
  const base = { compoundName: t(c.compoundName), composition: t(c.composition), description: t(c.description), status: c.status };
  if (!c.isPreparation) return { ...base, ingredients: [] };
  return {
    ...base,
    dosageForm: t(c.dosageForm),
    totalQuantity: Number(c.totalQuantity),
    totalUnit: t(c.totalUnit),
    ingredients: (c.ingredients || []).map((i) => ({
      name: t(i.name),
      role: i.role || 'active',
      unit: i.unit,
      ...(i.unit === 'qs' || t(i.quantity) === '' ? {} : { quantity: Number(i.quantity) }),
      ...(t(i.medicineId) ? { medicineId: t(i.medicineId) } : {}),
      notes: t(i.notes),
    })),
    instructions: t(c.instructions),
    requiresHomogenizer: Boolean(c.requiresHomogenizer),
    requiresUnguator: Boolean(c.requiresUnguator),
    lightSensitive: Boolean(c.lightSensitive),
    sig: t(c.sig),
    ...(t(c.budValue) === '' ? {} : { budValue: Number(c.budValue) }),
    budUnit: c.budUnit || 'days',
  };
};

/** Field errors from a failed API call: { fields, general } (paths like "values.0" land on "values"). */
export function apiFieldErrors(err) {
  const fields = {};
  for (const d of err?.details || []) {
    const path = String(d.path || '').replace(/\[(\d+)\]/g, '.$1');
    // a row's own error keeps its row ("ingredients.1.quantity"); anything else lands on its field
    const f = /^ingredients\.\d+\./.test(path) ? path : path.split('.')[0];
    if (f && !fields[f]) fields[f] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}
