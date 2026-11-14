import mongoose from 'mongoose';
import {
  Organization,
  AWAITING_REFUND_STATUSES, Batch, Invoice, NO_RESTOCK_REASONS, REFUNDED_STATUSES, REFUND_METHODS, REFUND_STATUSES, REFUND_STATUS_LABEL, RETURN_CONDITIONS, RETURN_CONDITION_LABEL,
  RETURN_REASONS, RETURN_REASON_LABEL, RETURN_STATUSES, RETURN_STATUS_LABEL, SalesReturn, nextSeq, returnStatusFor,
} from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { issueNumber } from './documentNumbering.service.js';
import { hasPermission } from '../config/permissions.js';
import { audit } from './audit.service.js';
import { recordMovement } from './ledger.service.js';
import { withTransaction } from './transaction.service.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';

/** yyyy-mm-dd -> midnight UTC (null when it is not a real date). */
const day = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? d : null;
};

/** The returnDate range; the "to" day is included in full. */
const dateRange = (from, to) => {
  const range = {};
  if (from && day(from)) range.$gte = day(from);
  if (to && day(to)) range.$lt = new Date(day(to).getTime() + 86400000);
  return Object.keys(range).length ? { returnDate: range } : {};
};

/** The choices the page's filters offer — one list, kept here with the model. */
export const returnsMeta = () => ({
  statuses: RETURN_STATUSES.map((value) => ({ value, label: RETURN_STATUS_LABEL[value] })),
  reasons: RETURN_REASONS.map((value) => ({ value, label: RETURN_REASON_LABEL[value] })),
  conditions: RETURN_CONDITIONS.map((value) => ({ value, label: RETURN_CONDITION_LABEL[value] })),
  refundMethods: REFUND_METHODS,
  refundStatuses: REFUND_STATUSES.map((value) => ({ value, label: REFUND_STATUS_LABEL[value] })),
  noRestockReasons: NO_RESTOCK_REASONS, // a return for one of these reasons can never be restocked
});

/**
 * The four cards, counted from the database (and from the same date filter as the list, so they always agree):
 *  totalRefunded    – money paid back (refunded + completed returns)
 *  returnsProcessed – returns whose refund has been paid (refunded + completed)
 *  itemsRestocked   – units actually put back into inventory
 *  pendingRefunds   – refund money still owed: pending, approved and refund-pending returns (rejected ones owe nothing)
 * Money is summed in whole paise and converted back, so the totals are exact.
 */
export async function returnsSummary(orgId, { dateFrom, dateTo } = {}) {
  const [rows] = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, ...dateRange(dateFrom, dateTo) } },
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 }, paise: { $sum: { $round: [{ $multiply: ['$refundAmount', 100] }, 0] } } } }],
        restocked: [{ $unwind: '$items' }, { $group: { _id: null, units: { $sum: '$items.restockedQuantity' } } }],
      },
    },
  ]);
  const by = Object.fromEntries((rows?.byStatus || []).map((r) => [r._id, r]));
  const sum = (statuses, key) => statuses.reduce((n, s) => n + (by[s]?.[key] || 0), 0);
  return {
    totalRefunded: sum(REFUNDED_STATUSES, 'paise') / 100,
    returnsProcessed: sum(REFUNDED_STATUSES, 'count'),
    itemsRestocked: rows?.restocked?.[0]?.units || 0,
    pendingRefunds: sum(AWAITING_REFUND_STATUSES, 'paise') / 100,
    pendingCount: sum(AWAITING_REFUND_STATUSES, 'count'),
    totalReturns: Object.values(by).reduce((n, r) => n + r.count, 0),
  };
}

export async function listReturns(orgId, { search, status, reason, dateFrom, dateTo, page, limit }) {
  const filter = { organizationId: orgId, ...dateRange(dateFrom, dateTo) };
  if (status) filter.status = status;
  if (reason) filter.reason = reason;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ returnNo: rx }, { invoiceNo: rx }, { 'customer.name': rx }, { 'customer.phone': rx }, { 'items.name': rx }];
  }
  const [rows, total] = await Promise.all([
    SalesReturn.find(filter).sort({ returnDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SalesReturn.countDocuments(filter),
  ]);
  const items = rows.map(({ items: lines, ...r }) => ({
    ...r,
    returnValue: r.returnValue ?? r.refundAmount,
    reasonLabel: RETURN_REASON_LABEL[r.reason] || r.reason,
    statusLabel: RETURN_STATUS_LABEL[r.status] || r.status,
    itemCount: lines.length,
    units: lines.reduce((n, i) => n + i.quantity, 0),
    restockedUnits: lines.reduce((n, i) => n + (i.restockedQuantity || 0), 0),
    preview: lines.slice(0, 2).map((i) => i.name),
  }));
  return paginated(items, { page, limit, total });
}

export async function getReturn(orgId, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw new ApiError(404, 'Sales return not found');
  const r = await SalesReturn.findOne({ _id: id, organizationId: orgId }).lean();
  if (!r) throw new ApiError(404, 'Sales return not found');
  return { ...r, returnValue: r.returnValue ?? r.refundAmount, reasonLabel: RETURN_REASON_LABEL[r.reason] || r.reason, statusLabel: RETURN_STATUS_LABEL[r.status] || r.status, units: r.items.reduce((n, i) => n + i.quantity, 0), restockedUnits: r.items.reduce((n, i) => n + (i.restockedQuantity || 0), 0) };
}


/* ------------------------------------------------------------------------------------------------ processing a new return */

const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const bad = (path, message) => fail(400, message, 'RETURN_INVALID', [{ path, message }]);
const oidOk = (id) => mongoose.Types.ObjectId.isValid(String(id));
const lineKey = (batchId, medicineId) => `${batchId}:${medicineId}`;
const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;

/**
 * What each invoice line is worth after its share of any bill discount, in whole paise. The shares are split so that they add up to the
 * invoice total EXACTLY (largest remainder), which keeps "returned value" and the invoice total consistent to the paisa.
 */
function lineNets(invoice) {
  const amounts = invoice.items.map((l) => Math.round(l.amount * 100));
  const sub = amounts.reduce((a, b) => a + b, 0);
  const total = Math.round(invoice.total * 100);
  if (sub <= 0) return amounts;
  const raw = amounts.map((a) => (a * total) / sub);
  const nets = raw.map(Math.floor);
  let rest = total - nets.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => {
      if (rest > 0) {
        nets[i] += 1;
        rest -= 1;
      }
    });
  return nets;
}
/** Value of returning `q` more units of a line that has `quantity` units and `already` returned: cumulative rounding, so partial returns add up exactly. */
const valueFor = (net, quantity, already, q) => Math.round(((already + q) * net) / quantity) - Math.round((already * net) / quantity);

const getInvoice = async (orgId, id, session) => {
  if (!oidOk(id)) throw fail(404, 'Invoice not found');
  const inv = await Invoice.findOne({ _id: id, organizationId: orgId }, null, session ? { session } : undefined).lean();
  if (!inv) throw fail(404, 'Invoice not found');
  return inv;
};

/** Search completed invoices by invoice number, customer name or phone, newest first — for the "find the original invoice" box. */
export async function searchInvoices(orgId, { search = '', limit = 8 } = {}) {
  const filter = { organizationId: orgId, status: 'completed' };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ invoiceNo: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
  }
  const rows = await Invoice.find(filter).sort({ invoiceDate: -1, _id: -1 }).limit(limit).select('invoiceNo invoiceDate customer total paymentType items').lean();
  return rows.map((i) => {
    const returnable = i.items.reduce((n, l) => n + Math.max(0, l.quantity - (l.returnedQuantity || 0)), 0);
    return { _id: i._id, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate, customer: i.customer, total: i.total, paymentType: i.paymentType, itemCount: i.items.length, returnableUnits: returnable };
  });
}

/** An invoice with, for every line, what was bought, what has already come back and what can still be returned. */
export async function getReturnableInvoice(orgId, id) {
  const inv = await getInvoice(orgId, id);
  if (inv.status !== 'completed') throw fail(409, `Invoice ${inv.invoiceNo} is ${inv.status}; only completed sales can be returned.`, 'INVOICE_NOT_RETURNABLE');
  const batches = await Batch.find({ organizationId: orgId, _id: { $in: inv.items.map((l) => l.batchId) } }).select('expiryDate status').lean();
  const byBatch = new Map(batches.map((b) => [String(b._id), b]));
  const now = new Date();
  const nets = lineNets(inv);
  const lines = inv.items.map((l, n) => {
    const batch = byBatch.get(String(l.batchId));
    const previouslyReturned = l.returnedQuantity || 0;
    const expired = Boolean(batch && batch.expiryDate <= now);
    return {
      medicineId: l.medicineId,
      batchId: l.batchId,
      name: l.name,
      batchNo: l.batchNo,
      expiryDate: batch?.expiryDate,
      batchStatus: batch?.status,
      batchExpired: expired,
      canRestock: Boolean(batch && batch.status === 'active' && !expired), // the batch itself can take units back
      originalQuantity: l.quantity,
      previouslyReturned,
      returnableQuantity: Math.max(0, l.quantity - previouslyReturned),
      unitPrice: Math.round(nets[n] / l.quantity) / 100, // what the customer actually paid per unit
      lineTotalPaise: nets[n], // lets the screen show the same amount the server will compute
    };
  });
  const refunded = inv.refundedAmount || 0;
  return {
    _id: inv._id,
    invoiceNo: inv.invoiceNo,
    invoiceDate: inv.invoiceDate,
    customer: inv.customer,
    total: inv.total,
    paid: inv.paid,
    due: inv.due,
    paymentType: inv.paymentType,
    returnedAmount: inv.returnedAmount || 0,
    refundedAmount: refunded,
    refundableLeft: Math.max(0, Math.round((inv.paid - refunded) * 100) / 100), // money still refundable: refunds can never exceed what was paid
    lines,
  };
}

/**
 * Puts verified, good units back into the batch they were sold from (same batch number and expiry), one SALE_RETURN ledger entry each.
 * Mutates the lines (restockedQuantity, expiryDate). Call inside the transaction that records or approves the return.
 */
async function restockLines(req, session, ref, lines, now) {
  for (const [n, l] of lines.entries()) {
    if (!l.restock || l.restockedQuantity > 0) continue;
    const updated = await Batch.findOneAndUpdate(
      { _id: l.batchId, organizationId: req.orgId, status: 'active', expiryDate: { $gt: now } },
      { $inc: { availableQuantity: l.quantity } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw bad(`items.${n}.restock`, `${l.name} (batch ${l.batchNo}) has expired or is no longer active, so its units cannot go back into stock.`);
    l.restockedQuantity = l.quantity;
    l.expiryDate = updated.expiryDate;
    await recordMovement(req, session, {
      medicineId: l.medicineId, batchId: l.batchId, type: 'SALE_RETURN', quantity: l.quantity, balanceAfter: updated.availableQuantity,
      reason: `Return ${ref.returnNo} against invoice ${ref.invoiceNo}`, refType: 'SalesReturn', refId: ref._id, ...(updated.branchId && { branchId: updated.branchId }),
    });
  }
}

const historyEntry = (req, action, previousStatus, newStatus, note) => ({ action, at: new Date(), by: req.user._id, byName: req.user.name, previousStatus, newStatus, ...(note && { note }) });

async function createReturnOnce(req, input) {
  const { invoiceId, reason, notes = '', items, idempotencyKey } = input;
  // Staff who may not approve returns record them as "pending": the units and the refund are claimed on the invoice (so they cannot be
  // returned twice), but nothing is restocked and no refund can start until someone with approval rights approves it.
  const needsApproval = !hasPermission(req.user, 'returns:approve');
  const refund = needsApproval ? { ...input.refund, status: 'pending', reference: '' } : input.refund;

  return withTransaction(async (session) => {
    const invoice = await getInvoice(req.orgId, invoiceId, session);
    if (invoice.status !== 'completed') throw fail(409, `Invoice ${invoice.invoiceNo} is ${invoice.status}; only completed sales can be returned.`, 'INVOICE_NOT_RETURNABLE');

    const nets = lineNets(invoice);
    const byKey = new Map(invoice.items.map((l, n) => [lineKey(l.batchId, l.medicineId), { line: l, net: nets[n] }]));
    const now = new Date();
    const seen = new Set();
    const lines = [];
    let valueP = 0;

    for (const [n, it] of items.entries()) {
      const key = lineKey(it.batchId, it.medicineId);
      const found = byKey.get(key);
      if (!found) throw bad(`items.${n}.batchId`, 'That product is not on the selected invoice, so it cannot be returned.');
      const { line, net } = found;
      if (seen.has(key)) throw bad(`items.${n}.batchId`, `${line.name} is listed twice. Return it on a single line.`);
      seen.add(key);
      const already = line.returnedQuantity || 0;
      const returnable = line.quantity - already;
      if (it.quantity > returnable) {
        throw bad(`items.${n}.quantity`, returnable <= 0 ? `${line.name} has already been returned in full.` : `Only ${returnable} unit${returnable === 1 ? '' : 's'} of ${line.name} can still be returned (bought ${line.quantity}, already returned ${already}).`);
      }

      // Restocking is a decision by staff, never automatic: the units must be good, the reason must allow it, and staff must say they checked them.
      const restock = Boolean(it.restock);
      if (restock) {
        if (NO_RESTOCK_REASONS.includes(reason)) throw bad(`items.${n}.restock`, `${RETURN_REASON_LABEL[reason]} returns can never be added back to sellable stock.`);
        if (it.condition !== 'good') throw bad(`items.${n}.restock`, `${line.name}: only units in good condition can be restocked (these are marked ${RETURN_CONDITION_LABEL[it.condition].toLowerCase()}).`);
        if (!it.verified) throw bad(`items.${n}.verified`, `${line.name}: confirm that the units were inspected (sealed, in date) before restocking them.`);
      }

      const amountP = valueFor(net, line.quantity, already, it.quantity);
      valueP += amountP;
      lines.push({
        medicineId: line.medicineId,
        batchId: line.batchId,
        name: line.name,
        batchNo: line.batchNo,
        originalQuantity: line.quantity,
        previouslyReturned: already,
        quantity: it.quantity,
        price: Math.round(net / line.quantity) / 100,
        amount: amountP / 100,
        condition: it.condition,
        restock,
        verified: restock ? true : Boolean(it.verified),
        restockedQuantity: 0,
      });
    }

    // Refund: recorded only, nothing is paid from here.
    const refundP = Math.round(refund.amount * 100);
    if (refundP > valueP) throw bad('refund.amount', `The refund cannot be more than the value of the returned products (${rupees(valueP)}).`);
    if (refundP < valueP && !refund.remarks) throw bad('refund.remarks', 'Explain why less than the full value is being refunded.');
    if (refund.status === 'completed' && ['UPI', 'Card', 'Bank Transfer'].includes(refund.method) && !refund.reference) {
      throw bad('refund.reference', `Enter the ${refund.method} transaction or reference ID for a completed refund.`);
    }
    // Refunds can never add up to more than the customer actually paid on this invoice (a credit sale may not be fully paid).
    const paidP = Math.round(invoice.paid * 100);
    const refundedP = Math.round((invoice.refundedAmount || 0) * 100);
    if (refundP > paidP - refundedP) {
      throw bad('refund.amount', `The customer has paid ${rupees(paidP)} on this invoice and ${rupees(refundedP)} has already been refunded, so at most ${rupees(Math.max(0, paidP - refundedP))} can be refunded. Record the rest as a smaller refund with remarks.`);
    }

    // Guarded, atomic claim on the invoice: it only applies if, at this instant, every line still has that many units to return and
    // the refunds would still not exceed what was paid. Two returns racing for the same units cannot both succeed.
    const guards = lines.map((l) => ({
      $expr: {
        $gt: [
          { $size: { $filter: { input: '$items', as: 'it', cond: { $and: [{ $eq: ['$$it.batchId', l.batchId] }, { $eq: ['$$it.medicineId', l.medicineId] }, { $gte: [{ $subtract: ['$$it.quantity', { $ifNull: ['$$it.returnedQuantity', 0] }] }, l.quantity] }] } } } },
          0,
        ],
      },
    }));
    guards.push({ $expr: { $lte: [{ $add: [{ $round: [{ $multiply: [{ $ifNull: ['$refundedAmount', 0] }, 100] }, 0] }, refundP] }, { $round: [{ $multiply: ['$paid', 100] }, 0] }] } });
    const claimed = await Invoice.updateOne({ _id: invoice._id, organizationId: req.orgId, status: 'completed', $and: guards }, [
      {
        $set: {
          returnedAmount: { $round: [{ $add: [{ $ifNull: ['$returnedAmount', 0] }, valueP / 100] }, 2] },
          refundedAmount: { $round: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, refundP / 100] }, 2] },
          items: {
            $map: {
              input: '$items',
              as: 'it',
              in: {
                $let: {
                  vars: { add: { $sum: lines.map((l) => ({ $cond: [{ $and: [{ $eq: ['$$it.batchId', l.batchId] }, { $eq: ['$$it.medicineId', l.medicineId] }] }, l.quantity, 0] })) } },
                  in: { $mergeObjects: ['$$it', { returnedQuantity: { $add: [{ $ifNull: ['$$it.returnedQuantity', 0] }, '$$add'] } }] },
                },
              },
            },
          },
        },
      },
    ], { session, updatePipeline: true });
    if (claimed.matchedCount !== 1) throw fail(409, 'Some of these units were just returned by someone else. Reload the invoice and try again.', 'RETURN_CONFLICT');

    const returnId = new mongoose.Types.ObjectId();
    // The credit-note number, from the organization's numbering settings (SR-0001 by default, unchanged).
    const numberingOrg = await Organization.findById(req.orgId, 'settings timezone', { session }).lean();
    const returnNo = (await issueNumber({ orgId: req.orgId, org: numberingOrg, series: 'salesReturn', session })).number;
    if (!needsApproval) await restockLines(req, session, { _id: returnId, returnNo, invoiceNo: invoice.invoiceNo }, lines, now);
    // Keep the expiry on lines that were not restocked too.
    const need = lines.filter((l) => !l.expiryDate);
    if (need.length) {
      const bs = await Batch.find({ organizationId: req.orgId, _id: { $in: need.map((l) => l.batchId) } }, 'expiryDate', { session }).lean();
      const by = new Map(bs.map((b) => [String(b._id), b.expiryDate]));
      for (const l of need) l.expiryDate = by.get(String(l.batchId));
    }

    const status = needsApproval ? 'pending' : returnStatusFor(refund.status);
    const [created] = await SalesReturn.create(
      [
        {
          _id: returnId,
          organizationId: req.orgId,
          returnNo,
          invoiceId: invoice._id,
          invoiceNo: invoice.invoiceNo,
          invoiceDate: invoice.invoiceDate,
          customer: invoice.customer,
          items: lines,
          returnValue: valueP / 100,
          refundAmount: refundP / 100,
          originalPaymentMethod: invoice.paymentType,
          refund: { method: refund.method, status: refund.status, reference: refund.reference || undefined, remarks: refund.remarks || undefined, ...(refund.status === 'completed' && { paidAt: now, paidBy: req.user._id }) },
          status,
          reason,
          notes: notes || undefined,
          returnDate: now,
          processedAt: now,
          processedBy: req.user._id,
          ...(!needsApproval && { approvedAt: now, approvedBy: req.user._id }),
          history: [historyEntry(req, 'CREATED', undefined, status, needsApproval ? 'Recorded; waiting for approval' : undefined)],
          ...(idempotencyKey && { idempotencyKey }),
          createdBy: req.user._id,
        },
      ],
      { session },
    );
    const restocked = lines.reduce((n, l) => n + l.restockedQuantity, 0);
    await audit(
      req,
      {
        action: 'SALES_RETURN_CREATE', entity: 'SalesReturn', entityId: returnId,
        message: `Return ${returnNo} recorded against ${invoice.invoiceNo} — ${rupees(valueP)} (${RETURN_REASON_LABEL[reason]}), ${needsApproval ? 'waiting for approval' : `${restocked} unit${restocked === 1 ? '' : 's'} restocked, refund ${REFUND_STATUS_LABEL[refund.status].toLowerCase()}`}`,
        meta: { invoiceNo: invoice.invoiceNo, returnValue: valueP / 100, refundAmount: refundP / 100, restocked, needsApproval },
      },
      session,
    );
    return created.toObject();
  });
}

const findByKey = (req, key) => SalesReturn.findOne({ organizationId: req.orgId, idempotencyKey: key }).lean();

/**
 * Records a customer return against an invoice. One transaction: it claims the units on the invoice lines (never more than were bought
 * minus what already came back, and never refunding more than was paid), restocks ONLY verified good units into the batch they were sold
 * from (with a SALE_RETURN ledger entry), saves the return and the audit entry. Safely repeatable: the same idempotencyKey returns the
 * original return. Returns { salesReturn, replayed }.
 */
export async function createReturn(req, input) {
  const key = input.idempotencyKey;
  if (key) {
    const existing = await findByKey(req, key);
    if (existing) return { salesReturn: existing, replayed: true };
  }
  try {
    return { salesReturn: await createReturnOnce(req, input), replayed: false };
  } catch (err) {
    if (key && err?.code === 11000) {
      const existing = await findByKey(req, key);
      if (existing) return { salesReturn: existing, replayed: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------------ approve, reject, refund, edit */

const loadReturn = async (req, id, session) => {
  if (!oidOk(id)) throw fail(404, 'Sales return not found');
  const r = await SalesReturn.findOne({ _id: id, organizationId: req.orgId }, null, session ? { session } : undefined).lean();
  if (!r) throw fail(404, 'Sales return not found');
  return r;
};
const notNow = (r, what) => fail(409, `${r.returnNo} is ${RETURN_STATUS_LABEL[r.status].toLowerCase()}${r.status === 'completed' || r.status === 'refunded' ? ' and its refund is paid' : ''}; ${what}`, 'RETURN_STATE', [{ path: 'status', message: `Return is ${r.status}` }]);
const presented = async (req, id) => getReturn(req.orgId, id);

/**
 * Approves a pending return. Only now are the units staff marked as good AND verified added back to their batch (never merely because the
 * return was approved: the person recording it had to tick that they inspected them). `doNotRestock` approves without adding stock.
 */
export async function approveReturn(req, id, { doNotRestock = false } = {}) {
  await withTransaction(async (session) => {
    const before = await loadReturn(req, id, session);
    if (before.status !== 'pending') throw notNow(before, 'only a pending return can be approved.');
    const now = new Date();
    const claimed = await SalesReturn.findOneAndUpdate(
      { _id: before._id, organizationId: req.orgId, status: 'pending' },
      { $set: { status: 'approved', approvedAt: now, approvedBy: req.user._id }, $push: { history: historyEntry(req, 'APPROVED', 'pending', 'approved', doNotRestock ? 'Approved without restocking' : undefined) } },
      { returnDocument: 'after', session },
    );
    if (!claimed) throw fail(409, 'This return was just handled by someone else.', 'RETURN_STATE');
    const lines = claimed.items.map((i) => i.toObject());
    if (doNotRestock) {
      for (const [n, l] of lines.entries()) if (l.restock) await SalesReturn.updateOne({ _id: claimed._id }, { $set: { [`items.${n}.restock`]: false, [`items.${n}.verified`]: false } }, { session });
    } else {
      await restockLines(req, session, claimed, lines, now);
      for (const [n, l] of lines.entries()) if (l.restockedQuantity > 0) await SalesReturn.updateOne({ _id: claimed._id }, { $set: { [`items.${n}.restockedQuantity`]: l.restockedQuantity, [`items.${n}.expiryDate`]: l.expiryDate } }, { session });
    }
    const restocked = lines.reduce((n, l) => n + (doNotRestock ? 0 : l.restockedQuantity), 0);
    await audit(req, { action: 'SALES_RETURN_APPROVE', entity: 'SalesReturn', entityId: claimed._id, message: `Return ${claimed.returnNo} approved — ${restocked} unit${restocked === 1 ? '' : 's'} restocked`, meta: { restocked, doNotRestock } }, session);
  });
  return presented(req, id);
}

/**
 * Rejects a return that has not touched stock or money yet, and gives its units and refund back to the invoice so they can be returned
 * properly. A return whose units were already restocked or whose refund is already paid can't be rejected — that would leave stock and
 * money wrong.
 */
export async function rejectReturn(req, id, reason) {
  await withTransaction(async (session) => {
    const r = await loadReturn(req, id, session);
    if (!['pending', 'approved', 'refund_pending'].includes(r.status)) throw notNow(r, 'it can no longer be rejected.');
    if (r.items.some((i) => i.restockedQuantity > 0)) throw fail(409, `${r.returnNo} has already put units back into stock, so it can't be rejected.`, 'RETURN_RESTOCKED');
    if (r.refund?.status === 'completed') throw fail(409, `${r.returnNo}'s refund has already been paid, so it can't be rejected.`, 'RETURN_REFUNDED');
    const now = new Date();
    const claimed = await SalesReturn.findOneAndUpdate(
      { _id: r._id, organizationId: req.orgId, status: r.status, 'refund.status': { $ne: 'completed' } },
      { $set: { status: 'rejected', rejectedAt: now, rejectedBy: req.user._id, rejectReason: reason }, $push: { history: historyEntry(req, 'REJECTED', r.status, 'rejected', reason) } },
      { returnDocument: 'after', session },
    );
    if (!claimed) throw fail(409, 'This return was just handled by someone else.', 'RETURN_STATE');
    // Give the units, the returned value and the promised refund back to the invoice.
    const release = await Invoice.updateOne({ _id: r.invoiceId, organizationId: req.orgId }, [
      {
        $set: {
          returnedAmount: { $max: [0, { $round: [{ $subtract: [{ $ifNull: ['$returnedAmount', 0] }, r.returnValue] }, 2] }] },
          refundedAmount: { $max: [0, { $round: [{ $subtract: [{ $ifNull: ['$refundedAmount', 0] }, r.refundAmount] }, 2] }] },
          items: {
            $map: {
              input: '$items',
              as: 'it',
              in: {
                $let: {
                  vars: { sub: { $sum: r.items.map((l) => ({ $cond: [{ $and: [{ $eq: ['$$it.batchId', l.batchId] }, { $eq: ['$$it.medicineId', l.medicineId] }] }, l.quantity, 0] })) } },
                  in: { $mergeObjects: ['$$it', { returnedQuantity: { $max: [0, { $subtract: [{ $ifNull: ['$$it.returnedQuantity', 0] }, '$$sub'] }] } }] },
                },
              },
            },
          },
        },
      },
    ], { session, updatePipeline: true });
    if (release.matchedCount !== 1) throw fail(409, 'The original invoice could not be updated, so nothing was rejected.', 'RETURN_STATE');
    await audit(req, { action: 'SALES_RETURN_REJECT', entity: 'SalesReturn', entityId: r._id, message: `Return ${r.returnNo} rejected (${reason}) — units and refund released back to ${r.invoiceNo}`, meta: { reason } }, session);
  });
  return presented(req, id);
}

// Where the refund may go from here. A paid (completed) refund is final: that is what stops one return being refunded twice.
const REFUND_FROM = { pending: ['processing', 'completed', 'failed'], processing: ['pending', 'completed', 'failed'], failed: ['pending', 'processing', 'completed'], completed: [] };

/**
 * Records a step in the refund (processing, completed, failed or back to pending). Recording only: no payment is ever started.
 * Completed is final and happens once — a second attempt (or two at the same moment) is refused, so a refund can't be paid twice.
 */
export async function recordRefund(req, id, { status, method, reference = '', remarks = '' }) {
  await withTransaction(async (session) => {
    const r = await loadReturn(req, id, session);
    if (r.status === 'pending') throw fail(409, `${r.returnNo} is still waiting for approval; its refund can't be recorded yet.`, 'RETURN_NOT_APPROVED');
    if (r.status === 'rejected') throw notNow(r, 'a rejected return has no refund.');
    const current = r.refund?.status || 'pending';
    if (current === 'completed') throw fail(409, `The refund for ${r.returnNo} has already been completed. It can't be recorded again.`, 'REFUND_ALREADY_PAID');
    if (current === status) throw fail(409, `The refund is already ${REFUND_STATUS_LABEL[status].toLowerCase()}.`, 'REFUND_STATE');
    if (!REFUND_FROM[current].includes(status)) throw fail(409, `A ${REFUND_STATUS_LABEL[current].toLowerCase()} refund can't become ${REFUND_STATUS_LABEL[status].toLowerCase()}.`, 'REFUND_STATE');
    const useMethod = method || r.refund?.method;
    const ref = reference || r.refund?.reference || '';
    if (status === 'completed' && ['UPI', 'Card', 'Bank Transfer'].includes(useMethod) && !ref) throw bad('reference', `Enter the ${useMethod} transaction or reference ID for a completed refund.`);
    const now = new Date();
    const next = returnStatusFor(status);
    const claimed = await SalesReturn.findOneAndUpdate(
      { _id: r._id, organizationId: req.orgId, status: { $in: ['approved', 'refund_pending'] }, 'refund.status': current },
      {
        $set: {
          status: next, 'refund.status': status, 'refund.method': useMethod, 'refund.reference': ref || undefined,
          ...(remarks && { 'refund.remarks': remarks }), ...(status === 'completed' && { 'refund.paidAt': now, 'refund.paidBy': req.user._id }),
        },
        $push: { history: historyEntry(req, 'REFUND', r.status, next, `Refund ${REFUND_STATUS_LABEL[status].toLowerCase()}${ref ? ` (${ref})` : ''}${remarks ? ` — ${remarks}` : ''}`) },
      },
      { returnDocument: 'after', session },
    );
    if (!claimed) throw fail(409, 'This refund was just updated by someone else. Reload and check its status.', 'REFUND_STATE');
    await audit(req, { action: 'SALES_RETURN_REFUND', entity: 'SalesReturn', entityId: r._id, message: `Refund for ${r.returnNo} ${REFUND_STATUS_LABEL[status].toLowerCase()} — ${rupees(Math.round(r.refundAmount * 100))} by ${useMethod}`, meta: { status, method: useMethod, reference: ref } }, session);
  });
  return presented(req, id);
}

/** Edits the notes and the refund's method and remarks of a return that is still open. Products, quantities and amounts are never editable (they drive stock and money). */
export async function updateReturn(req, id, { notes, refund = {} }) {
  const r = await loadReturn(req, id);
  if (!['pending', 'approved', 'refund_pending'].includes(r.status) || r.refund?.status === 'completed') throw notNow(r, 'it can no longer be edited.');
  const set = {};
  if (notes !== undefined) set.notes = notes || undefined;
  if (refund.method) set['refund.method'] = refund.method;
  if (refund.remarks !== undefined) set['refund.remarks'] = refund.remarks || undefined;
  if (!Object.keys(set).length) return presented(req, id);
  const claimed = await SalesReturn.findOneAndUpdate(
    { _id: r._id, organizationId: req.orgId, status: r.status, 'refund.status': { $ne: 'completed' } },
    { $set: set, $push: { history: historyEntry(req, 'EDITED', r.status, r.status, 'Details edited') } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw fail(409, 'This return was just handled by someone else.', 'RETURN_STATE');
  await audit(req, { action: 'SALES_RETURN_EDIT', entity: 'SalesReturn', entityId: r._id, message: `Return ${r.returnNo} details edited` });
  return presented(req, id);
}

/* ------------------------------------------------------------------------------------------------ dashboard */

/** Money refunded to customers (refunded + completed returns) for returns dated in [start, end), and how many returns still wait. Whole paise, then rupees. */
export async function refundTotals(orgId, start, end) {
  const range = start || end ? { returnDate: { ...(start && { $gte: start }), ...(end && { $lt: end }) } } : {};
  const rows = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, ...range } },
    { $group: { _id: '$status', count: { $sum: 1 }, paise: { $sum: { $round: [{ $multiply: ['$refundAmount', 100] }, 0] } } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  const sum = (statuses, key) => statuses.reduce((n, s) => n + (by[s]?.[key] || 0), 0);
  return { refunded: sum(REFUNDED_STATUSES, 'paise') / 100, refundedReturns: sum(REFUNDED_STATUSES, 'count'), awaitingApproval: by.pending?.count || 0, owed: sum(AWAITING_REFUND_STATUSES, 'paise') / 100 };
}
