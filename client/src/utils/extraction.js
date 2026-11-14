/**
 * Helpers for the AI-extracted invoice screen. Everything here is about showing and correcting what the AI read: nothing fills a gap, guesses a value or
 * matches a product. A value the invoice does not show stays empty (null on the server); the screen edits text and turns it back into numbers only when
 * it really is one.
 */

export const STATE_TONE = {
  ocr_pending: 'neutral',
  ocr_completed: 'info',
  ai_processing: 'info',
  ai_completed: 'info',
  validation_required: 'warning',
  ready_for_review: 'success',
  reviewed: 'sage',
  failed: 'danger',
};

// kind: text | number | percent | signed | date | expiry | page — mirrors the server's schema
export const SECTIONS = [
  {
    key: 'supplier',
    title: 'Supplier',
    fields: [
      ['name', 'Supplier name', 'text'],
      ['gstin', 'GSTIN', 'text'],
      ['address', 'Address', 'text'],
      ['phone', 'Phone', 'text'],
      ['email', 'Email', 'text'],
      ['state', 'State', 'text'],
      ['stateCode', 'State code', 'text'],
    ],
  },
  {
    key: 'invoice',
    title: 'Invoice',
    fields: [
      ['invoiceNumber', 'Invoice number', 'text'],
      ['invoiceDate', 'Invoice date', 'date'],
      ['dueDate', 'Due date', 'date'],
      ['purchaseOrderNumber', 'PO number', 'text'],
      ['deliveryChallanNumber', 'Delivery challan no.', 'text'],
      ['placeOfSupply', 'Place of supply', 'text'],
      ['paymentTerms', 'Payment terms', 'text'],
      ['currency', 'Currency', 'text'],
      ['invoiceType', 'Invoice type', 'text'],
    ],
  },
];
export const TOTAL_FIELDS = [
  ['subtotal', 'Gross subtotal', 'number'],
  ['discount', 'Total discount', 'number'],
  ['taxableAmount', 'Taxable amount', 'number'],
  ['cgst', 'CGST', 'number'],
  ['sgst', 'SGST', 'number'],
  ['igst', 'IGST', 'number'],
  ['otherCharges', 'Other charges', 'number'],
  ['shippingCharges', 'Shipping', 'number'],
  ['packagingCharges', 'Packaging', 'number'],
  ['roundOff', 'Round off', 'signed'],
  ['grandTotal', 'Grand total', 'number'],
  ['amountPaid', 'Amount paid', 'number'],
  ['balanceDue', 'Balance due', 'number'],
  ['amountInWords', 'Amount in words', 'text'],
];
// the main columns of the medicine table; the rest are under "More"
export const ITEM_COLUMNS = [
  ['medicineName', 'Medicine', 'text', 'w-56'],
  ['manufacturer', 'Manufacturer', 'text', 'w-36'],
  ['hsnCode', 'HSN', 'text', 'w-20'],
  ['batchNumber', 'Batch', 'text', 'w-28'],
  ['manufacturingDate', 'Mfg date', 'expiry', 'w-32'],
  ['expiryDate', 'Expiry', 'expiry', 'w-32'],
  ['quantity', 'Qty', 'number', 'w-20'],
  ['freeQuantity', 'Free', 'number', 'w-20'],
  ['mrp', 'MRP', 'number', 'w-24'],
  ['purchaseRate', 'Rate', 'number', 'w-24'],
  ['discountPercentage', 'Disc %', 'percent', 'w-20'],
  ['taxableAmount', 'Taxable', 'number', 'w-28'],
  ['gstPercentage', 'GST %', 'percent', 'w-20'],
  ['cgst', 'CGST', 'number', 'w-24'],
  ['sgst', 'SGST', 'number', 'w-24'],
  ['igst', 'IGST', 'number', 'w-24'],
  ['lineTotal', 'Line total', 'number', 'w-28'],
];
export const ITEM_MORE = [
  ['description', 'Description', 'text'],
  ['brand', 'Brand', 'text'],
  ['strength', 'Strength', 'text'],
  ['dosageForm', 'Dosage form', 'text'],
  ['packSize', 'Pack size', 'text'],
  ['unit', 'Unit', 'text'],
  ['receivedQuantity', 'Received qty (only if shown)', 'number'],
  ['discountAmount', 'Discount amount', 'number'],
  ['page', 'Page', 'page'],
];
const ITEM_KIND = Object.fromEntries([...ITEM_COLUMNS, ...ITEM_MORE].map(([k, , kind]) => [k, kind]));
ITEM_KIND.sourceText = 'text';
ITEM_KIND.itemId = 'text';

const kindOf = (path) => {
  const [a, b, c] = path.split('.');
  if (a === 'items') return ITEM_KIND[c];
  if (a === 'totals') return TOTAL_FIELDS.find(([k]) => k === b)?.[2];
  return [...SECTIONS.find((s) => s.key === a).fields].find(([k]) => k === b)?.[2];
};

const text = (v) => (v === null || v === undefined ? '' : String(v));

/** The server's invoice as form text: nothing becomes "0" or a made-up default; a missing value is an empty box. */
export function toForm(current) {
  const flat = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, text(v)]));
  return { supplier: flat(current.supplier), invoice: flat(current.invoice), totals: flat(current.totals), items: (current.items || []).map(flat) };
}

const REAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s, month) {
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return true;
  const m = REAL_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Why a typed value is not acceptable, or '' when it is (empty is always fine: it means "not on the invoice"). */
export function problemWith(kind, value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (kind === 'text') return '';
  if (kind === 'date') return validDate(s, false) ? '' : 'Use a real date as YYYY-MM-DD.';
  if (kind === 'expiry') return validDate(s, true) ? '' : 'Use YYYY-MM-DD, or YYYY-MM for month and year.';
  const n = Number(s.replace(/,/g, ''));
  if (!/^-?[\d,]*\.?\d+$/.test(s) || Number.isNaN(n)) return 'Enter a number.';
  if (kind === 'signed') return '';
  if (n < 0) return 'Cannot be negative.';
  if (kind === 'percent' && n > 100) return 'Cannot be above 100.';
  if (kind === 'page' && !Number.isInteger(n)) return 'Enter a whole page number.';
  return '';
}

/** Every field of the form that cannot be saved: { 'items.0.quantity': 'Enter a number.' }. */
export function formErrors(form) {
  const out = {};
  const check = (path, value) => {
    const p = problemWith(kindOf(path), value);
    if (p) out[path] = p;
  };
  for (const s of SECTIONS) for (const [k] of s.fields) check(`${s.key}.${k}`, form[s.key][k]);
  for (const [k] of TOTAL_FIELDS) check(`totals.${k}`, form.totals[k]);
  form.items.forEach((it, i) => Object.keys(it).forEach((k) => ITEM_KIND[k] && check(`items.${i}.${k}`, it[k])));
  return out;
}

/** The form back to an invoice: empty -> null, numeric kinds -> numbers, text trimmed. Invalid values are left as typed (the screen blocks saving first). */
export function fromForm(form) {
  const conv = (kind, v) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    return ['number', 'percent', 'signed', 'page'].includes(kind) && !problemWith(kind, s) ? Number(s.replace(/,/g, '')) : s;
  };
  const sect = (name, fields) => Object.fromEntries(fields.map(([k, , kind]) => [k, conv(kind, form[name][k])]));
  return {
    supplier: sect('supplier', SECTIONS[0].fields),
    invoice: sect('invoice', SECTIONS[1].fields),
    totals: sect('totals', TOTAL_FIELDS),
    items: form.items.map((it) =>
      Object.fromEntries([...ITEM_COLUMNS, ...ITEM_MORE, ['sourceText', '', 'text'], ['itemId', '', 'text']].map(([k, , kind]) => [k, conv(kind, it[k])])),
    ),
  };
}

export const isDirty = (form, saved) => JSON.stringify(form) !== JSON.stringify(saved);

/** A blank row the person fills in by hand (every value empty, none invented). */
export const blankItem = () => Object.fromEntries([...ITEM_COLUMNS, ...ITEM_MORE, ['sourceText', '', 'text'], ['itemId', '', 'text']].map(([k]) => [k, '']));

/** How a field should look: the worst issue on it, and where its value came from. */
export function fieldState(meta, issueMap, path) {
  const m = meta?.[path];
  const issue = issueMap?.[path] || null;
  const level = m?.level || null;
  let tip = '';
  if (level === 'edited') tip = 'Entered or changed by a person.';
  else if (level === 'missing') tip = 'Not found on the document. Enter it if it is there.';
  else if (m && m.found === false) tip = 'Not found in the OCR text. Verify it against the document.';
  else if (m)
    tip = `Read from page ${m.page ?? '?'}${m.confidence != null ? ` with ${Math.round(m.confidence * 100)}% OCR confidence` : ' (the OCR gave no confidence)'}${m.snippet ? `: “${m.snippet}”` : ''}.`;
  const tone = issue === 'error' ? 'danger' : issue === 'warning' || level === 'low' ? 'warning' : level === 'missing' ? 'missing' : level === 'edited' ? 'edited' : null;
  return { issue, level, tone, tip };
}
export const TONE_CLASS = { danger: 'border-danger ring-1 ring-danger/30', warning: 'border-warning ring-1 ring-warning/30', missing: 'border-dashed', edited: 'border-info' };

/** The issues for one line (for the line's own message list). */
export const issuesForLine = (issues, i) => (issues || []).filter((x) => x.path === `items.${i}` || x.path?.startsWith(`items.${i}.`));

/**
 * The extracted invoice as the existing review form takes it. Products and the supplier are NOT matched here (that is a later phase): every line comes
 * with "no match", so the person chooses them; anything not on the invoice stays empty.
 */
export function toReviewDraft(current, issues = []) {
  const none = { status: 'none', candidates: [] };
  const t = current.totals || {};
  return {
    invoiceNo: current.invoice?.invoiceNumber || '',
    invoiceDate: current.invoice?.invoiceDate || '',
    supplier: {
      name: current.supplier?.name || '',
      gstin: current.supplier?.gstin || '',
      phone: current.supplier?.phone || '',
      address: current.supplier?.address || '',
      match: none,
    },
    items: (current.items || []).map((i, n) => ({
      itemId: i.itemId,
      name: i.medicineName || i.description || '',
      manufacturer: i.manufacturer || '',
      batchNumber: i.batchNumber || '',
      manufacturingDate: i.manufacturingDate || '',
      expiryDate: i.expiryDate || '',
      quantity: i.quantity ?? undefined,
      freeQuantity: i.freeQuantity ?? 0,
      rate: i.purchaseRate ?? undefined,
      mrp: i.mrp ?? undefined,
      discountPercent: i.discountPercentage ?? 0,
      gstPercent: i.gstPercentage ?? undefined,
      issues: issuesForLine(issues, n)
        .filter((x) => x.severity !== 'info')
        .map((x) => x.message),
      match: none,
    })),
    totals: {
      stated: {
        subtotal: t.subtotal,
        taxableAmount: t.taxableAmount,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        additionalCharges: [t.otherCharges, t.shippingCharges, t.packagingCharges].some((v) => v != null)
          ? (t.otherCharges || 0) + (t.shippingCharges || 0) + (t.packagingCharges || 0)
          : undefined,
        grandTotal: t.grandTotal,
      },
    },
  };
}

export const issueCounts = (issues) => ({
  error: (issues || []).filter((i) => i.severity === 'error').length,
  warning: (issues || []).filter((i) => i.severity === 'warning').length,
  info: (issues || []).filter((i) => i.severity === 'info').length,
});
