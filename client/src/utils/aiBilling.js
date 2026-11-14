// The review step of AI Billing. A supplier invoice (read by a connected service, or typed in by hand) becomes a draft the user must check:
// products are matched to existing ones only when the match is exact (anything less is a suggestion the user confirms), nothing is saved
// until the user confirms, and stock is never touched here. The server checks everything again when the order is created.
import { computeOrder } from './orderForm.js';

export const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Why a chosen file can't be read (or '' when it can). */
export function fileProblem(file) {
  if (!file) return '';
  if (!FILE_TYPES.includes(file.type)) return 'Only PDF, PNG and JPEG files can be read.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_FILE_BYTES) return `That file is larger than ${MAX_FILE_BYTES / 1048576} MB.`;
  return '';
}
export const fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

let seq = 0;
const text = (v) => (v === null || v === undefined ? '' : String(v));

export const blankLine = () => ({ key: `l${++seq}`, name: '', sku: '', manufacturer: '', batchNumber: '', manufacturingDate: '', expiryDate: '', quantity: '', freeQuantity: '0', rate: '', mrp: '', discountPercent: '0', gstPercent: '', confidence: null, issues: [], match: { status: 'none', candidates: [] }, product: null });

/** A product the user (or an exact match) chose, in the shape the order form uses. */
export const productFrom = (c) => ({ _id: String(c.medicineId ?? c._id), name: c.name, unit: c.unit || '', sku: c.sku || '', gstPercent: c.gstPercent });

/** The review state from what the server read and matched. Exact matches are chosen already; nothing else is. */
export function reviewFromDraft(draft, source = 'ai') {
  const exact = draft.supplier?.match?.status === 'exact' ? draft.supplier.match.supplierId : '';
  return {
    source,
    invoiceNo: draft.invoiceNo || '',
    invoiceDate: draft.invoiceDate || '',
    supplier: { read: { name: draft.supplier?.name || '', gstin: draft.supplier?.gstin || '', phone: draft.supplier?.phone || '', address: draft.supplier?.address || '' }, match: draft.supplier?.match || { status: 'none', candidates: [] } },
    supplierId: exact ? String(exact) : '',
    lines: (draft.items || []).map((i) => ({
      key: `l${++seq}`, name: i.name, sku: i.sku || '', manufacturer: i.manufacturer || '', batchNumber: i.batchNumber || '', manufacturingDate: i.manufacturingDate || '', expiryDate: i.expiryDate || '',
      quantity: text(i.quantity), freeQuantity: text(i.freeQuantity ?? 0), rate: text(i.rate), mrp: text(i.mrp), discountPercent: text(i.discountPercent ?? 0), gstPercent: text(i.gstPercent),
      confidence: i.confidence, issues: i.issues || [], match: i.match, product: i.match?.status === 'exact' ? productFrom(i.match.candidates[0]) : null,
    })),
    statedTotal: draft.totals?.stated?.grandTotal ?? null,
    stated: draft.totals?.stated || {}, // what the invoice says: subtotal, taxable amount, CGST / SGST / IGST, additional charges, grand total
    additionalCharges: draft.totals?.stated?.additionalCharges ?? null,
    confidence: draft.confidence ?? null,
  };
}
export const blankReview = () => ({ source: 'manual', invoiceNo: '', invoiceDate: '', supplier: { read: { name: '', gstin: '', phone: '', address: '' }, match: { status: 'none', candidates: [] } }, supplierId: '', lines: [blankLine()], statedTotal: null, stated: {}, additionalCharges: null, confidence: null });

const isWhole = (v) => /^\d+$/.test(String(v).trim());
const isMoney = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());
const isPercent = (v) => isMoney(v) && Number(v) <= 100;

/** Where a line stands: ready, needs a product, or has numbers to fix. (Confidence is shown beside it, but only the checks below decide.) */
export function lineStatus(l) {
  if (!l.product) return 'needs-product';
  if (!isWhole(l.quantity) || Number(l.quantity) < 1 || !isMoney(l.rate) || !isPercent(l.gstPercent) || !isPercent(l.discountPercent) || !isWhole(l.freeQuantity)) return 'check-numbers';
  return 'ready';
}

const isRealDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

export function validateReview(r, { confirmed = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const e = {};
  if (!r.supplierId) e.supplierId = 'Choose the supplier — it is never picked for you unless it matches exactly.';
  if (!r.lines.length) e.lines = 'Add at least one product.';
  const seen = new Set();
  for (const l of r.lines) {
    const k = `line.${l.key}`;
    if (!l.product) e[`${k}.product`] = 'Choose the product this line is for.';
    else if (seen.has(l.product._id)) e[`${k}.product`] = `${l.product.name} is on the invoice twice. Combine the lines.`;
    else seen.add(l.product._id);
    if (!isWhole(l.quantity) || Number(l.quantity) < 1) e[`${k}.quantity`] = String(l.quantity).trim() === '' ? 'Enter the quantity.' : 'Use a whole number of at least 1.';
    if (!isMoney(l.rate)) e[`${k}.rate`] = String(l.rate).trim() === '' ? 'Enter the rate.' : 'Use a number with at most 2 decimals.';
    if (!isWhole(l.freeQuantity)) e[`${k}.freeQuantity`] = 'Use a whole number.';
    if (!isPercent(l.discountPercent)) e[`${k}.discountPercent`] = 'Enter 0 to 100.';
    if (!isPercent(l.gstPercent)) e[`${k}.gstPercent`] = String(l.gstPercent).trim() === '' ? 'Enter the GST percentage.' : 'Enter 0 to 100.';
    if (String(l.mrp).trim() !== '' && !isMoney(l.mrp)) e[`${k}.mrp`] = 'Use a number with at most 2 decimals.';
    if (l.batchNumber.length > 50) e[`${k}.batchNumber`] = 'Use 50 characters or fewer.';
    if (l.expiryDate && !isRealDay(l.expiryDate)) e[`${k}.expiryDate`] = 'That is not a real date.';
    else if (l.expiryDate && l.expiryDate <= today) e[`${k}.expiryDate`] = 'Already expired. Expired stock cannot be accepted into inventory.';
    if (l.manufacturingDate && !isRealDay(l.manufacturingDate)) e[`${k}.manufacturingDate`] = 'That is not a real date.';
    else if (l.manufacturingDate && l.manufacturingDate > today) e[`${k}.manufacturingDate`] = 'Cannot be in the future.';
    else if (l.manufacturingDate && l.expiryDate && l.manufacturingDate >= l.expiryDate) e[`${k}.manufacturingDate`] = 'Must be before the expiry date.';
  }
  if (r.invoiceNo.length > 60) e.invoiceNo = 'Use 60 characters or fewer.';
  if (!confirmed) e.confirmed = 'Confirm that you have checked these details against the invoice.';
  return e;
}

/** The invoice's totals from the lines as they stand now, beside what the invoice itself says. */
export function reviewTotals(r) {
  const items = r.lines.filter((l) => lineStatus(l) === 'ready').map((l) => ({ quantity: Number(l.quantity), freeQuantity: Number(l.freeQuantity), rate: Number(l.rate), discountPercent: Number(l.discountPercent), gstPercent: Number(l.gstPercent) }));
  const c = computeOrder({ items, charges: { other: Number(r.additionalCharges) || 0 } });
  const stated = r.statedTotal;
  const difference = stated === null || stated === undefined ? null : Math.round((c.grandTotal - stated) * 100) / 100;
  return { ...c, readyLines: items.length, stated: stated ?? null, difference, matchesInvoice: difference === null ? null : Math.abs(difference) <= 1 };
}

/** The request that creates the order: ids, quantities, rates and choices. The note says where it came from and who checked it. */
export function toDraftOrderPayload(r, { branchId, userName, status, idempotencyKey, today = new Date().toISOString().slice(0, 10) }) {
  const how = r.source === 'ai' ? 'read from the uploaded invoice and checked by' : 'entered from the invoice by';
  return {
    supplierId: r.supplierId,
    ...(branchId && { branchId }),
    orderDate: r.invoiceDate || today,
    referenceNo: r.invoiceNo.trim(),
    notes: `Supplier invoice${r.invoiceNo.trim() ? ` ${r.invoiceNo.trim()}` : ''} ${how} ${userName}.`,
    status,
    items: r.lines.map((l) => ({ medicineId: l.product._id, quantity: Number(l.quantity), freeQuantity: Number(l.freeQuantity), rate: Number(l.rate), discountPercent: Number(l.discountPercent), gstPercent: Number(l.gstPercent) })),
    charges: Number(r.additionalCharges) > 0 ? { other: Number(r.additionalCharges) } : {},
    payment: { terms: 'credit', advance: 0 },
    idempotencyKey,
  };
}

/** What the user checked, kept with the upload — including what an order does not hold (batch, dates, MRP) so goods receiving can use it later. */
export function reviewedSnapshot(r) {
  return {
    source: r.source,
    invoiceNo: r.invoiceNo,
    invoiceDate: r.invoiceDate,
    supplier: { read: r.supplier.read, supplierId: r.supplierId },
    lines: r.lines.map((l) => ({ name: l.name, productId: l.product?._id, manufacturer: l.manufacturer, batchNumber: l.batchNumber, manufacturingDate: l.manufacturingDate, expiryDate: l.expiryDate, quantity: Number(l.quantity), freeQuantity: Number(l.freeQuantity), rate: Number(l.rate), mrp: l.mrp === '' ? null : Number(l.mrp), discountPercent: Number(l.discountPercent), gstPercent: Number(l.gstPercent) })),
    stated: r.stated,
  };
}
