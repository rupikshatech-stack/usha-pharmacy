import mongoose from 'mongoose';
import { Compound, InvoiceExtraction, Medicine, ProductMapping } from '../../models/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/regex.js';
import { audit } from '../audit.service.js';
import { matchSupplier } from '../aiBilling.service.js';
import { assignItemIds } from '../aiExtraction/invoiceExtractionSchema.js';
import { loadUpload } from '../invoiceUpload.service.js';
import { describe } from './productNormalizationService.js';
import { compareAttributes, matchingConfig } from './productSimilarityService.js';

/**
 * Product matching (Phase 4): comparing the medicines of an AI-extracted invoice with the EXISTING products (the Medicine collection) and recording, for each
 * invoice row, which product it probably is, why, and what a person decided. It never creates or changes a product, never touches stock, batches or orders,
 * and never confirms anything by itself: "Matched" only means "reliable, no conflicts" — a person still confirms every row (or confirms all eligible rows).
 *
 * Per row the result is kept with the extraction (`matching.items[]`, keyed by the row's stable itemId) and holds product IDS only — product details are read
 * from the product master when shown. Rules (see productSimilarityService for the attribute comparison):
 *   – a candidate with a critical conflict (strength, dosage form or active ingredient differs) is never matched automatically, whatever its score;
 *   – "Matched": best candidate with no conflict at all, score >= the auto threshold, and no equally good rival;
 *   – "Needs review": a plausible candidate that has a warning (manufacturer, pack size, missing detail…), a middling score, or a rival of equal standing;
 *   – "Unmatched": nothing at or above the review threshold without a critical conflict;
 *   – a remembered mapping (same supplier, same normalized description) is reused only after the product passes the same attribute checks again.
 */
const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const IDENT_MIN = 4;

/* ------------------------------------------------------------------------------------------------ the product catalog */

const brandOf = (m) => (m.attributes || []).find((a) => /^brand$/i.test(a.key))?.value || '';
const briefOf = (m) => ({
  _id: m._id, name: m.medicineName, sku: m.sku || '', barcode: m.barcode || '', brand: brandOf(m), genericName: m.genericName || '', manufacturer: m.manufacturer || '', strength: m.strength || '',
  dosageForm: m.dosageForm || '', packSize: m.packSize || '', hsnCode: m.hsnCode || '', gstPercentage: m.gstPercentage ?? null, unit: m.unit || '', isActive: m.isActive !== false,
});

function describeProduct(m, compound) {
  const d = describe({ name: m.medicineName, strength: m.strength, dosageForm: m.dosageForm, packSize: m.packSize, manufacturer: m.manufacturer, brand: brandOf(m), hsnCode: m.hsnCode });
  const named = [m.genericName, m.salt, compound?.composition, compound?.compoundName].filter(Boolean).flatMap((t) => describe({ name: t }).tokens);
  d.ingredientPool = [...new Set([...named, ...d.tokens])];
  d.brand = brandOf(m);
  return d;
}

/** All active products with their comparable descriptions, and a prefix index so a line is only compared with products that could be it. */
async function loadCatalog(orgId) {
  const meds = await Medicine.find({ organizationId: orgId, isActive: true }).select('medicineName genericName salt manufacturer dosageForm strength packSize unit hsnCode gstPercentage barcode sku compoundId attributes isActive').limit(50000).lean();
  const compoundIds = [...new Set(meds.map((m) => m.compoundId).filter(Boolean).map(String))];
  const compounds = compoundIds.length ? await Compound.find({ organizationId: orgId, _id: { $in: compoundIds } }).select('compoundName composition').lean() : [];
  const byCompound = new Map(compounds.map((c) => [String(c._id), c]));
  const products = meds.map((m) => ({ id: String(m._id), med: m, d: describeProduct(m, byCompound.get(String(m.compoundId))) }));
  const prefix = new Map();
  const ident = new Map();
  products.forEach((p, i) => {
    for (const t of new Set([...p.d.tokens, ...p.d.ingredientPool])) {
      const k = t.slice(0, 3);
      if (!prefix.has(k)) prefix.set(k, new Set());
      prefix.get(k).add(i);
    }
    for (const c of [p.med.sku, p.med.barcode]) if (c && c.length >= IDENT_MIN) ident.set(c.toLowerCase(), i);
  });
  return { products, prefix, ident, byId: new Map(products.map((p) => [p.id, p])) };
}

const describeItem = (it) =>
  describe({ name: it.medicineName || it.description || '', description: it.medicineName ? it.description : '', strength: it.strength, dosageForm: it.dosageForm, packSize: it.packSize, manufacturer: it.manufacturer, brand: it.brand, hsnCode: it.hsnCode });

const wordsOf = (it) => [it.medicineName, it.description].filter(Boolean).join(' ').toLowerCase().split(/[^a-z0-9\-/]+/).filter((w) => w.length >= IDENT_MIN);

/* ------------------------------------------------------------------------------------------------ ranking one row */

function candidatesFor(inv, it, catalog, config) {
  const idx = new Set();
  for (const t of new Set([...inv.tokens, ...inv.ingredients])) for (const i of catalog.prefix.get(t.slice(0, 3)) || []) idx.add(i);
  const identified = new Set();
  for (const w of wordsOf(it)) if (catalog.ident.has(w)) {
    identified.add(catalog.ident.get(w));
    idx.add(catalog.ident.get(w));
  }
  const out = [];
  for (const i of idx) {
    const p = catalog.products[i];
    const r = compareAttributes(inv, p.d, { identifier: identified.has(i), config });
    out.push({ productId: p.id, ...r, critical: r.conflicts.some((c) => c.level === 'critical'), warnings: r.conflicts.filter((c) => c.level === 'warning') });
  }
  // plausible first (no critical conflict), then by score
  return out.sort((a, b) => Number(a.critical) - Number(b.critical) || b.score - a.score).filter((c) => c.score >= config.suggestionFloor);
}

const verdictOf = (c, config) => (c.critical ? 'conflict' : c.score >= config.auto && !c.warnings.length ? 'matched' : c.score >= config.review ? 'needs_review' : 'weak');

const briefSuggestion = (c, config) => ({ productId: c.productId, score: c.score, verdict: verdictOf(c, config), reasons: c.reasons, conflicts: c.conflicts });

/** The decision for one row (see the rules at the top of this file). */
function decide(it, inv, catalog, config, mapping) {
  const warnings = [];
  const name = it.medicineName || it.description;
  if (!name) return { status: 'unmatched', productId: null, score: 0, reasons: [], warnings: ['The invoice line has no medicine name.'], conflicts: [], suggestions: [], mappingSource: null };
  const ranked = candidatesFor(inv, it, catalog, config);
  const suggestions = ranked.slice(0, config.maxSuggestions).map((c) => briefSuggestion(c, config));

  // 1. a remembered mapping for this supplier's description — only if the product still passes the attribute checks
  if (mapping) {
    const p = catalog.byId.get(String(mapping.medicineId));
    if (!p) warnings.push('A remembered mapping was not used: its product is no longer available.');
    else {
      const r = compareAttributes(inv, p.d, { config });
      const critical = r.conflicts.filter((c) => c.level === 'critical');
      if (critical.length) warnings.push(`A remembered mapping was not used because the product no longer agrees with the invoice: ${critical.map((c) => c.message).join(' ')}`);
      else {
        const warn = r.conflicts.filter((c) => c.level === 'warning');
        const note = `Previously confirmed for this supplier${mapping.confirmedByName ? ` by ${mapping.confirmedByName}` : ''}`;
        const top = [{ productId: p.id, ...r, critical: false, warnings: warn }, ...ranked.filter((c) => c.productId !== p.id)].slice(0, config.maxSuggestions).map((c) => briefSuggestion(c, config));
        return { status: warn.length ? 'needs_review' : 'matched', productId: p.id, score: r.score, reasons: [note, ...r.reasons], warnings: warn.map((c) => c.message), conflicts: r.conflicts, suggestions: top, mappingSource: 'previously_confirmed', mappingId: String(mapping._id) };
      }
    }
  }

  const plausible = ranked.filter((c) => !c.critical);
  const best = plausible[0];
  if (!best || best.score < config.review) {
    const conflicting = ranked.filter((c) => c.critical).slice(0, 2);
    if (conflicting.length) warnings.push(`The closest products are different medicines: ${conflicting.map((c) => c.conflicts.find((x) => x.level === 'critical').message).join(' ')}`);
    return { status: 'unmatched', productId: null, score: best?.score ?? 0, reasons: [], warnings, conflicts: [], suggestions, mappingSource: null };
  }
  warnings.push(...best.warnings.map((c) => c.message));
  if (!inv.strengths.length && !inv.implied.length && !inv.form && !best.conflicts.some((c) => ['STRENGTH_MISSING', 'FORM_MISSING'].includes(c.code))) warnings.push('Neither a strength nor a dosage form is stated on the invoice or recorded on the product, so they cannot be checked.');
  let status = verdictOf(best, config) === 'matched' && !warnings.length ? 'matched' : 'needs_review';
  const rival = plausible.slice(1).find((c) => c.productId !== best.productId && c.score >= config.auto && best.score - c.score < config.ambiguityMargin);
  if (rival && status === 'matched') {
    status = 'needs_review';
    warnings.push('More than one product matches equally well. Choose the right one.');
  }
  return { status, productId: best.productId, score: best.score, reasons: best.reasons, warnings, conflicts: best.conflicts, suggestions, mappingSource: 'automatic' };
}

/* ------------------------------------------------------------------------------------------------ stored state */

const event = (req, action, productId, note) => ({ at: new Date(), by: req.user._id, byName: req.user.name, action, productId: productId ? String(productId) : null, ...(note && { note }) });

async function supplierKeyFor(orgId, supplier = {}) {
  const m = await matchSupplier(orgId, supplier);
  if (m.status === 'exact' && m.supplierId) return { supplierKey: String(m.supplierId), supplierId: m.supplierId };
  const gstin = String(supplier.gstin || '').replace(/\s/g, '').toUpperCase();
  if (gstin) return { supplierKey: `gstin:${gstin}`, supplierId: null };
  const name = String(supplier.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return name ? { supplierKey: `name:${name}`, supplierId: null } : { supplierKey: null, supplierId: null };
}

export async function context(orgId, id, { forWrite = false } = {}) {
  const u = await loadUpload(orgId, id);
  const ex = await InvoiceExtraction.findOne({ organizationId: orgId, uploadObjectId: u._id }).sort({ version: -1 }).lean();
  if (!ex) throw fail(409, 'Extract the invoice with AI first. Products are matched from the extracted medicines.', 'AI_NOT_EXTRACTED');
  if (forWrite && u.status === 'drafted') throw fail(409, 'A draft order was already saved from this invoice, so its product matches can no longer be changed.', 'UPLOAD_STATE');
  if (forWrite && ex.purchase?.orderId) throw fail(409, `A purchase order (${ex.purchase.orderNo}) was already ${ex.purchase.mode === 'linked' ? 'linked to' : 'made from'} this invoice, so its product matches can no longer be changed.`, 'UPLOAD_STATE');
  if (forWrite && u.aiStatus === 'processing') throw fail(409, 'The AI is reading this invoice right now. Wait for it to finish.', 'AI_ALREADY_RUNNING');
  return { u, ex };
}

async function saveMatching(orgId, ex, matching, extra = {}) {
  const r = await InvoiceExtraction.findOneAndUpdate({ _id: ex._id, organizationId: orgId, matchingRevision: ex.matchingRevision || 0 }, { $set: { matching, ...extra }, $inc: { matchingRevision: 1 } }, { returnDocument: 'after' }).lean();
  if (!r) throw fail(409, 'Someone else changed the product matches while you were working. Reload and try again.', 'MATCH_CHANGED');
  return r;
}

const entryOf = (ex, itemId) => (ex.matching?.items || []).find((e) => e.itemId === itemId);
function itemOf(ex, itemId) {
  const i = (ex.current.items || []).findIndex((x) => x.itemId === itemId);
  if (i < 0) throw fail(404, 'Invoice item not found', 'ITEM_NOT_FOUND');
  return { item: ex.current.items[i], index: i };
}
const isStale = (entry, item) => Boolean(entry) && entry.sourceKey !== describeItem(item).key;

function newEntry(req, it, inv, d, mapping, config) {
  return {
    itemId: it.itemId, sourceKey: inv.key, extractedMedicineName: it.medicineName || it.description || '', normalizedMedicineName: inv.core,
    existingProductId: d.productId, matchingStatus: d.status, confirmation: 'pending', matchingScore: d.score, matchingReasons: d.reasons, matchingWarnings: d.warnings, conflicts: d.conflicts,
    suggestedProductIds: d.suggestions.map((s) => s.productId), suggestions: d.suggestions, mappingSource: d.mappingSource || null, mappingId: d.mappingId || null, reviewed: false,
    confirmedBy: null, confirmedByName: null, confirmedAt: null, history: [event(req, d.status === 'unmatched' ? 'unmatched' : 'suggested', d.productId, d.mappingSource === 'previously_confirmed' ? 'remembered mapping' : undefined)],
  };
}

/* ------------------------------------------------------------------------------------------------ running it */

/**
 * Matches the rows of the extracted invoice with the products (POST /:id/match-products). By default rows a person already decided (confirmed, or a product
 * picked by hand) are kept, and only new, edited and still-open rows are matched again. `rematch: 'all'` starts every row over (it needs `force: true`
 * because it discards confirmations). The match runs at once; nothing else is changed.
 */
export async function runMatching(req, id, { rematch = 'open', force = false } = {}) {
  const { u, ex: first } = await context(req.orgId, id, { forWrite: true });
  let ex = first;
  if (rematch === 'all' && !force && (ex.matching?.items || []).some((e) => e.confirmation === 'confirmed')) throw fail(409, 'Some rows are already confirmed. Matching everything again would discard those confirmations; confirm that you want this.', 'MATCH_FORCE_REQUIRED');
  const items = ex.current.items || [];
  let extra = {};
  if (items.some((i) => !i.itemId)) {
    assignItemIds(items);
    extra = { current: ex.current }; // rows from before product matching existed get their stable ids now (the AI's original answer is left as it was)
    ex = { ...ex, ...extra };
  }
  const config = matchingConfig();
  const catalog = await loadCatalog(req.orgId);
  const { supplierKey, supplierId } = await supplierKeyFor(req.orgId, ex.current.supplier);
  const mappings = supplierKey ? new Map((await ProductMapping.find({ organizationId: req.orgId, supplierKey }).lean()).map((m) => [m.key, m])) : new Map();
  const old = new Map((ex.matching?.items || []).map((e) => [e.itemId, e]));
  const reused = [];
  const out = items.map((it) => {
    const inv = describeItem(it);
    const prev = old.get(it.itemId);
    const decided = prev && !isStale(prev, it) && (prev.confirmation === 'confirmed' || prev.confirmation === 'unmatched' || prev.reviewed);
    if (rematch !== 'all' && decided) return prev;
    const mapping = mappings.get(inv.key);
    const d = decide(it, inv, catalog, config, mapping);
    if (d.mappingSource === 'previously_confirmed') reused.push(d.mappingId);
    return newEntry(req, it, inv, d, mapping, config);
  });
  const matching = { runAt: new Date(), runBy: req.user._id, runByName: req.user.name, config: { auto: config.auto, review: config.review, maxSuggestions: config.maxSuggestions }, supplierKey, supplierId, items: out };
  await saveMatching(req.orgId, ex, matching, extra);
  if (reused.length) await ProductMapping.updateMany({ organizationId: req.orgId, _id: { $in: reused } }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } });
  const c = out.reduce((a, e) => ({ ...a, [e.matchingStatus]: (a[e.matchingStatus] || 0) + 1 }), {});
  await audit(req, { action: 'AI_PRODUCT_MATCH', entity: 'InvoiceUpload', entityId: u._id, message: `Products matched for invoice ${u.uploadId}: ${c.matched || 0} matched, ${c.needs_review || 0} need review, ${c.unmatched || 0} unmatched — nothing confirmed, no product or stock changed` });
  return getMatches(req.orgId, id);
}

/* ------------------------------------------------------------------------------------------------ reading it */

async function briefs(orgId, ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))].filter((x) => mongoose.isValidObjectId(x));
  const meds = list.length ? await Medicine.find({ organizationId: orgId, _id: { $in: list } }).select('medicineName genericName manufacturer dosageForm strength packSize unit hsnCode gstPercentage barcode sku attributes isActive').lean() : [];
  return new Map(meds.map((m) => [String(m._id), briefOf(m)]));
}

const STATUS_LABEL = { matched: 'Matched', needs_review: 'Needs Review', unmatched: 'Unmatched' };

/**
 * All rows with their matching state, a summary (for the cards), and — for each row — the current product and up to five suggestions, with product details read
 * from the product master. A row edited after it was matched is reported as stale (needs review again); a row never matched is "not matched yet".
 */
export async function getMatches(orgId, id, { status, search } = {}) {
  const { u, ex } = await context(orgId, id);
  const items = ex.current.items || [];
  const entries = new Map((ex.matching?.items || []).map((e) => [e.itemId, e]));
  const ids = [];
  for (const e of entries.values()) ids.push(e.existingProductId, ...(e.suggestedProductIds || []));
  const products = await briefs(orgId, ids);
  const rows = items.map((it, index) => {
    const e = it.itemId ? entries.get(it.itemId) : null;
    const stale = isStale(e, it);
    const inv = describeItem(it);
    const effective = !e ? 'unmatched' : stale ? 'needs_review' : e.matchingStatus;
    const warnings = [...(e?.matchingWarnings || []), ...(stale ? ['The invoice line was edited after it was matched. Match it again.'] : []), ...(!e ? ['Not matched yet.'] : [])];
    return {
      index, itemId: it.itemId || null,
      invoice: {
        name: it.medicineName || it.description || '', description: it.description || '', manufacturer: it.manufacturer || '', strength: it.strength || inv.strengths.join(' + ') || inv.implied.join(' + ') || '', dosageForm: it.dosageForm || (inv.form ? inv.form.replace('_', ' ') : ''),
        packSize: it.packSize || '', batchNumber: it.batchNumber, expiryDate: it.expiryDate, manufacturingDate: it.manufacturingDate, quantity: it.quantity, freeQuantity: it.freeQuantity,
      },
      notMatchedYet: !e, stale, status: effective, statusLabel: STATUS_LABEL[effective], confirmation: !e || stale ? 'pending' : e.confirmation,
      score: e?.matchingScore ?? null, reasons: e?.matchingReasons || [], warnings, conflicts: e?.conflicts || [], mappingSource: e?.mappingSource || null, reviewed: Boolean(e?.reviewed),
      confirmedByName: e?.confirmedByName || null, confirmedAt: e?.confirmedAt || null,
      product: e?.existingProductId ? products.get(String(e.existingProductId)) || null : null,
      suggestions: (e?.suggestions || []).map((s) => ({ ...s, product: products.get(String(s.productId)) || null })).filter((s) => s.product),
    };
  });
  const count = (f) => rows.filter(f).length;
  const summary = {
    total: rows.length, matched: count((r) => r.status === 'matched'), needsReview: count((r) => r.status === 'needs_review'), unmatched: count((r) => r.status === 'unmatched'),
    confirmed: count((r) => r.confirmation === 'confirmed'), markedUnmatched: count((r) => r.confirmation === 'unmatched'), pending: count((r) => r.confirmation === 'pending'), stale: count((r) => r.stale), notMatchedYet: count((r) => r.notMatchedYet),
  };
  const q = String(search || '').trim().toLowerCase();
  const shown = rows.filter((r) => (!status || r.status === status) && (!q || r.invoice.name.toLowerCase().includes(q) || (r.product?.name || '').toLowerCase().includes(q)));
  const cfg = matchingConfig();
  return {
    upload: { _id: u._id, uploadId: u.uploadId, status: u.status }, version: ex.version, matched: Boolean(ex.matching), runAt: ex.matching?.runAt || null, runByName: ex.matching?.runByName || null,
    config: { auto: cfg.auto, review: cfg.review, maxSuggestions: cfg.maxSuggestions }, summary, items: shown,
    complete: rows.length > 0 && rows.every((r) => r.confirmation === 'confirmed' && r.product), readyForPhase5: rows.length > 0 && rows.every((r) => r.confirmation === 'confirmed' && r.product), matchRevision: ex.matchingRevision || 0,
  };
}

/** Looks products up by hand: every word must be found in the name, SKU, barcode, manufacturer, generic name, salt, strength or a brand attribute. */
async function searchProducts(orgId, q) {
  const words = String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const fields = ['medicineName', 'sku', 'barcode', 'manufacturer', 'genericName', 'salt', 'strength', 'attributes.value'];
  return Medicine.find({ organizationId: orgId, isActive: true, $and: words.map((w) => ({ $or: fields.map((f) => ({ [f]: new RegExp(escapeRegex(w), 'i') })) })) }).limit(60).lean();
}

/**
 * Suggestions for one row: the best products by the matching rules (up to five), or — with `search` — the products found by hand, each scored against the row
 * with its reasons and conflicts. "No matching product found" is said plainly; new products are created in Inventory, never here.
 */
export async function getSuggestions(orgId, id, itemId, { search } = {}) {
  const { ex } = await context(orgId, id);
  const { item } = itemOf(ex, itemId);
  const config = matchingConfig();
  const inv = describeItem(item);
  let list;
  if (search && search.trim()) {
    const meds = await searchProducts(orgId, search);
    const compounds = new Map((await Compound.find({ organizationId: orgId, _id: { $in: meds.map((m) => m.compoundId).filter(Boolean) } }).select('compoundName composition').lean()).map((c) => [String(c._id), c]));
    list = meds.map((m) => {
      const r = compareAttributes(inv, describeProduct(m, compounds.get(String(m.compoundId))), { config });
      const c = { productId: String(m._id), ...r, critical: r.conflicts.some((x) => x.level === 'critical'), warnings: r.conflicts.filter((x) => x.level === 'warning') };
      return { ...briefSuggestion(c, config), product: briefOf(m) };
    }).sort((a, b) => Number(a.verdict === 'conflict') - Number(b.verdict === 'conflict') || b.score - a.score).slice(0, 20);
  } else {
    const catalog = await loadCatalog(orgId);
    list = candidatesFor(inv, item, catalog, config).slice(0, config.maxSuggestions).map((c) => ({ ...briefSuggestion(c, config), product: briefOf(catalog.byId.get(c.productId).med) }));
  }
  return {
    item: { itemId, name: item.medicineName || item.description || '', manufacturer: item.manufacturer || '', strength: item.strength || '' }, search: search || '', suggestions: list, none: list.length === 0,
    message: list.length === 0 ? 'No matching product found.' : undefined, createProductHint: list.length === 0 ? 'If the product does not exist, add it in Inventory (Product Management); it is never created from here.' : undefined,
  };
}

/* ------------------------------------------------------------------------------------------------ deciding */

async function productFor(orgId, productId) {
  if (!mongoose.isValidObjectId(productId)) throw fail(404, 'Product not found', 'PRODUCT_NOT_FOUND');
  const m = await Medicine.findOne({ _id: productId, organizationId: orgId }).lean();
  if (!m || m.isActive === false) throw fail(404, 'Product not found (or archived)', 'PRODUCT_NOT_FOUND');
  const compound = m.compoundId ? await Compound.findOne({ _id: m.compoundId, organizationId: orgId }).select('compoundName composition').lean() : null;
  return { m, d: describeProduct(m, compound) };
}

const mutate = (ex, itemId, fn) => {
  const items = (ex.matching?.items || []).map((e) => (e.itemId === itemId ? fn(e) : e));
  return { ...(ex.matching || {}), items };
};

/** A person picks (or changes) the product for a row. Conflicts are shown; a critical one needs `acknowledgeConflicts`. Nothing is confirmed yet. */
export async function selectProduct(req, id, itemId, { productId, acknowledgeConflicts = false }) {
  const { u, ex } = await context(req.orgId, id, { forWrite: true });
  if (!ex.matching) throw fail(409, 'Match the products first.', 'MATCH_NOT_RUN');
  const entry = entryOf(ex, itemId);
  const { item } = itemOf(ex, itemId);
  if (!entry) throw fail(409, 'This row has not been matched yet. Match the products again.', 'MATCH_NOT_RUN');
  const { m, d } = await productFor(req.orgId, productId);
  const r = compareAttributes(describeItem(item), d, { config: matchingConfig() });
  const critical = r.conflicts.filter((c) => c.level === 'critical');
  if (critical.length && !acknowledgeConflicts) throw fail(409, `This product differs from the invoice line: ${critical.map((c) => c.message).join(' ')} Select it only if the invoice is wrong.`, 'MATCH_CONFLICT', critical);
  const warnings = r.conflicts.filter((c) => c.level === 'warning').map((c) => c.message);
  const matching = mutate(ex, itemId, (e) => ({
    ...e, sourceKey: describeItem(item).key, existingProductId: String(m._id), matchingStatus: critical.length || warnings.length ? 'needs_review' : 'matched', confirmation: 'pending', matchingScore: r.score, matchingReasons: r.reasons, matchingWarnings: warnings,
    conflicts: r.conflicts, mappingSource: 'manual', mappingId: null, reviewed: true, confirmedBy: null, confirmedByName: null, confirmedAt: null,
    suggestedProductIds: [...new Set([String(m._id), ...(e.suggestedProductIds || [])])].slice(0, 5), history: [...(e.history || []), event(req, 'selected', m._id, critical.length ? 'conflicts acknowledged' : undefined)],
  }));
  await saveMatching(req.orgId, ex, matching);
  await audit(req, { action: 'AI_PRODUCT_SELECT', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId} line ${itemOf(ex, itemId).index + 1}: product “${m.medicineName}” selected${critical.length ? ' with acknowledged conflicts' : ''} — not confirmed yet` });
  return getMatches(req.orgId, id);
}

/** Remembers what this supplier's description is. One product per description: a different one replaces it and the old one is kept in the history. */
async function rememberMapping(req, ex, entry, item, productId, matching, m) {
  const inv = describeItem(item);
  if (!matching.supplierKey || !inv.key) return null;
  const set = {
    supplierId: matching.supplierId || undefined, originalName: (item.medicineName || item.description || '').slice(0, 300), normalizedName: inv.core, medicineId: productId, manufacturer: m.manufacturer || '', strength: m.strength || '',
    dosageForm: m.dosageForm || '', packSize: m.packSize || '', confirmedBy: req.user._id, confirmedByName: req.user.name, confirmedAt: new Date(),
  };
  const source = entry.mappingSource === 'manual' ? 'manual' : 'automatic';
  for (let tries = 0; tries < 2; tries += 1) {
    const found = await ProductMapping.findOne({ organizationId: req.orgId, supplierKey: matching.supplierKey, key: inv.key });
    try {
      if (found) {
        const changed = String(found.medicineId) !== String(productId);
        await ProductMapping.updateOne({ _id: found._id, organizationId: req.orgId }, { $set: { ...set, source: changed ? source : found.source }, ...(changed && { $push: { history: { medicineId: found.medicineId, source: found.source, by: found.confirmedBy, byName: found.confirmedByName, at: found.confirmedAt, replacedAt: new Date() } } }) });
        return String(found._id);
      }
      const created = await ProductMapping.create({ organizationId: req.orgId, supplierKey: matching.supplierKey, key: inv.key, source, usageCount: 0, ...set });
      return String(created._id);
    } catch (e) {
      if (e.code !== 11000) throw e; // two confirmations at once for the same description: try again as an update
    }
  }
  return null;
}

/** Confirms one row's product (the step that makes it final). Shared by confirm and confirm-all; returns { ok } or { ok: false, reason }. */
async function confirmEntry(req, ex, matching, entry, { acknowledgeConflicts }) {
  const { item } = itemOf(ex, entry.itemId);
  if (isStale(entry, item)) return { ok: false, reason: 'The invoice line was edited after it was matched. Match it again.' };
  if (!entry.existingProductId) return { ok: false, reason: 'No product is chosen for this row.' };
  const { m, d } = await productFor(req.orgId, entry.existingProductId).catch(() => ({}));
  if (!m) return { ok: false, reason: 'The chosen product is no longer available.' };
  const r = compareAttributes(describeItem(item), d, { config: matchingConfig() });
  const critical = r.conflicts.filter((c) => c.level === 'critical');
  if (critical.length && !acknowledgeConflicts) return { ok: false, reason: `Conflicts with the invoice: ${critical.map((c) => c.message).join(' ')}`, conflicts: critical };
  const remember = entry.mappingSource === 'manual' || (entry.matchingStatus === 'matched' && !critical.length);
  const mappingId = remember && entry.mappingSource !== 'previously_confirmed' ? await rememberMapping(req, ex, entry, item, entry.existingProductId, matching, m) : entry.mappingId;
  return {
    ok: true,
    entry: { ...entry, confirmation: 'confirmed', mappingId: mappingId || null, matchingWarnings: entry.matchingWarnings, conflicts: r.conflicts, confirmedBy: req.user._id, confirmedByName: req.user.name, confirmedAt: new Date(), history: [...(entry.history || []), event(req, 'confirmed', entry.existingProductId, critical.length ? 'conflicts acknowledged' : remember ? undefined : 'not remembered (similarity only)')] },
  };
}

export async function confirmItem(req, id, itemId, { acknowledgeConflicts = false } = {}) {
  const { u, ex } = await context(req.orgId, id, { forWrite: true });
  const entry = entryOf(ex, itemId);
  if (!entry) throw fail(409, 'This row has not been matched yet.', 'MATCH_NOT_RUN');
  const r = await confirmEntry(req, ex, ex.matching, entry, { acknowledgeConflicts });
  if (!r.ok) throw fail(409, r.reason, r.conflicts ? 'MATCH_CONFLICT' : 'MATCH_NOT_CONFIRMABLE', r.conflicts);
  await saveMatching(req.orgId, ex, mutate(ex, itemId, () => r.entry));
  await audit(req, { action: 'AI_PRODUCT_CONFIRM', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId} line ${itemOf(ex, itemId).index + 1}: product confirmed by ${req.user.name} — no stock changed` });
  return getMatches(req.orgId, id);
}

/**
 * Confirms every row that is eligible: a product is chosen, nothing conflicts, the row has not been edited since, and it is either "Matched" or a "Needs review"
 * row a person has already looked at (picked by hand). A "Needs review" row that only has a suggestion is never confirmed this way.
 */
export async function confirmAll(req, id) {
  const { u, ex } = await context(req.orgId, id, { forWrite: true });
  if (!ex.matching) throw fail(409, 'Match the products first.', 'MATCH_NOT_RUN');
  const done = new Map();
  const skipped = [];
  for (const e of ex.matching.items) {
    const index = (ex.current.items || []).findIndex((x) => x.itemId === e.itemId);
    if (index < 0 || e.confirmation === 'confirmed') continue;
    if (e.confirmation === 'unmatched') { skipped.push({ itemId: e.itemId, index, reason: 'Marked as unmatched.' }); continue; }
    if (!(e.matchingStatus === 'matched' || (e.matchingStatus === 'needs_review' && e.reviewed))) { skipped.push({ itemId: e.itemId, index, reason: e.matchingStatus === 'unmatched' ? 'No product matched.' : 'Needs a person to check it first.' }); continue; }
    if ((e.conflicts || []).some((c) => c.level === 'critical')) { skipped.push({ itemId: e.itemId, index, reason: 'Conflicts with the invoice.' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const r = await confirmEntry(req, ex, ex.matching, e, { acknowledgeConflicts: false });
    if (r.ok) done.set(e.itemId, r.entry);
    else skipped.push({ itemId: e.itemId, index, reason: r.reason });
  }
  if (done.size) await saveMatching(req.orgId, ex, { ...ex.matching, items: ex.matching.items.map((e) => done.get(e.itemId) || e) });
  await audit(req, { action: 'AI_PRODUCT_CONFIRM_ALL', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId}: ${done.size} product match(es) confirmed by ${req.user.name}, ${skipped.length} left for review — no stock changed` });
  return { confirmed: done.size, skipped, ...(await getMatches(req.orgId, id)) };
}

export async function markUnmatched(req, id, itemId, { note } = {}) {
  const { u, ex } = await context(req.orgId, id, { forWrite: true });
  const entry = entryOf(ex, itemId);
  const { item, index } = itemOf(ex, itemId);
  if (!entry) throw fail(409, 'This row has not been matched yet.', 'MATCH_NOT_RUN');
  const matching = mutate(ex, itemId, (e) => ({
    ...e, sourceKey: describeItem(item).key, existingProductId: null, matchingStatus: 'unmatched', confirmation: 'unmatched', mappingSource: null, mappingId: null, reviewed: true, confirmedBy: req.user._id, confirmedByName: req.user.name, confirmedAt: new Date(),
    history: [...(e.history || []), event(req, 'unmatched', e.existingProductId, note)],
  }));
  await saveMatching(req.orgId, ex, matching);
  await audit(req, { action: 'AI_PRODUCT_UNMATCHED', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId} line ${index + 1} marked as having no matching product` });
  return getMatches(req.orgId, id);
}

/* ------------------------------------------------------------------------------------------------ for the next phase */

/**
 * The invoice rows with their confirmed product, ready for the next phase (purchase orders and goods receipt): each row keeps its original description and its
 * own batch, expiry, quantities and prices. `complete` is true only when every row has a confirmed product. Nothing is created from this.
 */
export async function verifiedLines(orgId, id) {
  const m = await getMatches(orgId, id);
  const { ex } = await context(orgId, id);
  const lines = m.items.map((r) => {
    const it = ex.current.items[r.index];
    return {
      itemId: r.itemId, originalDescription: it.description || it.medicineName || '', invoiceMedicineName: it.medicineName || '', productId: r.product?._id || null, productName: r.product?.name || null, matchingConfirmation: r.stale ? 'pending' : r.confirmation,
      batchNumber: it.batchNumber, expiryDate: it.expiryDate, manufacturingDate: it.manufacturingDate, quantity: it.quantity, freeQuantity: it.freeQuantity, purchaseRate: it.purchaseRate, mrp: it.mrp,
      discount: { percentage: it.discountPercentage, amount: it.discountAmount }, gst: { percentage: it.gstPercentage, cgst: it.cgst, sgst: it.sgst, igst: it.igst }, taxableAmount: it.taxableAmount, lineTotal: it.lineTotal,
    };
  });
  return { uploadId: m.upload.uploadId, version: m.version, summary: m.summary, complete: m.complete, supplier: ex.current.supplier, invoice: ex.current.invoice, lines };
}

