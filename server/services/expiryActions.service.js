import mongoose from 'mongoose';
import { Batch, Branch, Invoice, Medicine, Supplier } from '../models/index.js';
import { hasPermission } from '../config/permissions.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from './audit.service.js';
import { recordMovement } from './ledger.service.js';
import { withTransaction } from './transaction.service.js';
import { reportableBranches, round2 } from './analytics.service.js';
import { expirySettings } from './analyticsExpiry.service.js';

/**
 * What a pharmacist can DO about expiring stock, from the Expiry Intelligence register.
 *
 * THE RULE THAT SHAPES ALL OF THIS: only one of these actions moves stock.
 *
 *   dispose           writes the stock off  — it is gone, and the ledger says so
 *   returnSettle:returned  removes the stock — the supplier physically took it back
 *   everything else   moves NOTHING. Flagging a lot for clearance records a SUGGESTED discount and does not touch
 *                     the selling price; requesting a supplier return quarantines the lot so it cannot be sold, but
 *                     the units are still ours and still on the books until the supplier actually takes them.
 *
 * That distinction is the whole safety story of this screen. A report is allowed to be wrong; stock is not. Every
 * action that does move stock goes through the same append-only ledger as every other movement in the system, inside
 * a transaction, and every action of any kind writes an audit entry naming who did it and why.
 *
 * Quarantine is reversible. A supplier who refuses, or a change of mind, puts the lot back on sale — see `returnSettle`.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** The actions this endpoint accepts. */
export const EXPIRY_ACTIONS = ['dispose', 'clearance', 'clearanceClear', 'returnRequest', 'returnSettle'];
/** How a supplier return can end. Only `returned` takes the stock off the books. */
export const RETURN_OUTCOMES = ['returned', 'rejected', 'cancelled'];

/**
 * Writing stock off is destructive and irreversible, so it asks for more than the permission to edit stock:
 * `inventory:delete`, which by default only an organization administrator and an inventory manager hold. Flagging a
 * lot for clearance or asking a supplier to take it back changes nothing that cannot be undone, so those need only
 * `inventory:write`, which the route already enforces.
 */
const DISPOSE_PERMISSION = 'inventory:delete';

/**
 * The lots an action may touch: this organization's, in a store the person may act in, and not already finished with.
 * Loading them up front means a bulk action either applies to every lot named or to none of them — a half-applied
 * disposal across forty lots would be impossible to unpick.
 */
async function loadTargets(req, batchIds, { allowDisposed = false } = {}) {
  const branches = reportableBranches(req.user, null); // null = every store this person may act in
  const ids = [...new Set(batchIds.map(String))];
  const batches = await Batch.find({
    _id: { $in: ids.map(oid) },
    organizationId: req.orgId,
    ...(branches ? { branchId: { $in: branches } } : {}),
  }).lean();

  if (batches.length !== ids.length) {
    const found = new Set(batches.map((b) => String(b._id)));
    const missing = ids.filter((id) => !found.has(id));
    throw new ApiError(
      404,
      missing.length === ids.length
        ? 'Those lots could not be found in a store you can act in.'
        : `${missing.length} of the ${ids.length} lots could not be found in a store you can act in. Nothing was changed.`,
      undefined,
      'BATCH_NOT_FOUND',
    );
  }
  if (!allowDisposed) {
    const gone = batches.filter((b) => b.disposedAt);
    if (gone.length) throw new ApiError(409, `${gone.length === 1 ? 'That lot has' : `${gone.length} of those lots have`} already been written off. Nothing was changed.`, undefined, 'BATCH_DISPOSED');
  }
  if (batches.some((b) => b.status === 'archived')) throw new ApiError(409, 'An archived lot cannot be acted on.', undefined, 'BATCH_ARCHIVED');
  return batches;
}

/** The medicine names for an audit message, so the trail reads as English rather than as object ids. */
async function nameMap(orgId, batches, session) {
  const meds = await Medicine.find({ _id: { $in: batches.map((b) => b.medicineId) }, organizationId: orgId }, null, { session }).select('medicineName').lean();
  return new Map(meds.map((m) => [String(m._id), m.medicineName]));
}
const describe = (b, names) => `${names.get(String(b.medicineId)) || 'Unknown medicine'} batch ${b.batchNumber}`;

/* ------------------------------------------------------------------ disposal */

/**
 * Writes lots off. This is the one action that destroys stock, so it is the one with the strictest permission, a
 * required reason, and a full ledger entry per lot.
 *
 * The units leave through the ordinary stock ledger (`WRITE_OFF`), exactly as a manual write-off would, so the
 * invariant the rest of the system relies on — that the sum of a batch's ledger entries equals its quantity on hand —
 * still holds afterwards. Reserved units block a disposal: stock promised to an order cannot be destroyed underneath it.
 */
export async function disposeBatches(req, { batchIds, reason }) {
  if (!hasPermission(req.user, DISPOSE_PERMISSION)) {
    throw new ApiError(403, 'Writing stock off needs permission to delete inventory. Ask an administrator.', undefined, 'FORBIDDEN');
  }
  const targets = await loadTargets(req, batchIds);

  const blocked = targets.filter((b) => (b.reservedQuantity || 0) > 0);
  if (blocked.length) {
    throw new ApiError(
      409,
      `${blocked.length === 1 ? 'A lot has' : `${blocked.length} lots have`} units reserved for an order. Release the reservation first. Nothing was changed.`,
      undefined,
      'STOCK_RESERVED',
    );
  }

  return withTransaction(async (session) => {
    const names = await nameMap(req.orgId, targets, session);
    const done = [];
    for (const b of targets) {
      const quantity = b.availableQuantity || 0;
      if (quantity > 0) {
        // The guard is part of the update, so a sale landing at the same instant cannot leave the batch negative.
        const updated = await Batch.findOneAndUpdate(
          { _id: b._id, organizationId: req.orgId, availableQuantity: quantity, reservedQuantity: { $lte: 0 } },
          { $set: { availableQuantity: 0, status: 'archived', disposedAt: new Date(), disposedBy: req.user._id, disposalReason: reason } },
          { returnDocument: 'after', session },
        );
        if (!updated) throw new ApiError(409, `The stock on ${describe(b, names)} changed while it was being written off. Nothing was changed — look again and retry.`, undefined, 'STOCK_CHANGED');

        await recordMovement(req, session, {
          medicineId: b.medicineId,
          batchId: b._id,
          type: 'WRITE_OFF',
          quantity: -quantity,
          balanceAfter: 0,
          reason: `Expiry write-off: ${reason}`,
          refType: 'ExpiryDisposal',
          refId: b._id,
          branchId: b.branchId,
        });
      } else {
        await Batch.updateOne(
          { _id: b._id, organizationId: req.orgId },
          { $set: { status: 'archived', disposedAt: new Date(), disposedBy: req.user._id, disposalReason: reason } },
          { session },
        );
      }
      done.push({ id: String(b._id), quantity, value: round2(quantity * (b.purchasePrice || 0)) });
    }

    const units = done.reduce((n, d) => n + d.quantity, 0);
    const value = round2(done.reduce((n, d) => n + d.value, 0));
    await audit(
      req,
      {
        action: 'EXPIRY_DISPOSE',
        entity: 'Batch',
        entityId: targets.length === 1 ? targets[0]._id : undefined,
        message: `Expiry write-off — ${targets.length} lot${targets.length === 1 ? '' : 's'}, ${units} units, ₹${value}: ${reason}${targets.length === 1 ? ` (${describe(targets[0], names)})` : ''}`,
        meta: { reason, batchIds: done.map((d) => d.id), units, value },
      },
      session,
    );
    return { action: 'dispose', batches: done.length, units, value, reason };
  });
}

/* ------------------------------------------------------------------ clearance */

/**
 * Flags lots for clearance at a SUGGESTED discount.
 *
 * It deliberately does not change `sellingPrice`. A report that quietly repriced stock would be a report nobody could
 * trust, and the discount a pharmacy actually offers depends on things this system cannot see — a standing promotion,
 * what the shop down the road is charging, whether the customer is a hospital. So this records the advice and leaves
 * the decision with whoever sets prices.
 */
export async function flagClearance(req, { batchIds, discountPercent, note }) {
  const targets = await loadTargets(req, batchIds);
  const ceiling = expirySettings(req.tenant.organization).clearanceMaxDiscount;
  if (discountPercent > ceiling) {
    throw new ApiError(400, `This organization's largest clearance discount is ${ceiling}%.`, [{ path: 'discountPercent', message: `Choose ${ceiling}% or less` }], 'DISCOUNT_TOO_LARGE');
  }

  return withTransaction(async (session) => {
    const names = await nameMap(req.orgId, targets, session);
    await Batch.updateMany(
      { _id: { $in: targets.map((b) => b._id) }, organizationId: req.orgId },
      { $set: { 'clearance.flagged': true, 'clearance.discountPercent': discountPercent, 'clearance.note': note || '', 'clearance.flaggedAt': new Date(), 'clearance.flaggedBy': req.user._id } },
      { session },
    );
    await audit(
      req,
      {
        action: 'EXPIRY_CLEARANCE_FLAG',
        entity: 'Batch',
        entityId: targets.length === 1 ? targets[0]._id : undefined,
        message: `Marked for clearance at ${discountPercent}% — ${targets.length} lot${targets.length === 1 ? '' : 's'}${targets.length === 1 ? ` (${describe(targets[0], names)})` : ''}. Selling prices were not changed.`,
        meta: { discountPercent, note: note || '', batchIds: targets.map((b) => String(b._id)) },
      },
      session,
    );
    return { action: 'clearance', batches: targets.length, discountPercent };
  });
}

/** Takes lots off clearance. The suggestion is withdrawn; nothing about the stock itself changes. */
export async function clearClearance(req, { batchIds }) {
  const targets = await loadTargets(req, batchIds, { allowDisposed: true });
  return withTransaction(async (session) => {
    await Batch.updateMany(
      { _id: { $in: targets.map((b) => b._id) }, organizationId: req.orgId },
      { $set: { 'clearance.flagged': false }, $unset: { 'clearance.discountPercent': '', 'clearance.note': '' } },
      { session },
    );
    await audit(
      req,
      { action: 'EXPIRY_CLEARANCE_CLEAR', entity: 'Batch', entityId: targets.length === 1 ? targets[0]._id : undefined, message: `Taken off clearance — ${targets.length} lot${targets.length === 1 ? '' : 's'}`, meta: { batchIds: targets.map((b) => String(b._id)) } },
      session,
    );
    return { action: 'clearanceClear', batches: targets.length };
  });
}

/* ------------------------------------------------------------------ supplier returns */

/**
 * Asks the supplier to take lots back, and QUARANTINES them so they cannot be sold in the meantime.
 *
 * No debit note is raised and no money moves: this system has no purchase-return document, and inventing a financial
 * record here would be worse than not having one. What it records is the intention, the stock set aside, and an audit
 * entry — enough to produce a list to send the distributor, and enough to undo.
 *
 * A lot with no supplier recorded cannot be sent back, because there is nobody to send it to. That is refused plainly
 * rather than being silently skipped in a bulk action.
 */
export async function requestSupplierReturn(req, { batchIds, note }) {
  const targets = await loadTargets(req, batchIds);

  const orphans = targets.filter((b) => !b.supplierId);
  if (orphans.length) {
    throw new ApiError(
      409,
      `${orphans.length === 1 ? 'That lot has' : `${orphans.length} of those lots have`} no supplier recorded, so there is nobody to send ${orphans.length === 1 ? 'it' : 'them'} back to. Nothing was changed.`,
      undefined,
      'NO_SUPPLIER',
    );
  }
  const already = targets.filter((b) => b.supplierReturn?.status === 'requested' || b.supplierReturn?.status === 'returned');
  if (already.length) throw new ApiError(409, `${already.length === 1 ? 'A lot is' : `${already.length} lots are`} already part of a supplier return. Nothing was changed.`, undefined, 'RETURN_EXISTS');

  return withTransaction(async (session) => {
    const names = await nameMap(req.orgId, targets, session);
    await Batch.updateMany(
      { _id: { $in: targets.map((b) => b._id) }, organizationId: req.orgId },
      { $set: { status: 'quarantined', 'supplierReturn.status': 'requested', 'supplierReturn.note': note || '', 'supplierReturn.markedAt': new Date(), 'supplierReturn.markedBy': req.user._id } },
      { session },
    );
    const units = targets.reduce((n, b) => n + (b.availableQuantity || 0), 0);
    const value = round2(targets.reduce((n, b) => n + (b.availableQuantity || 0) * (b.purchasePrice || 0), 0));
    await audit(
      req,
      {
        action: 'EXPIRY_RETURN_REQUEST',
        entity: 'Batch',
        entityId: targets.length === 1 ? targets[0]._id : undefined,
        message: `Supplier return requested — ${targets.length} lot${targets.length === 1 ? '' : 's'}, ${units} units, ₹${value}${targets.length === 1 ? ` (${describe(targets[0], names)})` : ''}. The stock is quarantined and remains ours until the supplier takes it.`,
        meta: { note: note || '', batchIds: targets.map((b) => String(b._id)), units, value },
      },
      session,
    );
    return { action: 'returnRequest', batches: targets.length, units, value };
  });
}

/**
 * Closes a supplier return one of three ways.
 *
 *   returned   the supplier took the goods: the stock leaves through the ledger and the lot is archived
 *   rejected   the supplier refused: the stock is ours, comes out of quarantine and goes back on sale
 *   cancelled  we changed our minds: the same, and the request is recorded as withdrawn
 *
 * Only the first moves stock. The other two exist so that quarantining a lot is never a one-way door — a pharmacist
 * who sets aside the wrong lot must be able to put it back without an administrator unpicking the database.
 */
export async function settleSupplierReturn(req, { batchIds, outcome, note }) {
  const targets = await loadTargets(req, batchIds);
  const notOpen = targets.filter((b) => b.supplierReturn?.status !== 'requested');
  if (notOpen.length) throw new ApiError(409, `${notOpen.length === 1 ? 'A lot has' : `${notOpen.length} lots have`} no open supplier return to close. Nothing was changed.`, undefined, 'NO_OPEN_RETURN');

  return withTransaction(async (session) => {
    const names = await nameMap(req.orgId, targets, session);
    const settled = { status: outcome, note: note || '', settledAt: new Date(), settledBy: req.user._id };
    let units = 0;
    let value = 0;

    for (const b of targets) {
      if (outcome === 'returned') {
        const quantity = b.availableQuantity || 0;
        if (quantity > 0) {
          const updated = await Batch.findOneAndUpdate(
            { _id: b._id, organizationId: req.orgId, availableQuantity: quantity },
            { $set: { availableQuantity: 0, status: 'archived', 'supplierReturn.status': outcome, 'supplierReturn.note': settled.note, 'supplierReturn.settledAt': settled.settledAt, 'supplierReturn.settledBy': settled.settledBy } },
            { returnDocument: 'after', session },
          );
          if (!updated) throw new ApiError(409, `The stock on ${describe(b, names)} changed while the return was being recorded. Nothing was changed — look again and retry.`, undefined, 'STOCK_CHANGED');

          await recordMovement(req, session, {
            medicineId: b.medicineId,
            batchId: b._id,
            type: 'ADJUSTMENT',
            quantity: -quantity,
            balanceAfter: 0,
            reason: `Returned to supplier${note ? `: ${note}` : ''}`,
            refType: 'SupplierReturn',
            refId: b._id,
            branchId: b.branchId,
          });
        } else {
          await Batch.updateOne({ _id: b._id, organizationId: req.orgId }, { $set: { status: 'archived', supplierReturn: { ...b.supplierReturn, ...settled } } }, { session });
        }
        units += quantity;
        value += quantity * (b.purchasePrice || 0);
      } else {
        // Refused or withdrawn: the lot comes out of quarantine and is sellable again exactly as it was.
        await Batch.updateOne(
          { _id: b._id, organizationId: req.orgId },
          { $set: { status: 'active', 'supplierReturn.status': outcome, 'supplierReturn.note': settled.note, 'supplierReturn.settledAt': settled.settledAt, 'supplierReturn.settledBy': settled.settledBy } },
          { session },
        );
      }
    }

    const WORD = { returned: 'taken back by the supplier', rejected: 'refused by the supplier', cancelled: 'withdrawn' };
    await audit(
      req,
      {
        action: `EXPIRY_RETURN_${outcome.toUpperCase()}`,
        entity: 'Batch',
        entityId: targets.length === 1 ? targets[0]._id : undefined,
        message:
          `Supplier return ${WORD[outcome]} — ${targets.length} lot${targets.length === 1 ? '' : 's'}` +
          (outcome === 'returned' ? `, ${units} units, ₹${round2(value)} removed from stock` : ', the stock is out of quarantine and back on sale') +
          (targets.length === 1 ? ` (${describe(targets[0], names)})` : ''),
        meta: { outcome, note: note || '', batchIds: targets.map((b) => String(b._id)), units, value: round2(value) },
      },
      session,
    );
    return { action: 'returnSettle', outcome, batches: targets.length, units, value: round2(value) };
  });
}

/* ------------------------------------------------------------------ the dispatcher */

/** Runs one action over one lot or many. Everything is validated before anything is written. */
export async function runExpiryAction(req, body) {
  switch (body.action) {
    case 'dispose':
      return disposeBatches(req, body);
    case 'clearance':
      return flagClearance(req, body);
    case 'clearanceClear':
      return clearClearance(req, body);
    case 'returnRequest':
      return requestSupplierReturn(req, body);
    case 'returnSettle':
      return settleSupplierReturn(req, body);
    default:
      throw new ApiError(400, 'That is not an action this report can take.', undefined, 'UNKNOWN_ACTION');
  }
}

/* ------------------------------------------------------------------ transfer advice */

/**
 * Which store would be most likely to sell this lot before it expires.
 *
 * It is ADVICE, not a transfer: moving stock between stores is its own module, with its own approvals, dispatch and
 * receipt steps, and short-circuiting that from a report would be a way to lose stock. So this answers the question
 * the pharmacist actually has — "where would this sell?" — and leaves the moving to the transfer screens.
 *
 * The answer is the store with the highest recent demand for the medicine, excluding the store already holding it,
 * together with how long that store would take to get through the lot.
 */
export async function transferSuggestion(org, user, batchId) {
  const orgId = org._id;
  const settings = expirySettings(org);
  const batch = await Batch.findOne({ _id: oid(batchId), organizationId: orgId }).lean();
  if (!batch) throw new ApiError(404, 'Batch not found');

  const since = new Date(Date.now() - settings.velocityWindowDays * 86400000);
  const rows = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: since } } },
    { $unwind: '$items' },
    { $match: { 'items.medicineId': batch.medicineId } },
    { $group: { _id: '$branchId', units: { $sum: { $max: [0, { $subtract: ['$items.quantity', { $ifNull: ['$items.returnedQuantity', 0] }] }] } } } },
    { $sort: { units: -1 } },
  ]);

  const scope = reportableBranches(user, null);
  const allowed = scope ? new Set(scope.map(String)) : null;
  const names = new Map((await Branch.find({ organizationId: orgId }).select('name status').lean()).map((b) => [String(b._id), b]));

  const candidates = rows
    .filter((r) => r._id && String(r._id) !== String(batch.branchId))
    .filter((r) => !allowed || allowed.has(String(r._id)))
    .filter((r) => names.get(String(r._id))?.status !== 'inactive')
    .map((r) => {
      const perDay = r.units / settings.velocityWindowDays;
      return {
        branchId: String(r._id),
        branchName: names.get(String(r._id))?.name || 'Unknown store',
        avgDailySales: round2(perDay),
        // How long that store would take to sell the whole lot at its own rate.
        daysToClear: perDay > 0 ? Math.ceil(batch.availableQuantity / perDay) : null,
      };
    });

  return {
    batchId: String(batch._id),
    currentBranchId: batch.branchId ? String(batch.branchId) : null,
    velocityWindowDays: settings.velocityWindowDays,
    candidates,
    best: candidates[0] || null,
    // Said plainly, because an empty list here is a real answer and not a failure.
    note: candidates.length ? 'Transfers are arranged in Stock Management → Inter Store Transfer. This is advice only; nothing has been moved.' : 'No other store has sold this medicine recently, so there is nowhere obvious to move it.',
  };
}

/* ------------------------------------------------------------------ one lot in detail */

/**
 * Everything behind one row, for the drawer: the lot, its medicine and supplier, how it has sold week by week, every
 * movement of its stock, and the audit trail of what people have done to it.
 */
export async function getBatchDetail(org, user, batchId) {
  const orgId = org._id;
  const settings = expirySettings(org);
  const branches = reportableBranches(user, null);
  const batch = await Batch.findOne({ _id: oid(batchId), organizationId: orgId, ...(branches ? { branchId: { $in: branches } } : {}) }).lean();
  if (!batch) throw new ApiError(404, 'Batch not found');

  const since = new Date(Date.now() - settings.velocityWindowDays * 86400000);
  const [medicine, supplier, branch, sales, movements, trail] = await Promise.all([
    Medicine.findOne({ _id: batch.medicineId, organizationId: orgId }).select('medicineName genericName manufacturer strength packSize unit hsnCode scheduleCategory categoryId').lean(),
    batch.supplierId ? Supplier.findOne({ _id: batch.supplierId, organizationId: orgId }).select('name code phone email procurement').lean() : null,
    batch.branchId ? Branch.findOne({ _id: batch.branchId, organizationId: orgId }).select('name').lean() : null,
    // Units of THIS lot sold per week, for the sparkline.
    Invoice.aggregate([
      { $match: { organizationId: orgId, status: 'completed', invoiceDate: { $gte: since } } },
      { $unwind: '$items' },
      { $match: { 'items.batchId': batch._id } },
      { $group: { _id: { $dateTrunc: { date: '$invoiceDate', unit: 'week' } }, units: { $sum: '$items.quantity' }, value: { $sum: '$items.amount' } } },
      { $sort: { _id: 1 } },
    ]),
    mongoose.model('StockMovement').find({ organizationId: orgId, batchId: batch._id }).sort({ createdAt: -1 }).limit(50).lean(),
    mongoose.model('AuditLog').find({ organizationId: orgId, entity: 'Batch', entityId: batch._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  return {
    id: String(batch._id),
    batchNumber: batch.batchNumber,
    expiryDate: batch.expiryDate?.toISOString() || null,
    manufacturingDate: batch.manufacturingDate?.toISOString() || null,
    receivedAt: batch.createdAt?.toISOString() || null,
    quantity: batch.availableQuantity,
    reservedQuantity: batch.reservedQuantity || 0,
    initialQuantity: batch.initialQuantity,
    purchasePrice: round2(batch.purchasePrice),
    sellingPrice: round2(batch.sellingPrice),
    mrp: round2(batch.mrp),
    batchStatus: batch.status,
    disposedAt: batch.disposedAt?.toISOString() || null,
    disposalReason: batch.disposalReason || null,
    clearance: batch.clearance?.flagged ? { ...batch.clearance, flaggedAt: batch.clearance.flaggedAt?.toISOString() || null } : null,
    supplierReturn: batch.supplierReturn?.status ? { ...batch.supplierReturn, markedAt: batch.supplierReturn.markedAt?.toISOString() || null, settledAt: batch.supplierReturn.settledAt?.toISOString() || null } : null,
    medicine: medicine ? { ...medicine, id: String(medicine._id) } : null,
    supplier: supplier ? { ...supplier, id: String(supplier._id) } : null,
    branchName: branch?.name || '',
    salesHistory: sales.map((s) => ({ weekStart: s._id.toISOString(), units: s.units, value: round2(s.value) })),
    movements: movements.map((m) => ({ id: String(m._id), type: m.type, quantity: m.quantity, balanceAfter: m.balanceAfter, reason: m.reason || '', at: m.createdAt.toISOString() })),
    auditTrail: trail.map((a) => ({ id: String(a._id), action: a.action, message: a.message, by: a.userName || '', at: a.createdAt.toISOString() })),
  };
}
