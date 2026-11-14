import mongoose from 'mongoose';
import { GoodsReceipt, GoodsReceiptDraft, GoodsReceiptReversal, InvoiceExtraction, InvoiceUpload, Order, StockMovement, Supplier, SupplierInvoice } from '../../models/index.js';
import { hasPermission } from '../../config/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit.service.js';
import { matchSupplier } from '../aiBilling.service.js';
import { getExtraction } from '../invoiceAiExtractionService.js';
import { saveDraft } from '../invoiceUpload.service.js';
import { approveOrder, deleteOrder, getOrder, listOrders, markOrdered, submitOrder } from '../order.service.js';
import { assertMayUseBranch, orderScopeFilter } from '../orderAccess.js';
import { context, verifiedLines } from '../productMatching/productMatchingService.js';
import { getSupplier } from '../supplier.service.js';

/**
 * AI Billing -> purchasing. A verified supplier invoice becomes (or is linked to) an order in the EXISTING Orders module, and a SupplierInvoice record in the
 * purchase history. This file prepares and records; it never moves stock (that is the goods receipt, through the order module's receiving service) and never
 * records a payment. Every step refuses to go on while the invoice has unresolved errors, unconfirmed products or an unverified state.
 */
const fail = (status, message, code, details) => new ApiError(status, message, details, code);
export const invoiceKeyOf = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* ------------------------------------------------------------------------------------------------ the final review */

/** Has the person's verification been made for the invoice exactly as it stands now? (Any later correction or re-matching makes it stale.) */
const verificationValid = (ex) => Boolean(ex.finalReview?.verified && ex.finalReview.editCount === (ex.editCount || 0) && ex.finalReview.matchingRevision === (ex.matchingRevision || 0) && ex.finalReview.version === ex.version);

async function supplierChoice(orgId, ex) {
  const read = ex.current.supplier || {};
  const m = await matchSupplier(orgId, read);
  const chosen = ex.finalReview?.supplierId ? await Supplier.findOne({ _id: ex.finalReview.supplierId, organizationId: orgId }).select('name gstin phone email address isActive').lean() : null;
  const record = chosen || (m.status === 'exact' ? await Supplier.findOne({ _id: m.supplierId, organizationId: orgId }).select('name gstin phone email address isActive').lean() : null);
  return { read, record, suggested: m.status === 'exact', candidates: m.candidates || [] };
}

/**
 * Everything the final review page shows, and the checks that decide whether the invoice may go on to a purchase order and goods receipt. A check marked
 * `blocking` that fails keeps the invoice where it is; nothing here changes anything.
 */
export async function finalReview(req, id) {
  const { u, ex } = await context(req.orgId, id);
  const x = await getExtraction(req.orgId, id); // validation and duplicates are computed fresh
  const lines = await verifiedLines(req.orgId, id);
  const supplier = await supplierChoice(req.orgId, ex);
  const errors = x.validation.issues.filter((i) => i.severity === 'error');
  const warnings = x.validation.issues.filter((i) => i.severity === 'warning');
  const unresolved = lines.lines.filter((l) => l.matchingConfirmation !== 'confirmed' || !l.productId);
  const key = invoiceKeyOf(ex.current.invoice?.invoiceNumber);
  const existingInvoice = supplier.record && key ? await SupplierInvoice.findOne({ organizationId: req.orgId, 'supplier.supplierId': supplier.record._id, invoiceKey: key, uploadObjectId: { $ne: u._id } }).select('invoiceNumber orderNo status').lean() : null;
  const check = (k, label, ok, blocking, message) => ({ key: k, label, ok, blocking, message: ok ? undefined : message });
  const checks = [
    check('ocr', 'OCR extraction completed', Boolean(u.ocrSummary), true, 'Scan the invoice with OCR first.'),
    check('ai', 'AI extraction completed', true, true, ''),
    check('reviewed', 'Invoice reviewed by a person', ex.reviewStatus === 'reviewed', true, 'Check the extracted invoice against the document and mark it reviewed.'),
    check('invoiceNumber', 'Invoice number and date present', Boolean(ex.current.invoice?.invoiceNumber && ex.current.invoice?.invoiceDate), true, 'The invoice number and date are required.'),
    check('supplier', 'Supplier chosen from your suppliers', Boolean(supplier.record), true, 'Choose the supplier (or add them in Suppliers).'),
    check('validation', 'No unresolved validation errors', errors.length === 0, true, `${errors.length} validation error(s) remain: ${errors.slice(0, 3).map((e) => e.message).join(' ')}`),
    check('products', 'Every medicine is matched to a confirmed product', unresolved.length === 0 && lines.lines.length > 0, true, lines.lines.length ? `${unresolved.length} line(s) have no confirmed product.` : 'The invoice has no medicine lines.'),
    check('duplicate', 'Not a duplicate of a recorded supplier invoice', !existingInvoice || Boolean(ex.finalReview?.duplicateAcknowledged), true, existingInvoice ? `Invoice ${existingInvoice.invoiceNumber} from this supplier is already recorded (${existingInvoice.orderNo}). Open that purchase, or ask someone who can approve orders to record a legitimate repeat.` : ''),
    check('permission', 'You may create purchase orders and receive goods', hasPermission(req.user, 'inventory:write'), true, 'You do not have permission to receive goods.'),
    check('batches', 'Batch and expiry details present', lines.lines.every((l) => l.batchNumber && l.expiryDate), false, 'Some lines have no batch number or expiry date. They can only be received once those are entered.'),
    check('totals', 'No warnings on the figures', warnings.length === 0, false, `${warnings.length} warning(s) to look at.`),
  ];
  const verification = { verified: verificationValid(ex), stale: Boolean(ex.finalReview?.verified && !verificationValid(ex)), byName: ex.finalReview?.byName || null, at: ex.finalReview?.at || null };
  const prerequisites = checks.filter((c) => c.blocking).every((c) => c.ok);
  return {
    upload: { _id: u._id, uploadId: u.uploadId, fileName: u.fileName }, version: ex.version, supplier, invoice: ex.current.invoice, totals: ex.current.totals, lines: lines.lines, checks, issues: { errors, warnings },
    duplicates: x.duplicates, existingInvoice, ready: prerequisites, verification, purchase: ex.purchase || null, canProceed: prerequisites && verification.verified,
  };
}

/** The person's final verification: they confirm the invoice (as it is now) is right. Refused while any blocking check fails. */
export async function verifyInvoice(req, id, { confirmed, supplierId, acknowledgeDuplicate = false }) {
  if (!confirmed) throw fail(400, 'Confirm that you have verified the invoice before continuing.', 'VERIFY_NOT_CONFIRMED');
  const { u, ex } = await context(req.orgId, id, { forWrite: true });
  if (supplierId) {
    const s = mongoose.isValidObjectId(supplierId) ? await Supplier.findOne({ _id: supplierId, organizationId: req.orgId, isActive: true }).select('_id').lean() : null;
    if (!s) throw fail(404, 'Supplier not found', 'SUPPLIER_NOT_FOUND');
    await InvoiceExtraction.updateOne({ _id: ex._id, organizationId: req.orgId }, { $set: { 'finalReview.supplierId': s._id } });
  }
  if (acknowledgeDuplicate && !hasPermission(req.user, 'orders:approve')) throw fail(403, 'Only someone who can approve orders may record an invoice that already exists.', 'DUPLICATE_INVOICE_NOT_ALLOWED');
  if (acknowledgeDuplicate) await InvoiceExtraction.updateOne({ _id: ex._id, organizationId: req.orgId }, { $set: { 'finalReview.duplicateAcknowledged': true } });
  const r = await finalReview(req, id);
  const ex2 = await InvoiceExtraction.findOne({ _id: ex._id, organizationId: req.orgId }).lean();
  const blocked = r.checks.filter((c) => c.blocking && !c.ok);
  if (blocked.length) throw fail(409, `The invoice cannot be verified yet: ${blocked.map((c) => c.message).join(' ')}`, 'FINAL_REVIEW_BLOCKED', blocked);
  await InvoiceExtraction.updateOne(
    { _id: ex._id, organizationId: req.orgId },
    { $set: { finalReview: { verified: true, by: req.user._id, byName: req.user.name, at: new Date(), editCount: ex2.editCount || 0, matchingRevision: ex2.matchingRevision || 0, version: ex2.version, supplierId: ex2.finalReview?.supplierId || r.supplier.record._id, duplicateAcknowledged: Boolean(acknowledgeDuplicate || ex2.finalReview?.duplicateAcknowledged) } } },
  );
  await audit(req, { action: 'AI_INVOICE_VERIFIED', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId} (${ex.current.invoice.invoiceNumber}) verified by ${req.user.name} — nothing ordered or received yet` });
  return finalReview(req, id);
}

async function verifiedContext(req, id) {
  const { u, ex } = await context(req.orgId, id);
  if (!verificationValid(ex)) throw fail(409, ex.finalReview?.verified ? 'The invoice changed after it was verified. Verify it again.' : 'Verify the invoice in the final review first.', 'NOT_VERIFIED');
  const supplier = await Supplier.findOne({ _id: ex.finalReview.supplierId, organizationId: req.orgId }).select('name gstin').lean();
  if (!supplier) throw fail(409, 'The supplier chosen for this invoice no longer exists.', 'SUPPLIER_NOT_FOUND');
  return { u, ex, supplier };
}

/* ------------------------------------------------------------------------------------------------ order comparison */

/** Per product: what the order expects, what has arrived, what the invoice lists, what is still due, and the difference. */
export function compareWithOrder(order, lines) {
  const byMed = new Map();
  for (const l of lines) {
    const k = String(l.productId);
    const cur = byMed.get(k) || { paid: 0, free: 0, name: l.productName || l.invoiceMedicineName };
    byMed.set(k, { ...cur, paid: cur.paid + (l.quantity || 0), free: cur.free + (l.freeQuantity || 0) });
  }
  const rows = order.items.map((it) => {
    const inv = byMed.get(String(it.medicineId));
    const ordered = it.quantity + (it.freeQuantity || 0);
    const received = it.receivedQuantity || 0;
    const remaining = Math.max(0, ordered - received);
    const invoiceQty = inv ? inv.paid + inv.free : 0;
    byMed.delete(String(it.medicineId));
    return { medicineId: String(it.medicineId), name: it.name, orderedQuantity: ordered, orderedPaid: it.quantity, orderedFree: it.freeQuantity || 0, previouslyReceived: received, invoiceQuantity: invoiceQty, remainingQuantity: remaining, difference: invoiceQty - remaining, onInvoice: Boolean(inv) };
  });
  const notOnOrder = [...byMed.entries()].map(([id, v]) => ({ medicineId: id, name: v.name, invoiceQuantity: v.paid + v.free }));
  return { rows, notOnOrder, differences: rows.filter((r) => r.onInvoice && r.difference !== 0).length + notOnOrder.length };
}

/** Existing orders that could be this invoice's order: the supplier's open orders, or any order found by the search (order id, supplier, invoice number, PO number). */
export async function purchaseOrderOptions(req, id, { search = '' } = {}) {
  const { ex, supplier } = await verifiedContext(req, id);
  const lines = (await verifiedLines(req.orgId, id)).lines;
  const scope = orderScopeFilter(req.user);
  const found = await listOrders(req.orgId, { search: search || undefined, supplierId: search ? undefined : String(ex.finalReview.supplierId), page: 1, limit: 20 }, scope);
  const out = [];
  for (const o of found.items) {
    if (['cancelled'].includes(o.status) && !search) continue;
    const full = await getOrder(req.orgId, o._id);
    const cmp = compareWithOrder(full, lines);
    const sameSupplier = String(full.supplier?.supplierId) === String(ex.finalReview.supplierId);
    out.push({
      _id: full._id, orderNo: full.orderNo, status: full.status, statusLabel: full.statusLabel, supplier: full.supplier, referenceNo: full.referenceNo || '', orderDate: full.orderDate, grandTotal: full.grandTotal, branchName: full.branchName,
      sameSupplier, receivable: ['ordered', 'partially_received'].includes(full.status), linkable: sameSupplier && !['cancelled', 'received'].includes(full.status) && cmp.notOnOrder.length === 0, comparison: cmp,
      blockedBecause: !sameSupplier ? 'It belongs to a different supplier.' : full.status === 'cancelled' ? 'It is cancelled.' : full.status === 'received' ? 'It is already fully received.' : cmp.notOnOrder.length ? `The invoice lists ${cmp.notOnOrder.map((n) => n.name).join(', ')}, which is not on this order.` : undefined,
    });
  }
  return { supplier: { _id: supplier._id, name: supplier.name }, invoiceNumber: ex.current.invoice.invoiceNumber, orders: out, searched: search || null };
}

/* ------------------------------------------------------------------------------------------------ the supplier invoice record */

/** Records the verified invoice in the purchase history. Idempotent per upload; the unique index stops a second record of the same supplier invoice. */
async function recordSupplierInvoice(req, { u, ex, supplier }, order, { acknowledgeDuplicate }) {
  const mine = await SupplierInvoice.findOne({ organizationId: req.orgId, uploadObjectId: u._id });
  if (mine) return mine;
  const key = invoiceKeyOf(ex.current.invoice.invoiceNumber);
  const first = await SupplierInvoice.findOne({ organizationId: req.orgId, 'supplier.supplierId': supplier._id, invoiceKey: { $regex: `^${key}(#\\d+)?$` } }).sort({ createdAt: 1 }).lean();
  if (first) {
    if (!acknowledgeDuplicate) throw fail(409, `Invoice ${first.invoiceNumber} from ${supplier.name} is already recorded (${first.orderNo}). Open that purchase instead, or ask someone who can approve orders to record a legitimate repeat.`, 'DUPLICATE_SUPPLIER_INVOICE', [{ reference: first.orderNo, invoiceId: String(first._id) }]);
    if (!hasPermission(req.user, 'orders:approve')) throw fail(403, 'Only someone who can approve orders may record an invoice that already exists.', 'DUPLICATE_INVOICE_NOT_ALLOWED');
  }
  const count = first ? await SupplierInvoice.countDocuments({ organizationId: req.orgId, 'supplier.supplierId': supplier._id, invoiceKey: { $regex: `^${key}(#\\d+)?$` } }) : 0;
  const lines = (await verifiedLines(req.orgId, String(u._id))).lines;
  const rows = ex.current.items;
  const doc = {
    organizationId: req.orgId, supplier: { supplierId: supplier._id, name: supplier.name, gstin: supplier.gstin }, invoiceNumber: ex.current.invoice.invoiceNumber, invoiceKey: count ? `${key}#${count + 1}` : key, ...(first && { duplicateOf: first._id }),
    invoiceDate: ex.current.invoice.invoiceDate ? new Date(`${ex.current.invoice.invoiceDate}T00:00:00.000Z`) : undefined, invoiceType: ex.current.invoice.invoiceType || undefined, orderId: order._id, orderNo: order.orderNo,
    uploadObjectId: u._id, uploadId: u.uploadId, extractionVersion: ex.version, totals: ex.current.totals, calculatedTotal: order.grandTotal,
    items: lines.map((l, i) => ({ itemId: l.itemId, medicineId: l.productId, name: l.productName || l.invoiceMedicineName, batchNumber: l.batchNumber || undefined, manufacturingDate: l.manufacturingDate ? new Date(l.manufacturingDate) : undefined, expiryDate: l.expiryDate ? new Date(l.expiryDate) : undefined, invoiceQuantity: l.quantity ?? undefined, freeQuantity: l.freeQuantity ?? undefined, purchaseRate: l.purchaseRate ?? undefined, mrp: l.mrp ?? undefined, discountPercentage: rows[i]?.discountPercentage ?? undefined, gstPercentage: rows[i]?.gstPercentage ?? undefined, lineTotal: l.lineTotal ?? undefined })),
    paymentStatus: order.payment?.status || 'unpaid', createdBy: req.user._id, createdByName: req.user.name, verifiedBy: ex.finalReview.by, verifiedByName: ex.finalReview.byName, verifiedAt: ex.finalReview.at,
  };
  try {
    return await SupplierInvoice.create(doc);
  } catch (e) {
    if (e.code === 11000) throw fail(409, 'This supplier invoice was just recorded by someone else.', 'DUPLICATE_SUPPLIER_INVOICE');
    throw e;
  }
}

const markPurchase = (req, ex, data) => InvoiceExtraction.updateOne({ _id: ex._id, organizationId: req.orgId }, { $set: { purchase: { ...data, by: req.user._id, byName: req.user.name, at: new Date() } } });

/* ------------------------------------------------------------------------------------------------ create or link an order */

/** The order lines for a verified invoice: one per product (several batches of a medicine are summed; a different rate is averaged and flagged). */
export function orderItemsFrom(lines, rows) {
  const by = new Map();
  lines.forEach((l, i) => {
    const r = rows[i] || {};
    const cur = by.get(l.productId) || { medicineId: l.productId, quantity: 0, freeQuantity: 0, value: 0, rates: new Set(), disc: new Set(), gst: new Set() };
    cur.quantity += l.quantity || 0;
    cur.freeQuantity += l.freeQuantity || 0;
    cur.value += (l.quantity || 0) * (l.purchaseRate || 0);
    cur.rates.add(l.purchaseRate ?? 0);
    cur.disc.add(r.discountPercentage ?? 0);
    cur.gst.add(r.gstPercentage ?? 0);
    by.set(l.productId, cur);
  });
  const notes = [];
  const items = [...by.values()].map((c) => {
    if (c.rates.size > 1 || c.disc.size > 1 || c.gst.size > 1) notes.push('Batches of one product with different rates, discounts or GST were combined on one order line (averaged); each batch keeps its own price in the goods receipt.');
    return { medicineId: c.medicineId, quantity: c.quantity, freeQuantity: c.freeQuantity, rate: c.quantity ? Math.round((c.value / c.quantity) * 100) / 100 : [...c.rates][0] || 0, discountPercent: Math.max(...c.disc), gstPercent: Math.max(...c.gst) };
  });
  return { items, notes: [...new Set(notes)] };
}

/**
 * Option A: makes the purchase order from the verified invoice in the existing Orders module (a draft, or — for someone allowed to — taken on to "ordered" so goods
 * can be received), records the supplier invoice, and ties the two to this AI Billing invoice. Safely repeatable: the same invoice never makes a second order.
 */
export async function createPurchaseOrder(req, id, { branchId, expectedDate, status = 'draft', acknowledgeDuplicate: ackBody = false } = {}) {
  const vc = await verifiedContext(req, id);
  const { u, ex, supplier } = vc;
  const acknowledgeDuplicate = ackBody || Boolean(ex.finalReview?.duplicateAcknowledged); // acknowledged at the final review by someone who may approve orders
  if (ex.purchase?.orderId) return { replayed: true, purchase: ex.purchase, order: await getOrder(req.orgId, ex.purchase.orderId) };
  const r = await finalReview(req, id);
  if (!r.ready) throw fail(409, `The invoice cannot proceed: ${r.checks.filter((c) => c.blocking && !c.ok).map((c) => c.message).join(' ')}`, 'FINAL_REVIEW_BLOCKED');
  await assertMayUseBranch(req, branchId);
  const lines = r.lines;
  const { items, notes } = orderItemsFrom(lines, ex.current.items);
  const t = ex.current.totals || {};
  const charges = { shipping: t.shippingCharges || 0, packaging: t.packagingCharges || 0, other: t.otherCharges || 0 };
  const payload = {
    supplierId: String(supplier._id), ...(branchId && { branchId }), referenceNo: String(ex.current.invoice.invoiceNumber).slice(0, 60), orderDate: ex.current.invoice.invoiceDate || undefined, ...(expectedDate && { expectedDate }),
    notes: `Supplier invoice ${ex.current.invoice.invoiceNumber}${notes.length ? `. ${notes[0]}` : ''}`.slice(0, 480), items, charges, payment: { terms: 'credit', advance: 0 }, acknowledgeDuplicate: acknowledgeDuplicate || undefined,
    reviewed: { source: 'ai-billing', invoiceNumber: ex.current.invoice.invoiceNumber, verifiedBy: ex.finalReview.byName, statedGrandTotal: t.grandTotal ?? null },
  };
  // a repeat of this supplier's invoice number must stop BEFORE an order is made
  const key = invoiceKeyOf(ex.current.invoice.invoiceNumber);
  const dup = await SupplierInvoice.findOne({ organizationId: req.orgId, 'supplier.supplierId': supplier._id, invoiceKey: key, uploadObjectId: { $ne: u._id } }).lean();
  if (dup && !acknowledgeDuplicate) throw fail(409, `Invoice ${dup.invoiceNumber} from ${supplier.name} is already recorded (${dup.orderNo}).`, 'DUPLICATE_SUPPLIER_INVOICE', [{ reference: dup.orderNo }]);
  const saved = await saveDraft(req, id, payload);
  let order = saved.order;
  let invoice;
  try {
    invoice = await recordSupplierInvoice(req, vc, order, { acknowledgeDuplicate });
  } catch (e) {
    if (!saved.replayed && order.status === 'draft') await deleteOrder(req, order._id).catch(() => {}); // no order without its invoice record
    throw e;
  }
  await markPurchase(req, ex, { mode: 'created', orderId: order._id, orderNo: order.orderNo, supplierInvoiceId: invoice._id });
  // take it on to "ordered" only through the normal workflow, and only as far as this person is allowed to
  let note;
  if (status === 'ordered') {
    try {
      if (order.status === 'draft') await submitOrder(req, order._id);
      let cur = await getOrder(req.orgId, order._id);
      if (cur.status === 'pending') {
        if (!hasPermission(req.user, 'orders:approve')) note = 'The order is waiting for approval; it can be received once it is approved and marked as ordered.';
        else await approveOrder(req, order._id);
      }
      cur = await getOrder(req.orgId, order._id);
      if (cur.status === 'approved') await markOrdered(req, order._id);
    } catch (e) {
      note = e.message;
    }
    order = await getOrder(req.orgId, order._id);
  }
  await audit(req, { action: 'AI_PURCHASE_ORDER_CREATED', entity: 'InvoiceUpload', entityId: u._id, message: `Purchase order ${order.orderNo} made from verified invoice ${ex.current.invoice.invoiceNumber} (${supplier.name}); status ${order.status} — no stock changed` });
  return { replayed: false, purchase: { mode: 'created', orderId: order._id, orderNo: order.orderNo, supplierInvoiceId: invoice._id }, order, supplierInvoice: invoice.toObject(), note, difference: t.grandTotal != null ? Math.round((order.grandTotal - t.grandTotal) * 100) / 100 : null };
}

/**
 * Option B: links the verified invoice to an EXISTING order of the same supplier instead of creating a second one. The order is not changed. Differences from
 * what was ordered are shown first and must be acknowledged; a product the order does not contain blocks linking.
 */
export async function linkPurchaseOrder(req, id, { orderId, acknowledgeDifferences = false, acknowledgeDuplicate: ackBody = false }) {
  const vc = await verifiedContext(req, id);
  const { u, ex, supplier } = vc;
  const acknowledgeDuplicate = ackBody || Boolean(ex.finalReview?.duplicateAcknowledged);
  if (ex.purchase?.orderId) {
    if (String(ex.purchase.orderId) === String(orderId)) return { replayed: true, purchase: ex.purchase, order: await getOrder(req.orgId, orderId) };
    throw fail(409, `This invoice is already ${ex.purchase.mode === 'linked' ? 'linked to' : 'the source of'} ${ex.purchase.orderNo}.`, 'ALREADY_LINKED');
  }
  const r = await finalReview(req, id);
  if (!r.ready) throw fail(409, `The invoice cannot proceed: ${r.checks.filter((c) => c.blocking && !c.ok).map((c) => c.message).join(' ')}`, 'FINAL_REVIEW_BLOCKED');
  if (!mongoose.isValidObjectId(orderId)) throw fail(404, 'Order not found', 'ORDER_NOT_FOUND');
  const { assertOrderAccess } = await import('../orderAccess.js');
  await assertOrderAccess(req, orderId);
  const order = await getOrder(req.orgId, orderId);
  if (String(order.supplier?.supplierId) !== String(supplier._id)) throw fail(409, 'That order belongs to a different supplier.', 'SUPPLIER_MISMATCH');
  if (order.status === 'cancelled') throw fail(409, 'That order is cancelled, so goods cannot be received against it.', 'ORDER_CANCELLED');
  if (order.status === 'received') throw fail(409, 'That order is already fully received.', 'ORDER_STATE');
  const cmp = compareWithOrder(order, r.lines);
  if (cmp.notOnOrder.length) throw fail(409, `The invoice lists products that are not on ${order.orderNo}: ${cmp.notOnOrder.map((n) => n.name).join(', ')}. Link a different order, or add them to a new order.`, 'NOT_ON_ORDER', cmp.notOnOrder);
  if (cmp.differences > 0 && !acknowledgeDifferences) throw fail(409, `The invoice differs from ${order.orderNo} on ${cmp.differences} product(s). Review the comparison and acknowledge the differences to link it.`, 'ORDER_DIFFERS', cmp.rows.filter((x) => x.difference !== 0));
  const invoice = await recordSupplierInvoice(req, vc, order, { acknowledgeDuplicate });
  await markPurchase(req, ex, { mode: 'linked', orderId: order._id, orderNo: order.orderNo, supplierInvoiceId: invoice._id });
  await InvoiceUpload.updateOne({ _id: u._id, organizationId: req.orgId, orderId: { $exists: false } }, { $set: { orderId: order._id } });
  await audit(req, { action: 'AI_PURCHASE_ORDER_LINKED', entity: 'InvoiceUpload', entityId: u._id, message: `Verified invoice ${ex.current.invoice.invoiceNumber} linked to existing order ${order.orderNo} — the order was not changed` });
  return { replayed: false, purchase: { mode: 'linked', orderId: order._id, orderNo: order.orderNo, supplierInvoiceId: invoice._id }, order, comparison: cmp, supplierInvoice: invoice.toObject() };
}

/* ------------------------------------------------------------------------------------------------ purchase history */

/** Everything about one purchase (an order): the supplier invoices, the goods receipts (and any reversal), the stock entries each one made, and what is owed. */
export async function purchaseHistory(req, orderId) {
  const { assertOrderAccess } = await import('../orderAccess.js');
  await assertOrderAccess(req, orderId);
  const order = await getOrder(req.orgId, orderId);
  const oid = new mongoose.Types.ObjectId(orderId);
  const [invoices, receipts, reversals, drafts] = await Promise.all([
    SupplierInvoice.find({ organizationId: req.orgId, orderId: oid }).sort({ createdAt: 1 }).lean(),
    GoodsReceipt.find({ organizationId: req.orgId, orderId: oid }).sort({ receivedAt: 1 }).lean(),
    GoodsReceiptReversal.find({ organizationId: req.orgId, orderId: oid }).sort({ reversedAt: 1 }).lean(),
    GoodsReceiptDraft.find({ organizationId: req.orgId, orderId: oid }).sort({ createdAt: 1 }).select('draftNo status receiptNo createdByName createdAt').lean(),
  ]);
  const refIds = [...receipts.map((r) => r._id), ...reversals.map((r) => r._id)];
  const moves = refIds.length ? await StockMovement.find({ organizationId: req.orgId, refType: { $in: ['GoodsReceipt', 'GoodsReceiptReversal'] }, refId: { $in: refIds } }).sort({ createdAt: 1, _id: 1 }).lean() : [];
  const grn = new Map(receipts.map((r) => [String(r._id), r]));
  const stock = moves.map((m) => ({
    movementId: m._id, type: m.type, movementType: m.type === 'PURCHASE' ? 'PURCHASE_RECEIPT' : 'PURCHASE_RECEIPT_REVERSAL', medicineId: m.medicineId, batchId: m.batchId, branchId: m.branchId, previousQuantity: m.balanceAfter - m.quantity, quantityChange: m.quantity,
    newQuantity: m.balanceAfter, receiptId: m.refType === 'GoodsReceipt' ? m.refId : undefined, reversalId: m.refType === 'GoodsReceiptReversal' ? m.refId : undefined, supplierId: order.supplier?.supplierId, orderId: order._id, userId: m.createdBy, at: m.createdAt,
    rejectedQuantity: m.refType === 'GoodsReceipt' ? (grn.get(String(m.refId))?.items.find((l) => String(l.batchId) === String(m.batchId))?.rejectedQuantity ?? 0) : 0,
  }));
  const reversedIds = new Set(reversals.map((r) => String(r.receiptId)));
  const supplier = order.supplier?.supplierId ? await getSupplier(req.orgId, order.supplier.supplierId).catch(() => null) : null;
  return {
    order: { _id: order._id, orderNo: order.orderNo, status: order.status, statusLabel: order.statusLabel, supplier: order.supplier, referenceNo: order.referenceNo, grandTotal: order.grandTotal, payment: order.payment, items: order.items },
    supplierInvoices: invoices, receipts: receipts.map((r) => ({ ...r, reversed: reversedIds.has(String(r._id)), reversal: reversals.find((x) => String(x.receiptId) === String(r._id)) || null })), drafts, stock,
    account: { paymentStatus: order.payment?.status || 'unpaid', paid: order.payment?.paid ?? order.payment?.advance ?? 0, balance: order.payment?.balance ?? null, supplierOutstanding: supplier?.outstandingAmount ?? null, note: 'Payments are only recorded, never made, by this system.' },
  };
}
