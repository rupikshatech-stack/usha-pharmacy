import { ITEM_FIELDS, SUPPLIER_FIELDS, INVOICE_FIELDS, TOTAL_FIELDS } from './invoiceExtractionSchema.js';

/**
 * Linking every extracted value back to the OCR it came from, and saying how far it can be trusted — WITHOUT asking the model how sure it is (a model's
 * own "confidence" is not evidence). Instead each value is looked for in the OCR output:
 *   – found in a table cell or line  -> the confidence is the OCR provider's own for that cell / line; level high (>= 90%), medium (>= 70%) or low (< 70%);
 *     the page and the OCR text it was found in are kept as the source;
 *   – found, but the provider gave no confidence -> medium, confidence null (never invented);
 *   – NOT found anywhere in the OCR text -> low, found: false. A value that is not in the document is the signature of an invented one, so it is flagged;
 *   – null -> missing.
 * A value a person typed is level "edited" (the person is the source).
 * Meta shape: { 'items.2.batchNumber': { level, confidence, page, snippet, found }, … }
 */
const SKIP = new Set(['page', 'sourceText', 'currency', 'invoiceType', 'amountInWords']); // derived or descriptive: no meaningful place to find them

export const levelOf = (c) => (c === null || c === undefined ? 'medium' : c >= 0.9 ? 'high' : c >= 0.7 ? 'medium' : 'low');
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The OCR output as places a value can be found: lines, table cells, and whole table rows (so a row can be found from its text). */
export function indexOcr(ocr) {
  const segs = [];
  for (const p of ocr.pages || []) {
    if (p.lines?.length) for (const l of p.lines) segs.push({ kind: 'line', page: p.pageNumber, text: l.text, confidence: l.confidence ?? null });
    else for (const t of String(p.text || '').split('\n')) if (t.trim()) segs.push({ kind: 'line', page: p.pageNumber, text: t, confidence: p.confidence ?? null });
  }
  const rows = [];
  for (const t of ocr.tables || []) {
    for (const cells of [...(t.headerRows || []), ...(t.bodyRows || [])]) {
      const cs = cells.filter((c) => c.text);
      if (!cs.length) continue;
      const known = cs.map((c) => c.confidence).filter((c) => c !== null && c !== undefined);
      const row = { kind: 'row', page: t.pageNumber, text: cs.map((c) => c.text).join(' '), compact: squash(cs.map((c) => c.text).join('')), confidence: known.length ? Math.min(...known) : null, cells: cs.map((c) => ({ kind: 'cell', page: t.pageNumber, text: c.text, confidence: c.confidence ?? null })) };
      rows.push(row);
      for (const c of row.cells) segs.push(c);
    }
  }
  const pageTexts = (ocr.pages || []).map((p) => ({ page: p.pageNumber, text: norm(p.text || '') }));
  return { segs, rows, pageTexts, full: norm(ocr.text || '') };
}

/** The spellings a number may have on an invoice. */
function numberForms(n) {
  const forms = new Set([n.toFixed(2), String(n), n.toFixed(1)]);
  if (Number.isInteger(n)) forms.add(String(n));
  const [int, dec] = n.toFixed(2).split('.');
  const western = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const indian = int.length > 3 ? `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}` : int;
  for (const g of [western, indian]) {
    forms.add(`${g}.${dec}`);
    if (dec === '00') forms.add(g);
  }
  if (n.toFixed(2).endsWith('0') && !n.toFixed(2).endsWith('00')) forms.add(n.toFixed(1));
  return [...forms];
}
const numberRx = (form) => new RegExp(`(?<![\\d.,])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d|[.,]\\d)`);

/** The spellings a date may have on an invoice (expiry dates are often just month and year). */
function dateForms(iso) {
  const [y, m, d] = iso.split('-');
  const yy = y.slice(2);
  const mon = MONTHS[+m - 1];
  const out = [`${d}/${m}/${y}`, `${d}-${m}-${y}`, `${d}.${m}.${y}`, `${d}/${m}/${yy}`, `${d}-${m}-${yy}`, `${m}/${y}`, `${m}-${y}`, `${m}/${yy}`, `${m}-${yy}`, `${m}.${y}`, `${mon}-${y}`, `${mon} ${y}`, `${mon}/${yy}`, `${mon}-${yy}`, `${mon}'${yy}`, `${mon} ${yy}`, `${d}-${mon}-${y}`, `${d} ${mon} ${y}`, `${d}-${mon}-${yy}`, `${d}/${mon}/${y}`, iso, `${+d}/${+m}/${y}`];
  return out;
}

const matcher = (kind, value) => {
  if (typeof value === 'number') {
    const rxs = numberForms(value).map(numberRx);
    return (text) => rxs.some((rx) => rx.test(text));
  }
  if (kind === 'date' || kind === 'expiry') {
    const forms = dateForms(value).map(norm);
    return (text) => {
      const t = norm(text);
      return forms.some((f) => t.includes(f));
    };
  }
  const needle = norm(value);
  const compact = squash(value);
  return (text) => norm(text).includes(needle) || (compact.length >= 4 && squash(text).includes(compact));
};

const best = (cands) => cands.reduce((a, b) => (a === null || (b.confidence ?? -1) > (a.confidence ?? -1) ? b : a), null);

function find(ix, kind, value, scope) {
  const test = matcher(kind, value);
  const pool = scope ? scope.cells.concat([{ kind: 'row', page: scope.page, text: scope.text, confidence: scope.confidence }]) : ix.segs;
  const hit = best(pool.filter((s) => s.kind !== 'row' || scope).filter((s) => test(s.text)));
  if (hit) return { found: true, confidence: hit.confidence, page: hit.page, snippet: hit.text.slice(0, 160) };
  if (!scope) {
    // a value may be split over lines (an address, a long name): look in each page's whole text
    for (const p of ix.pageTexts) if (typeof value === 'string' && test(p.text)) return { found: true, confidence: null, page: p.page, snippet: null };
    if (typeof value === 'string' && test(ix.full)) return { found: true, confidence: null, page: null, snippet: null };
  }
  return { found: false, confidence: null, page: null, snippet: null };
}

/** The OCR table row (or line) a model-quoted source text points at, or null when it cannot be traced. */
export function findRow(ix, sourceText) {
  const key = squash(sourceText || '');
  if (key.length < 6) return null;
  const hit = ix.rows.filter((r) => r.compact.length >= 6 && (r.compact.includes(key) || key.includes(r.compact))).sort((a, b) => Math.abs(a.compact.length - key.length) - Math.abs(b.compact.length - key.length))[0];
  if (hit) return hit;
  const line = ix.segs.find((s) => s.kind === 'line' && squash(s.text).length >= 6 && (squash(s.text).includes(key) || key.includes(squash(s.text))));
  return line ? { page: line.page, text: line.text, confidence: line.confidence, cells: [line] } : null;
}

const entry = (found, kind) => ({ ...found, level: !found.found ? 'low' : levelOf(found.confidence), kind });

/** Links every extracted value to the OCR (see the top of this file). Returns { meta, untraced } — `untraced` lists the item rows that could not be found in the OCR. */
export function buildMeta(ocr, data) {
  const ix = indexOcr(ocr);
  const meta = {};
  const put = (path, value, kind, scope) => {
    if (value === null || value === undefined) meta[path] = { level: 'missing', found: false, confidence: null, page: null, snippet: null };
    else if (SKIP.has(path.split('.').pop())) meta[path] = { level: 'high', found: true, confidence: null, page: null, snippet: null, derived: true };
    else meta[path] = entry(find(ix, kind, value, scope), kind);
  };
  for (const [section, fields] of [['supplier', SUPPLIER_FIELDS], ['invoice', INVOICE_FIELDS], ['totals', TOTAL_FIELDS]]) {
    for (const [k, kind] of Object.entries(fields)) put(`${section}.${k}`, data[section]?.[k], kind);
  }
  const untraced = [];
  (data.items || []).forEach((it, i) => {
    const row = findRow(ix, it.sourceText);
    if (!row) untraced.push(i);
    const scope = row?.cells ? row : null;
    for (const [k, kind] of Object.entries(ITEM_FIELDS)) put(`items.${i}.${k}`, it[k], kind, k === 'sourceText' ? null : scope);
    meta[`items.${i}.row`] = row ? { level: levelOf(row.confidence), found: true, confidence: row.confidence ?? null, page: row.page, snippet: row.text.slice(0, 200) } : { level: 'low', found: false, confidence: null, page: null, snippet: null };
  });
  return { meta, untraced };
}

/** After a person edits: untouched values keep their OCR link; changed or new ones become "edited". */
export function mergeEdits(meta, before, after) {
  const out = {};
  const same = (a, b) => a === b || (a == null && b == null);
  const visit = (path, a, b) => {
    out[path] = same(a, b) && meta[path] ? meta[path] : b == null ? { level: 'missing', found: false, confidence: null, page: null, snippet: null } : { level: 'edited', found: true, confidence: null, page: null, snippet: null };
  };
  for (const [section, fields] of [['supplier', SUPPLIER_FIELDS], ['invoice', INVOICE_FIELDS], ['totals', TOTAL_FIELDS]]) for (const k of Object.keys(fields)) visit(`${section}.${k}`, before[section]?.[k], after[section]?.[k]);
  (after.items || []).forEach((it, i) => {
    const old = (before.items || [])[i];
    for (const k of Object.keys(ITEM_FIELDS)) visit(`items.${i}.${k}`, old?.[k], it[k]);
    out[`items.${i}.row`] = old && same(old.sourceText, it.sourceText) && meta[`items.${i}.row`] ? meta[`items.${i}.row`] : { level: 'edited', found: true, confidence: null, page: null, snippet: null };
  });
  return out;
}

/** Warnings about values that cannot be relied on: not in the OCR text at all, or read with low confidence. Values a person has edited are theirs. */
export function traceIssues(meta, data) {
  const issues = [];
  const label = (path) => {
    const [a, b, c] = path.split('.');
    return a === 'items' ? `Line ${+b + 1} ${c.replace(/([A-Z])/g, ' $1').toLowerCase()}` : `${a === 'supplier' ? 'Supplier ' : ''}${b.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
  };
  for (const [path, m] of Object.entries(meta)) {
    if (path.endsWith('.row')) {
      if (!m.found && m.level !== 'edited') issues.push({ severity: 'warning', code: 'ROW_NOT_TRACED', path, message: `Line ${+path.split('.')[1] + 1} could not be matched to a row of the OCR text. Check it against the document.` });
      continue;
    }
    if (m.level === 'edited' || m.level === 'missing' || m.derived) continue;
    if (!m.found) issues.push({ severity: 'warning', code: 'NOT_IN_OCR', path, message: `${label(path)} was not found in the OCR text. It may not be on the document — verify it or clear it.` });
    else if (m.level === 'low') issues.push({ severity: 'warning', code: 'LOW_CONFIDENCE', path, message: `${label(path)} was read with low confidence (${Math.round(m.confidence * 100)}%). Verify it.` });
  }
  return issues;
}

export const _test = { numberForms, dateForms };
