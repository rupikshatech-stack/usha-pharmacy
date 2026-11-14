import mongoose from 'mongoose';
import { Batch, Branch, Dispatch, GoodsReceipt, GoodsReceiptDraft, OPEN_TRANSFER_STATUSES, Order, Receipt, StockMovement, Transfer, TransferEvent, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';

const CI = { locale: 'en', strength: 2 };
export const DEFAULT_BRANCH = { name: 'Main Store', code: 'MAIN' };

/**
 * The organization's default store, created on first use. Batches that were never assigned a store belong to it, and the
 * Selling Point sells from it. Safe to call concurrently (one default per organization is enforced by an index).
 */
export async function ensureDefaultBranch(orgId, session) {
  const find = () => Branch.findOne({ organizationId: orgId, isDefault: true }, null, { session }).lean();
  const existing = await find();
  if (existing) return existing;
  try {
    const [created] = await Branch.create([{ organizationId: orgId, ...DEFAULT_BRANCH, isDefault: true }], { session });
    return created.toObject();
  } catch (e) {
    // Another request created it first. (Inside a transaction a duplicate-key error aborts it, so only retry outside one.)
    if (e.code === 11000 && !session) return find();
    throw e;
  }
}

export const defaultBranchId = async (orgId, session) => (await ensureDefaultBranch(orgId, session))._id;

/**
 * Filter selecting the batches held in one store. A batch with no store recorded counts as the default store's, so
 * batches created before stores existed keep working without being rewritten.
 */
export const inBranch = (branchId, defaultId) =>
  String(branchId) === String(defaultId)
    ? { $or: [{ branchId: defaultId }, { branchId: { $exists: false } }, { branchId: null }] }
    : { branchId };

/** The same rule as an aggregation expression over `$branchId`. */
export const branchExpr = (branchId, defaultId) => ({ $eq: [{ $ifNull: ['$branchId', defaultId] }, branchId] });

/** An active store of this organization, or an ApiError. */
export async function requireActiveBranch(orgId, id, session, label = 'store') {
  if (!id || !mongoose.isValidObjectId(id)) throw new ApiError(400, `Choose a valid ${label}`, [{ path: label === 'store' ? 'branchId' : label, message: `Choose a valid ${label}` }], 'INVALID_BRANCH');
  const branch = await Branch.findOne({ _id: id, organizationId: orgId }, null, { session }).lean();
  if (!branch) throw new ApiError(404, 'Store not found', [{ path: 'branchId', message: 'Store not found' }], 'BRANCH_NOT_FOUND');
  if (branch.status !== 'active') throw new ApiError(409, `${branch.name} is inactive`, [{ path: 'branchId', message: `${branch.name} is inactive` }], 'BRANCH_INACTIVE');
  return branch;
}

const dup = (path = 'name') => {
  const message = path === 'code' ? 'A branch with this code already exists' : 'A branch with this name already exists';
  return new ApiError(409, message, [{ path, message }], 'DUPLICATE');
};

const PROFILE_FIELDS = ['addressLine1', 'addressLine2', 'country', 'state', 'city', 'pincode', 'landmark', 'email', 'managerName', 'gstin', 'openingDate', 'notes'];
/** The whole address on one line, from its parts: what older screens (transfers, orders) show. */
export const composeAddress = (b) => [b.addressLine1, b.addressLine2, b.landmark, b.city, b.state, b.pincode, b.country].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
const dateOf = (v) => (v ? new Date(`${v}T00:00:00.000Z`) : null);

/** Cleans the profile part of a request: uppercase GSTIN, a real Date for the opening date, India as the default country, the one-line address built from the parts. */
function profileOf(data, before = {}) {
  const hasProfile = PROFILE_FIELDS.some((k) => data[k] !== undefined);
  const out = { ...data };
  if (data.gstin !== undefined) out.gstin = String(data.gstin).toUpperCase();
  if (data.openingDate !== undefined) out.openingDate = dateOf(data.openingDate);
  if (hasProfile) {
    if (!before.country && !data.country) out.country = 'India';
    const merged = { ...before, ...out };
    out.address = composeAddress(merged) || merged.address || '';
  }
  return out;
}

/**
 * Stores with how many batches and units each holds and its open transfers. With no options it is every store (what the transfer, order and batch screens use);
 * with `paged` it is one page of them, filtered by name / code (`search`) and `status`, with the total.
 */
export async function listBranches(orgId, { paged = false, page = 1, limit = 10, search = '', status } = {}) {
  await ensureDefaultBranch(orgId);
  const def = await defaultBranchId(orgId);
  const filter = { organizationId: orgId, ...(status && { status }) };
  if (paged && search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const total = paged ? await Branch.countDocuments(filter) : 0;
  const [branches, stock, open, orderCounts, staffCounts] = await Promise.all([
    Branch.find(filter).sort({ isDefault: -1, name: 1 }).collation(CI).skip(paged ? (page - 1) * limit : 0).limit(paged ? limit : 0).lean(),
    Batch.aggregate([
      { $match: { organizationId: orgId, status: { $ne: 'archived' } } },
      { $group: { _id: { $ifNull: ['$branchId', def] }, batches: { $sum: 1 }, units: { $sum: '$availableQuantity' } } },
    ]),
    Transfer.aggregate([
      { $match: { organizationId: orgId, status: { $in: OPEN_TRANSFER_STATUSES } } },
      { $project: { ends: ['$fromBranchId', '$toBranchId'] } },
      { $unwind: '$ends' },
      { $group: { _id: '$ends', n: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $match: { organizationId: orgId, branchId: { $exists: true, $ne: null } } }, { $group: { _id: '$branchId', n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { organizationId: orgId } }, { $unwind: '$branchIds' }, { $group: { _id: '$branchIds', n: { $sum: 1 } } }]),
  ]);
  const oc = new Map(orderCounts.map((x) => [String(x._id), x.n]));
  const sc = new Map(staffCounts.map((x) => [String(x._id), x.n]));
  const s = new Map(stock.map((x) => [String(x._id), x]));
  const o = new Map(open.map((x) => [String(x._id), x.n]));
  const rows = branches.map((b) => ({ ...b, batchCount: s.get(String(b._id))?.batches ?? 0, unitsOnHand: s.get(String(b._id))?.units ?? 0, openTransfers: o.get(String(b._id)) ?? 0, orderCount: oc.get(String(b._id)) ?? 0, staffCount: sc.get(String(b._id)) ?? 0 }));
  return paged ? paginated(rows, { page, limit, total }) : rows;
}

/** One branch with the same figures. */
export async function getBranch(orgId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Branch not found');
  const all = await listBranches(orgId);
  const b = all.find((x) => String(x._id) === String(id));
  if (!b) throw new ApiError(404, 'Branch not found');
  return b;
}

export async function createBranch(req, data) {
  await ensureDefaultBranch(req.orgId);
  try {
    const [b] = await Branch.create([{ ...profileOf(data), organizationId: req.orgId, isDefault: false, createdBy: req.user._id, createdByName: req.user.name, updatedBy: req.user._id, updatedByName: req.user.name }]);
    await audit(req, { action: 'BRANCH_CREATE', entity: 'Branch', entityId: b._id, message: `Branch added — ${b.name} (${b.code})` });
    return b.toObject();
  } catch (e) {
    if (e.code === 11000) throw dup(/code/.test(e.message) ? 'code' : 'name');
    throw e;
  }
}

export async function updateBranch(req, id, data) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Store not found');
  const before = await Branch.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!before) throw new ApiError(404, 'Store not found');
  if (before.isDefault && data.status === 'inactive') throw new ApiError(409, 'The default store cannot be deactivated.', undefined, 'DEFAULT_BRANCH');
  if (data.status === 'inactive' && before.status === 'active') {
    const open = await Transfer.countDocuments({ organizationId: req.orgId, status: { $in: OPEN_TRANSFER_STATUSES }, $or: [{ fromBranchId: before._id }, { toBranchId: before._id }] });
    if (open) throw new ApiError(409, `${before.name} has ${open} open transfer${open === 1 ? '' : 's'}. Finish or cancel them first.`, undefined, 'BRANCH_IN_USE');
  }
  try {
    const set = { ...profileOf(data, before), updatedBy: req.user._id, updatedByName: req.user.name };
    const b = await Branch.findOneAndUpdate({ _id: id, organizationId: req.orgId }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
    await audit(req, { action: 'BRANCH_UPDATE', entity: 'Branch', entityId: b._id, message: `Branch updated — ${b.name} (${Object.keys(data).join(', ')})` });
    return b;
  } catch (e) {
    if (e.code === 11000) throw dup(/code/.test(e.message) ? 'code' : 'name');
    throw e;
  }
}

/**
 * What in the system still points at a branch, by kind: stock and its history, transfers (with their dispatches, receipts and events), purchases (orders and
 * goods receipts), and staff assigned to it. Sales are not tied to a branch (the Selling Point sells from the default branch, which can't be deleted).
 */
export async function branchUsage(orgId, branchId) {
  const id = branchId;
  const org = { organizationId: orgId };
  const either = { $or: [{ fromBranchId: id }, { toBranchId: id }] };
  const [batches, movements, transfers, dispatches, receipts, events, orders, receiptsGrn, drafts, staff] = await Promise.all([
    Batch.exists({ ...org, branchId: id }),
    StockMovement.exists({ ...org, $or: [{ branchId: id }, { fromBranchId: id }, { toBranchId: id }] }),
    Transfer.exists({ ...org, ...either }),
    Dispatch.exists({ ...org, ...either }),
    Receipt.exists({ ...org, ...either }),
    TransferEvent.exists({ ...org, branchId: id }),
    Order.exists({ ...org, branchId: id }),
    GoodsReceipt.exists({ ...org, branchId: id }),
    GoodsReceiptDraft.exists({ ...org, branchId: id }),
    User.exists({ organizationId: orgId, branchIds: id }),
  ]);
  const used = [];
  if (batches || movements) used.push('stock or stock history');
  if (transfers || dispatches || receipts || events) used.push('transfers');
  if (orders || receiptsGrn || drafts) used.push('purchase orders or goods receipts');
  if (staff) used.push('staff assigned to it');
  return used;
}

/**
 * A branch that nothing refers to can be deleted; otherwise it is kept — deactivate it instead. Nothing related (stock, transfers, purchases, financial records) is
 * ever deleted along with it. The default branch is never deleted.
 */
export async function deleteBranch(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Store not found');
  const b = await Branch.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!b) throw new ApiError(404, 'Store not found');
  if (b.isDefault) throw new ApiError(409, 'The default store cannot be deleted.', undefined, 'DEFAULT_BRANCH');
  const used = await branchUsage(req.orgId, b._id);
  if (used.length) throw new ApiError(409, `${b.name} can't be deleted: it has ${used.join(', ')}. Deactivate it instead — its history is kept.`, [{ path: 'status', message: 'Deactivate it instead' }], 'IN_USE');
  await Branch.deleteOne({ _id: b._id, organizationId: req.orgId });
  await audit(req, { action: 'BRANCH_DELETE', entity: 'Branch', entityId: b._id, message: `Store deleted — ${b.name}` });
}
