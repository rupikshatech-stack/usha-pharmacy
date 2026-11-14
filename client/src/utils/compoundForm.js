import { computeFormula } from './compoundMath';

/**
 * The Add / Edit formula dialog: what an empty one looks like, what counts as valid, and how it becomes the request.
 * The server checks all of it again and refuses a formula that cannot be made — these rules only let someone fix a
 * mistake while they are still typing.
 */
export const ROLES = [
  { value: 'active', label: 'Active' },
  { value: 'base', label: 'Base' },
  { value: 'excipient', label: 'Excipient' },
];
export const UNITS = ['%', 'g', 'mg', 'mL', 'drops', 'qs'];
export const TOTAL_UNITS = ['g', 'mg', 'mL', 'capsules', 'sachets'];
export const DOSAGE_FORMS = ['Cream', 'Ointment', 'Gel', 'Lotion', 'Suspension', 'Solution', 'Capsule', 'Suppository', 'Powder', 'Paste'];
export const BUD_UNITS = ['days', 'months'];

export const blankIngredient = () => ({ name: '', role: 'active', quantity: '', unit: '%', medicineId: '', notes: '' });

/** The batch as it stands while being typed: what to weigh, what the base makes up, and anything that does not add up. */
export const previewBatch = (f) =>
  computeFormula({
    totalQuantity: Number(f.totalQuantity) || 0,
    totalUnit: f.totalUnit,
    ingredients: (f.ingredients || []).map((i) => ({ ...i, quantity: i.quantity === '' ? undefined : Number(i.quantity) })),
  });
