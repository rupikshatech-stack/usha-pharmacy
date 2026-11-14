import mongoose from 'mongoose';
import { Batch, Branch, CANCELLABLE_TRANSFER_STATUSES, Dispatch, IN_TRANSIT_STATUSES, Medicine, OPEN_TRANSFER_STATUSES, Organization, Receipt, Transfer, TransferEvent, User, nextSeq } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { paginated } from '../utils/pagination.js';
import { escapeRegex } from '../utils/regex.js';
import { audit } from './audit.service.js';
import { defaultBranchId, ensureDefaultBranch, inBranch, requireActiveBranch } from './branch.service.js';
import { recordMovement } from './ledger.service.js';
import { sellableUnitsExpr } from './stock.service.js';
import { withTransaction } from './transaction.service.js';

/**
 * Inter-store transfers.
 *
 *   draft --submit--> submitted --approve--> approved --dispatch--> in_transit --receive--> completed
 *                                                                          \--(part)--> partially_received --receive (the rest)--^
 *                        |  \--reject--> rejected (final)   |  \--(part)--> partially_dispatched --dispatch (the rest)--^
 *                        \__________ cancel ________________/ (after a dispatch the units return to the source store)
 *
 * When the organization does not require approval, SUBMIT takes a draft straight to "approved".
 * Stock moves in only two steps, each ONE transaction that is claimed atomically (so it can't happen twice):
 *   DISPATCH takes the units out of the source store's batches, with the guard inside the update (never below zero, never
 *            expired / quarantined / reserved stock) and a TRANSFER_OUT ledger entry per batch.
 *   RECEIVE  adds the units to the SAME lot in the destination store (creating that store's batch if it has none) with
 *            a TRANSFER_IN ledger entry. Totals are conserved: out = in, so the ledger always reconciles.
 * While in transit, the units belong to no store's batch. Availability is checked at submit and again at dispatch.
 */

const oid = (id) => new mongoose.Types.ObjectId(id);
const bad = (id) => !mongoose.isValidObjectId(id);
const refOf = (seq) => `TRF-${String(seq).padStart(4, '0')}`;
const fail = (status, message, code, details) => new ApiError(status, message, details, code);

/**
 * Appends one event to the transfer's permanent history, inside the same transaction as the change it describes. `t` needs _id and
 * reference. `branchId` is where the action happened (source for dispatch, destination for receiving).
 */
async function recordEvent(req, session, t, action, previousStatus, newStatus, { remarks, branchId, metadata } = {}) {
  await TransferEvent.create(
    [{ organizationId: req.orgId, transferId: t._id, transferReference: t.reference, action, previousStatus, newStatus, performedBy: req.user._id, performedByName: req.user.name, branchId, remarks, timestamp: new Date(), metadata }],
    { session },
  );
}

/** The list filter "pending" groups everything waiting to be dispatched: submitted (needs approval) and approved. */
export const PENDING_STATUSES = ['submitted', 'approved'];

/** yyyy-mm-dd (or an ISO string) -> a Date at midnight UTC, or null. */
export function parseTransferDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

/* ------------------------------------------------------------------------------------------------ settings */

export async function getTransferSettings(orgId) {
  const org = await Organization.findById(orgId).select('settings').lean();
  return { approvalRequired: Boolean(org?.settings?.transferApprovalRequired), allowSelfApproval: Boolean(org?.settings?.transferSelfApproval) };
}

export async function updateTransferSettings(req, { approvalRequired, allowSelfApproval }) {
  await Organization.updateOne({ _id: req.orgId }, { $set: { 'settings.transferApprovalRequired': approvalRequired, ...(allowSelfApproval !== undefined && { 'settings.transferSelfApproval': allowSelfApproval }) } });
  await audit(req, { action: 'TRANSFER_SETTINGS', entity: 'Organization', entityId: req.orgId, message: `Transfer approval ${approvalRequired ? 'is now required' : 'is no longer required'}` });
  return getTransferSettings(req.orgId);
}

/* ------------------------------------------------------------------------------------------------ validation */

/**
 * Checks a draft's lines against the SOURCE store's batches and returns the lines with name / batch snapshots.
 * Throws one error that lists every problem (path items.N.field) so the form can mark each line.
 */
async function resolveItems(orgId, from, items, session) {
  const def = await defaultBranchId(orgId, session);
  const problems = [];
  const seen = new Set();
  const out = [];
  const now = new Date();
  for (const [i, it] of items.entries()) {
    const problem = (field, message) => problems.push({ path: `items.${i}.${field}`, message });
    if (seen.has(String(it.batchId))) {
      problem('batchId', 'This batch is already on the transfer');
      continue;
    }
    seen.add(String(it.batchId));
    const batch = await Batch.findOne({ _id: it.batchId, organizationId: orgId, ...inBranch(from._id, def) }, null, { session }).lean();
    if (!batch) {
      problem('batchId', `This batch is not held in ${from.name}`);
      continue;
    }
    const medicine = await Medicine.findOne({ _id: batch.medicineId, organizationId: orgId }, null, { session }).select('medicineName isActive unit').lean();
    if (!medicine) {
      problem('batchId', 'The medicine no longer exists');
      continue;
    }
    if (!medicine.isActive) problem('batchId', `${medicine.medicineName} is archived`);
    else if (batch.status !== 'active') problem('batchId', `Batch ${batch.batchNumber} is ${batch.status} and cannot be transferred`);
    else if (batch.expiryDate <= now) problem('batchId', `Batch ${batch.batchNumber} has expired and cannot be transferred`);
    else if (it.quantity > batch.availableQuantity - batch.reservedQuantity) {
      problem('quantity', `Only ${Math.max(0, batch.availableQuantity - batch.reservedQuantity)} unit(s) of ${medicine.medicineName} batch ${batch.batchNumber} are available in ${from.name}`);
    }
    out.push({ medicineId: batch.medicineId, batchId: batch._id, medicineName: medicine.medicineName, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, quantity: it.quantity, ...(medicine.unit && { unit: medicine.unit }) });
  }
  if (problems.length) throw fail(400, problems[0].message, 'TRANSFER_INVALID', problems);
  return out;
}

async function resolveStores(orgId, { fromBranchId, toBranchId }, session) {
  if (String(fromBranchId) === String(toBranchId)) throw fail(400, 'Choose a different destination store', 'SAME_STORE', [{ path: 'toBranchId', message: 'Choose a different destination store' }]);
  const from = await requireActiveBranch(orgId, fromBranchId, session, 'fromBranchId');
  const to = await requireActiveBranch(orgId, toBranchId, session, 'toBranchId');
  return { from, to };
}

/* ------------------------------------------------------------------------------------------------ reading */

/** A dispatch record as the API shows it. */
const presentDispatch = (d) => ({ ...d, items: d.items });

const userNames = async (ids) => {
  const users = await User.find({ _id: { $in: ids.filter(Boolean) } }).select('name').lean();
  return new Map(users.map((u) => [String(u._id), u.name]));
};

const summarize = (t, branches) => ({
  ...t,
  fromBranch: branches.get(String(t.fromBranchId)) || { _id: t.fromBranchId, name: 'Unknown store' },
  toBranch: branches.get(String(t.toBranchId)) || { _id: t.toBranchId, name: 'Unknown store' },
  itemCount: t.items.length,
  totalUnits: t.items.reduce((s, i) => s + i.quantity, 0),
});

const loadBranches = async (orgId, ids) => {
  const rows = await Branch.find({ organizationId: orgId, _id: { $in: ids } }).select('name code address phone').lean();
  return new Map(rows.map((b) => [String(b._id), b]));
};

/** dd-mm-yyyy style input is not accepted here: the API takes yyyy-mm-dd and the range includes both end days. */
const dayRange = (from, to) => {
  const range = {};
  if (from) range.$gte = parseTransferDate(from);
  if (to) range.$lte = parseTransferDate(to);
  return Object.keys(range).length ? { transferDate: range } : {};
};

export async function listTransfers(orgId, { search, status, fromBranchId, toBranchId, dateFrom, dateTo, page, limit }, scope = null) {
  const filter = { organizationId: orgId, ...dayRange(dateFrom, dateTo), ...(scope && { $and: [scope] }) };
  if (status === 'pending') filter.status = { $in: PENDING_STATUSES };
  else if (status === 'transit') filter.status = { $in: IN_TRANSIT_STATUSES };
  else if (status) filter.status = status;
  if (fromBranchId) filter.fromBranchId = oid(fromBranchId);
  if (toBranchId) filter.toBranchId = oid(toBranchId);
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ reference: rx }, { 'items.medicineName': rx }, { 'items.batchNumber': rx }];
  }
  const [rows, total] = await Promise.all([
    Transfer.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Transfer.countDocuments(filter),
  ]);
  const [branches, names] = await Promise.all([
    loadBranches(orgId, [...new Set(rows.flatMap((t) => [String(t.fromBranchId), String(t.toBranchId)]))].map(oid)),
    userNames(rows.map((t) => t.createdBy)),
  ]);
  return paginated(
    rows.map((t) => {
      const { items, ...rest } = summarize(t, branches);
      const discrepancyUnits = items.reduce((sum, i) => sum + (i.damagedQuantity || 0) + (i.missingQuantity || 0), 0);
      return { ...rest, items: undefined, createdByName: names.get(String(t.createdBy)) || '—', preview: items.slice(0, 3).map((i) => i.medicineName), discrepancyUnits, hasDiscrepancy: discrepancyUnits > 0 };
    }),
    { page, limit, total },
  );
}

/** The four cards at the top of the page: real counts from the database. */
export async function transferSummary(orgId, scope = null) {
  const rows = await Transfer.aggregate([{ $match: { organizationId: orgId, ...(scope && { $and: [scope] }) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const n = (s) => by[s] ?? 0;
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    pending: PENDING_STATUSES.reduce((sum, s) => sum + n(s), 0), // waiting for approval or dispatch
    inTransit: IN_TRANSIT_STATUSES.reduce((sum, st) => sum + n(st), 0), // dispatched (fully or in part), not yet received
    completed: n('completed'),
    byStatus: by,
  };
}

/** Where every dispatched unit of a line is: received, damaged, missing — or still expected. Older transfers (made before receiving
 *  could be partial) have no receiving fields: a completed one counts as received in full. */
function progress(it, status) {
  const dispatched = it.dispatchedQuantity ?? (['in_transit', 'partially_received', 'completed'].includes(status) ? it.quantity : 0);
  const received = it.receivedQuantity ?? (status === 'completed' ? dispatched : 0);
  const damaged = it.damagedQuantity ?? 0;
  const missing = it.missingQuantity ?? 0;
  return { dispatched, received, damaged, missing, remaining: Math.max(0, dispatched - received - damaged - missing) };
}

export async function getTransfer(orgId, id) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  const t = await Transfer.findOne({ _id: id, organizationId: orgId }).lean();
  if (!t) throw fail(404, 'Transfer not found');
  const [dispatches, receipts] = await Promise.all([
    Dispatch.find({ organizationId: orgId, transferId: t._id }).sort({ dispatchedAt: 1, _id: 1 }).lean(),
    Receipt.find({ organizationId: orgId, transferId: t._id }).sort({ receivedAt: 1, _id: 1 }).lean(),
  ]);
  const [branches, names] = await Promise.all([
    loadBranches(orgId, [t.fromBranchId, t.toBranchId]),
    userNames([t.createdBy, t.submittedBy, t.approvedBy, t.rejectedBy, t.dispatchedBy, t.receivedBy, t.cancelledBy, ...dispatches.map((d) => d.dispatchedBy), ...receipts.map((r) => r.receivedBy)]),
  ]);
  const who = (u) => (u ? names.get(String(u)) || 'Unknown user' : undefined);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const timeline = [
    { event: 'created', label: 'Draft created', at: t.createdAt, by: who(t.createdBy) },
    t.submittedAt && { event: 'submitted', label: t.approvalRequired ? 'Submitted for approval' : 'Submitted', at: t.submittedAt, by: who(t.submittedBy) },
    t.approvedAt && { event: 'approved', label: t.autoApproved ? 'Approved automatically (approval is not required)' : 'Approved', at: t.approvedAt, by: t.autoApproved ? undefined : who(t.approvedBy) },
    t.rejectedAt && { event: 'rejected', label: 'Rejected', at: t.rejectedAt, by: who(t.rejectedBy), note: t.rejectReason },
    ...(dispatches.length
      ? dispatches.map((d) => ({ event: 'dispatched', ref: d.reference, label: `Dispatched ${d.reference} — ${plural(d.totalUnits, 'unit')} left the source store${d.closedShort ? ' (closed short)' : ''}`, at: d.dispatchedAt, by: who(d.dispatchedBy) }))
      : t.dispatchedAt
        ? [{ event: 'dispatched', label: 'Dispatched — stock left the source store', at: t.dispatchedAt, by: who(t.dispatchedBy) }]
        : []),
    ...(receipts.length
      ? receipts.map((r) => ({
          event: 'received',
          ref: r.reference,
          label: `Received ${r.reference} — ${plural(r.totalReceived, 'unit')} added to the destination store${r.totalDamaged ? `, ${r.totalDamaged} damaged` : ''}${r.totalMissing ? `, ${r.totalMissing} missing` : ''}${r.closed ? ' (receipt closed)' : ''}`,
          at: r.receivedAt,
          by: who(r.receivedBy) || r.receivedByName,
          note: r.remarks || undefined,
        }))
      : t.receivedAt
        ? [{ event: 'received', label: 'Received — stock added to the destination store', at: t.receivedAt, by: who(t.receivedBy) }]
        : []),
    t.cancelledAt && { event: 'cancelled', label: t.dispatchedAt ? 'Cancelled — units returned to the source store' : 'Cancelled', at: t.cancelledAt, by: who(t.cancelledBy), note: t.cancelReason },
  ].filter(Boolean);

  const detail = {
    ...summarize(t, branches),
    expectedArrivalDate: t.expectedArrivalDate, internalRemarks: t.internalRemarks,
    submittedAt: t.submittedAt, approvedAt: t.approvedAt, rejectedAt: t.rejectedAt, dispatchedAt: t.dispatchedAt, receivedAt: t.receivedAt, cancelledAt: t.cancelledAt,
    submittedByName: who(t.submittedBy), approvedByName: t.autoApproved ? undefined : who(t.approvedBy), rejectedByName: who(t.rejectedBy), dispatchedByName: who(t.dispatchedBy), receivedByName: who(t.receivedBy), cancelledByName: who(t.cancelledBy),
    timeline, createdByName: who(t.createdBy), dispatches: dispatches.map(presentDispatch), receipts };
  detail.items = detail.items.map((i) => {
    const p = progress(i, t.status);
    const sentBefore = i.dispatchedQuantity ?? (['in_transit', 'partially_received', 'completed'].includes(t.status) ? i.quantity : 0);
    return {
      ...i,
      requestedQuantity: i.quantity, // an approval never changes the quantity, so requested = approved
      approvedQuantity: i.quantity,
      dispatchedQuantity: sentBefore,
      remainingQuantity: i.quantity - sentBefore, // still to DISPATCH
      receivedQuantity: p.received,
      damagedQuantity: p.damaged,
      missingQuantity: p.missing,
      remainingToReceive: p.remaining, // still to RECEIVE
    };
  });
  detail.dispatchedUnits = detail.items.reduce((sum, i) => sum + i.dispatchedQuantity, 0);
  detail.receivedUnits = detail.items.reduce((sum, i) => sum + i.receivedQuantity, 0);
  detail.damagedUnits = detail.items.reduce((sum, i) => sum + i.damagedQuantity, 0);
  detail.missingUnits = detail.items.reduce((sum, i) => sum + i.missingQuantity, 0);
  detail.hasDiscrepancy = detail.damagedUnits + detail.missingUnits > 0;
  detail.rejectionReason = t.rejectReason; // the same fields under the names used in the transfer record
  detail.cancellationReason = t.cancelReason;
  if (['draft', 'approved', 'partially_dispatched'].includes(t.status)) {
    // Still to be edited or dispatched, so show how much each batch has available RIGHT NOW (the server re-checks when it moves).
    const [batches, medicines] = await Promise.all([
      Batch.find({ organizationId: orgId, _id: { $in: t.items.map((i) => i.batchId) } }).select('availableQuantity reservedQuantity').lean(),
      Medicine.find({ organizationId: orgId, _id: { $in: t.items.map((i) => i.medicineId) } }).select('strength dosageForm').lean(),
    ]);
    const b = new Map(batches.map((x) => [String(x._id), x]));
    const m = new Map(medicines.map((x) => [String(x._id), x]));
    detail.items = detail.items.map((i) => {
      const batch = b.get(String(i.batchId));
      const med = m.get(String(i.medicineId));
      return { ...i, availableNow: batch ? Math.max(0, batch.availableQuantity - batch.reservedQuantity) : 0, subtitle: [med?.strength, med?.dosageForm].filter(Boolean).join(' · ') };
    });
  }
  return detail;
}

/* ------------------------------------------------------------------------------------------------ drafts */

export async function createTransfer(req, data) {
  return withTransaction(async (session) => {
    await ensureDefaultBranch(req.orgId, session);
    const { from, to } = await resolveStores(req.orgId, data, session);
    const items = await resolveItems(req.orgId, from, data.items, session);
    const reference = refOf(await nextSeq(req.orgId, 'transfer', session));
    const [t] = await Transfer.create(
      [{ organizationId: req.orgId, reference, fromBranchId: from._id, toBranchId: to._id, transferDate: data.transferDate, ...(data.expectedArrivalDate && { expectedArrivalDate: data.expectedArrivalDate }), notes: data.notes, internalRemarks: data.internalRemarks || '', items, status: 'draft', createdBy: req.user._id }],
      { session },
    );
    await recordEvent(req, session, t, 'CREATED', undefined, 'draft', { branchId: from._id, remarks: data.notes || undefined, metadata: { from: from.name, to: to.name, lines: items.length, units: items.reduce((n, i) => n + i.quantity, 0) } });
    await audit(req, { action: 'TRANSFER_CREATE', entity: 'Transfer', entityId: t._id, message: `Transfer ${reference} drafted — ${from.name} → ${to.name} (${items.length} line${items.length === 1 ? '' : 's'})` }, session);
    return t._id;
  }).then((id) => getTransfer(req.orgId, id));
}

/** Throws the right error for a transfer that is not in the state an action needs. */
async function notInState(orgId, id, wanted) {
  const t = await Transfer.findOne({ _id: id, organizationId: orgId }).select('status reference').lean();
  if (!t) return fail(404, 'Transfer not found');
  return fail(409, `${t.reference} is ${t.status.replace('_', ' ')}; only a ${wanted} transfer can do this.`, 'TRANSFER_STATE', [{ path: 'status', message: `Transfer is ${t.status}` }]);
}

export async function updateTransfer(req, id, data) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  await withTransaction(async (session) => {
    const { from, to } = await resolveStores(req.orgId, data, session);
    const items = await resolveItems(req.orgId, from, data.items, session);
    const t = await Transfer.findOneAndUpdate(
      { _id: id, organizationId: req.orgId, status: 'draft' },
      { $set: { fromBranchId: from._id, toBranchId: to._id, transferDate: data.transferDate, notes: data.notes, internalRemarks: data.internalRemarks || '', items }, ...(data.expectedArrivalDate ? {} : { $unset: { expectedArrivalDate: '' } }) },
      { returnDocument: 'after', session, runValidators: true },
    );
    if (!t) throw await notInState(req.orgId, id, 'draft');
    if (data.expectedArrivalDate) await Transfer.updateOne({ _id: id, organizationId: req.orgId }, { $set: { expectedArrivalDate: data.expectedArrivalDate } }, { session });
    await recordEvent(req, session, t, 'UPDATED', 'draft', 'draft', { branchId: from._id, metadata: { from: from.name, to: to.name, lines: items.length, units: items.reduce((n, i) => n + i.quantity, 0) } });
    await audit(req, { action: 'TRANSFER_UPDATE', entity: 'Transfer', entityId: t._id, message: `Transfer ${t.reference} edited — ${from.name} → ${to.name}` }, session);
  });
  return getTransfer(req.orgId, id);
}

export async function deleteTransfer(req, id) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  await withTransaction(async (session) => {
    const t = await Transfer.findOneAndDelete({ _id: id, organizationId: req.orgId, status: 'draft' }, { session });
    if (!t) {
      const e = await notInState(req.orgId, id, 'draft');
      if (e.status === 409) e.message = `${e.message.split(';')[0]}. Only a draft can be deleted — cancel it instead.`;
      throw e;
    }
    // the history outlives the draft it describes
    await recordEvent(req, session, t, 'DELETED', 'draft', undefined, { branchId: t.fromBranchId });
    await audit(req, { action: 'TRANSFER_DELETE', entity: 'Transfer', entityId: t._id, message: `Draft transfer ${t.reference} deleted` }, session);
  });
}

/* ------------------------------------------------------------------------------------------------ approval */

/**
 * Hands a draft in. Everything is re-checked first (stores still active, every batch still has the quantity). Where approval
 * is required the transfer waits as "submitted"; otherwise it is approved straight away. No stock moves yet.
 */
export async function submitTransfer(req, id) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  const { approvalRequired } = await getTransferSettings(req.orgId);
  await withTransaction(async (session) => {
    const current = await Transfer.findOne({ _id: id, organizationId: req.orgId, status: 'draft' }, null, { session }).lean();
    if (!current) throw await notInState(req.orgId, id, 'draft');
    const { from } = await resolveStores(req.orgId, current, session);
    await resolveItems(req.orgId, from, current.items.map((i) => ({ batchId: i.batchId, quantity: i.quantity })), session);
    const now = new Date();
    const set = { status: approvalRequired ? 'submitted' : 'approved', approvalRequired, submittedBy: req.user._id, submittedAt: now };
    if (!approvalRequired) Object.assign(set, { approvedAt: now, approvedBy: req.user._id, autoApproved: true });
    const t = await Transfer.findOneAndUpdate({ _id: id, organizationId: req.orgId, status: 'draft' }, { $set: set }, { returnDocument: 'after', session });
    if (!t) throw await notInState(req.orgId, id, 'draft');
    await recordEvent(req, session, t, 'SUBMITTED', 'draft', set.status, { branchId: t.fromBranchId, metadata: { approvalRequired, autoApproved: !approvalRequired } });
    await audit(req, { action: 'TRANSFER_SUBMIT', entity: 'Transfer', entityId: t._id, message: `Transfer ${t.reference} submitted${approvalRequired ? ' for approval' : ' (approval not required)'}` }, session);
  });
  return getTransfer(req.orgId, id);
}

export async function approveTransfer(req, id) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  await withTransaction(async (session) => {
    const t = await Transfer.findOneAndUpdate(
      { _id: id, organizationId: req.orgId, status: 'submitted' },
      { $set: { status: 'approved', approvedBy: req.user._id, approvedAt: new Date() } },
      { returnDocument: 'after', session },
    );
    if (!t) throw await notInState(req.orgId, id, 'submitted');
    await recordEvent(req, session, t, 'APPROVED', 'submitted', 'approved', { branchId: t.fromBranchId });
    await audit(req, { action: 'TRANSFER_APPROVE', entity: 'Transfer', entityId: t._id, message: `Transfer ${t.reference} approved` }, session);
  });
  return getTransfer(req.orgId, id);
}

export async function rejectTransfer(req, id, reason) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  await withTransaction(async (session) => {
    const t = await Transfer.findOneAndUpdate(
      { _id: id, organizationId: req.orgId, status: 'submitted' },
      { $set: { status: 'rejected', rejectedBy: req.user._id, rejectedAt: new Date(), rejectReason: reason } },
      { returnDocument: 'after', session },
    );
    if (!t) throw await notInState(req.orgId, id, 'submitted');
    await recordEvent(req, session, t, 'REJECTED', 'submitted', 'rejected', { branchId: t.fromBranchId, remarks: reason });
    await audit(req, { action: 'TRANSFER_REJECT', entity: 'Transfer', entityId: t._id, message: `Transfer ${t.reference} rejected (${reason})` }, session);
  });
  return getTransfer(req.orgId, id);
}

/* ------------------------------------------------------------------------------------------------ stock movement */

/**
 * Dispatches stock for an APPROVED transfer — all of it, or part of it (the transfer can be dispatched in several goes).
 *
 *   items         [{ batchId, quantity }]  what to send now; omitted = everything still to be sent. A quantity can never exceed what
 *                 was approved and is still unsent, nor what the batch really has available (on hand minus reserved).
 *   closeShort    after this dispatch, drop whatever is still unsent: the transfer goes in transit with what was sent.
 *   idempotencyKey  makes the request safe to repeat: the same key returns the original dispatch instead of sending again.
 *
 * ONE transaction does everything or nothing: the guarded stock decrements, a TRANSFER_OUT ledger entry per batch, the permanent
 * Dispatch record (unique reference DSP-0001 …, date, user), the transfer's new state and the audit entry. A second dispatch racing
 * on the same transfer loses (the dispatchSeq guard) and is told to retry; it never double-sends.
 */
export async function dispatchTransfer(req, id, { items: requested, closeShort = false, notes = '', idempotencyKey } = {}) {
  if (bad(id)) throw fail(404, 'Transfer not found');

  if (idempotencyKey) {
    const earlier = await Dispatch.findOne({ organizationId: req.orgId, idempotencyKey }).lean();
    if (earlier) {
      if (String(earlier.transferId) !== String(id)) throw fail(409, 'This dispatch key was already used for another transfer.', 'IDEMPOTENCY_CONFLICT');
      return { ...(await getTransfer(req.orgId, id)), dispatch: presentDispatch(earlier), duplicate: true };
    }
  }

  let dispatchId;
  try {
    dispatchId = await withTransaction(async (session) => {
      const t = await Transfer.findOne({ _id: id, organizationId: req.orgId, status: { $in: ['approved', 'partially_dispatched'] } }, null, { session }).lean();
      if (!t) throw await notInState(req.orgId, id, 'approved');
      const { from, to } = await resolveStores(req.orgId, { fromBranchId: t.fromBranchId, toBranchId: t.toBranchId }, session);
      const def = await defaultBranchId(req.orgId, session);

      // ---- what is being sent now
      const remaining = (it) => it.quantity - (it.dispatchedQuantity || 0);
      const wanted = requested?.length ? requested : t.items.filter((it) => remaining(it) > 0).map((it) => ({ batchId: String(it.batchId), quantity: remaining(it) }));
      const problems = [];
      const seen = new Set();
      const lines = [];
      wanted.forEach((w, i) => {
        const problem = (field, message) => problems.push({ path: `items.${i}.${field}`, message });
        if (seen.has(String(w.batchId))) return problem('batchId', 'This batch is already on the dispatch');
        seen.add(String(w.batchId));
        const item = t.items.find((x) => String(x.batchId) === String(w.batchId));
        if (!item) return problem('batchId', 'This batch is not part of the transfer');
        if (w.quantity > remaining(item)) {
          return problem('quantity', remaining(item) === 0 ? `${item.medicineName} batch ${item.batchNumber} has already been dispatched in full` : `Cannot dispatch more than the ${remaining(item)} still to send (approved ${item.quantity})`);
        }
        lines.push({ item, quantity: w.quantity });
      });
      if (problems.length) throw fail(400, problems[0].message, 'DISPATCH_INVALID', problems);
      if (!lines.length) throw fail(400, 'There is nothing left to dispatch on this transfer.', 'DISPATCH_INVALID', [{ path: 'items', message: 'Nothing left to dispatch' }]);

      // ---- take the stock out (the guard is part of the update: active, unexpired, in the SOURCE store, enough UNRESERVED units)
      const now = new Date();
      const seq = await nextSeq(req.orgId, 'dispatch', session);
      const reference = `DSP-${String(seq).padStart(4, '0')}`;
      const newId = new mongoose.Types.ObjectId();
      const dispatched = [];
      for (const [i, { item, quantity }] of lines.entries()) {
        const updated = await Batch.findOneAndUpdate(
          { _id: item.batchId, organizationId: req.orgId, status: 'active', expiryDate: { $gt: now }, ...inBranch(from._id, def), $expr: { $gte: [sellableUnitsExpr, quantity] } },
          { $inc: { availableQuantity: -quantity } },
          { returnDocument: 'after', session },
        );
        if (!updated) {
          const batch = await Batch.findOne({ _id: item.batchId, organizationId: req.orgId }, null, { session }).lean();
          const free = batch ? Math.max(0, batch.availableQuantity - batch.reservedQuantity) : 0;
          const why = !batch ? 'the batch no longer exists' : batch.status !== 'active' ? `the batch is ${batch.status}` : batch.expiryDate <= now ? 'the batch has expired' : `only ${free} unit(s) are available (${batch.availableQuantity} on hand, ${batch.reservedQuantity} reserved)`;
          throw fail(409, `Cannot dispatch ${quantity} of ${item.medicineName} batch ${item.batchNumber}: ${why}.`, 'INSUFFICIENT_STOCK', [{ path: `items.${i}.quantity`, message: 'Not enough available stock' }]);
        }
        await recordMovement(req, session, {
          medicineId: item.medicineId, batchId: item.batchId, type: 'TRANSFER_OUT', quantity: -quantity, balanceAfter: updated.availableQuantity,
          reason: `Dispatch ${reference} for transfer ${t.reference} to ${to.name}`, refType: 'Dispatch', refId: newId, branchId: from._id, fromBranchId: from._id, toBranchId: to._id,
        });
        const before = item.dispatchedQuantity || 0;
        dispatched.push({
          batchId: item.batchId, medicineId: item.medicineId, medicineName: item.medicineName, batchNumber: item.batchNumber,
          approvedQuantity: item.quantity, previouslyDispatched: before, dispatchedQuantity: quantity, remainingQuantity: item.quantity - before - quantity, balanceAfter: updated.availableQuantity,
        });
      }

      // ---- the transfer's new state. The filter includes dispatchSeq, so a dispatch that raced us and won makes this match nothing.
      const sent = new Map(dispatched.map((d) => [String(d.batchId), d.dispatchedQuantity]));
      const itemsAfter = t.items.map((it) => ({ ...it, dispatchedQuantity: (it.dispatchedQuantity || 0) + (sent.get(String(it.batchId)) || 0) }));
      const allSent = itemsAfter.every((it) => it.dispatchedQuantity >= it.quantity);
      const finished = allSent || closeShort;
      const update = await Transfer.updateOne(
        { _id: id, organizationId: req.orgId, status: { $in: ['approved', 'partially_dispatched'] }, dispatchSeq: t.dispatchSeq || 0 },
        {
          $set: {
            items: itemsAfter, status: finished ? 'in_transit' : 'partially_dispatched', lastDispatchedAt: now,
            ...(t.dispatchedAt ? {} : { dispatchedAt: now, dispatchedBy: req.user._id }),
            ...(closeShort && !allSent ? { closedShort: true } : {}),
          },
          $inc: { dispatchSeq: 1 },
        },
        { session },
      );
      if (!update.matchedCount) throw fail(409, `${t.reference} was changed by someone else while you were dispatching. Reload it and try again.`, 'RETRY');

      await Dispatch.create(
        [{
          _id: newId, organizationId: req.orgId, reference, transferId: t._id, transferReference: t.reference, fromBranchId: from._id, toBranchId: to._id,
          items: dispatched, totalUnits: dispatched.reduce((s, d) => s + d.dispatchedQuantity, 0), closedShort: closeShort && !allSent, notes,
          ...(idempotencyKey && { idempotencyKey }), dispatchedBy: req.user._id, dispatchedAt: now,
        }],
        { session },
      );
      await recordEvent(req, session, t, 'DISPATCHED', t.status, finished ? 'in_transit' : 'partially_dispatched', {
        branchId: from._id,
        remarks: notes || undefined,
        metadata: { dispatchReference: reference, units: dispatched.reduce((n, d) => n + d.dispatchedQuantity, 0), closedShort: closeShort && !allSent, lines: dispatched.map((d) => ({ batchNumber: d.batchNumber, dispatched: d.dispatchedQuantity, remaining: d.remainingQuantity })) },
      });
      await audit(
        req,
        {
          action: 'TRANSFER_DISPATCH', entity: 'Transfer', entityId: t._id,
          message: `Dispatch ${reference} for transfer ${t.reference}: ${dispatched.reduce((s, d) => s + d.dispatchedQuantity, 0)} units, ${from.name} → ${to.name}${finished ? '' : ' (part of the transfer; more to dispatch)'}${closeShort && !allSent ? ' — closed short' : ''}`,
          meta: { dispatchReference: reference },
        },
        session,
      );
      return newId;
    });
  } catch (e) {
    if (idempotencyKey) {
      // A request with the same key committed first (a double click or a retry): hand back ITS result instead of an error.
      const first = await Dispatch.findOne({ organizationId: req.orgId, idempotencyKey, transferId: id }).lean();
      if (first) return { ...(await getTransfer(req.orgId, id)), dispatch: presentDispatch(first), duplicate: true };
    }
    if (e.code === 11000) throw fail(409, 'The transfer changed while it was being dispatched. Please try again.', 'RETRY');
    throw e;
  }
  const created = await Dispatch.findOne({ _id: dispatchId, organizationId: req.orgId }).lean();
  return { ...(await getTransfer(req.orgId, id)), dispatch: presentDispatch(created), duplicate: false };
}

/**
 * Receives stock at the DESTINATION branch — all of it, or part of it (a transfer can be received in several goes).
 *
 *   items         [{ batchId, receivedQuantity, damagedQuantity?, missingQuantity?, remarks? }]  what the receiver counted on each line.
 *                 Omitted = everything still expected arrived in good condition. Per line: received + damaged + missing can never exceed
 *                 what was dispatched minus what earlier receipts already accounted for. Damaged or missing units need remarks.
 *   closeReceipt  nothing more is coming: whatever is still expected is written off as missing (needs overall remarks).
 *   idempotencyKey  makes the request safe to repeat: the same key returns the original receipt instead of crediting stock again.
 *
 * ONLY the good units (receivedQuantity) are credited to the destination store, and only when this request is confirmed — never at
 * dispatch. Damaged and missing units are recorded on the transfer, the receipt and the history but credit no batch (they left the
 * source store and never became sellable stock at the destination), so every dispatched unit ends up in exactly one place: received,
 * damaged, missing, or still expected. ONE transaction does everything or nothing: the batch credits, a TRANSFER_IN ledger entry per
 * batch, the permanent Receipt record (unique reference RCV-0001 …, receiver, time), the transfer's new state (completed automatically
 * when every unit is accounted for, otherwise partially received), the history event and the audit entry.
 */
export async function receiveTransfer(req, id, { items: requested, closeReceipt = false, remarks = '', idempotencyKey } = {}) {
  if (bad(id)) throw fail(404, 'Transfer not found');

  const asDuplicate = async (first) => ({ ...(await getTransfer(req.orgId, id)), receipt: first, duplicate: true });
  if (idempotencyKey) {
    const earlier = await Receipt.findOne({ organizationId: req.orgId, idempotencyKey }).lean();
    if (earlier) {
      if (String(earlier.transferId) !== String(id)) throw fail(409, 'This receipt key was already used for another transfer.', 'IDEMPOTENCY_CONFLICT');
      return asDuplicate(earlier);
    }
  }

  let receiptId;
  try {
    receiptId = await withTransaction(async (session) => {
      const t = await Transfer.findOne({ _id: id, organizationId: req.orgId, status: { $in: ['in_transit', 'partially_received'] } }, null, { session }).lean();
      if (!t) throw await notInState(req.orgId, id, 'in transit');
      const [from, to] = await Promise.all([Branch.findOne({ _id: t.fromBranchId, organizationId: req.orgId }, null, { session }).lean(), Branch.findOne({ _id: t.toBranchId, organizationId: req.orgId }, null, { session }).lean()]);
      if (!to || to.status !== 'active') throw fail(409, `${to?.name || 'The destination store'} is inactive, so it cannot receive stock.`, 'BRANCH_INACTIVE');
      const def = await defaultBranchId(req.orgId, session);
      const note = String(remarks || '').trim();
      if (closeReceipt && note.length < 3) throw fail(400, 'Explain why you are closing the receipt with units still missing (at least 3 characters).', 'RECEIPT_INVALID', [{ path: 'remarks', message: 'Explain why the rest is not coming' }]);

      // ---- what the receiver counted
      const prog = new Map(t.items.map((it) => [String(it.batchId), progress(it, t.status)]));
      const wanted = requested?.length
        ? requested
        : t.items
            .filter((it) => prog.get(String(it.batchId)).remaining > 0)
            .map((it) => ({ batchId: String(it.batchId), receivedQuantity: closeReceipt ? 0 : prog.get(String(it.batchId)).remaining, damagedQuantity: 0, missingQuantity: closeReceipt ? prog.get(String(it.batchId)).remaining : 0, remarks: closeReceipt ? `Receipt closed: ${note}` : '' }));
      const problems = [];
      const seen = new Set();
      const counted = new Map(); // batchId -> { r, d, m, remarks }
      wanted.forEach((w, i) => {
        const problem = (field, message) => problems.push({ path: `items.${i}.${field}`, message });
        if (seen.has(String(w.batchId))) return problem('batchId', 'This batch is already on the receipt');
        seen.add(String(w.batchId));
        const item = t.items.find((x) => String(x.batchId) === String(w.batchId));
        if (!item) return problem('batchId', 'This batch is not part of the transfer');
        const p = prog.get(String(item.batchId));
        const r = w.receivedQuantity ?? 0;
        const d = w.damagedQuantity ?? 0;
        const m = w.missingQuantity ?? 0;
        if (r + d + m === 0) return problem('receivedQuantity', 'Enter what arrived, or leave this line out');
        if (r > p.remaining) return problem('receivedQuantity', p.remaining === 0 ? `${item.medicineName} batch ${item.batchNumber} has already been fully accounted for` : `Cannot receive more than the ${p.remaining} still expected (dispatched ${p.dispatched}, already received ${p.received})`);
        if (r + d + m > p.remaining) return problem('missingQuantity', `Received + damaged + missing (${r + d + m}) is more than the ${p.remaining} still expected`);
        const text = String(w.remarks || '').trim();
        if ((d > 0 || m > 0) && text.length < 3) return problem('remarks', 'Explain the damaged or missing quantity (at least 3 characters)');
        counted.set(String(item.batchId), { r, d, m, remarks: text });
      });
      if (problems.length) throw fail(400, problems[0].message, 'RECEIPT_INVALID', problems);
      if (!counted.size && !closeReceipt) throw fail(400, 'There is nothing to receive: enter at least one quantity.', 'RECEIPT_INVALID', [{ path: 'items', message: 'Enter at least one quantity' }]);

      // ---- closing the receipt writes off whatever is still expected as missing, which needs an explanation
      if (closeReceipt) {
        if (note.length < 3) throw fail(400, 'Explain why you are closing the receipt with units still missing (at least 3 characters).', 'RECEIPT_INVALID', [{ path: 'remarks', message: 'Explain why the rest is not coming' }]);
        for (const it of t.items) {
          const p = prog.get(String(it.batchId));
          const c = counted.get(String(it.batchId)) || { r: 0, d: 0, m: 0, remarks: '' };
          const left = p.remaining - c.r - c.d - c.m;
          if (left > 0) counted.set(String(it.batchId), { ...c, m: c.m + left, remarks: c.remarks || `Receipt closed: ${note}` });
        }
      }
      if (![...counted.values()].some((c) => c.r + c.d + c.m > 0)) throw fail(400, 'There is nothing to receive or close on this transfer.', 'RECEIPT_INVALID', [{ path: 'items', message: 'Nothing to receive' }]);

      // ---- credit the destination store with the GOOD units only
      const now = new Date();
      const seq = await nextSeq(req.orgId, 'receipt', session);
      const reference = `RCV-${String(seq).padStart(4, '0')}`;
      const newId = new mongoose.Types.ObjectId();
      const lines = [];
      for (const it of t.items) {
        const c = counted.get(String(it.batchId));
        if (!c) continue;
        const p = prog.get(String(it.batchId));
        let destinationBatchId;
        let balance;
        if (c.r > 0) {
          const source = await Batch.findOne({ _id: it.batchId, organizationId: req.orgId }, null, { session }).lean();
          if (!source) throw fail(409, `Batch ${it.batchNumber} no longer exists.`, 'BATCH_MISSING');
          const held = await Batch.findOne({ organizationId: req.orgId, medicineId: it.medicineId, batchNumber: it.batchNumber, ...inBranch(to._id, def) }, null, { session }).lean();
          if (held) {
            if (held.expiryDate.getTime() !== source.expiryDate.getTime()) {
              throw fail(409, `${to.name} already holds batch ${it.batchNumber} of ${it.medicineName} with a different expiry date.`, 'BATCH_CONFLICT');
            }
            const upd = await Batch.findOneAndUpdate(
              { _id: held._id, organizationId: req.orgId },
              { $inc: { availableQuantity: c.r }, ...(held.status === 'archived' && { $set: { status: 'active' } }) },
              { returnDocument: 'after', session },
            );
            balance = upd.availableQuantity;
            destinationBatchId = held._id;
          } else {
            const [created] = await Batch.create(
              [{
                organizationId: req.orgId, medicineId: it.medicineId, batchNumber: it.batchNumber, manufacturer: source.manufacturer,
                manufacturingDate: source.manufacturingDate, expiryDate: source.expiryDate, purchasePrice: source.purchasePrice,
                sellingPrice: source.sellingPrice, mrp: source.mrp, initialQuantity: c.r, availableQuantity: c.r,
                reservedQuantity: 0, branchId: to._id, supplierId: source.supplierId, status: 'active',
              }],
              { session },
            );
            balance = created.availableQuantity;
            destinationBatchId = created._id;
          }
          await recordMovement(req, session, {
            medicineId: it.medicineId, batchId: destinationBatchId, type: 'TRANSFER_IN', quantity: c.r, balanceAfter: balance,
            reason: `Receipt ${reference} for transfer ${t.reference} from ${from?.name || 'another store'}`, refType: 'Receipt', refId: newId, branchId: to._id, fromBranchId: t.fromBranchId, toBranchId: to._id,
          });
        }
        lines.push({
          batchId: it.batchId, ...(destinationBatchId && { destinationBatchId }), medicineId: it.medicineId, medicineName: it.medicineName, batchNumber: it.batchNumber,
          dispatchedQuantity: p.dispatched, previouslyReceived: p.received, previouslyReported: p.damaged + p.missing,
          receivedQuantity: c.r, damagedQuantity: c.d, missingQuantity: c.m, remainingQuantity: p.remaining - c.r - c.d - c.m,
          ...(c.remarks && { remarks: c.remarks }), ...(balance !== undefined && { balanceAfter: balance }),
        });
      }

      // ---- the transfer's new state. The filter includes receiptSeq, so a receipt that raced us and won makes this match nothing.
      const itemsAfter = t.items.map((it) => {
        const p = prog.get(String(it.batchId));
        const c = counted.get(String(it.batchId));
        return {
          ...it,
          dispatchedQuantity: p.dispatched,
          receivedQuantity: p.received + (c?.r || 0),
          damagedQuantity: p.damaged + (c?.d || 0),
          missingQuantity: p.missing + (c?.m || 0),
          ...(c?.remarks ? { remarks: [it.remarks, `[${reference}] ${c.remarks}`].filter(Boolean).join(' · ').slice(0, 600) } : {}),
        };
      });
      const complete = itemsAfter.every((it) => it.dispatchedQuantity - it.receivedQuantity - it.damagedQuantity - it.missingQuantity <= 0);
      const newStatus = complete ? 'completed' : 'partially_received';
      const update = await Transfer.updateOne(
        { _id: id, organizationId: req.orgId, status: { $in: ['in_transit', 'partially_received'] }, receiptSeq: t.receiptSeq || 0 },
        { $set: { items: itemsAfter, status: newStatus, receivedBy: req.user._id, receivedAt: now, ...(closeReceipt ? { receiptClosed: true } : {}) }, $inc: { receiptSeq: 1 } },
        { session },
      );
      if (!update.matchedCount) throw fail(409, `${t.reference} was changed by someone else while you were receiving it. Reload it and try again.`, 'RETRY');

      const totals = lines.reduce((s, l) => ({ r: s.r + l.receivedQuantity, d: s.d + l.damagedQuantity, m: s.m + l.missingQuantity }), { r: 0, d: 0, m: 0 });
      await Receipt.create(
        [{
          _id: newId, organizationId: req.orgId, reference, transferId: t._id, transferReference: t.reference, fromBranchId: t.fromBranchId, toBranchId: to._id,
          items: lines, totalReceived: totals.r, totalDamaged: totals.d, totalMissing: totals.m, closed: Boolean(closeReceipt), remarks: note,
          ...(idempotencyKey && { idempotencyKey }), receivedBy: req.user._id, receivedByName: req.user.name, receivedAt: now,
        }],
        { session },
      );
      await recordEvent(req, session, t, 'RECEIVED', t.status, newStatus, {
        branchId: to._id,
        remarks: note || (totals.d || totals.m ? lines.filter((l) => l.remarks).map((l) => `${l.medicineName}: ${l.remarks}`).join('; ').slice(0, 500) : undefined),
        metadata: { receiptReference: reference, received: totals.r, damaged: totals.d, missing: totals.m, closed: Boolean(closeReceipt), complete, lines: lines.map((l) => ({ batchNumber: l.batchNumber, received: l.receivedQuantity, damaged: l.damagedQuantity, missing: l.missingQuantity, remaining: l.remainingQuantity })) },
      });
      await audit(
        req,
        {
          action: 'TRANSFER_RECEIVE', entity: 'Transfer', entityId: t._id,
          message: `Receipt ${reference} for transfer ${t.reference} at ${to.name}: ${totals.r} received${totals.d ? `, ${totals.d} damaged` : ''}${totals.m ? `, ${totals.m} missing` : ''}${complete ? '' : ' (part of the transfer; more expected)'}`,
          meta: { receiptReference: reference },
        },
        session,
      );
      return newId;
    });
  } catch (e) {
    if (idempotencyKey) {
      // A request with the same key committed first (a double click or a retry): hand back ITS result instead of an error.
      const first = await Receipt.findOne({ organizationId: req.orgId, idempotencyKey, transferId: id }).lean();
      if (first) return asDuplicate(first);
    }
    if (e.code === 11000) throw fail(409, 'The destination batch changed while receiving. Please try again.', 'RETRY');
    throw e;
  }
  const created = await Receipt.findOne({ _id: receiptId, organizationId: req.orgId }).lean();
  return { ...(await getTransfer(req.orgId, id)), receipt: created, duplicate: false };
}

/**
 * Cancels a transfer that has not been received. Before dispatch nothing has moved, so there is nothing to undo; after
 * dispatch the units in transit go back to the source store's batches (with a ledger entry).
 */
export async function cancelTransfer(req, id, reason = '') {
  if (bad(id)) throw fail(404, 'Transfer not found');
  await withTransaction(async (session) => {
    const before = await Transfer.findOneAndUpdate(
      { _id: id, organizationId: req.orgId, status: { $in: CANCELLABLE_TRANSFER_STATUSES } },
      { $set: { status: 'cancelled', cancelledBy: req.user._id, cancelledAt: new Date(), ...(reason && { cancelReason: reason }) } },
      { returnDocument: 'before', session },
    );
    if (!before) throw await notInState(req.orgId, id, 'draft, submitted, approved or in transit (nothing received yet)');
    if (IN_TRANSIT_STATUSES.includes(before.status)) {
      for (const line of before.items) {
        const back = line.dispatchedQuantity ?? line.quantity; // only what actually left the source store goes back
        if (back <= 0) continue;
        const it = { batchId: line.batchId, medicineId: line.medicineId, medicineName: line.medicineName, batchNumber: line.batchNumber, expiryDate: line.expiryDate, quantity: back };
        const batch = await Batch.findOne({ _id: it.batchId, organizationId: req.orgId }, null, { session }).lean();
        if (!batch) throw fail(409, `Batch ${it.batchNumber} no longer exists, so the units cannot be returned.`, 'BATCH_MISSING');
        const upd = await Batch.findOneAndUpdate(
          { _id: it.batchId, organizationId: req.orgId },
          { $inc: { availableQuantity: it.quantity }, ...(batch.status === 'archived' && { $set: { status: 'active' } }) },
          { returnDocument: 'after', session },
        );
        await recordMovement(req, session, {
          medicineId: it.medicineId, batchId: it.batchId, type: 'TRANSFER_IN', quantity: it.quantity, balanceAfter: upd.availableQuantity,
          reason: `Transfer ${before.reference} cancelled — units returned`, refType: 'Transfer', refId: before._id, branchId: before.fromBranchId, fromBranchId: before.toBranchId, toBranchId: before.fromBranchId,
        });
      }
    }
    await recordEvent(req, session, before, 'CANCELLED', before.status, 'cancelled', { branchId: before.fromBranchId, remarks: reason || undefined, metadata: { unitsReturned: IN_TRANSIT_STATUSES.includes(before.status) ? before.items.reduce((n, i) => n + (i.dispatchedQuantity ?? i.quantity), 0) : 0 } });
    await audit(req, { action: 'TRANSFER_CANCEL', entity: 'Transfer', entityId: before._id, message: `Transfer ${before.reference} cancelled${IN_TRANSIT_STATUSES.includes(before.status) ? ' — units returned to the source store' : ''}${reason ? ` (${reason})` : ''}` }, session);
  });
  return getTransfer(req.orgId, id);
}

/** Units currently on the road: dispatched and neither received, nor reported damaged or missing. */
export async function unitsInTransit(orgId, scope = null) {
  const accounted = { $add: [{ $ifNull: ['$items.receivedQuantity', 0] }, { $ifNull: ['$items.damagedQuantity', 0] }, { $ifNull: ['$items.missingQuantity', 0] }] };
  const [r] = await Transfer.aggregate([
    { $match: { organizationId: orgId, status: { $in: IN_TRANSIT_STATUSES }, ...(scope && { $and: [scope] }) } },
    { $unwind: '$items' },
    { $group: { _id: null, units: { $sum: { $max: [0, { $subtract: [{ $ifNull: ['$items.dispatchedQuantity', '$items.quantity'] }, accounted] }] } }, transfers: { $addToSet: '$_id' } } },
  ]);
  return { units: r?.units ?? 0, transfers: r?.transfers.length ?? 0 };
}

/** The permanent history of a transfer, oldest first. Still readable after a draft has been deleted. */
export async function listTransferEvents(orgId, id, { page = 1, limit = 50 } = {}) {
  if (bad(id)) throw fail(404, 'Transfer not found');
  const filter = { organizationId: orgId, transferId: oid(id) };
  const [rows, total] = await Promise.all([
    TransferEvent.find(filter).sort({ timestamp: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    TransferEvent.countDocuments(filter),
  ]);
  if (!total && !(await Transfer.exists({ _id: id, organizationId: orgId }))) throw fail(404, 'Transfer not found');
  const branches = await loadBranches(orgId, [...new Set(rows.map((e) => e.branchId).filter(Boolean).map(String))].map(oid));
  return paginated(rows.map((e) => ({ ...e, branchName: e.branchId ? branches.get(String(e.branchId))?.name : undefined })), { page, limit, total });
}

export { OPEN_TRANSFER_STATUSES };

/** Everything the printable transfer document needs, assembled on the server from the stored records. */
export async function getTransferPrint(req, id) {
  const transfer = await getTransfer(req.orgId, id);
  const org = await Organization.findById(req.orgId).select('name email phone address gstin').lean();
  const a = org?.address || {};
  return {
    organization: {
      name: org?.name || '', email: org?.email || '', phone: org?.phone || '', gstin: org?.gstin || '',
      address: [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.pincode].filter(Boolean).join(', '),
    },
    transfer,
    printedAt: new Date(),
    printedBy: { id: req.user?._id, name: req.user?.name },
  };
}

/* ------------------------------------------------------------------------------------------------ notifications */

const NOTIFY_DAYS = 14;
const NOTIFY_ACTIONS = ['SUBMITTED', 'APPROVED', 'REJECTED', 'DISPATCHED', 'RECEIVED'];

/**
 * In-app notifications are derived from the permanent TransferEvent history (nothing is stored twice): submitted for approval,
 * approved, rejected, dispatched, received, partial receipt, completed. Only transfers at the user's own stores are included, and
 * "submitted for approval" only goes to people who can approve. Newest first. "Read" state is per person and kept by the browser.
 */
export async function transferNotifications(req, scope, perms, limit = 30) {
  const since = new Date(Date.now() - NOTIFY_DAYS * 86400000);
  const events = await TransferEvent.find({ organizationId: req.orgId, action: { $in: NOTIFY_ACTIONS }, timestamp: { $gte: since } }).sort({ timestamp: -1, _id: -1 }).limit(200).lean();
  const transfers = await Transfer.find({ organizationId: req.orgId, _id: { $in: [...new Set(events.map((e) => String(e.transferId)))] } }).select('reference status fromBranchId toBranchId approvalRequired').lean();
  const byId = new Map(transfers.map((t) => [String(t._id), t]));
  const branches = await loadBranches(req.orgId, [...new Set(transfers.flatMap((t) => [String(t.fromBranchId), String(t.toBranchId)]))].map(oid));
  const allowed = scope ? new Set(scope.map(String)) : null;
  const out = [];
  for (const e of events) {
    const t = byId.get(String(e.transferId));
    if (!t) continue;
    if (allowed && !allowed.has(String(t.fromBranchId)) && !allowed.has(String(t.toBranchId))) continue;
    const route = `${branches.get(String(t.fromBranchId))?.name || 'Source'} → ${branches.get(String(t.toBranchId))?.name || 'Destination'}`;
    let kind;
    let text;
    if (e.action === 'SUBMITTED') {
      if (e.newStatus !== 'submitted') continue; // approval was not required: nothing to approve
      if (!perms.includes('transfer:approve')) continue;
      [kind, text] = ['submitted', 'submitted for approval'];
    } else if (e.action === 'APPROVED') [kind, text] = ['approved', 'approved'];
    else if (e.action === 'REJECTED') [kind, text] = ['rejected', `rejected${e.remarks ? ` — ${e.remarks}` : ''}`];
    else if (e.action === 'DISPATCHED') [kind, text] = ['dispatched', e.newStatus === 'partially_dispatched' ? 'partly dispatched' : 'dispatched — stock is on its way'];
    else if (e.newStatus === 'completed') [kind, text] = ['completed', 'received — transfer completed'];
    else [kind, text] = ['partial', 'partial receipt recorded — the rest is still expected'];
    out.push({ id: String(e._id), kind, transferId: String(t._id), reference: t.reference, route, message: `${t.reference} ${text}`, by: e.performedByName || '', at: e.timestamp });
    if (out.length >= limit) break;
  }
  return out;
}
