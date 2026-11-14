import mongoose from 'mongoose';
import { GoodsReceipt, GoodsReceiptDraft, GoodsReceiptReversal, Order, StockMovement, SupplierInvoice, nextSeq } from '../../models/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { audit } from '../audit.service.js';
import { loadUpload } from '../invoiceUpload.service.js';
import { getOrder, getReceivable, receiveOrder, reverseReceipt } from '../order.service.js';
import { assertOrderAccess, orderScopeFilter } from '../orderAccess.js';
import { context, verifiedLines } from '../productMatching/productMatchingService.js';

/**
 * Goods receipts for AI Billing and the Orders module. A DRAFT is the working copy where the person enters what ACTUALLY arrived (never assumed equal to
 * the invoice), the accepted / rejected / damaged split, and the batch details. CONFIRMING hands the lines to the order module's single transactional
 * receiving service (order.service.receiveOrder): one transaction adds only the accepted units to stock, writes the append-only ledger entries and the
 * immutable GRN, updates the order, the supplier invoice record and this draft together — or none of it. Nothing here touches stock directly.
 */
const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const n0 = (v) => (v === null || v === undefined ? 0 : Number(v));
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const dateOf = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`) : undefined);
const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const batchKey = (medicineId, batch) => `${medicineId}|${String(batch || '').trim().toLowerCase()}`;

/** What a line comes to: units that arrived (paid + free), and the accepted ones that may enter sellable stock. */
export const lineFigures = (l) => {
  const arrived = n0(l.receivedQuantity) + n0(l.receivedFree);
  const accepted = Math.max(0, arrived - n0(l.rejectedQuantity) - n0(l.damagedQuantity));
  return { arrived, accepted };
};

/** Everything standing in the way of confirming this draft, line by line (empty = it can be confirmed). Pure: nothing is saved. */
export function problemsOf(draft, receivable) {
  const out = [];
  const add = (i, field, message) => out.push({ path: `items.${i}.${field}`, line: i + 1, field, message });
  const taken = new Map();
  let anyArrived = false;
  draft.items.forEach((l, i) => {
    if (l.receivedQuantity === null || l.receivedQuantity === undefined) return add(i, 'receivedQuantity', `Enter how many units of ${l.name} actually arrived (0 if none). It is never assumed to match the invoice.`);
    const free = l.receivedFree === null || l.receivedFree === undefined ? (n0(l.invoice?.freeQuantity) > 0 ? null : 0) : l.receivedFree;
    if (free === null) return add(i, 'receivedFree', `Enter how many free units of ${l.name} arrived (0 if none).`);
    const { arrived, accepted } = lineFigures({ ...l, receivedFree: free });
    if (arrived === 0) return undefined;
    anyArrived = true;
    if (n0(l.rejectedQuantity) + n0(l.damagedQuantity) > arrived) add(i, 'rejectedQuantity', `Rejected and damaged units (${n0(l.rejectedQuantity) + n0(l.damagedQuantity)}) cannot be more than the units that arrived (${arrived}).`);
    if (n0(l.rejectedQuantity) + n0(l.damagedQuantity) > 0 && !String(l.remarks || '').trim()) add(i, 'remarks', `Say why ${l.name} was rejected or damaged.`);
    const t = taken.get(String(l.medicineId)) || { paid: 0, free: 0 };
    taken.set(String(l.medicineId), { paid: t.paid + n0(l.receivedQuantity), free: t.free + free });
    if (accepted > 0) {
      if (!String(l.batchNumber || '').trim()) add(i, 'batchNumber', `Enter the batch number for ${l.name}: stock is only added for units in a known batch.`);
      if (!l.expiryDate) add(i, 'expiryDate', `Enter the expiry date for ${l.name}.`);
      else if (new Date(l.expiryDate) <= today()) add(i, 'expiryDate', `${l.name} has expired (or expires today). Expired medicine cannot enter sellable stock: record those units as rejected.`);
      if (l.manufacturingDate && l.expiryDate && new Date(l.manufacturingDate) >= new Date(l.expiryDate)) add(i, 'manufacturingDate', 'The manufacturing date must be before the expiry date.');
      if (l.manufacturingDate && new Date(l.manufacturingDate) > today()) add(i, 'manufacturingDate', 'The manufacturing date cannot be in the future.');
    }
  });
  if (receivable) {
    for (const [med, t] of taken) {
      const o = receivable.lines.find((x) => String(x.medicineId) === med);
      if (!o) out.push({ path: 'items', message: 'A product on this receipt is not on the order.' });
      else {
        if (t.paid > o.remainingPaid) out.push({ path: 'items', message: `${o.name}: ${t.paid} paid units entered but only ${o.remainingPaid} more are expected on the order (ordered ${o.orderedPaid}, already received ${o.previouslyReceived}).` });
        if (t.free > o.remainingFree) out.push({ path: 'items', message: `${o.name}: ${t.free} free units entered but only ${o.remainingFree} more are expected.` });
      }
    }
    if (!receivable.receivable) out.push({ path: 'order', message: `The order is ${receivable.status}; goods can only be received against an order that has been marked as ordered.` });
  }
  if (!anyArrived && !out.some((p) => p.field === 'receivedQuantity' || p.field === 'receivedFree')) out.push({ path: 'items', message: 'Nothing arrived. There is nothing to receive.' });
  return out;
}

const present = (d, receivable) => {
  const problems = d.status === 'draft' ? problemsOf(d, receivable) : [];
  const items = d.items.map((l) => ({ ...l, ...lineFigures(l), expiryDate: iso(l.expiryDate), manufacturingDate: iso(l.manufacturingDate) }));
  const sumOf = (k) => items.reduce((a, l) => a + n0(l[k]), 0);
  return {
    ...d, items, totals: { arrived: sumOf('arrived'), accepted: sumOf('accepted'), rejected: sumOf('rejectedQuantity'), damaged: sumOf('damagedQuantity'), invoiceQuantity: d.items.reduce((a, l) => a + n0(l.invoice?.quantity) + n0(l.invoice?.freeQuantity), 0) },
    receivable: receivable || undefined, problems, canConfirm: d.status === 'draft' && problems.length === 0,
  };
};

async function loadDraft(req, id) {
  if (!mongoose.isValidObjectId(String(id))) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
  const d = await GoodsReceiptDraft.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!d) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
  await assertOrderAccess(req, d.orderId);
  return d;
}

/* ------------------------------------------------------------------------------------------------ creating a draft */

const blankLine = (o, ol) => ({ medicineId: ol.medicineId, name: ol.name, unit: ol.unit, invoice: {}, receivedQuantity: null, receivedFree: null, rejectedQuantity: 0, damagedQuantity: 0, batchNumber: '', purchasePrice: ol.rate, remarks: '' });

/**
 * A draft goods receipt (POST /api/goods-receipts). From an AI Billing invoice (`uploadId`): the verified, product-confirmed lines of an invoice whose order was
 * created or linked, each with its invoice quantities, batch, expiry and prices — and the actually-received quantities left EMPTY. Or from an order alone
 * (`orderId`): one line per product still expected. Repeating the request returns the open draft instead of making another.
 */
export async function createDraft(req, { orderId, uploadId } = {}) {
  let upload;
  let ex;
  if (uploadId) {
    upload = await loadUpload(req.orgId, uploadId);
    ({ ex } = await context(req.orgId, uploadId));
    if (!ex.purchase?.orderId) throw fail(409, 'Create or link the purchase order for this invoice first.', 'NO_PURCHASE_ORDER');
    if (!ex.finalReview?.verified || ex.finalReview.editCount !== (ex.editCount || 0) || ex.finalReview.matchingRevision !== (ex.matchingRevision || 0)) throw fail(409, 'Verify the invoice in the final review first.', 'NOT_VERIFIED');
    orderId = orderId || String(ex.purchase.orderId);
    if (String(ex.purchase.orderId) !== String(orderId)) throw fail(409, `This invoice belongs to order ${ex.purchase.orderNo}.`, 'ORDER_MISMATCH');
  }
  if (!mongoose.isValidObjectId(String(orderId))) throw fail(400, 'Choose the order to receive against.', 'ORDER_REQUIRED');
  await assertOrderAccess(req, orderId);
  const order = await getOrder(req.orgId, orderId);
  if (['cancelled', 'received'].includes(order.status)) throw fail(409, `${order.orderNo} is ${order.statusLabel.toLowerCase()}; nothing more can be received against it.`, 'ORDER_STATE');
  const open = await GoodsReceiptDraft.findOne({ organizationId: req.orgId, orderId: order._id, status: 'draft', ...(upload ? { uploadObjectId: upload._id } : { uploadObjectId: { $exists: false } }) }).lean();
  if (open) return getDraft(req, open._id);
  let items;
  let invoiceRef = {};
  if (upload) {
    const v = (await verifiedLines(req.orgId, uploadId)).lines;
    const sInv = await SupplierInvoice.findOne({ organizationId: req.orgId, uploadObjectId: upload._id }).lean();
    invoiceRef = { supplierInvoiceId: sInv?._id, supplierInvoiceNumber: ex.current.invoice.invoiceNumber, supplierInvoiceDate: dateOf(ex.current.invoice.invoiceDate), uploadObjectId: upload._id, uploadId: upload.uploadId };
    items = v.map((l, i) => {
      const ol = order.items.find((x) => String(x.medicineId) === String(l.productId));
      if (!ol) throw fail(409, `${l.productName || l.invoiceMedicineName} is not on order ${order.orderNo}.`, 'NOT_ON_ORDER');
      const row = ex.current.items[i] || {};
      return {
        ...blankLine(order, ol), itemId: l.itemId, batchNumber: l.batchNumber || '', manufacturingDate: dateOf(l.manufacturingDate), expiryDate: dateOf(l.expiryDate), purchasePrice: l.purchaseRate ?? ol.rate, mrp: l.mrp ?? undefined,
        invoice: { quantity: l.quantity ?? null, freeQuantity: l.freeQuantity ?? null, batchNumber: l.batchNumber, manufacturingDate: l.manufacturingDate, expiryDate: l.expiryDate, mrp: l.mrp, purchaseRate: l.purchaseRate, discountPercentage: row.discountPercentage ?? null, gstPercentage: row.gstPercentage ?? null, lineTotal: l.lineTotal },
      };
    });
  } else {
    const rec = await getReceivable(req.orgId, orderId);
    items = rec.lines.filter((l) => l.remainingQuantity > 0).map((l) => ({ ...blankLine(order, order.items.find((x) => String(x.medicineId) === String(l.medicineId))), mrp: l.mrp, sellingPrice: l.sellingPrice }));
    if (!items.length) throw fail(409, 'Nothing is still expected on this order.', 'ORDER_STATE');
  }
  const draftNo = `GRD-${String(await nextSeq(req.orgId, 'goodsReceiptDraft')).padStart(4, '0')}`;
  let created;
  try {
    created = await GoodsReceiptDraft.create({
    organizationId: req.orgId, draftNo, orderId: order._id, orderNo: order.orderNo, supplier: { supplierId: order.supplier?.supplierId, name: order.supplier?.name }, branchId: order.branchId, ...invoiceRef, items, createdBy: req.user._id, createdByName: req.user.name,
  });
  } catch (e) {
    if (e.code === 11000 && upload) {
      const again = await GoodsReceiptDraft.findOne({ organizationId: req.orgId, uploadObjectId: upload._id, status: 'draft' }).lean(); // another request just made it
      if (again) return getDraft(req, again._id);
    }
    throw e;
  }
  await audit(req, { action: 'GRN_DRAFT_CREATE', entity: 'GoodsReceiptDraft', entityId: created._id, message: `Draft goods receipt ${draftNo} started for order ${order.orderNo}${upload ? ` from invoice ${invoiceRef.supplierInvoiceNumber}` : ''} — no stock changed` });
  return getDraft(req, created._id);
}

/* ------------------------------------------------------------------------------------------------ reading and editing */

export async function getDraft(req, id) {
  const d = await loadDraft(req, id);
  const receivable = await getReceivable(req.orgId, d.orderId);
  return present(d, receivable);
}

const EDITABLE = ['receivedQuantity', 'receivedFree', 'rejectedQuantity', 'damagedQuantity', 'batchNumber', 'manufacturingDate', 'expiryDate', 'purchasePrice', 'mrp', 'sellingPrice', 'remarks'];

/**
 * Updates a draft (PUT /api/goods-receipts/:id): the actual quantities, the accepted / rejected split and the batch details. The invoice's own figures on each
 * line never change. An extra line for the same product (a second batch) can be added; manually added lines can be removed by leaving them out.
 */
export async function updateDraft(req, id, { items, notes, expectedRevision }) {
  const d = await loadDraft(req, id);
  if (d.status !== 'draft') throw fail(409, `This goods receipt is ${d.status === 'confirmed' ? 'confirmed' : d.status}, so it can no longer be changed.`, 'RECEIPT_STATE');
  if (expectedRevision !== undefined && expectedRevision !== d.revision) throw fail(409, 'Someone else changed this goods receipt. Reload it and try again.', 'RECEIPT_CHANGED');
  const order = await getOrder(req.orgId, d.orderId);
  const byId = new Map(d.items.map((l) => [String(l._id), l]));
  const next = [];
  const seen = new Set();
  for (const sub of items || []) {
    const cur = sub._id ? byId.get(String(sub._id)) : null;
    if (sub._id && !cur) throw fail(400, 'A line of this goods receipt was not found.', 'LINE_NOT_FOUND', [{ path: 'items', message: 'Unknown line' }]);
    let line;
    if (cur) {
      seen.add(String(cur._id));
      line = { ...cur };
    } else {
      const ol = order.items.find((x) => String(x.medicineId) === String(sub.medicineId));
      if (!ol) throw fail(400, 'That product is not on this order.', 'NOT_ON_ORDER', [{ path: 'items', message: 'Not on the order' }]);
      line = blankLine(order, ol);
    }
    for (const k of EDITABLE) {
      if (sub[k] === undefined) continue;
      line[k] = k === 'manufacturingDate' || k === 'expiryDate' ? dateOf(sub[k]) : sub[k];
    }
    next.push(line);
  }
  // lines that came from the invoice always stay; manually added lines not mentioned are removed
  for (const l of d.items) if (!seen.has(String(l._id)) && l.itemId) next.push(l);
  const r = await GoodsReceiptDraft.findOneAndUpdate(
    { _id: d._id, organizationId: req.orgId, status: 'draft', revision: d.revision },
    { $set: { items: next, ...(notes !== undefined && { notes }), updatedByName: req.user.name }, $inc: { revision: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!r) throw fail(409, 'Someone else changed this goods receipt. Reload it and try again.', 'RECEIPT_CHANGED');
  return present(r, await getReceivable(req.orgId, r.orderId));
}

/* ------------------------------------------------------------------------------------------------ confirming */

const invoiceStatus = (receiptCount, complete) => (receiptCount === 0 ? 'verified' : complete ? 'received' : 'partially_received');

/** Keeps the supplier invoice record in step with a receipt, inside the same transaction: what was accepted / rejected per product and batch, the receipts, the status. */
async function applyToInvoice(req, session, receipt, sign) {
  const inv = await SupplierInvoice.findOne({ organizationId: req.orgId, orderId: receipt.orderId, ...(receipt.supplierInvoice?.invoiceId && { _id: receipt.supplierInvoice.invoiceId }) }, null, { session }).lean();
  if (!inv) return;
  const items = inv.items.map((i) => ({ ...i }));
  for (const l of receipt.items) {
    const hit = items.find((i) => batchKey(i.medicineId, i.batchNumber) === batchKey(l.medicineId, l.batchNumber)) || items.find((i) => String(i.medicineId) === String(l.medicineId) && !i.batchNumber);
    if (!hit) continue;
    hit.receivedQuantity = Math.max(0, n0(hit.receivedQuantity) + sign * (l.quantity + l.freeQuantity));
    hit.acceptedQuantity = Math.max(0, n0(hit.acceptedQuantity) + sign * l.acceptedQuantity);
    hit.rejectedQuantity = Math.max(0, n0(hit.rejectedQuantity) + sign * l.rejectedQuantity);
    hit.damagedQuantity = Math.max(0, n0(hit.damagedQuantity) + sign * l.damagedQuantity);
  }
  const ids = sign > 0 ? [...inv.receiptIds, receipt._id] : inv.receiptIds.filter((x) => String(x) !== String(receipt._id));
  const nos = sign > 0 ? [...inv.receiptNos, receipt.receiptNo] : inv.receiptNos.filter((x) => x !== receipt.receiptNo);
  const order = await Order.findOne({ _id: receipt.orderId, organizationId: req.orgId }, 'status payment', { session }).lean();
  await SupplierInvoice.updateOne({ _id: inv._id, organizationId: req.orgId }, { $set: { items, receiptIds: ids, receiptNos: nos, status: invoiceStatus(ids.length, order?.status === 'received'), paymentStatus: order?.payment?.status || inv.paymentStatus } }, { session });
}

/**
 * Confirms a draft goods receipt (POST /api/goods-receipts/:id/confirm): checks every line, then hands it to the order module's receiving service. Only accepted
 * units enter stock. Safely repeatable — confirming an already-confirmed draft returns its GRN and adds nothing; two confirmations at once make one.
 */
export async function confirmDraft(req, id, { confirmed } = {}) {
  if (!confirmed) throw fail(400, 'Confirm that the quantities are what actually arrived before stock is updated.', 'CONFIRM_REQUIRED');
  let d = await loadDraft(req, id);
  const replay = async (draft) => ({ replayed: true, draft: present(draft), receipt: await GoodsReceipt.findOne({ _id: draft.receiptId, organizationId: req.orgId }).lean(), order: await getOrder(req.orgId, draft.orderId) });
  if (d.status === 'confirmed') return replay(d);
  if (d.status === 'discarded') throw fail(409, 'This goods receipt was discarded.', 'RECEIPT_STATE');
  if (d.status === 'confirming') {
    const stale = Date.now() - new Date(d.updatedAt).getTime() > 2 * 60 * 1000; // a confirmation that died without a receipt is released
    if (!stale) throw fail(409, 'This goods receipt is being confirmed right now.', 'RECEIPT_IN_PROGRESS');
    const done = await GoodsReceipt.findOne({ organizationId: req.orgId, idempotencyKey: `grd-${d._id}` }).lean();
    if (!done) await GoodsReceiptDraft.updateOne({ _id: d._id, organizationId: req.orgId, status: 'confirming' }, { $set: { status: 'draft' } });
    d = await loadDraft(req, id);
    if (d.status === 'confirmed') return replay(d);
  }
  const receivable = await getReceivable(req.orgId, d.orderId);
  const problems = problemsOf(d, receivable);
  if (problems.length) throw fail(422, `This goods receipt cannot be confirmed yet: ${problems.slice(0, 3).map((p) => p.message).join(' ')}`, 'RECEIPT_INVALID', problems);
  const claimed = await GoodsReceiptDraft.findOneAndUpdate({ _id: d._id, organizationId: req.orgId, status: 'draft', revision: d.revision }, { $set: { status: 'confirming' } }, { returnDocument: 'after' }).lean();
  if (!claimed) {
    const now = await GoodsReceiptDraft.findOne({ _id: d._id, organizationId: req.orgId }).lean();
    if (now?.status === 'confirmed') return replay(now);
    throw fail(409, now?.status === 'confirming' ? 'This goods receipt is being confirmed right now.' : 'Someone changed this goods receipt. Reload it and check the quantities.', 'RECEIPT_CHANGED');
  }
  const items = d.items
    .filter((l) => lineFigures({ ...l, receivedFree: l.receivedFree ?? 0 }).arrived > 0)
    .map((l) => ({
      medicineId: String(l.medicineId), quantity: n0(l.receivedQuantity), freeQuantity: n0(l.receivedFree), rejectedQuantity: n0(l.rejectedQuantity), damagedQuantity: n0(l.damagedQuantity), batchNumber: l.batchNumber || '',
      manufacturingDate: iso(l.manufacturingDate) || undefined, expiryDate: iso(l.expiryDate) || undefined, purchasePrice: l.purchasePrice ?? undefined, mrp: l.mrp ?? undefined, sellingPrice: l.sellingPrice ?? undefined, remarks: l.remarks || undefined,
    }));
  try {
    const r = await receiveOrder(req, d.orderId, {
      items, remarks: d.notes, idempotencyKey: `grd-${d._id}`,
      meta: { ...(d.supplierInvoiceNumber && { supplierInvoice: { invoiceId: d.supplierInvoiceId, number: d.supplierInvoiceNumber, date: d.supplierInvoiceDate } }), draftId: d._id, ...(d.uploadId && { uploadId: d.uploadId }) },
      afterReceipt: async (session, { receipt }) => {
        await GoodsReceiptDraft.updateOne({ _id: d._id, organizationId: req.orgId }, { $set: { status: 'confirmed', receiptId: receipt._id, receiptNo: receipt.receiptNo, confirmedBy: req.user._id, confirmedByName: req.user.name, confirmedAt: new Date() } }, { session });
        await applyToInvoice(req, session, receipt, +1);
      },
    });
    const fresh = await GoodsReceiptDraft.findOne({ _id: d._id, organizationId: req.orgId }).lean();
    return { replayed: r.replayed, draft: present(fresh), receipt: r.receipt, order: r.order };
  } catch (e) {
    await GoodsReceiptDraft.updateOne({ _id: d._id, organizationId: req.orgId, status: 'confirming' }, { $set: { status: 'draft' } }); // nothing was received: the draft is editable again
    throw e;
  }
}

/** Reverses a confirmed goods receipt (POST /api/goods-receipts/:id/reverse). The order module does the stock work; this keeps the supplier invoice in step. */
export async function reverse(req, id, { reason, idempotencyKey }) {
  const receipt = await GoodsReceipt.findOne({ _id: id, organizationId: req.orgId }).select('orderId').lean();
  if (!receipt) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
  await assertOrderAccess(req, receipt.orderId);
  return reverseReceipt(req, id, { reason, idempotencyKey, afterReversal: (session, { receipt: r }) => applyToInvoice(req, session, r, -1) });
}

/* ------------------------------------------------------------------------------------------------ lists and details */

/** Goods receipts, newest first: `status` draft = drafts being prepared; otherwise confirmed receipts (with whether each was reversed). */
export async function listGoodsReceipts(req, { status, orderId, search, page = 1, limit = 20 }) {
  const scope = orderScopeFilter(req.user);
  const filter = { organizationId: req.orgId, ...(scope && { $and: [scope] }), ...(orderId && { orderId: new mongoose.Types.ObjectId(orderId) }) };
  if (status === 'draft' || status === 'confirming') {
    const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const f = { ...filter, status: { $in: ['draft', 'confirming'] }, ...(rx && { $or: [{ draftNo: rx }, { orderNo: rx }, { 'supplier.name': rx }, { supplierInvoiceNumber: rx }] }) };
    const [rows, total] = await Promise.all([GoodsReceiptDraft.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-items').lean(), GoodsReceiptDraft.countDocuments(f)]);
    return { items: rows.map((r) => ({ ...r, kind: 'draft' })), total, page, limit };
  }
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ receiptNo: rx }, { orderNo: rx }, { 'supplier.name': rx }, { 'supplierInvoice.number': rx }];
  }
  const reversedIds = (await GoodsReceiptReversal.find({ organizationId: req.orgId }).select('receiptId').lean()).map((r) => r.receiptId);
  if (status === 'reversed') filter._id = { $in: reversedIds };
  if (status === 'confirmed') filter._id = { $nin: reversedIds };
  const [rows, total] = await Promise.all([GoodsReceipt.find(filter).sort({ receivedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), GoodsReceipt.countDocuments(filter)]);
  const rev = new Set(reversedIds.map(String));
  return { items: rows.map((r) => ({ ...r, kind: 'receipt', reversed: rev.has(String(r._id)) })), total, page, limit };
}

/** One goods receipt: a draft (with what stops it being confirmed) or a confirmed GRN (with its reversal, supplier invoice and the stock entries it made). */
export async function getGoodsReceipt(req, id) {
  if (!mongoose.isValidObjectId(String(id))) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
  const grn = await GoodsReceipt.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!grn) return { kind: 'draft', ...(await getDraft(req, id)) };
  await assertOrderAccess(req, grn.orderId);
  const [reversal, invoice, moves] = await Promise.all([
    GoodsReceiptReversal.findOne({ organizationId: req.orgId, receiptId: grn._id }).lean(),
    grn.supplierInvoice?.invoiceId ? SupplierInvoice.findOne({ _id: grn.supplierInvoice.invoiceId, organizationId: req.orgId }).select('invoiceNumber invoiceDate status paymentStatus orderNo').lean() : null,
    StockMovement.find({ organizationId: req.orgId, refType: { $in: ['GoodsReceipt', 'GoodsReceiptReversal'] }, refId: { $in: [grn._id] } }).sort({ createdAt: 1 }).lean(),
  ]);
  const revMoves = reversal ? await StockMovement.find({ organizationId: req.orgId, refType: 'GoodsReceiptReversal', refId: reversal._id }).sort({ createdAt: 1 }).lean() : [];
  const trail = [...moves, ...revMoves].map((m) => ({ movementId: m._id, movementType: m.type === 'PURCHASE' ? 'PURCHASE_RECEIPT' : 'PURCHASE_RECEIPT_REVERSAL', medicineId: m.medicineId, batchId: m.batchId, branchId: m.branchId, previousQuantity: m.balanceAfter - m.quantity, quantity: m.quantity, newQuantity: m.balanceAfter, receiptId: grn._id, supplierId: grn.supplier?.supplierId, orderId: grn.orderId, userId: m.createdBy, at: m.createdAt }));
  return { kind: 'receipt', receipt: { ...grn, reversed: Boolean(reversal) }, reversal, supplierInvoice: invoice, stock: trail };
}

