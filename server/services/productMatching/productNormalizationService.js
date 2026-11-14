/**
 * Turning a medicine description into comparable parts: a plain name, its strengths, its dosage form, its pack size and the active ingredients it names.
 * Pure functions, no database. The same code describes an invoice line ("PCM 500 TAB") and a product ("Paracetamol 500mg Tablet"), so the two can be compared
 * part by part. Anything a description does not say stays null — it is never guessed.
 *
 * Abbreviations are a small, explicit dictionary (ABBREVIATIONS): an unknown short form simply stays as it is and is matched by similarity, never expanded
 * by guesswork. Strength, dosage form and active ingredient are the attributes that make two products different medicines, so they are parsed here with care.
 */

/** Short forms that are unambiguous in pharmacy practice. Extend as needed. */
export const ABBREVIATIONS = {
  pcm: 'paracetamol', para: 'paracetamol', amox: 'amoxicillin', amoxy: 'amoxicillin', azithro: 'azithromycin', cipro: 'ciprofloxacin', metro: 'metronidazole',
  diclo: 'diclofenac', ibu: 'ibuprofen', omep: 'omeprazole', panto: 'pantoprazole', cetz: 'cetirizine', ranit: 'ranitidine', dexa: 'dexamethasone', pred: 'prednisolone',
  vit: 'vitamin', multivit: 'multivitamin', ors: 'oral rehydration salts',
};
/** Molecules the matcher recognises by name, so "different active ingredient" can be told from "different brand name". */
export const INGREDIENTS = new Set([
  'paracetamol', 'ibuprofen', 'diclofenac', 'aspirin', 'amoxicillin', 'azithromycin', 'ciprofloxacin', 'metronidazole', 'cetirizine', 'levocetirizine', 'omeprazole', 'pantoprazole',
  'ranitidine', 'dexamethasone', 'prednisolone', 'metformin', 'atorvastatin', 'amlodipine', 'telmisartan', 'losartan', 'ondansetron', 'domperidone', 'ambroxol', 'montelukast',
  'cefixime', 'cefpodoxime', 'doxycycline', 'levofloxacin', 'ofloxacin', 'clavulanic', 'nimesulide', 'aceclofenac', 'rabeprazole', 'esomeprazole', 'loperamide', 'salbutamol',
]);

const FORMS = {
  tablet: ['tab', 'tabs', 'tablet', 'tablets', 'tb'],
  capsule: ['cap', 'caps', 'capsule', 'capsules', 'softgel', 'softgels'],
  syrup: ['syr', 'syrup', 'syp', 'elixir'],
  suspension: ['susp', 'suspension'],
  dry_syrup: ['drysyrup', 'dry syrup', 'ds'],
  injection: ['inj', 'injection', 'vial', 'amp', 'ampoule', 'ampule'],
  drops: ['drop', 'drops', 'gtt'],
  ointment: ['oint', 'ointment'],
  cream: ['cream', 'crm'],
  gel: ['gel'],
  lotion: ['lotion', 'lot'],
  solution: ['soln', 'solution'],
  powder: ['powder', 'pwd'],
  sachet: ['sachet', 'sachets'],
  inhaler: ['inhaler', 'rotacap', 'rotacaps', 'respule', 'respules'],
  spray: ['spray'],
  suppository: ['suppository', 'supp'],
  infusion: ['infusion', 'iv'],
  lozenge: ['lozenge', 'lozenges'],
};
const FORM_OF = new Map();
for (const [form, words] of Object.entries(FORMS)) for (const w of words) FORM_OF.set(w, form);
export const FORM_LABEL = (f) => (f ? f.replace('_', ' ') : null);

const MASS = { mg: 1, milligram: 1, milligrams: 1, g: 1000, gm: 1000, gms: 1000, gram: 1000, grams: 1000, mcg: 0.001, µg: 0.001, ug: 0.001, microgram: 0.001, micrograms: 0.001 };
const trimNum = (n) => String(Math.round(n * 10000) / 10000);

const clean = (s) => String(s ?? '').toLowerCase().replace(/[‐–—_]/g, '-').replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();

/** Strength components in a canonical form: "500mg", "0.5mg" (from 500 mcg), "250mg/5ml", "5%", "40000iu". Sorted, so "500+125" equals "125+500". */
export function parseStrengths(text) {
  const t = clean(text).replace(/,(?=\d{3}\b)/g, '');
  const found = [];
  const taken = [];
  const take = (m, canon) => {
    found.push(canon);
    taken.push([m.index, m.index + m[0].length]);
  };
  // ratios first: 125mg/5ml, 250 mg per 5 ml
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|gm|iu)\s*(?:\/|per)\s*(\d+(?:\.\d+)?)?\s*(ml|l)\b/g)) {
    const mass = MASS[m[2]];
    take(m, `${trimNum(Number(m[1]) * (mass ?? 1))}${mass ? 'mg' : m[2]}/${trimNum(Number(m[3] || 1))}${m[4]}`);
  }
  const inside = (i) => taken.some(([a, b]) => i >= a && i < b);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(mg|milligrams?|mcg|µg|ug|micrograms?|gms?|grams?|g|iu|%)(?![a-z])/g)) {
    if (inside(m.index)) continue;
    const mass = MASS[m[2]];
    take(m, mass ? `${trimNum(Number(m[1]) * mass)}mg` : `${trimNum(Number(m[1]))}${m[2]}`);
  }
  return [...new Set(found)].sort();
}

/** Bare numbers that look like a strength written without a unit ("PCM 500", "Dolo 650"): not part of a unit, a pack size or a letter-number code. */
export function impliedNumbers(text) {
  let t = clean(text);
  t = t.replace(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|gm|gms|ml|l|iu|%)(?![a-z])/g, ' ').replace(/\b\d+\s*(?:x|×)\s*\d+\b/g, ' ').replace(/\b\d+\s*'?s\b/g, ' ').replace(/\b\d+\s*(?:tabs|tablets|caps|capsules|strips|vials|ampoules|nos|pcs|pieces)\b/g, ' ');
  return [...new Set([...t.matchAll(/(?<![a-z0-9.])(\d+(?:\.\d+)?)(?![a-z0-9]|\.\d)/g)].map((m) => trimNum(Number(m[1]))))];
}

export function parseForm(text) {
  const words = clean(text).replace(/\./g, ' ').split(/[^a-z]+/).filter(Boolean);
  if (/dry\s*syrup/.test(clean(text))) return 'dry_syrup';
  for (const w of words) {
    const f = FORM_OF.get(w);
    if (f && f !== 'dry_syrup') return f; // the first dosage form the description names
  }
  return null;
}

/** A pack size as { count, unit, raw }: "10s", "strip of 10", "10 tablets", "1x10", "100ml", "15 g". Null when nothing is stated. */
export function parsePack(text) {
  const t = clean(text);
  if (!t) return null;
  let m = /(\d+)\s*(?:x|×)\s*(\d+)\b/.exec(t);
  if (m) return { count: Number(m[1]) * Number(m[2]), unit: 'unit', raw: m[0] };
  m = /\b(\d+)\s*'?s\b/.exec(t) || /\b(?:strip|pack|box|bottle|vial|tube)s?\s*of\s*(\d+)\b/.exec(t) || /\b(\d+)\s*(?:tabs|tablets|caps|capsules|strips|vials|ampoules|sachets|nos|pcs|pieces|units)\b/.exec(t);
  if (m) return { count: Number(m[1]), unit: 'unit', raw: m[0] };
  m = /\b(\d+(?:\.\d+)?)\s*(ml|l|g|gm|gms|kg)\b/.exec(t);
  if (m) return { count: Number(m[1]) * ({ l: 1000, kg: 1000 }[m[2]] || 1), unit: m[2] === 'l' || m[2] === 'ml' ? 'ml' : 'g', raw: m[0] };
  return null;
}
export const sameBase = (a, b) => a && b && a.unit === b.unit && a.count === b.count;

/** Words of a name, abbreviations expanded, punctuation removed. */
export function words(text) {
  return clean(text)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9µ%+/.\- ]/g, ' ')
    .split(/[\s+/\-.]+/)
    .filter(Boolean)
    .flatMap((w) => (ABBREVIATIONS[w] ? ABBREVIATIONS[w].split(' ') : [w]));
}

const STOP = new Set(['and', 'with', 'of', 'the', 'for', 'plus', 'pack', 'strip', 'strips', 'box', 'bottle', 'pcs', 'nos', 'no', 'qty', 'new', 'x', 's']);
const UNIT_WORDS = new Set(['mg', 'mcg', 'ug', 'g', 'gm', 'gms', 'ml', 'l', 'iu', 'kg', 'milligram', 'milligrams', 'gram', 'grams']);

/**
 * The comparable description of a medicine. `core` is the name with strengths, dosage form, pack size and filler removed, e.g.
 * "PCM 500 TAB" -> core "paracetamol". `key` identifies the description for remembered mappings (core + strengths + form + pack count).
 */
export function describe({ name = '', description = '', strength = '', dosageForm = '', packSize = '', manufacturer = '', brand = '', hsnCode = '' } = {}) {
  const all = [name, description].filter(Boolean).join(' ');
  const strengths = parseStrengths(strength || '').length ? parseStrengths(strength) : parseStrengths(all);
  const form = parseForm(dosageForm || '') || parseForm(all);
  const noRatio = clean(all).replace(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|gm|iu)\s*(?:\/|per)\s*(\d+(?:\.\d+)?)?\s*(ml|l)\b/g, ' '); // the volume in 250mg/5ml is part of the strength, not a pack
  const pack = parsePack(packSize || '') || parsePack(noRatio);
  const implied = strengths.length ? [] : impliedNumbers(name);
  const stripped = clean(all)
    .replace(/(\d+(?:\.\d+)?)\s*(mg|milligrams?|mcg|µg|ug|micrograms?|gms?|grams?|g|iu|%|ml|l|kg)(?![a-z])/g, ' ')
    .replace(/\b\d+\s*(?:x|×)\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*'?s\b/g, ' ');
  const coreWords = words(stripped).filter((w) => !STOP.has(w) && !UNIT_WORDS.has(w) && !FORM_OF.has(w) && !/^\d+(\.\d+)?$/.test(w));
  const core = coreWords.join(' ');
  const ingredients = [...new Set(coreWords.filter((w) => INGREDIENTS.has(w)))].sort();
  return {
    core, tokens: coreWords, strengths, implied, form, pack, ingredients,
    manufacturer: normalizeManufacturer(manufacturer), manufacturerRaw: String(manufacturer || '').trim(),
    brand: String(brand || '').trim(), hsn: String(hsnCode || '').replace(/\D/g, ''),
    numbersInName: impliedNumbers(name),
    key: [coreWords.slice().sort().join(' '), strengths.join('+') || implied.join('+'), form || '', pack ? `${pack.count}${pack.unit}` : ''].join('|'),
  };
}

const MAKER_NOISE = new Set(['pvt', 'ltd', 'limited', 'private', 'laboratories', 'laboratory', 'labs', 'lab', 'pharma', 'pharmaceuticals', 'pharmaceutical', 'healthcare', 'industries', 'india', 'co', 'company', 'and', 'the']);
/** A manufacturer's name without legal suffixes and punctuation, so "Micro Labs Ltd." and "MICRO LABS" agree. */
export function normalizeManufacturer(m) {
  return clean(m).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w && !MAKER_NOISE.has(w)).join(' ');
}

/** The plain, comparable form of a product name (what a typed search is compared with). */
export const normalizeName = (name) => describe({ name }).core;
