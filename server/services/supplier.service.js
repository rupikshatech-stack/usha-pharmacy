import mongoose from 'mongoose';
import { Branch, GoodsReceipt, GoodsReceiptDraft, ORDER_STATUS_LABEL, Order, Supplier, SUPPLIER_PAYMENT_TERMS_LABEL, SUPPLIER_TYPE_LABEL, TERM_DAYS, nextSeq } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';

/**
 * What each supplier is owed, worked out from their orders (nothing is stored twice, so it cannot drift): the unpaid balance of every order that
 * is not a draft or cancelled, and how many of their orders are still open. There is no separate credit module yet.
 */
async function standing(orgId, ids) {
  if (!ids.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { organizationId: orgId, 'supplier.supplierId': { $in: ids }, status: { $in: ['pending', 'approved', 'ordered', 'partially_received', 'received'] } } },
    {
      $group: {
        _id: '$supplier.supplierId',
        orders: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', ['pending', 'approved', 'ordered', 'partially_received']] }, 1, 0] } },
        owedPaise: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $round: [{ $multiply: [{ $ifNull: ['$payment.remaining', 0] }, 100] }, 0] }] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), { totalOrders: r.orders, openOrders: r.open, outstandingAmount: r.owedPaise / 100 }]));
}
const withStanding = (s, st) => ({ ...s, totalOrders: st.get(String(s._id))?.totalOrders || 0, openOrders: st.get(String(s._id))?.openOrders || 0, outstandingAmount: st.get(String(s._id))?.outstandingAmount || 0 });

const present = (s) => ({
  ...s,
  // one line for lists and order snapshots: street, landmark, city/state, PIN. The country is a field of its own on the details screen, not part of this line.
  addressLine: [s.address?.line1, s.address?.line2, s.address?.landmark, [s.address?.city, s.address?.state].filter(Boolean).join(', '), s.address?.pincode].filter(Boolean).join(', '),
  typeLabel: SUPPLIER_TYPE_LABEL[s.supplierType] || '',
  paymentTermsLabel: SUPPLIER_PAYMENT_TERMS_LABEL[s.procurement?.paymentTerms] || '',
  // the days a term implies, so every screen says the same thing without working it out again
  creditDays: s.procurement?.paymentTerms === 'custom' ? Number(s.procurement?.creditPeriodDays || 0) : TERM_DAYS[s.procurement?.paymentTerms] ?? 0,
  status: s.isActive === false ? 'inactive' : 'active',
});

/**
 * Suppliers, a page at a time. Everything — searching, filtering, sorting and paging — happens in the database, so the page count and the totals are of the
 * whole set and not of what one page happens to hold. Without an explicit sort, preferred suppliers come first and then it is A to Z; asking for a sort
 * (company name, when it was added, when it was last changed, or type) uses that instead, with the name breaking ties so the order is never arbitrary.
 */
export async function listSuppliers(orgId, { search, active, type, preferred, sort, dir = 'asc', page, limit }) {
  const filter = { organizationId: orgId };
  if (active === 'inactive') filter.isActive = false;
  else if (active !== 'all') filter.isActive = true;
  if (type) filter.supplierType = type;
  if (preferred !== undefined) filter.isPreferred = preferred === true || preferred === 'true';
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { contactPerson: rx }, { phone: rx }, { email: rx }, { gstin: rx }];
  }
  const way = dir === 'desc' ? -1 : 1;
  // the tiebreaker must not be the sorted field itself, or it would quietly overwrite the direction that was asked for
  const order = sort ? { [sort]: way, ...(sort === 'name' ? {} : { name: 1 }), _id: 1 } : { isPreferred: -1, name: 1, _id: 1 };
  const [rows, total] = await Promise.all([
    Supplier.find(filter).collation({ locale: 'en', strength: 2 }).sort(order).skip((page - 1) * limit).limit(limit).lean(),
    Supplier.countDocuments(filter),
  ]);
  const st = await standing(orgId, rows.map((r) => r._id));
  return paginated(rows.map((r) => withStanding(present(r), st)), { page, limit, total });
}

/**
 * What buying from this supplier actually looks like, worked out from the orders and goods receipts themselves — never stored, so it cannot drift:
 * how many purchase orders, how much they came to, how many are still open, what is still owed, how many deliveries arrived and when the last one was.
 * Drafts and cancelled orders are left out of the money; they are not purchases.
 */
export async function supplierStats(orgId, supplierId) {
  const id = new mongoose.Types.ObjectId(String(supplierId));
  const counted = ['pending', 'approved', 'ordered', 'partially_received', 'received', 'completed'];
  const open = ['pending', 'approved', 'ordered', 'partially_received'];
  const [orders] = await Order.aggregate([
    { $match: { organizationId: orgId, 'supplier.supplierId': id, status: { $in: counted } } },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        openOrders: { $sum: { $cond: [{ $in: ['$status', open] }, 1, 0] } },
        amountPaise: { $sum: { $round: [{ $multiply: [{ $ifNull: ['$grandTotal', 0] }, 100] }, 0] } },
        owedPaise: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, { $round: [{ $multiply: [{ $ifNull: ['$payment.remaining', 0] }, 100] }, 0] }] } },
        lastOrderDate: { $max: '$orderDate' },
      },
    },
  ]);
  const [receipts] = await GoodsReceipt.aggregate([
    { $match: { organizationId: orgId, 'supplier.supplierId': id } },
    { $group: { _id: null, totalGoodsReceipts: { $sum: 1 }, lastReceiptDate: { $max: '$receivedAt' } } },
  ]);
  return {
    totalOrders: orders?.totalOrders || 0,
    openOrders: orders?.openOrders || 0,
    totalPurchaseAmount: (orders?.amountPaise || 0) / 100,
    outstandingAmount: (orders?.owedPaise || 0) / 100,
    totalGoodsReceipts: receipts?.totalGoodsReceipts || 0,
    lastOrderDate: orders?.lastOrderDate || null,
    lastPurchaseDate: receipts?.lastReceiptDate || orders?.lastOrderDate || null,
  };
}

export async function getSupplier(orgId, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new ApiError(404, 'Supplier not found');
  const s = await Supplier.findOne({ _id: id, organizationId: orgId }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');
  const [stats, branch] = await Promise.all([
    supplierStats(orgId, s._id),
    s.procurement?.defaultBranchId ? Branch.findOne({ _id: s.procurement.defaultBranchId, organizationId: orgId }, 'name').lean() : null,
  ]);
  return { ...present(s), ...stats, defaultBranchName: branch?.name || '' };
}

/** The next free supplier code for this organization (SUP-0001, SUP-0002 …). */
async function nextCode(orgId) {
  for (let i = 0; i < 5; i += 1) {
    const code = `SUP-${String(await nextSeq(orgId, 'supplier')).padStart(4, '0')}`;
    if (!(await Supplier.exists({ organizationId: orgId, code }))) return code; // a code typed by hand could already have taken this number
  }
  throw new ApiError(409, 'Could not allocate a supplier code. Try again.', undefined, 'SUPPLIER_CODE');
}

const duplicate = (field, code) =>
  field === 'code'
    ? new ApiError(409, `Supplier code ${code} is already used.`, [{ path: 'code', message: 'This supplier code is already used' }], 'DUPLICATE_SUPPLIER')
    : new ApiError(409, 'A supplier with this name already exists.', [{ path: 'name', message: 'A supplier with this name already exists.' }], 'DUPLICATE_SUPPLIER');

/** The store a supplier's deliveries go to must be one of this organization's active stores. */
async function checkBranch(orgId, id) {
  if (!id) return;
  const b = await Branch.findOne({ _id: id, organizationId: orgId }, 'status').lean();
  if (!b) throw new ApiError(400, 'That store does not exist.', [{ path: 'procurement.defaultBranchId', message: 'Choose a store from the list' }], 'BRANCH_NOT_FOUND');
  if (b.status && b.status !== 'active') throw new ApiError(400, 'That store is not active.', [{ path: 'procurement.defaultBranchId', message: 'Choose an active store' }], 'BRANCH_INACTIVE');
}

/**
 * The same GST number on two suppliers is a warning, not a refusal: a group can trade under one registration, and the Orders module has always allowed it.
 * The caller is told which supplier already has it so a person can decide.
 */
async function gstinTwin(orgId, gstin, exceptId) {
  if (!gstin) return null;
  const twin = await Supplier.findOne({ organizationId: orgId, gstin, ...(exceptId && { _id: { $ne: exceptId } }) }, 'name code').lean();
  return twin ? { name: twin.name, code: twin.code || '' } : null;
}

export async function createSupplier(req, input) {
  const code = String(input.code || '').trim().toUpperCase() || (await nextCode(req.orgId));
  await checkBranch(req.orgId, input.procurement?.defaultBranchId);
  try {
    const s = await Supplier.create({ ...input, code, organizationId: req.orgId, createdBy: req.user._id, createdByName: req.user.name });
    await audit(req, { action: 'SUPPLIER_CREATE', entity: 'Supplier', entityId: s._id, message: `Supplier ${s.name} (${code}) added`, meta: { code, name: s.name, gstin: s.gstin || '', supplierType: s.supplierType } });
    return { ...present(s.toObject()), gstinWarning: await gstinTwin(req.orgId, s.gstin, s._id) };
  } catch (e) {
    if (e?.code === 11000) throw duplicate(String(e?.message || '').includes('code_1') ? 'code' : 'name', code);
    throw e;
  }
}

/**
 * Edits a supplier. Orders and goods receipts keep the snapshot taken when they were made, so nothing already recorded changes; only this record does.
 */
export async function updateSupplier(req, id, input) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const before = await Supplier.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!before) throw new ApiError(404, 'Supplier not found');
  const code = input.code === undefined ? undefined : String(input.code || '').trim().toUpperCase() || before.code;
  await checkBranch(req.orgId, input.procurement?.defaultBranchId);
  try {
    // only what was actually sent: an edit never resets a field the form did not include
    const set = Object.fromEntries(Object.entries({ ...input, ...(code !== undefined && { code }) }).filter(([, v]) => v !== undefined));
    set.updatedBy = req.user._id;
    set.updatedByName = req.user.name;
    const s = await Supplier.findOneAndUpdate({ _id: before._id, organizationId: req.orgId }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
    const changed = Object.keys(input).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(s[k]));
    await audit(req, { action: 'SUPPLIER_UPDATE', entity: 'Supplier', entityId: s._id, message: `Supplier ${s.name} updated${changed.length ? ` (${changed.join(', ')})` : ''}`, meta: { code: s.code, changed } });
    return { ...present(s), gstinWarning: await gstinTwin(req.orgId, s.gstin, s._id) };
  } catch (e) {
    if (e?.code === 11000) throw duplicate(String(e?.message || '').includes('code_1') ? 'code' : 'name', code || before.code);
    throw e;
  }
}

/** Marks a supplier preferred, or takes the mark away. */
export async function setPreferred(req, id, preferred) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const s = await Supplier.findOneAndUpdate({ _id: id, organizationId: req.orgId }, { $set: { isPreferred: Boolean(preferred), updatedBy: req.user._id, updatedByName: req.user.name } }, { returnDocument: 'after' }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');
  await audit(req, { action: 'SUPPLIER_PREFERRED', entity: 'Supplier', entityId: s._id, message: `${s.name} ${preferred ? 'marked as preferred' : 'is no longer preferred'}`, meta: { code: s.code, before: !preferred, after: Boolean(preferred) } });
  return present(s);
}

/**
 * Activates or deactivates a supplier. An inactive supplier stays in the system with all of its history and simply stops being offered for new orders, so
 * deactivating is the safe alternative to deleting. Deactivating is refused while orders are still open with them.
 */
export async function setSupplierStatus(req, id, active) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const before = await Supplier.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!before) throw new ApiError(404, 'Supplier not found');
  if (!active && before.isActive) {
    const open = await Order.countDocuments({ organizationId: req.orgId, 'supplier.supplierId': before._id, status: { $in: ['pending', 'approved', 'ordered', 'partially_received'] } });
    if (open) throw new ApiError(409, `${before.name} has ${open} open order${open === 1 ? '' : 's'}. Finish or cancel them first.`, [{ path: 'status', message: 'Open orders must be finished first' }], 'SUPPLIER_IN_USE');
  }
  const s = await Supplier.findOneAndUpdate({ _id: before._id, organizationId: req.orgId }, { $set: { isActive: Boolean(active), updatedBy: req.user._id, updatedByName: req.user.name } }, { returnDocument: 'after' }).lean();
  await audit(req, { action: active ? 'SUPPLIER_ACTIVATE' : 'SUPPLIER_DEACTIVATE', entity: 'Supplier', entityId: s._id, message: `Supplier ${s.name} ${active ? 'activated' : 'deactivated'}`, meta: { code: s.code, before: { isActive: before.isActive }, after: { isActive: Boolean(active) } } });
  return present(s);
}

/**
 * What still points at a supplier: their purchase orders (which carry the payment that was agreed and recorded), the deliveries received from them, the supplier
 * invoices recorded against them, and any goods receipt still being prepared from an AI Billing invoice. Anything with money or stock behind it is in this list,
 * because deleting the supplier would leave those records pointing at nothing.
 */
export async function supplierUsage(orgId, supplierId) {
  const org = { organizationId: orgId };
  const [orders, receipts, invoices, drafts] = await Promise.all([
    Order.exists({ ...org, 'supplier.supplierId': supplierId }),
    GoodsReceipt.exists({ ...org, 'supplier.supplierId': supplierId }),
    mongoose.models.SupplierInvoice ? mongoose.models.SupplierInvoice.exists({ ...org, 'supplier.supplierId': supplierId }) : null,
    GoodsReceiptDraft.exists({ ...org, 'supplier.supplierId': supplierId }),
  ]);
  const used = [];
  if (orders) used.push('purchase orders');
  if (receipts) used.push('goods receipts');
  if (invoices) used.push('supplier invoices');
  if (drafts) used.push('AI Billing goods receipts being prepared');
  return used;
}

/**
 * A supplier nothing refers to can be deleted; one with any purchasing history is kept, because deleting it would orphan orders, deliveries and invoices.
 * Deactivate it instead — the history stays and the supplier stops appearing on new orders.
 */
export async function deleteSupplier(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const s = await Supplier.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');
  const used = await supplierUsage(req.orgId, s._id);
  if (used.length) throw new ApiError(409, `${s.name} can't be deleted: it has ${used.join(', ')}. Deactivate it instead — its history is kept.`, [{ path: 'status', message: 'Deactivate it instead' }], 'IN_USE');
  await Supplier.deleteOne({ _id: s._id, organizationId: req.orgId });
  await audit(req, { action: 'SUPPLIER_DELETE', entity: 'Supplier', entityId: s._id, message: `Supplier deleted — ${s.name} (${s.code || 'no code'})`, meta: { code: s.code, name: s.name } });
}

/* ------------------------------------------------------------------------------------------------ purchase history */

const RECEIPT_STATE = { none: 'Not received', partial: 'Partially received', complete: 'Received' };

/**
 * One supplier's purchasing, taken straight from the EXISTING records — the orders placed with them and the goods receipts booked against those orders. There
 * is no second history to keep in step: every column is read from the order or its receipts. Drafts are left out (nothing was placed yet); a cancelled order
 * stays, labelled as cancelled, because it happened.
 *
 * Per order: when it was placed, when it was expected, when the last delivery arrived, the money (total, paid, outstanding as the order itself records it),
 * the order's status and how much of it has been received. Each row carries the ids needed to open the order or its latest receipt.
 */
export async function supplierPurchases(orgId, supplierId, { page = 1, limit = 10 } = {}) {
  if (!mongoose.isValidObjectId(supplierId)) throw new ApiError(404, 'Supplier not found');
  // the supplier must be this organization's: another organization is told the same thing as someone asking for a supplier that does not exist
  if (!(await Supplier.exists({ _id: supplierId, organizationId: orgId }))) throw new ApiError(404, 'Supplier not found');
  const id = new mongoose.Types.ObjectId(String(supplierId));
  const filter = { organizationId: orgId, 'supplier.supplierId': id, status: { $ne: 'draft' } };
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ orderDate: -1, createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .select('orderNo orderDate expectedDate status grandTotal payment branchId createdAt').lean(),
    Order.countDocuments(filter),
  ]);
  const receipts = orders.length
    ? await GoodsReceipt.aggregate([
      { $match: { organizationId: orgId, orderId: { $in: orders.map((o) => o._id) } } },
      { $sort: { receivedAt: 1 } },
      { $group: { _id: '$orderId', count: { $sum: 1 }, lastAt: { $max: '$receivedAt' }, lastId: { $last: '$_id' }, lastNo: { $last: '$receiptNo' } } },
    ])
    : [];
  const byOrder = new Map(receipts.map((r) => [String(r._id), r]));

  const items = orders.map((o) => {
    const got = byOrder.get(String(o._id));
    const paidInFull = o.payment?.status === 'paid';
    const outstanding = paidInFull ? 0 : Math.round(Number(o.payment?.remaining || 0) * 100) / 100;
    const receiptStatus = o.status === 'received' || o.status === 'completed' ? 'complete' : got?.count ? 'partial' : 'none';
    return {
      _id: o._id, orderNo: o.orderNo,
      orderDate: o.orderDate || o.createdAt || null,
      expectedDate: o.expectedDate || null,
      receivedDate: got?.lastAt || null,
      totalAmount: Math.round(Number(o.grandTotal || 0) * 100) / 100,
      paidAmount: Math.round((Number(o.grandTotal || 0) - outstanding) * 100) / 100, // what the order records as settled; nothing here pays anything
      outstandingAmount: outstanding,
      paymentStatus: o.payment?.status || '',
      status: o.status,
      statusLabel: ORDER_STATUS_LABEL[o.status] || o.status,
      receiptStatus,
      receiptStatusLabel: RECEIPT_STATE[receiptStatus],
      receiptCount: got?.count || 0,
      lastReceiptId: got?.lastId || null,
      lastReceiptNo: got?.lastNo || '',
    };
  });
  return paginated(items, { page, limit, total });
}
