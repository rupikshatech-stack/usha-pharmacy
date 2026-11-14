import { randomBytes } from 'node:crypto';

/**
 * The shape of an AI-extracted supplier invoice, in ONE place. It is used three ways:
 *   1. to describe the answer we ask the model for (a JSON schema for Gemini and another dialect for OpenAI),
 *   2. to check what came back, strictly (`normalizeExtraction`): unknown keys are dropped, every value is coerced to its type or becomes null, and
 *      anything that had to be dropped is reported in `problems` — it is never silently "fixed" into something the invoice did not say,
 *   3. to check what a person typed when correcting it (same function).
 * Money is a number in rupees; quantities are numbers; dates are real calendar dates as YYYY-MM-DD; anything unavailable is null.
 */

const S = 'string';
const N = 'number';

export const SUPPLIER_FIELDS = { name: S, gstin: S, address: S, phone: S, email: S, state: S, stateCode: S };
export const INVOICE_FIELDS = { invoiceNumber: S, invoiceDate: 'date', dueDate: 'date', purchaseOrderNumber: S, deliveryChallanNumber: S, placeOfSupply: S, paymentTerms: S, currency: S, invoiceType: S };
export const ITEM_FIELDS = {
  medicineName: S, description: S, manufacturer: S, brand: S, strength: S, dosageForm: S, hsnCode: S, batchNumber: S, manufacturingDate: 'expiry', expiryDate: 'expiry', packSize: S, unit: S,
  quantity: N, freeQuantity: N, receivedQuantity: N, mrp: N, purchaseRate: N, discountPercentage: 'percent', discountAmount: N, taxableAmount: N, gstPercentage: 'percent', cgst: N, sgst: N, igst: N, lineTotal: N,
  page: 'page', sourceText: S,
};
export const TOTAL_FIELDS = { subtotal: N, discount: N, taxableAmount: N, cgst: N, sgst: N, igst: N, otherCharges: N, shippingCharges: N, packagingCharges: N, roundOff: 'signed', grandTotal: N, amountInWords: S, amountPaid: N, balanceDue: N };

export const MAX_ITEMS = 500;
const MAX_TEXT = { default: 300, address: 600, description: 600, sourceText: 800, amountInWords: 300, paymentTerms: 300 };

/* ------------------------------------------------------------------------------------------------ what the model is asked for */

const DOC = {
  supplierName: 'Supplier name exactly as printed', gstin: '15-character GSTIN of the SUPPLIER (not the buyer)', stateCode: 'Two-digit GST state code',
  batchNumber: 'Batch number exactly as printed; null if the invoice does not show one', expiryDate: 'Expiry as YYYY-MM-DD, or YYYY-MM when only month and year are printed; null if not printed',
  manufacturingDate: 'Manufacturing date as YYYY-MM-DD, or YYYY-MM when only month and year are printed; null if not printed',
  quantity: 'Billed (paid) quantity in the invoice unit; NOT the free quantity', freeQuantity: 'Free / bonus quantity shown separately; null if none is shown', receivedQuantity: 'Only if the invoice explicitly shows a received quantity; otherwise null',
  mrp: 'Maximum retail price per unit (MRP) — never the purchase rate', purchaseRate: 'Rate the buyer pays per unit before tax (PTR / PTS / rate) — never the MRP',
  sourceText: 'The verbatim OCR text of this row (copy it exactly as it appears in the input)', page: 'Page number (1-based) the row appears on',
};

function typeOf(kind, key) {
  const description = DOC[key];
  if (kind === S) return { type: 'string', ...(description && { description }) };
  if (kind === 'date' || kind === 'expiry') return { type: 'string', description: description || 'A date as YYYY-MM-DD (null if not printed)' };
  if (kind === 'page') return { type: 'integer', description };
  return { type: 'number', ...(description && { description }) };
}
const objectOf = (fields) => ({ type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([k, kind]) => [k, typeOf(kind, k)])), required: Object.keys(fields) });

/** The canonical schema: every property is present in the answer, and null when unavailable. */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    supplier: objectOf(SUPPLIER_FIELDS),
    invoice: objectOf(INVOICE_FIELDS),
    items: { type: 'array', description: 'One entry per product row of the invoice, in order. Never merge rows.', items: objectOf(ITEM_FIELDS) },
    totals: objectOf(TOTAL_FIELDS),
    warnings: { type: 'array', items: { type: 'string' }, description: 'Anything ambiguous, unclear or inconsistent that a person should look at' },
  },
  required: ['supplier', 'invoice', 'items', 'totals', 'warnings'],
};

const walk = (node, fn) => {
  const out = fn({ ...node });
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, walk(v, fn)]));
  if (out.items) out.items = walk(out.items, fn);
  return out;
};

/** Gemini's responseSchema dialect: nullable fields, no "required" on nullable values. */
export const geminiSchema = () =>
  walk(EXTRACTION_SCHEMA, (n) => {
    if (n.type === 'object') return { type: 'object', properties: n.properties, required: n.required };
    if (n.type === 'array') return { type: 'array', items: n.items, ...(n.description && { description: n.description }) };
    return { type: n.type, nullable: true, ...(n.description && { description: n.description }) };
  });

/** OpenAI structured outputs (strict): every key required, nullable values as a type union, no extra keys. */
export const openAiSchema = () =>
  walk(EXTRACTION_SCHEMA, (n) => {
    if (n.type === 'object') return { type: 'object', properties: n.properties, required: n.required, additionalProperties: false };
    if (n.type === 'array') return { type: 'array', items: n.items, ...(n.description && { description: n.description }) };
    return { type: [n.type, 'null'], ...(n.description && { description: n.description }) };
  });

/* ------------------------------------------------------------------------------------------------ checking what came back */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Every medicine row carries a stable id (not asked of the model) so later steps — product matching — stay attached to the row when others are added or removed. */
const ITEM_ID = /^itm_[a-f0-9]{12}$/;
const validItemId = (v) => (typeof v === 'string' && ITEM_ID.test(v) ? v : null);
export const newItemId = () => `itm_${randomBytes(6).toString('hex')}`;
/** Gives every row without an id one (in place) and returns the rows. */
export function assignItemIds(items) {
  const seen = new Set();
  for (const it of items) {
    if (!it.itemId || seen.has(it.itemId)) it.itemId = newItemId();
    seen.add(it.itemId);
  }
  return items;
}

/** Real calendar day? (new Date accepts 30 February; this does not.) */
export function isRealDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A number from a number or a plain numeric string ("1,250.50", "₹ 99"); anything else is not a number. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/**
 * One value, checked against its kind. Returns { value, note } where `note` explains a value that had to be dropped or interpreted.
 * `expiry` kinds accept YYYY-MM-DD, or YYYY-MM which means "valid through the end of that month" (the printed convention for medicines).
 */
export function coerce(kind, raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (kind === S) {
    if (typeof raw === 'number') return { value: String(raw) };
    if (typeof raw !== 'string') return { value: null, note: 'was not text' };
    const v = raw.replace(/\s+/g, ' ').trim();
    return { value: v === '' ? null : v };
  }
  if (kind === 'date' || kind === 'expiry') {
    if (typeof raw !== 'string' || !raw.trim()) return { value: null };
    const s = raw.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return isRealDay(+m[1], +m[2], +m[3]) ? { value: s } : { value: null, note: `"${s}" is not a real calendar date` };
    m = kind === 'expiry' ? /^(\d{4})-(\d{2})$/.exec(s) : null;
    if (m && +m[2] >= 1 && +m[2] <= 12) {
      const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
      return { value: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`, note: `only month and year were given ("${s}"); treated as the last day of the month` };
    }
    return { value: null, note: `"${s}" is not a date in YYYY-MM-DD form` };
  }
  if (kind === 'page') {
    const n = toNumber(raw);
    return Number.isInteger(n) && n >= 1 && n <= 10000 ? { value: n } : { value: null };
  }
  const n = toNumber(raw);
  if (n === null) return typeof raw === 'string' && !raw.trim() ? { value: null } : { value: null, note: `"${String(raw).slice(0, 40)}" is not a number` };
  if (kind === 'signed') return { value: Math.round(n * 100) / 100 };
  if (n < 0) return { value: null, note: `${n} is negative` };
  if (kind === 'percent' && n > 100) return { value: null, note: `${n} is above 100%` };
  return { value: Math.round(n * 10000) / 10000 };
}

function section(raw, fields, path, problems) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const [key, kind] of Object.entries(fields)) {
    const { value, note } = coerce(kind, src[key]);
    out[key] = kind === S && typeof value === 'string' ? value.slice(0, MAX_TEXT[key] || MAX_TEXT.default) : value;
    if (note) problems.push({ path: `${path}.${key}`, message: `${key} ${note}`, original: src[key] ?? null, interpreted: value !== null });
  }
  return out;
}

/**
 * Strictly checks an extraction. Returns { data, problems }, or throws { code: 'shape' } when the answer is not an invoice at all (not an object, or `items`
 * is not a list). Never invents anything: a value that cannot be read as its type becomes null and is listed in `problems` with what it originally was.
 */
export function normalizeExtraction(raw) {
  if (!isObj(raw)) throw Object.assign(new Error('The answer is not a JSON object.'), { code: 'shape' });
  if (!Array.isArray(raw.items)) throw Object.assign(new Error('The answer has no list of items.'), { code: 'shape' });
  const problems = [];
  const items = raw.items.slice(0, MAX_ITEMS).map((it, i) => ({ ...section(it, ITEM_FIELDS, `items.${i}`, problems), itemId: validItemId(isObj(it) ? it.itemId : null) }));
  if (raw.items.length > MAX_ITEMS) problems.push({ path: 'items', message: `Only the first ${MAX_ITEMS} rows were kept (the answer had ${raw.items.length}).`, original: null });
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).filter((w) => typeof w === 'string' && w.trim()).map((w) => w.replace(/\s+/g, ' ').trim().slice(0, 300)).slice(0, 50);
  return {
    data: { supplier: section(raw.supplier, SUPPLIER_FIELDS, 'supplier', problems), invoice: section(raw.invoice, INVOICE_FIELDS, 'invoice', problems), items, totals: section(raw.totals, TOTAL_FIELDS, 'totals', problems) },
    problems,
    warnings,
  };
}
