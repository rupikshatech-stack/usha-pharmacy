import mongoose from 'mongoose';
import {
  Batch, CANCELLABLE_ORDER_STATUSES, Counter, GoodsReceipt, GoodsReceiptReversal, Medicine, Order, ORDER_STATUS_LABEL, Organization, PAYMENT_METHODS, PAYMENT_STATUS_LABEL, PAYMENT_TERMS, PAYMENT_TERMS_LABEL,
  RECEIVABLE_ORDER_STATUSES, Supplier, User, nextSeq,
} from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { computeOrder } from '../utils/orderMath.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';
import { createBatchInTx } from './batch.service.js';
import { defaultBranchId, inBranch, requireActiveBranch } from './branch.service.js';
import { recordMovement } from './ledger.service.js';
import { listMedicines } from './medicine.service.js';
import { withTransaction } from './transaction.service.js';
import { issueNumber } from './documentNumbering.service.js';

/** The order's own fields under the names the API documents, beside the stored ones (so either can be used). */
const aliases = (o) => ({
  orderId: o.orderNo,
  supplierId: o.supplier?.supplierId,
  expectedDeliveryDate: o.expectedDate,
  orderStatus: o.status,
  taxAmount: o.gstTotal,
  discount: o.discountTotal,
  shippingCharges: o.charges?.shipping ?? 0,
  otherCharges: (o.charges?.packaging ?? 0) + (o.charges?.other ?? 0),
  paymentTerms: o.payment?.terms,
  paymentStatus: o.payment?.status,
  advancePayment: o.payment?.advance ?? 0,
  remainingAmount: o.payment?.remaining ?? 0,
});
/** An order line under the documented names, beside the stored ones. */
const itemAliases = (i) => ({
  ...i,
  productId: i.medicineId,
  orderedQuantity: i.quantity,
  receivedQuantity: i.receivedQuantity || 0,
  purchaseRate: i.rate,
  discount: i.discountAmount ?? 0,
  gstPercentage: i.gstPercent,
  totalAmount: i.total,
});

const present = ({ items, ...o }) => ({
  ...o,
  ...aliases(o),
  statusLabel: ORDER_STATUS_LABEL[o.status] || o.status,
  itemCount: items.length, // number of products on the order
  units: items.reduce((n, i) => n + i.quantity + (i.freeQuantity || 0), 0), // paid + free units expected
  receivedUnits: items.reduce((n, i) => n + (i.receivedQuantity || 0), 0), // units that have arrived (accepted + rejected + damaged)
  acceptedUnits: items.reduce((n, i) => n + (i.acceptedQuantity ?? i.receivedQuantity ?? 0), 0), // added to stock
  rejectedUnits: items.reduce((n, i) => n + (i.rejectedQuantity || 0) + (i.damagedQuantity || 0), 0),
  preview: items.slice(0, 2).map((i) => i.name),
  paymentStatusLabel: o.payment?.status ? PAYMENT_STATUS_LABEL[o.payment.status] : undefined,
});

/** Orders, newest first. `search` matches the order id, the supplier's name or any product on the order. */
export async function listOrders(orgId, { search, status, supplierId, branchId, paymentStatus, dateFrom, dateTo, overdue, page, limit }, scope = null) {
  const filter = { organizationId: orgId, ...(scope && { $and: [scope] }) }; // `scope` keeps a store-limited user to their stores' orders
  if (status) filter.status = status;
  if (supplierId) filter['supplier.supplierId'] = new mongoose.Types.ObjectId(supplierId);
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);
  if (paymentStatus) filter['payment.status'] = paymentStatus;
  if (dateFrom || dateTo) filter.orderDate = { ...(dateFrom && { $gte: new Date(`${dateFrom}T00:00:00.000Z`) }), ...(dateTo && { $lt: new Date(new Date(`${dateTo}T00:00:00.000Z`).getTime() + 86400000) }) };
  if (overdue) Object.assign(filter, { status: { $in: ['ordered', 'partially_received'] }, expectedDate: { $lt: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') } }); // expected before today and still not complete
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ orderNo: rx }, { 'supplier.name': rx }, { 'items.name': rx }, { referenceNo: rx }];
  }
  const [rows, total] = await Promise.all([
    Order.find(filter).sort({ orderDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return paginated(rows.map(present), { page, limit, total });
}

export async function getOrder(orgId, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new ApiError(404, 'Order not found');
  const o = await Order.findOne({ _id: id, organizationId: orgId }).lean();
  if (!o) throw new ApiError(404, 'Order not found');
  const branch = o.branchId ? await mongoose.model('Branch').findOne({ _id: o.branchId, organizationId: orgId }).select('name').lean() : null;
  const receipts = await GoodsReceipt.find({ organizationId: orgId, orderId: o._id }).sort({ receivedAt: 1, _id: 1 }).lean();
  const people = await User.find({ organizationId: orgId, _id: { $in: [o.createdBy, o.submittedBy, o.approvedBy, o.orderedBy, o.cancelledBy].filter(Boolean) } }, 'name').lean();
  const who = (uid) => people.find((u) => String(u._id) === String(uid))?.name;
  return {
    ...present(o), items: o.items.map(itemAliases), branchName: branch?.name, receipts, receivedHistory: receipts, history: o.history || [], approvedBy: o.approvedBy,
    createdByName: who(o.createdBy), submittedByName: who(o.submittedBy), approvedByName: who(o.approvedBy), orderedByName: who(o.orderedBy), cancelledByName: who(o.cancelledBy),
  };
}

/** The choices for the form, and what the next order number will be (a preview: it is only assigned when the order is saved). */
export async function orderMeta(orgId) {
  const c = await Counter.findOne({ organizationId: orgId, key: 'order' }).lean();
  const last = await Order.findOne({ organizationId: orgId }).sort({ createdAt: -1 }).select('orderNo').lean();
  const lastN = Number(/(\d+)$/.exec(last?.orderNo || '')?.[1] || 0);
  return {
    nextOrderNo: `ORD-${String(Math.max(c?.seq || 0, lastN) + 1).padStart(4, '0')}`,
    paymentTerms: PAYMENT_TERMS.map((value) => ({ value, label: PAYMENT_TERMS_LABEL[value] })),
    paymentMethods: PAYMENT_METHODS,
    paymentStatuses: Object.entries(PAYMENT_STATUS_LABEL).map(([value, label]) => ({ value, label })),
    gstRates: [0, 5, 12, 18, 28],
    statuses: Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label })),
  };
}

/**
 * Products for the order form: the existing inventory search (name, generic name, SKU, barcode, manufacturer, batch number …), with each
 * product's current stock, unit and GST, plus its latest purchase price and its current batches.
 */
export async function searchOrderProducts(orgId, { search = '', limit = 10 } = {}) {
  const { items } = await listMedicines(orgId, { search, page: 1, limit, sortBy: 'medicineName', sortDir: 'asc' });
  const ids = items.map((m) => m._id);
  const batches = await Batch.find({ organizationId: orgId, medicineId: { $in: ids }, status: { $ne: 'archived' } }).sort({ createdAt: -1 }).select('medicineId batchNumber expiryDate availableQuantity purchasePrice').lean();
  const by = new Map();
  for (const b of batches) (by.get(String(b.medicineId)) || by.set(String(b.medicineId), []).get(String(b.medicineId))).push(b);
  return items.map((m) => {
    const bs = by.get(String(m._id)) || [];
    return {
      _id: m._id,
      name: m.medicineName,
      sku: m.sku || m.barcode || '',
      genericName: m.genericName || '',
      manufacturer: m.manufacturer || '',
      category: m.categoryName || '',
      unit: m.unit || '',
      currentStock: m.availableStock ?? 0,
      gstPercent: m.gstPercentage ?? 12,
      purchasePrice: bs.find((b) => b.purchasePrice > 0)?.purchasePrice ?? 0, // from the most recently received batch that has one
      batches: bs.slice(0, 4).map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: b.availableQuantity, purchasePrice: b.purchasePrice })),
    };
  });
}

const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const bad = (path, message) => fail(400, message, 'ORDER_INVALID', [{ path, message }]);
const addressLine = (a = {}) => [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.pincode].filter(Boolean).join(', ');
const rupees = (n) => `₹${n.toFixed(2)}`;

/**
 * Checks everything about an order's content and works out its numbers: the supplier and store (this organization's, active), the dates, the
 * products (this organization's, active, each once), the arithmetic, the additional discount and the payment terms. Shared by creating and
 * editing, so both follow the same rules. Returns the fields to save (never taken from the client: totals, snapshots, payment status).
 */
async function prepareOrder(req, input, session) {
  const { supplierId, branchId, orderDate, expectedDate, referenceNo, notes, items, charges, payment } = input;
  const supplier = mongoose.isValidObjectId(supplierId) ? await Supplier.findOne({ _id: supplierId, organizationId: req.orgId }, null, { session }).lean() : null;
  if (!supplier) throw fail(404, 'Supplier not found', 'SUPPLIER_NOT_FOUND', [{ path: 'supplierId', message: 'Choose a supplier from the list' }]);
  if (!supplier.isActive) throw fail(409, `${supplier.name} is inactive`, 'SUPPLIER_INACTIVE', [{ path: 'supplierId', message: `${supplier.name} is inactive` }]);
  const branch = branchId ? await requireActiveBranch(req.orgId, branchId, session) : await requireActiveBranch(req.orgId, await defaultBranchId(req.orgId, session), session);

  const when = orderDate ? new Date(`${orderDate}T00:00:00.000Z`) : new Date();
  const due = expectedDate ? new Date(`${expectedDate}T00:00:00.000Z`) : undefined;
  if (due && due < new Date(`${when.toISOString().slice(0, 10)}T00:00:00.000Z`)) throw bad('expectedDate', 'The expected delivery date cannot be before the order date.');

  // Products: they must exist in this organization, active, and each appears once.
  const seen = new Set();
  const meds = new Map((await Medicine.find({ organizationId: req.orgId, _id: { $in: items.map((i) => i.medicineId) } }, null, { session }).lean()).map((m) => [String(m._id), m]));
  const categories = new Map();
  const catIds = [...meds.values()].map((m) => m.categoryId).filter(Boolean);
  if (catIds.length) for (const a of await mongoose.model('Attribute').find({ organizationId: req.orgId, _id: { $in: catIds } }, 'attributeName', { session }).lean()) categories.set(String(a._id), a.attributeName);
  for (const [n, it] of items.entries()) {
    const m = meds.get(String(it.medicineId));
    if (!m) throw bad(`items.${n}.medicineId`, 'That product was not found.');
    if (!m.isActive) throw bad(`items.${n}.medicineId`, `${m.medicineName} is archived and cannot be ordered.`);
    if (seen.has(String(m._id))) throw bad(`items.${n}.medicineId`, `${m.medicineName} is on the order twice. Change its quantity instead.`);
    seen.add(String(m._id));
  }

  const calc = computeOrder({ items, charges, advance: payment.advance });
  // Additional discount may not take the order below zero.
  if (calc._p.additionalDiscount > calc._p.beforeAdditionalDiscount) throw bad('charges.additionalDiscount', `The additional discount cannot be more than the order value before it (${rupees(calc.beforeAdditionalDiscount)}).`);
  // Payment: only recorded, but it must make sense with the agreed terms.
  if (calc._p.advance > calc._p.grandTotal) throw bad('payment.advance', `The advance payment cannot be more than the order total (${rupees(calc.grandTotal)}).`);
  if (['cod', 'credit'].includes(payment.terms) && calc._p.advance > 0) throw bad('payment.advance', `${PAYMENT_TERMS_LABEL[payment.terms]} orders have no advance payment. Choose Advance or Partial Payment terms instead.`);
  if (payment.terms === 'advance' && calc._p.advance <= 0) throw bad('payment.advance', 'Enter the advance payment amount.');
  if (payment.terms === 'partial' && !(calc._p.advance > 0 && calc._p.advance < calc._p.grandTotal)) throw bad('payment.advance', 'A partial payment must be more than 0 and less than the order total.');
  if (calc._p.advance > 0 && !payment.method) throw bad('payment.method', 'Choose how the advance payment was made.');

  const lines = items.map((it, n) => {
    const m = meds.get(String(it.medicineId));
    const l = calc.lines[n];
    return {
      medicineId: m._id, name: m.medicineName, sku: m.sku || m.barcode || undefined, genericName: m.genericName || undefined, manufacturer: m.manufacturer || undefined,
      category: categories.get(String(m.categoryId)), unit: m.unit || undefined,
      quantity: it.quantity, freeQuantity: it.freeQuantity || 0, rate: it.rate, discountPercent: it.discountPercent || 0, gstPercent: it.gstPercent || 0,
      amount: l.amount, discountAmount: l.discountAmount, gstAmount: l.gstAmount, total: l.total, receivedQuantity: 0,
    };
  });
  const fields = {
    supplier: { supplierId: supplier._id, name: supplier.name, contactPerson: supplier.contactPerson, phone: supplier.phone, email: supplier.email, address: addressLine(supplier.address), gstin: supplier.gstin },
    branchId: branch._id, referenceNo: referenceNo || undefined, items: lines, orderDate: when, expectedDate: due, notes: notes || undefined,
    totalItems: calc.totalItems, totalQuantity: calc.totalQuantity, totalFreeQuantity: calc.totalFreeQuantity, subtotal: calc.subtotal, discountTotal: calc.discount, gstTotal: calc.gst,
    charges: { shipping: calc.shipping, packaging: calc.packaging, other: calc.other, gstPercent: charges.gstPercent || 0, gstAmount: calc.chargesGst, additionalDiscount: calc.additionalDiscount },
    grandTotal: calc.grandTotal,
    payment: { terms: payment.terms, method: calc.advance > 0 ? payment.method : undefined, advance: calc.advance, remaining: calc.remaining, status: calc.paymentStatus },
  };
  return { fields, supplier, calc };
}

async function createOrderOnce(req, input) {
  const { idempotencyKey } = input;
  return withTransaction(async (session) => {
    // "Submit" sends it for approval when the organization requires that, otherwise it is authorized straight away; "draft" just saves it.
    const approvalRequired = (await getOrderSettings(req.orgId, session)).approvalRequired;
    const status = input.status === 'draft' ? 'draft' : approvalRequired ? 'pending' : 'approved';
    const nowT = new Date();
    const { fields, supplier, calc } = await prepareOrder(req, input, session);
    // The order number, from the organization's numbering settings (ORD-0001 by default, unchanged).
    const numberingOrg = await Organization.findById(req.orgId, 'settings timezone', { session }).lean();
    const orderNo = (await issueNumber({ orgId: req.orgId, org: numberingOrg, series: 'purchase', branchId: fields.branchId || null, session })).number;
    const [created] = await Order.create(
      [
        {
          organizationId: req.orgId, orderNo, ...fields, status,
          ...(status !== 'draft' && { submittedAt: nowT, submittedBy: req.user._id }), ...(status === 'approved' && { approvedAt: nowT }),
          history: [history(req, 'CREATED', undefined, status, status === 'draft' ? 'Saved as a draft' : status === 'pending' ? 'Submitted for approval' : 'Submitted (approval not required)')],
          ...(idempotencyKey && { idempotencyKey }), createdBy: req.user._id,
        },
      ],
      { session },
    );
    await audit(req, { action: 'ORDER_CREATE', entity: 'Order', entityId: created._id, message: `Order ${orderNo} ${status === 'draft' ? 'saved as a draft' : status === 'pending' ? 'submitted for approval' : 'approved'} with ${supplier.name} — ${calc.totalItems} product${calc.totalItems === 1 ? '' : 's'}, ${rupees(calc.grandTotal)}`, meta: { grandTotal: calc.grandTotal, status } }, session);
    return created.toObject();
  });
}

/**
 * Edits an order that is still a draft (an order that has been submitted must be sent back to draft first, so an approval never
 * covers contents that changed afterwards). The same checks and arithmetic as creating; the status, number, history and creator stay as they are.
 */
export async function updateOrder(req, id, input) {
  await withTransaction(async (session) => {
    const before = await loadOrder(req, id, session);
    if (before.status !== 'draft') throw wrongState(before, 'only a draft can be edited. An order that has been submitted must be sent back to draft first.');
    const { fields, calc } = await prepareOrder(req, input, session);
    const claimed = await Order.findOneAndUpdate(
      { _id: before._id, organizationId: req.orgId, status: 'draft' },
      { $set: fields, $push: { history: history(req, 'EDITED', 'draft', 'draft', 'Order details edited') } },
      { returnDocument: 'after', session },
    );
    if (!claimed) throw fail(409, 'This order was just handled by someone else. Reload it and check its status.', 'ORDER_STATE');
    await audit(req, { action: 'ORDER_EDIT', entity: 'Order', entityId: before._id, message: `Order ${before.orderNo} edited — ${calc.totalItems} product${calc.totalItems === 1 ? '' : 's'}, ${rupees(calc.grandTotal)}`, meta: { grandTotal: calc.grandTotal } }, session);
  });
  return getOrder(req.orgId, id);
}

const findByKey = (req, key) => Order.findOne({ organizationId: req.orgId, idempotencyKey: key }).lean();

/**
 * Creates an order. Safely repeatable: the same idempotencyKey returns the order already made. The totals are computed here from
 * the lines and charges (never taken from the client); payment is only recorded — no payment is ever made or started.
 * Returns { order, replayed }.
 */
export async function createOrder(req, input) {
  const key = input.idempotencyKey;
  if (key) {
    const existing = await findByKey(req, key);
    if (existing) return { order: existing, replayed: true };
  }
  try {
    return { order: await createOrderOnce(req, input), replayed: false };
  } catch (err) {
    if (key && err?.code === 11000) {
      const existing = await findByKey(req, key);
      if (existing) return { order: existing, replayed: true };
    }
    throw err;
  }
}


/* ------------------------------------------------------------------------------------------------ settings and the workflow */

export async function getOrderSettings(orgId, session) {
  const org = await Organization.findById(orgId, 'settings', session ? { session } : undefined).lean();
  return { approvalRequired: Boolean(org?.settings?.orderApprovalRequired) };
}
export async function updateOrderSettings(req, { approvalRequired }) {
  await Organization.updateOne({ _id: req.orgId }, { $set: { 'settings.orderApprovalRequired': approvalRequired } });
  await audit(req, { action: 'ORDER_SETTINGS', entity: 'Organization', entityId: req.orgId, message: `Order approval ${approvalRequired ? 'is now required' : 'is no longer required'}` });
  return getOrderSettings(req.orgId);
}

const history = (req, action, previousStatus, newStatus, note) => ({ action, at: new Date(), by: req.user._id, byName: req.user.name, previousStatus, newStatus, ...(note && { note }) });
const oidOk = (id) => mongoose.isValidObjectId(String(id));
const label = (st) => ORDER_STATUS_LABEL[st]?.toLowerCase() || st;

const loadOrder = async (req, id, session) => {
  if (!oidOk(id)) throw fail(404, 'Order not found');
  const o = await Order.findOne({ _id: id, organizationId: req.orgId }, null, session ? { session } : undefined).lean();
  if (!o) throw fail(404, 'Order not found');
  return o;
};
const wrongState = (o, what) => fail(409, `${o.orderNo} is ${label(o.status)}; ${what}`, 'ORDER_STATE', [{ path: 'status', message: `Order is ${o.status}` }]);

/**
 * Moves an order from one status to another with a compare-and-set, so two people acting at once cannot both succeed, and records it in the
 * order's history and the audit log. `from` lists the statuses the step is allowed from.
 */
async function step(req, id, { from, to, set = {}, action, note, what, audit: auditAction, message }) {
  const o = await loadOrder(req, id);
  if (!from.includes(o.status)) throw wrongState(o, what);
  const claimed = await Order.findOneAndUpdate(
    { _id: o._id, organizationId: req.orgId, status: o.status },
    { $set: { status: to, ...set }, $push: { history: history(req, action, o.status, to, note) } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw fail(409, 'This order was just handled by someone else. Reload it and check its status.', 'ORDER_STATE');
  await audit(req, { action: auditAction, entity: 'Order', entityId: o._id, message: message(o) });
  return getOrder(req.orgId, id);
}

/** draft → pending (when approval is required) or approved (when it is not). */
export async function submitOrder(req, id) {
  const { approvalRequired } = await getOrderSettings(req.orgId);
  const to = approvalRequired ? 'pending' : 'approved';
  return step(req, id, {
    from: ['draft'], to, action: 'SUBMITTED', what: 'only a draft can be submitted.', audit: 'ORDER_SUBMIT',
    set: { submittedAt: new Date(), submittedBy: req.user._id, ...(to === 'approved' && { approvedAt: new Date() }), rejectReason: undefined },
    note: approvalRequired ? 'Submitted for approval' : 'Submitted (approval not required)',
    message: (o) => `Order ${o.orderNo} ${approvalRequired ? 'submitted for approval' : 'approved'}`,
  });
}
/** pending → approved. */
export async function approveOrder(req, id) {
  return step(req, id, { from: ['pending'], to: 'approved', action: 'APPROVED', what: 'only an order waiting for approval can be approved.', audit: 'ORDER_APPROVE', set: { approvedAt: new Date(), approvedBy: req.user._id }, message: (o) => `Order ${o.orderNo} approved` });
}
/** pending → back to draft, with the reason. */
export async function rejectOrder(req, id, reason) {
  return step(req, id, { from: ['pending'], to: 'draft', action: 'REJECTED', note: reason, what: 'only an order waiting for approval can be sent back.', audit: 'ORDER_REJECT', set: { rejectReason: reason }, message: (o) => `Order ${o.orderNo} sent back to draft (${reason})` });
}
/** approved → ordered: it has been sent to the supplier. */
export async function markOrdered(req, id) {
  return step(req, id, { from: ['approved'], to: 'ordered', action: 'ORDERED', note: 'Sent to the supplier', what: 'only an approved order can be marked as ordered.', audit: 'ORDER_PLACE', set: { orderedAt: new Date(), orderedBy: req.user._id }, message: (o) => `Order ${o.orderNo} marked as ordered` });
}
/** Before anything has arrived. Once goods have been received an order can no longer be cancelled (the stock is already in). */
export async function cancelOrder(req, id, reason = '') {
  return step(req, id, { from: CANCELLABLE_ORDER_STATUSES, to: 'cancelled', action: 'CANCELLED', note: reason || undefined, what: 'it can no longer be cancelled.', audit: 'ORDER_CANCEL', set: { cancelledAt: new Date(), cancelledBy: req.user._id, ...(reason && { cancelReason: reason }) }, message: (o) => `Order ${o.orderNo} cancelled${reason ? ` (${reason})` : ''}` });
}

/* ------------------------------------------------------------------------------------------------ receiving goods */

// Where a line stands, also for lines made before receiving existed (their `receivedQuantity` counts paid units first).
const arrivedPaid = (l) => l.arrivedPaid ?? Math.min(l.receivedQuantity || 0, l.quantity);
const arrivedFree = (l) => l.arrivedFree ?? Math.max(0, (l.receivedQuantity || 0) - l.quantity);
const day = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00.000Z`) : undefined);
const sameDay = (a, b) => a && b && new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

/** What the goods received form needs: each line with ordered, previously received, remaining and the batch defaults (last prices, existing batches). */
export async function getReceivable(orgId, id) {
  const o = await getOrder(orgId, id);
  const meds = await Batch.find({ organizationId: orgId, medicineId: { $in: o.items.map((i) => i.medicineId) }, status: { $ne: 'archived' } }).sort({ createdAt: -1 }).select('medicineId batchNumber expiryDate mrp sellingPrice purchasePrice availableQuantity').lean();
  const by = new Map();
  for (const b of meds) (by.get(String(b.medicineId)) || by.set(String(b.medicineId), []).get(String(b.medicineId))).push(b);
  return {
    _id: o._id, orderNo: o.orderNo, status: o.status, statusLabel: o.statusLabel, supplier: o.supplier, branchName: o.branchName, branchId: o.branchId,
    receivable: RECEIVABLE_ORDER_STATUSES.includes(o.status),
    lines: o.items.map((l) => {
      const paidLeft = l.quantity - arrivedPaid(l);
      const freeLeft = (l.freeQuantity || 0) - arrivedFree(l);
      const bs = by.get(String(l.medicineId)) || [];
      const last = bs[0];
      return {
        medicineId: l.medicineId, name: l.name, unit: l.unit, sku: l.sku,
        orderedQuantity: l.quantity + (l.freeQuantity || 0), orderedPaid: l.quantity, orderedFree: l.freeQuantity || 0,
        previouslyReceived: l.receivedQuantity || 0, remainingQuantity: paidLeft + freeLeft, remainingPaid: paidLeft, remainingFree: freeLeft,
        rate: l.rate, mrp: last?.mrp, sellingPrice: last?.sellingPrice, // defaults for a new batch: the last batch's prices
        batches: bs.slice(0, 5).map((b) => ({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: b.availableQuantity })),
      };
    }),
  };
}

async function receiveOnce(req, id, input) {
  const { items, remarks = '', idempotencyKey } = input;
  return withTransaction(async (session) => {
    const order = await loadOrder(req, id, session);
    if (!RECEIVABLE_ORDER_STATUSES.includes(order.status)) {
      throw wrongState(order, ['draft', 'pending', 'approved'].includes(order.status) ? 'it has to be marked as ordered before goods can be received.' : 'nothing more can be received against it.');
    }
    const now = new Date();
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const branchId = order.branchId || (await defaultBranchId(req.orgId, session));
    await requireActiveBranch(req.orgId, branchId, session); // stock is not added to a branch that has been deactivated
    const branchFilter = inBranch(branchId, await defaultBranchId(req.orgId, session));
    const seen = new Set();
    const takenBy = new Map();
    const lines = [];

    for (const [n, it] of items.entries()) {
      const line = order.items.find((l) => String(l.medicineId) === String(it.medicineId));
      if (!line) throw bad(`items.${n}.medicineId`, 'That product is not on this order.');
      const batchKey = `${line.medicineId}|${(it.batchNumber || '').trim().toLowerCase()}`;
      if ((it.batchNumber || '').trim() && seen.has(batchKey)) throw bad(`items.${n}.batchNumber`, `Batch ${it.batchNumber.trim()} of ${line.name} is listed twice. Put its units on one line.`);
      seen.add(batchKey);
      // one medicine may arrive in several batches: the limits count everything already taken by the earlier lines of this receipt
      const taken = takenBy.get(String(line.medicineId)) || { paid: 0, free: 0 };
      const paidLeft = line.quantity - arrivedPaid(line) - taken.paid;
      const freeLeft = (line.freeQuantity || 0) - arrivedFree(line) - taken.free;
      takenBy.set(String(line.medicineId), { paid: taken.paid + (it.quantity || 0), free: taken.free + (it.freeQuantity || 0) });
      const q = it.quantity;
      const f = it.freeQuantity || 0;
      const arriving = q + f;
      if (arriving < 1) throw bad(`items.${n}.quantity`, `Enter how many units of ${line.name} arrived.`);
      if (q > paidLeft) throw bad(`items.${n}.quantity`, `Only ${paidLeft} more unit${paidLeft === 1 ? '' : 's'} of ${line.name} ${paidLeft === 1 ? 'is' : 'are'} expected (ordered ${line.quantity}, already received ${arrivedPaid(line)}). More than ordered can't be received.`);
      if (f > freeLeft) throw bad(`items.${n}.freeQuantity`, `Only ${freeLeft} free unit${freeLeft === 1 ? '' : 's'} of ${line.name} ${freeLeft === 1 ? 'is' : 'are'} still expected.`);
      const rejected = it.rejectedQuantity || 0;
      const damaged = it.damagedQuantity || 0;
      if (rejected + damaged > arriving) throw bad(`items.${n}.rejectedQuantity`, `Rejected and damaged units (${rejected + damaged}) can't be more than the units that arrived (${arriving}).`);
      if (rejected + damaged > 0 && !it.remarks) throw bad(`items.${n}.remarks`, `Say why ${line.name} was rejected or damaged.`);
      const accepted = arriving - rejected - damaged;

      const out = {
        medicineId: line.medicineId, name: line.name, unit: line.unit, orderedQuantity: line.quantity + (line.freeQuantity || 0), previouslyReceived: line.receivedQuantity || 0,
        remainingBefore: paidLeft + freeLeft, quantity: q, freeQuantity: f, rejectedQuantity: rejected, damagedQuantity: damaged, acceptedQuantity: accepted,
        remainingAfter: paidLeft + freeLeft - arriving, remarks: it.remarks || undefined, rate: line.rate,
      };
      if (accepted > 0) {
        // Stock is only added for verified units: every accepted unit must be in a known batch with a valid, future expiry.
        const batchNumber = (it.batchNumber || '').trim();
        if (!batchNumber) throw bad(`items.${n}.batchNumber`, `Enter the batch number for ${line.name}.`);
        if (!it.expiryDate) throw bad(`items.${n}.expiryDate`, `Enter the expiry date for ${line.name}.`);
        const expiry = day(it.expiryDate);
        if (expiry <= today) throw bad(`items.${n}.expiryDate`, `${line.name} has already expired (or expires today). Expired stock can't be added to sellable inventory — record those units as rejected instead.`);
        const mfg = day(it.manufacturingDate);
        if (mfg && mfg > today) throw bad(`items.${n}.manufacturingDate`, 'The manufacturing date cannot be in the future.');
        if (mfg && mfg >= expiry) throw bad(`items.${n}.manufacturingDate`, 'The manufacturing date must be before the expiry date.');
        const price = it.purchasePrice ?? line.rate ?? 0;
        const existing = await Batch.findOne({ organizationId: req.orgId, medicineId: line.medicineId, batchNumber, ...branchFilter }, null, { session }).lean();
        if (existing) {
          if (existing.status !== 'active') throw bad(`items.${n}.batchNumber`, `Batch ${batchNumber} of ${line.name} is ${existing.status}, so no stock can be added to it.`);
          if (!sameDay(existing.expiryDate, expiry)) throw bad(`items.${n}.expiryDate`, `Batch ${batchNumber} of ${line.name} is already in stock with expiry ${existing.expiryDate.toISOString().slice(0, 10)}. A batch number has one expiry date.`);
        } else {
          let { mrp, sellingPrice } = it;
          if (mrp === undefined || sellingPrice === undefined) {
            const last = await Batch.findOne({ organizationId: req.orgId, medicineId: line.medicineId }, 'mrp sellingPrice', { session }).sort({ createdAt: -1 }).lean();
            mrp ??= last?.mrp;
            sellingPrice ??= last?.sellingPrice;
          }
          if (mrp === undefined) throw bad(`items.${n}.mrp`, `Enter the MRP for the new batch ${batchNumber} of ${line.name}.`);
          if (sellingPrice === undefined) throw bad(`items.${n}.sellingPrice`, `Enter the selling price for the new batch ${batchNumber} of ${line.name}.`);
          if (sellingPrice > mrp) throw bad(`items.${n}.sellingPrice`, 'The selling price cannot be more than the MRP.');
          out.mrp = mrp;
          out.sellingPrice = sellingPrice;
        }
        Object.assign(out, { batchNumber, expiryDate: expiry, manufacturingDate: mfg, purchasePrice: price, existingBatchId: existing?._id });
      } else if (it.batchNumber) {
        out.batchNumber = it.batchNumber.trim();
      }
      lines.push(out);
    }

    // Guarded, atomic claim on the order lines: it only applies if, at this instant, every line still expects that many units. Two receipts
    // racing for the same units cannot both succeed, and nothing more than ordered can ever be received.
    const paidArrived = { $ifNull: ['$$it.arrivedPaid', { $min: [{ $ifNull: ['$$it.receivedQuantity', 0] }, '$$it.quantity'] }] };
    const freeArrived = { $ifNull: ['$$it.arrivedFree', { $max: [0, { $subtract: [{ $ifNull: ['$$it.receivedQuantity', 0] }, '$$it.quantity'] }] }] };
    const matches = (l) => ({ $eq: ['$$it.medicineId', l.medicineId] });
    const sumFor = (pick) => ({ $sum: lines.map((l) => ({ $cond: [matches(l), pick(l), 0] })) });
    const perMedicine = [...takenBy.entries()].map(([m, t]) => ({ medicineId: lines.find((l) => String(l.medicineId) === m).medicineId, quantity: t.paid, freeQuantity: t.free }));
    const guards = perMedicine.map((l) => ({
      $expr: { $gt: [{ $size: { $filter: { input: '$items', as: 'it', cond: { $and: [matches(l), { $gte: [{ $subtract: ['$$it.quantity', paidArrived] }, l.quantity] }, { $gte: [{ $subtract: [{ $ifNull: ['$$it.freeQuantity', 0] }, freeArrived] }, l.freeQuantity] }] } } } }, 0] },
    }));
    const claimed = await Order.updateOne({ _id: order._id, organizationId: req.orgId, status: { $in: RECEIVABLE_ORDER_STATUSES }, $and: guards }, [
      {
        $set: {
          items: {
            $map: {
              input: '$items', as: 'it',
              in: {
                $let: {
                  vars: { q: sumFor((l) => l.quantity), f: sumFor((l) => l.freeQuantity), a: sumFor((l) => l.acceptedQuantity), r: sumFor((l) => l.rejectedQuantity), d: sumFor((l) => l.damagedQuantity) },
                  in: {
                    $mergeObjects: ['$$it', {
                      arrivedPaid: { $add: [paidArrived, '$$q'] }, arrivedFree: { $add: [freeArrived, '$$f'] },
                      receivedQuantity: { $add: [{ $ifNull: ['$$it.receivedQuantity', 0] }, '$$q', '$$f'] },
                      acceptedQuantity: { $add: [{ $ifNull: ['$$it.acceptedQuantity', 0] }, '$$a'] },
                      rejectedQuantity: { $add: [{ $ifNull: ['$$it.rejectedQuantity', 0] }, '$$r'] },
                      damagedQuantity: { $add: [{ $ifNull: ['$$it.damagedQuantity', 0] }, '$$d'] },
                    }],
                  },
                },
              },
            },
          },
        },
      },
    ], { session, updatePipeline: true });
    if (claimed.matchedCount !== 1) throw fail(409, 'Some of these units were just received by someone else. Reload the order and try again.', 'RECEIPT_CONFLICT');

    // Stock: accepted units go into their batch (new, or the existing batch of that number), with a PURCHASE ledger entry — through the existing stock module.
    const receiptId = new mongoose.Types.ObjectId();
    const receiptNo = `GRN-${String(await nextSeq(req.orgId, 'goodsReceipt', session)).padStart(4, '0')}`;
    const reason = `Goods received ${receiptNo} for order ${order.orderNo}`;
    for (const l of lines) {
      if (l.acceptedQuantity <= 0) continue;
      const medicine = await Medicine.findOne({ _id: l.medicineId, organizationId: req.orgId }, null, { session }).lean();
      if (!medicine) throw fail(404, `${l.name} no longer exists`, 'MEDICINE_NOT_FOUND');
      if (!medicine.isActive) throw fail(409, `${l.name} is archived. Reactivate it before receiving stock.`, 'MEDICINE_INACTIVE');
      if (l.existingBatchId) {
        const updated = await Batch.findOneAndUpdate({ _id: l.existingBatchId, organizationId: req.orgId, status: 'active' }, { $inc: { availableQuantity: l.acceptedQuantity } }, { returnDocument: 'after', session });
        if (!updated) throw bad('items', `Batch ${l.batchNumber} of ${l.name} is no longer active, so stock can't be added to it.`);
        await recordMovement(req, session, { medicineId: l.medicineId, batchId: updated._id, type: 'PURCHASE', quantity: l.acceptedQuantity, balanceAfter: updated.availableQuantity, reason, refType: 'GoodsReceipt', refId: receiptId, branchId });
        l.batchId = updated._id;
        l.balanceAfter = updated.availableQuantity;
      } else {
        const batch = await createBatchInTx(req, medicine, {
          batchNumber: l.batchNumber, manufacturingDate: l.manufacturingDate, expiryDate: l.expiryDate, purchasePrice: l.purchasePrice, sellingPrice: l.sellingPrice, mrp: l.mrp,
          initialQuantity: l.acceptedQuantity, branchId, supplierId: order.supplier?.supplierId, ledger: { reason, refType: 'GoodsReceipt', refId: receiptId },
        }, session);
        l.batchId = batch._id;
        l.newBatch = true;
        l.balanceAfter = batch.availableQuantity;
      }
    }

    const after = await Order.findOne({ _id: order._id, organizationId: req.orgId }, null, { session }).lean();
    const complete = after.items.every((l) => (l.receivedQuantity || 0) >= l.quantity + (l.freeQuantity || 0));
    const status = complete ? 'received' : 'partially_received';
    const total = (k) => lines.reduce((n, l) => n + l[k], 0);
    const arrived = total('quantity') + total('freeQuantity');
    const [created] = await GoodsReceipt.create([{
      _id: receiptId, organizationId: req.orgId, receiptNo, orderId: order._id, orderNo: order.orderNo, supplier: { supplierId: order.supplier?.supplierId, name: order.supplier?.name }, branchId,
      items: lines.map(({ existingBatchId, rate, ...l }) => l), totalArrived: arrived, totalAccepted: total('acceptedQuantity'), totalRejected: total('rejectedQuantity'), totalDamaged: total('damagedQuantity'),
      remarks, ...(idempotencyKey && { idempotencyKey }), ...(input.meta && { ...input.meta }), receivedBy: req.user._id, receivedByName: req.user.name, receivedAt: now,
    }], { session });
    await Order.updateOne({ _id: order._id, organizationId: req.orgId }, {
      $set: { status, ...(complete && { receivedAt: now }) },
      $push: { history: history(req, 'RECEIVED', order.status, status, `${receiptNo}: ${arrived} unit${arrived === 1 ? '' : 's'} arrived, ${total('acceptedQuantity')} added to stock${total('rejectedQuantity') + total('damagedQuantity') ? `, ${total('rejectedQuantity') + total('damagedQuantity')} rejected or damaged` : ''}`) },
    }, { session });
    await audit(req, {
      action: 'ORDER_RECEIVE', entity: 'Order', entityId: order._id,
      message: `Goods received ${receiptNo} for ${order.orderNo} — ${total('acceptedQuantity')} unit${total('acceptedQuantity') === 1 ? '' : 's'} added to stock${complete ? ' (order complete)' : ''}`,
      meta: { receiptNo, arrived, accepted: total('acceptedQuantity'), rejected: total('rejectedQuantity'), damaged: total('damagedQuantity'), status },
    }, session);
    // work that must succeed or fail together with the stock (the supplier invoice record, a draft receipt): same transaction
    if (input.afterReceipt) await input.afterReceipt(session, { order, receipt: created.toObject() });
    return created.toObject();
  });
}

const receiptByKey = (req, key) => GoodsReceipt.findOne({ organizationId: req.orgId, idempotencyKey: key }).lean();

/**
 * Takes a goods receipt back out (an authorized correction, e.g. the wrong invoice was received). Nothing is edited or deleted: for every batch the receipt
 * filled, the accepted units are removed by an OPPOSITE entry in the append-only stock ledger — and only if they are still on hand (units already sold,
 * transferred or reserved cannot be taken back, so stock never goes negative). The order's received counts and status are recalculated, and a permanent
 * reversal record is written. One transaction; a receipt can be reversed once. `afterReversal(session, ...)` lets the caller keep its own records consistent.
 */
export async function reverseReceipt(req, receiptId, { reason = '', idempotencyKey, afterReversal } = {}) {
  if (!oidOk(receiptId)) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
  if (String(reason).trim().length < 3) throw bad('reason', 'Give a reason for the reversal (at least 3 characters).');
  const already = await GoodsReceiptReversal.findOne({ organizationId: req.orgId, receiptId }).lean();
  if (already) {
    if (idempotencyKey && already.idempotencyKey === idempotencyKey) return { reversal: already, replayed: true, order: await getOrder(req.orgId, already.orderId) };
    throw fail(409, `${already.receiptNo} was already reversed.`, 'ALREADY_REVERSED');
  }
  try {
    return await withTransaction(async (session) => {
      const receipt = await GoodsReceipt.findOne({ _id: receiptId, organizationId: req.orgId }, null, { session }).lean();
      if (!receipt) throw fail(404, 'Goods receipt not found', 'RECEIPT_NOT_FOUND');
      const order = await loadOrder(req, receipt.orderId, session);
      if (order.status === 'cancelled') throw wrongState(order, 'a cancelled order has no receipts to reverse.');
      const reversalId = new mongoose.Types.ObjectId();
      const why = `Reversal of ${receipt.receiptNo}: ${String(reason).trim()}`;
      const out = [];
      for (const l of receipt.items) {
        if (!l.acceptedQuantity || !l.batchId) continue;
        const updated = await Batch.findOneAndUpdate(
          { _id: l.batchId, organizationId: req.orgId, $expr: { $gte: [{ $subtract: ['$availableQuantity', { $ifNull: ['$reservedQuantity', 0] }] }, l.acceptedQuantity] } },
          { $inc: { availableQuantity: -l.acceptedQuantity } }, { returnDocument: 'after', session },
        );
        if (!updated) {
          const now = await Batch.findOne({ _id: l.batchId, organizationId: req.orgId }, 'availableQuantity reservedQuantity batchNumber', { session }).lean();
          throw fail(409, `Batch ${l.batchNumber} of ${l.name} has only ${Math.max(0, (now?.availableQuantity || 0) - (now?.reservedQuantity || 0))} unit(s) free, but ${l.acceptedQuantity} must be taken back out. The rest have been sold, moved or reserved, so this receipt cannot be reversed.`, 'BATCH_STOCK_USED');
        }
        await recordMovement(req, session, { medicineId: l.medicineId, batchId: l.batchId, type: 'ADJUSTMENT', quantity: -l.acceptedQuantity, balanceAfter: updated.availableQuantity, reason: why, refType: 'GoodsReceiptReversal', refId: reversalId, branchId: receipt.branchId });
        out.push({ medicineId: l.medicineId, name: l.name, batchId: l.batchId, batchNumber: l.batchNumber, quantity: l.acceptedQuantity, balanceAfter: updated.availableQuantity, paid: l.quantity, free: l.freeQuantity, rejected: l.rejectedQuantity, damaged: l.damagedQuantity });
      }
      // the order takes the arrived units back: the counts go down by exactly what this receipt added
      const take = new Map();
      for (const l of receipt.items) {
        const c = take.get(String(l.medicineId)) || { paid: 0, free: 0, accepted: 0, rejected: 0, damaged: 0 };
        take.set(String(l.medicineId), { paid: c.paid + l.quantity, free: c.free + l.freeQuantity, accepted: c.accepted + l.acceptedQuantity, rejected: c.rejected + l.rejectedQuantity, damaged: c.damaged + l.damagedQuantity });
      }
      const items = order.items.map((it) => {
        const t = take.get(String(it.medicineId));
        if (!t) return it;
        const next = {
          ...it, arrivedPaid: arrivedPaid(it) - t.paid, arrivedFree: arrivedFree(it) - t.free, receivedQuantity: (it.receivedQuantity || 0) - t.paid - t.free, acceptedQuantity: (it.acceptedQuantity || 0) - t.accepted,
          rejectedQuantity: (it.rejectedQuantity || 0) - t.rejected, damagedQuantity: (it.damagedQuantity || 0) - t.damaged,
        };
        if ([next.arrivedPaid, next.arrivedFree, next.receivedQuantity, next.acceptedQuantity, next.rejectedQuantity, next.damagedQuantity].some((n) => n < 0)) throw fail(409, `The order's received counts for ${it.name} no longer add up, so ${receipt.receiptNo} cannot be reversed automatically.`, 'ORDER_COUNTS');
        return next;
      });
      const status = items.every((l) => (l.receivedQuantity || 0) === 0) ? 'ordered' : 'partially_received';
      const total = out.reduce((n, l) => n + l.quantity, 0);
      await Order.updateOne({ _id: order._id, organizationId: req.orgId }, {
        $set: { items, status }, $unset: { receivedAt: 1 },
        $push: { history: history(req, 'RECEIPT_REVERSED', order.status, status, `${receipt.receiptNo} reversed: ${total} unit${total === 1 ? '' : 's'} taken back out of stock (${String(reason).trim()})`) },
      }, { session });
      const [reversal] = await GoodsReceiptReversal.create([{ _id: reversalId, organizationId: req.orgId, receiptId: receipt._id, receiptNo: receipt.receiptNo, orderId: order._id, orderNo: order.orderNo, reason: String(reason).trim(), lines: out, totalRemoved: total, ...(idempotencyKey && { idempotencyKey }), reversedBy: req.user._id, reversedByName: req.user.name, reversedAt: new Date() }], { session });
      await audit(req, { action: 'ORDER_RECEIPT_REVERSE', entity: 'Order', entityId: order._id, message: `Goods received ${receipt.receiptNo} reversed — ${total} unit${total === 1 ? '' : 's'} taken back out of stock (${String(reason).trim()})`, meta: { receiptNo: receipt.receiptNo, total, status } }, session);
      if (afterReversal) await afterReversal(session, { receipt, order, reversal: reversal.toObject() });
      return { reversal: reversal.toObject(), replayed: false };
    }).then(async (r) => ({ ...r, order: await getOrder(req.orgId, r.reversal.orderId) }));
  } catch (err) {
    if (err?.code === 11000) throw fail(409, 'This receipt was just reversed by someone else.', 'ALREADY_REVERSED');
    throw err;
  }
}

/**
 * Receives goods against an order, in full or in part. One transaction: it claims the units on the order lines (never more than were
 * ordered), adds ONLY the verified, accepted units to stock in their batch (new or existing, with the expiry and price captured), records
 * rejected / damaged units separately, writes the permanent goods received record, and moves the order to partially received or received.
 * Safely repeatable: the same idempotencyKey returns the original record. Returns { receipt, order, replayed }.
 */
export async function receiveOrder(req, id, input) {
  const key = input.idempotencyKey;
  const done = async (receipt, replayed) => ({ receipt, replayed, order: await getOrder(req.orgId, id) });
  if (key) {
    const existing = await receiptByKey(req, key);
    if (existing) return done(existing, true);
  }
  try {
    return await done(await receiveOnce(req, id, input), false);
  } catch (err) {
    if (key && err?.code === 11000) {
      const existing = await receiptByKey(req, key);
      if (existing) return done(existing, true);
    }
    throw err;
  }
}

/** The goods received history, newest first, optionally for one order. */
export async function listReceipts(orgId, { orderId, page = 1, limit = 20 } = {}, scope = null) {
  const filter = { organizationId: orgId, ...(orderId && { orderId: new mongoose.Types.ObjectId(orderId) }), ...(scope && { $and: [scope] }) };
  const [rows, total] = await Promise.all([GoodsReceipt.find(filter).sort({ receivedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), GoodsReceipt.countDocuments(filter)]);
  return paginated(rows, { page, limit, total });
}


/** Everything the printable order needs, assembled on the server from the stored records. */
export async function getOrderPrint(req, id) {
  const order = await getOrder(req.orgId, id);
  const org = await Organization.findById(req.orgId).select('name email phone address gstin').lean();
  const a = org?.address || {};
  return {
    organization: {
      name: org?.name || '', email: org?.email || '', phone: org?.phone || '', gstin: org?.gstin || '',
      address: [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.pincode].filter(Boolean).join(', '),
    },
    order,
    printedAt: new Date(),
    printedBy: { id: req.user?._id, name: req.user?.name },
  };
}


/* ------------------------------------------------------------------------------------------------ summary, delete, status */

/**
 * Figures for the orders page, counted from the database: orders by status, what is waiting for approval or for goods, what is overdue
 * (expected before today and not complete), the value of open orders, and what is still unpaid. Cancelled orders and drafts are not "committed"
 * money, so they are left out of the values. Whole paise, then rupees.
 */
export async function orderSummary(orgId, now = new Date(), scope = null) {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const committed = { $in: ['pending', 'approved', 'ordered', 'partially_received', 'received'] };
  const paise = { $round: [{ $multiply: ['$grandTotal', 100] }, 0] };
  const [r] = await Order.aggregate([
    { $match: { organizationId: orgId, ...(scope && { $and: [scope] }) } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 }, paise: { $sum: paise } } }],
        overdue: [{ $match: { status: { $in: ['ordered', 'partially_received'] }, expectedDate: { $lt: today } } }, { $count: 'n' }],
        unpaid: [{ $match: { status: committed, 'payment.status': { $in: ['unpaid', 'partially_paid'] } } }, { $group: { _id: null, n: { $sum: 1 }, paise: { $sum: { $round: [{ $multiply: [{ $ifNull: ['$payment.remaining', 0] }, 100] }, 0] } } } }],
        thisMonth: [{ $match: { status: committed, orderDate: { $gte: monthStart } } }, { $group: { _id: null, n: { $sum: 1 }, paise: { $sum: paise } } }],
      },
    },
  ]);
  const by = Object.fromEntries((r?.byStatus || []).map((x) => [x._id, x]));
  const count = (st) => by[st]?.count || 0;
  const value = (...sts) => sts.reduce((n, st) => n + (by[st]?.paise || 0), 0) / 100;
  const statuses = Object.fromEntries(Object.keys(ORDER_STATUS_LABEL).map((st) => [st, count(st)]));
  return {
    total: Object.values(statuses).reduce((a, b) => a + b, 0),
    byStatus: statuses,
    awaitingApproval: count('pending'),
    awaitingReceipt: count('ordered') + count('partially_received'), // sent to the supplier, goods still to come
    overdue: r?.overdue?.[0]?.n || 0,
    openValue: value('pending', 'approved', 'ordered', 'partially_received'), // committed, not yet complete
    receivedValue: value('received'),
    unpaidOrders: r?.unpaid?.[0]?.n || 0,
    unpaidAmount: (r?.unpaid?.[0]?.paise || 0) / 100,
    thisMonthOrders: r?.thisMonth?.[0]?.n || 0,
    thisMonthValue: (r?.thisMonth?.[0]?.paise || 0) / 100,
  };
}

/** Removes a draft order for good (anything that has been submitted can only be cancelled, so its history stays). The audit log keeps a record. */
export async function deleteOrder(req, id) {
  const o = await loadOrder(req, id);
  if (o.status !== 'draft') throw wrongState(o, 'only a draft can be deleted. Cancel an order that has been submitted.');
  const gone = await Order.deleteOne({ _id: o._id, organizationId: req.orgId, status: 'draft' });
  if (gone.deletedCount !== 1) throw fail(409, 'This order was just handled by someone else. Reload it and check its status.', 'ORDER_STATE');
  await audit(req, { action: 'ORDER_DELETE', entity: 'Order', entityId: o._id, message: `Draft order ${o.orderNo} deleted` });
}

/**
 * Moves an order to a status by name, through the same steps as the dedicated endpoints, so the same rules, permissions and history apply:
 *   pending/approved ← draft (submit)   approved ← pending (approve)   draft ← pending (send back, needs a reason)   ordered ← approved   cancelled ← any open
 * Received and partially received are never set by hand.
 */
export async function setOrderStatus(req, id, { status, reason }, can) {
  const o = await loadOrder(req, id);
  const need = (perm) => {
    if (!can(perm)) throw fail(403, 'You do not have permission to do that.', 'FORBIDDEN');
  };
  if (status === o.status) throw wrongState(o, `it is already ${label(status)}.`);
  if (status === 'cancelled') { need('inventory:write'); return cancelOrder(req, id, reason); }
  if (status === 'ordered') { need('inventory:write'); return markOrdered(req, id); }
  if (status === 'approved' && o.status === 'pending') { need('orders:approve'); return approveOrder(req, id); }
  if (status === 'draft' && o.status === 'pending') {
    need('orders:approve');
    if (reason.length < 3) throw bad('reason', 'Give a reason for sending the order back (at least 3 characters).');
    return rejectOrder(req, id, reason);
  }
  if (['pending', 'approved'].includes(status) && o.status === 'draft') {
    need('inventory:write');
    const submitted = await submitOrder(req, id);
    if (submitted.status !== status) throw fail(409, `${o.orderNo} was ${label(submitted.status)} on submission (that depends on whether orders need approval).`, 'ORDER_STATE', [{ path: 'status', message: `The order is now ${submitted.status}` }]);
    return submitted;
  }
  throw wrongState(o, `it cannot go from ${label(o.status)} to ${label(status)}. Received and partially received follow from receiving goods.`);
}
