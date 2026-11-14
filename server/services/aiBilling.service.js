import { Medicine, Supplier } from '../models/index.js';
import { computeOrder } from '../utils/orderMath.js';

/**
 * AI Billing review: turning what an invoice-reading service returned (or what a person typed in) into a draft that must be checked.
 *
 * Nothing here saves anything and nothing here guesses. Products are matched to existing ones only when the match is exact; anything less is offered as
 * a candidate for the user to confirm, never chosen for them. Every line says what needs checking. Stock is never touched. (Reading the file itself is
 * the job of the pluggable provider in invoiceExtraction/; storing and scanning uploads is in invoiceUpload.service.js.)
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const LOW_CONFIDENCE = 0.8;
const POSSIBLE_MATCH = 0.7; // similarity from which a product is offered as a candidate (never chosen automatically)

/** The file's real type from its first bytes, so a renamed file can't slip through. */
export function sniffType(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/* ------------------------------------------------------------------------------------------------ matching (never invents) */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const squash = (s) => norm(s).replace(/ /g, '');
const bigrams = (s) => {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
  return out;
};
/** Dice coefficient on character pairs: 1 = identical, 0 = nothing in common. */
export function similarity(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const [g, n] of bx) common += Math.min(n, by.get(g) || 0);
  return (2 * common) / (x.length - 1 + y.length - 1);
}

const round = (n) => Math.round(n * 100) / 100;

function matchProduct(item, medicines) {
  const name = norm(item.name);
  const sku = String(item.sku || '').trim().toLowerCase();
  const exact = medicines.filter((m) => (name && norm(m.medicineName) === name) || (sku && [m.sku, m.barcode].some((c) => c && c.toLowerCase() === sku)));
  const pick = (m, score) => ({ medicineId: m._id, name: m.medicineName, unit: m.unit || '', sku: m.sku || '', manufacturer: m.manufacturer || '', gstPercent: m.gstPercentage ?? 12, score: round(score) });
  if (exact.length === 1) return { status: 'exact', medicineId: exact[0]._id, candidates: [pick(exact[0], 1)] };
  // two products with the same name, or nothing exact: offer candidates, choose none
  const ranked = (exact.length ? exact.map((m) => [m, 1]) : medicines.map((m) => [m, Math.max(similarity(item.name, m.medicineName), 0)])).filter(([, s]) => s >= POSSIBLE_MATCH).sort((p, q) => q[1] - p[1]).slice(0, 4);
  return { status: ranked.length ? 'possible' : 'none', medicineId: null, candidates: ranked.map(([m, s]) => pick(m, s)) };
}

export async function matchSupplier(orgId, supplier = {}) {
  const suppliers = await Supplier.find({ organizationId: orgId, isActive: true }).select('name gstin phone').lean();
  const gstin = String(supplier.gstin || '').trim().toUpperCase();
  const brief = (s, score) => ({ supplierId: s._id, name: s.name, gstin: s.gstin || '', score: round(score) });
  const byGst = gstin ? suppliers.filter((s) => s.gstin && s.gstin.toUpperCase() === gstin) : [];
  if (byGst.length === 1) return { status: 'exact', by: 'gstin', supplierId: byGst[0]._id, candidates: [brief(byGst[0], 1)] };
  const byName = suppliers.filter((s) => norm(s.name) && norm(s.name) === norm(supplier.name));
  if (byName.length === 1) return { status: 'exact', by: 'name', supplierId: byName[0]._id, candidates: [brief(byName[0], 1)] };
  const ranked = suppliers.map((s) => [s, similarity(supplier.name, s.name)]).filter(([, s]) => s >= POSSIBLE_MATCH).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return { status: ranked.length ? 'possible' : 'none', by: null, supplierId: null, candidates: ranked.map(([s, sc]) => brief(s, sc)) };
}

/* ------------------------------------------------------------------------------------------------ the review draft */

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const day = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').slice(0, 10));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : null; // a real calendar date: not the 30th of February
};
const text = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Cleans what was read (or typed) and matches it. Every line says what needs checking: a missing or odd number or date, a low confidence, a product that
 * was not matched exactly. `needsReview` is true unless the line is fully read AND matched exactly AND confident.
 */
export async function reviewDraft(orgId, raw = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const medicines = await Medicine.find({ organizationId: orgId, isActive: true }).select('medicineName sku barcode unit manufacturer gstPercentage').limit(5000).lean();
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 200).map((it) => {
    const quantity = num(it.quantity);
    const rate = num(it.rate);
    const mrp = num(it.mrp);
    const gst = num(it.gstPercent);
    const discount = num(it.discountPercent);
    const confidence = num(it.confidence);
    const mfg = day(it.manufacturingDate);
    const expiry = day(it.expiryDate);
    const issues = [];
    if (!text(it.name, 200)) issues.push('The product name is missing.');
    if (quantity === null || !Number.isInteger(quantity) || quantity < 1) issues.push('The quantity is missing or not a whole number.');
    if (rate === null || rate < 0) issues.push('The rate is missing or invalid.');
    if (gst === null || gst < 0 || gst > 100) issues.push('The GST percentage is missing or invalid.');
    if (discount !== null && (discount < 0 || discount > 100)) issues.push('The discount is not between 0 and 100.');
    if (it.expiryDate && !expiry) issues.push('The expiry date could not be read as a date.');
    if (expiry && expiry <= today) issues.push('The expiry date has already passed — expired stock cannot be accepted into inventory.');
    if (it.manufacturingDate && !mfg) issues.push('The manufacturing date could not be read as a date.');
    if (mfg && expiry && mfg >= expiry) issues.push('The manufacturing date is not before the expiry date.');
    if (mrp !== null && rate !== null && rate > mrp) issues.push('The purchase rate is higher than the MRP.');
    if (confidence !== null && confidence < LOW_CONFIDENCE) issues.push(`Low confidence (${Math.round(confidence * 100)}%).`);
    const match = matchProduct(it, medicines);
    if (match.status === 'possible') issues.push('Not an exact match — choose the right product from the suggestions.');
    if (match.status === 'none') issues.push('No matching product — choose one or remove the line.');
    const freeQuantity = num(it.freeQuantity);
    return {
      name: text(it.name, 200), sku: text(it.sku, 60), manufacturer: text(it.manufacturer, 120), batchNumber: text(it.batchNumber, 50), manufacturingDate: mfg, expiryDate: expiry,
      quantity: quantity !== null && Number.isInteger(quantity) && quantity > 0 ? quantity : null,
      freeQuantity: Number.isInteger(freeQuantity) && freeQuantity > 0 ? freeQuantity : 0,
      rate: rate !== null && rate >= 0 ? rate : null, mrp: mrp !== null && mrp >= 0 ? mrp : null,
      discountPercent: discount !== null && discount >= 0 && discount <= 100 ? discount : 0, gstPercent: gst !== null && gst >= 0 && gst <= 100 ? gst : null,
      amount: num(it.amount), confidence, match, issues, needsReview: issues.length > 0,
    };
  });
  const supplier = { name: text(raw.supplier?.name, 150), gstin: text(raw.supplier?.gstin, 20).toUpperCase(), phone: text(raw.supplier?.phone, 20), address: text(raw.supplier?.address, 300), match: await matchSupplier(orgId, raw.supplier) };

  // The invoice's totals, worked out from the lines we could read, beside what the invoice itself says.
  const t = raw.totals || {};
  const stated = { subtotal: num(t.subtotal), taxableAmount: num(t.taxableAmount), cgst: num(t.cgst), sgst: num(t.sgst), igst: num(t.igst), additionalCharges: num(t.additionalCharges), grandTotal: num(t.grandTotal) };
  const taxStated = [stated.cgst, stated.sgst, stated.igst].some((v) => v !== null) ? round((stated.cgst || 0) + (stated.sgst || 0) + (stated.igst || 0)) : null;
  const complete = items.filter((i) => i.quantity !== null && i.rate !== null);
  const calc = computeOrder({ items: complete.map((i) => ({ quantity: i.quantity, rate: i.rate, discountPercent: i.discountPercent, gstPercent: i.gstPercent ?? 0 })), charges: { other: stated.additionalCharges || 0 } });
  const difference = stated.grandTotal === null ? null : round(calc.grandTotal - stated.grandTotal);
  return {
    invoiceNo: text(raw.invoiceNo, 60), invoiceDate: day(raw.invoiceDate), supplier, items,
    totals: {
      subtotal: calc.subtotal, discount: calc.discount, taxable: round(calc.subtotal - calc.discount), gst: calc.gst, additionalCharges: calc.chargesTotal, grandTotal: calc.grandTotal,
      stated: { ...stated, tax: taxStated }, difference, matchesInvoice: difference === null ? null : Math.abs(difference) <= 1,
      taxDifference: taxStated === null ? null : round(calc.gst - taxStated),
    },
    confidence: num(raw.confidence), needsReview: true, // always: nothing from here is saved until a person has checked it
    summary: { lines: items.length, exact: items.filter((i) => i.match.status === 'exact').length, needAttention: items.filter((i) => i.needsReview).length },
  };
}
