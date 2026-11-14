import crypto from 'node:crypto';
import { CREDIT_STATUS_LABEL, CREDIT_TXN_LABEL, CreditRequest, CreditTransaction, Organization, User, nextSeq } from '../models/index.js';
import { hasPermission } from '../config/permissions.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';
import { withTransaction } from './transaction.service.js';
import { getStorage } from './storage/index.js';
import { IMAGE_EXT, IMAGE_TYPES, cleanFileName, sniffImage } from '../utils/imageFile.js';

/**
 * Credit requests: a person pays, uploads a screenshot of the payment and asks for credits; an administrator decides later. This file is the only place the
 * rules live — the amount, the screenshot (its real type and size, checked here whatever the browser said), who may see what, and the conversion rate.
 * An approval is the only thing that moves credits: it writes the balance on the user and the matching ledger entry in ONE database transaction (see
 * `approveRequest`). It never touches an invoice or stock.
 *
 *   CREDIT_RUPEES_PER_CREDIT   default conversion rate (rupees per credit) when the organization has not set its own (default 5); CREDIT_CONVERSION_RATE is accepted too
 *   CREDIT_SCREENSHOT_MAX_MB   largest screenshot (default 5); MAX_PAYMENT_SCREENSHOT_SIZE_MB is accepted too
 *   CREDIT_MAX_AMOUNT          largest single payment (default 1,000,000)
 */
const fail = (status, message, code, details) => new ApiError(status, message, details, code);
// one rule for every upload in the system, so a screenshot and a product photo are judged the same way
export { IMAGE_TYPES, sniffImage, cleanFileName };
const EXT = IMAGE_EXT;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** The first of these variables that is set to a positive number, else the default — so a setting can have more than one accepted name. */
const envNum = (names, d) => {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && String(raw).trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0) return Number(raw);
  }
  return d;
};

export const maxBytes = () => Math.round(envNum(['CREDIT_SCREENSHOT_MAX_MB', 'MAX_PAYMENT_SCREENSHOT_SIZE_MB'], 5) * 1024 * 1024);
export const maxAmount = () => num(process.env.CREDIT_MAX_AMOUNT, 1000000);

/** A payment amount typed as text: a positive number with at most two decimals. */
export function parseAmount(v) {
  const s = String(v ?? '').trim();
  if (!s) throw fail(400, 'Enter the payment amount.', 'CREDIT_AMOUNT', [{ path: 'amount', message: 'Enter the payment amount' }]);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw fail(400, 'The payment amount must be a number like 500 or 499.50.', 'CREDIT_AMOUNT', [{ path: 'amount', message: 'Enter a valid amount (at most two decimals)' }]);
  const n = Number(s);
  if (n <= 0) throw fail(400, 'The payment amount must be greater than zero.', 'CREDIT_AMOUNT', [{ path: 'amount', message: 'Must be greater than zero' }]);
  if (n > maxAmount()) throw fail(400, `The payment amount cannot be more than ₹${maxAmount().toLocaleString('en-IN')}.`, 'CREDIT_AMOUNT', [{ path: 'amount', message: 'That is too large' }]);
  return n;
}

/**
 * THE credit calculation, used for the estimate on a request and for the credits awarded at approval — nowhere else. Credits are WHOLE numbers, ROUNDED DOWN:
 * credits = floor(amount / rate), done in whole paise so there are no floating-point surprises, and the rupees left over are returned (and stored) instead
 * of vanishing. With 1 credit = ₹5: ₹500 = 100, ₹1,000 = 200, ₹2,500 = 500, ₹499.50 = 99 credits with ₹4.50 left over.
 */
export function creditsFor(amount, rate) {
  const a = Math.round(Number(amount) * 100);
  const r = Math.round(Number(rate) * 100);
  if (!(a > 0 && r > 0)) return { credits: 0, remainder: 0 };
  const credits = Math.floor(a / r);
  return { credits, remainder: (a - credits * r) / 100 };
}

/* ------------------------------------------------------------------------------------------------ settings */

/** The conversion rate in force (rupees per credit): the organization's own, else the environment default, else 5. One place; everything else asks here. */
export async function getCreditSettings(orgId) {
  const org = await Organization.findById(orgId, 'settings').lean();
  const own = Number(org?.settings?.creditRupeesPerCredit);
  const rate = Number.isFinite(own) && own > 0 ? own : envNum(['CREDIT_RUPEES_PER_CREDIT', 'CREDIT_CONVERSION_RATE'], 5);
  return { rupeesPerCredit: rate, custom: Number.isFinite(own) && own > 0, acceptedTypes: IMAGE_TYPES, maxFileMB: maxBytes() / 1048576, maxAmount: maxAmount() };
}

export async function updateCreditSettings(req, { rupeesPerCredit }) {
  await Organization.updateOne({ _id: req.orgId }, { $set: { 'settings.creditRupeesPerCredit': rupeesPerCredit } });
  await audit(req, { action: 'CREDIT_RATE_CHANGE', entity: 'Organization', entityId: req.orgId, message: `Credit conversion rate set to ₹${rupeesPerCredit} per credit (existing requests keep the rate they were made at)` });
  return getCreditSettings(req.orgId);
}

/* ------------------------------------------------------------------------------------------------ requests */

const present = ({ screenshot, ...r }) => ({
  ...r, statusLabel: CREDIT_STATUS_LABEL[r.status] || r.status,
  submittedAt: r.createdAt, // the same instant as createdAt, under the name the API documents
  ...(r.status === 'rejected' && r.remarks ? { rejectionReason: r.remarks } : {}), // a rejection's remarks ARE its reason; one field, two names
  screenshot: { fileName: screenshot.fileName, mimeType: screenshot.mimeType, size: screenshot.size }, // never the storage key, never the hash
});

/**
 * Submits a credit request: checks the amount and the screenshot, stores the file safely, and records a Pending request for this person. Safely repeatable: the
 * same idempotency key returns the first request; the same screenshot cannot back two live (pending or approved) requests.
 */
export async function createRequest(req, { buffer, amount, fileName, contentType, idempotencyKey }) {
  const value = parseAmount(amount);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, 'Choose the payment screenshot to upload.', 'CREDIT_NO_FILE', [{ path: 'screenshot', message: 'Choose the payment screenshot' }]);
  if (buffer.length > maxBytes()) throw fail(413, `The screenshot is larger than ${maxBytes() / 1048576} MB.`, 'CREDIT_FILE_TOO_LARGE', [{ path: 'screenshot', message: `Use a file up to ${maxBytes() / 1048576} MB` }]);
  const real = sniffImage(buffer);
  if (!real) throw fail(415, 'The screenshot must be a JPG, JPEG, PNG or WEBP image.', 'CREDIT_UNSUPPORTED_TYPE', [{ path: 'screenshot', message: 'Use a JPG, PNG or WEBP image' }]);
  if (contentType && contentType !== real) throw fail(400, `The file says it is ${contentType} but its contents are ${real}.`, 'CREDIT_TYPE_MISMATCH', [{ path: 'screenshot', message: 'The file is not what it claims to be' }]);

  const key = String(idempotencyKey || '').trim().slice(0, 100) || undefined;
  if (key) {
    const same = await CreditRequest.findOne({ organizationId: req.orgId, userId: req.user._id, idempotencyKey: key }).lean();
    if (same) return { request: present(same), replayed: true };
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const dup = await CreditRequest.findOne({ organizationId: req.orgId, 'screenshot.sha256': sha256, status: { $in: ['pending', 'approved'] } }).select('requestNo status').lean();
  if (dup) throw fail(409, `This screenshot was already submitted (${dup.requestNo}, ${CREDIT_STATUS_LABEL[dup.status].toLowerCase()}). Upload the screenshot of a new payment.`, 'DUPLICATE_SCREENSHOT', [{ path: 'screenshot', message: `Already used for ${dup.requestNo}` }]);

  const { rupeesPerCredit } = await getCreditSettings(req.orgId);
  const _id = new (await import('mongoose')).default.Types.ObjectId();
  const storageKey = `${req.orgId}/credit/${_id}${EXT[real]}`;
  const storage = getStorage();
  await storage.put(storageKey, buffer);
  try {
    const requestNo = `CR-${String(await nextSeq(req.orgId, 'creditRequest')).padStart(4, '0')}`;
    const created = await CreditRequest.create({
      _id, organizationId: req.orgId, requestNo, userId: req.user._id, userName: req.user.name, userEmail: req.user.email, amount: value, rateAtRequest: rupeesPerCredit, suggestedCredits: creditsFor(value, rupeesPerCredit).credits,
      screenshot: { storageKey, fileName: cleanFileName(fileName), mimeType: real, size: buffer.length, sha256 }, status: 'pending', ...(key && { idempotencyKey: key }),
      history: [{ action: 'SUBMITTED', at: new Date(), by: req.user._id, byName: req.user.name, note: `₹${value} paid; payment screenshot uploaded` }],
    });
    await audit(req, { action: 'CREDIT_REQUEST_SUBMIT', entity: 'CreditRequest', entityId: created._id, message: `Credit request ${requestNo} submitted: ₹${value}`, meta: { requestNo, amount: value, rateAtRequest: rupeesPerCredit, suggestedCredits: creditsFor(value, rupeesPerCredit).credits, status: 'pending' } });
    // the proof is its own event in the trail: what was accepted, how big it was, and the hash that identifies it — never where it is kept
    await audit(req, { action: 'CREDIT_PROOF_UPLOAD', entity: 'CreditRequest', entityId: created._id, message: `Payment proof uploaded for ${requestNo}: ${cleanFileName(fileName)} (${real}, ${buffer.length} bytes)`, meta: { requestNo, fileName: cleanFileName(fileName), mimeType: real, size: buffer.length, sha256 } });
    return { request: present(created.toObject()), replayed: false };
  } catch (e) {
    await storage.remove(storageKey).catch(() => {}); // never leave a file behind without a request
    if (e.code === 11000) {
      if (key) {
        const same = await CreditRequest.findOne({ organizationId: req.orgId, userId: req.user._id, idempotencyKey: key }).lean();
        if (same) return { request: present(same), replayed: true };
      }
      throw fail(409, 'This screenshot was just submitted. Upload the screenshot of a new payment.', 'DUPLICATE_SCREENSHOT', [{ path: 'screenshot', message: 'Already used' }]);
    }
    throw e;
  }
}

const isAdmin = (user) => hasPermission(user, 'settings:manage');

/**
 * Requests, newest first. Everyone sees their own; an administrator can ask for everyone's (`scope: 'all'`). Filters: status, submitted date range, and a search
 * that matches the request id and — when looking at everyone's — the requester's name or email.
 */
export async function listRequests(req, { page = 1, limit = 10, status, scope = 'mine', search, from, to }) {
  const filter = { organizationId: req.orgId, ...(status && { status }) };
  if (!(scope === 'all' && isAdmin(req.user))) filter.userId = req.user._id;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = filter.userId ? [{ requestNo: rx }] : [{ requestNo: rx }, { userName: rx }, { userEmail: rx }];
  }
  if (from || to) filter.createdAt = { ...(from && { $gte: new Date(`${from}T00:00:00.000Z`) }), ...(to && { $lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000) }) };
  const [rows, total] = await Promise.all([
    CreditRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CreditRequest.countDocuments(filter),
  ]);
  return paginated(rows.map(present), { page, limit, total });
}

/** Totals worked out from the requests themselves (there is no separate balance to keep in step): credits awarded, amounts, and how many are in each status. */
export async function creditSummary(req, { scope = 'mine' } = {}) {
  const match = { organizationId: req.orgId, ...(scope === 'all' && isAdmin(req.user) ? {} : { userId: req.user._id }) };
  const rows = await CreditRequest.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 }, credits: { $sum: { $ifNull: ['$approvedCredits', 0] } }, paid: { $sum: { $ifNull: ['$approvedAmount', 0] } } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  return {
    approvedCredits: by.approved?.credits || 0, approvedAmount: Math.round((by.approved?.paid || 0) * 100) / 100,
    counts: { pending: by.pending?.n || 0, approved: by.approved?.n || 0, rejected: by.rejected?.n || 0 },
  };
}

async function load(req, id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw fail(404, 'Credit request not found', 'NOT_FOUND');
  const r = await CreditRequest.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!r || (String(r.userId) !== String(req.user._id) && !isAdmin(req.user))) throw fail(404, 'Credit request not found', 'NOT_FOUND'); // not yours: the same answer as "not there"
  return r;
}

export async function getRequest(req, id) {
  return present(await load(req, id));
}

/** The screenshot, for the person who made the request and for administrators. */
export async function getScreenshot(req, id) {
  const r = await load(req, id);
  return { buffer: await getStorage().get(r.screenshot.storageKey), mimeType: r.screenshot.mimeType, fileName: r.screenshot.fileName };
}

/* ------------------------------------------------------------------------------------------------ review */

const reviewer = (req) => ({ reviewedBy: req.user._id, reviewedByName: req.user.name, reviewedAt: new Date() });

async function decide(req, id, change, entry, session) {
  const r = await load(req, id); // an administrator can see any request of the organization
  if (String(r.userId) === String(req.user._id)) throw fail(403, 'You cannot review your own request. Ask another administrator.', 'SELF_REVIEW');
  // a decided request is never decided again: turning a rejected request into an approved one would need a documented reversal workflow, which does not exist
  if (r.status !== 'pending') throw fail(409, `${r.requestNo} was already ${CREDIT_STATUS_LABEL[r.status].toLowerCase()}.`, 'CREDIT_STATE');
  // the decision only applies while the request is still pending: two administrators acting at once cannot both succeed, so credits can never be added twice
  const done = await CreditRequest.findOneAndUpdate({ _id: r._id, organizationId: req.orgId, status: 'pending' }, { $set: change, $push: { history: { ...entry, at: new Date(), by: req.user._id, byName: req.user.name } } }, { returnDocument: 'after', session }).lean();
  if (!done) throw fail(409, `${r.requestNo} was just reviewed by someone else.`, 'CREDIT_STATE');
  return { r, done };
}

/**
 * Moves someone's credit balance and writes the ledger entry for it, in the caller's transaction. This is the ONLY way a balance changes: the entry records the
 * balance before and after, so the ledger and the balance can never drift apart. `credits` is signed, so a future deduction is a negative entry.
 */
export async function postCreditTransaction(req, session, { userId, userName, credits, type, description, requestId, requestNo }) {
  const owner = await User.findOneAndUpdate({ _id: userId, organizationId: req.orgId }, { $inc: { creditBalance: credits } }, { returnDocument: 'after', session }).lean();
  if (!owner) throw fail(409, 'The person who made this request no longer exists.', 'CREDIT_NO_USER');
  const newBalance = Number(owner.creditBalance || 0);
  const txnNo = `CT-${String(await nextSeq(req.orgId, 'creditTransaction', session)).padStart(4, '0')}`;
  const [txn] = await CreditTransaction.create(
    [{ organizationId: req.orgId, txnNo, userId, userName: userName || owner.name, requestId, requestNo, type, credits, previousBalance: newBalance - credits, newBalance, description, createdBy: req.user._id, createdByName: req.user.name }],
    { session },
  );
  // every movement of credits is in the trail on its own, with the balance before and after, whatever caused it (an approval today, an adjustment or reversal later)
  await audit(
    req,
    { action: 'CREDIT_AWARDED', entity: 'CreditTransaction', entityId: txn._id, message: `${credits >= 0 ? '+' : ''}${credits} credits for ${userName || owner.name}: balance ${newBalance - credits} -> ${newBalance} (${txnNo}${requestNo ? `, ${requestNo}` : ''})`, meta: { txnNo, type, userId: String(userId), requestId: requestId ? String(requestId) : undefined, requestNo, credits, previousBalance: newBalance - credits, newBalance } },
    session,
  );
  return txn.toObject();
}

/**
 * Approves a request. The administrator states the payment amount they APPROVE (it need not equal what was requested); the SERVER works out the credits from that
 * amount at the rate in force now (creditsFor), and keeps the amount, the rate, the credits and the leftover separately. Credits sent by the browser are ignored.
 */
export async function approveRequest(req, id, { approvedAmount, remarks }) {
  const amount = parseAmount(approvedAmount);
  const { rupeesPerCredit } = await getCreditSettings(req.orgId);
  const { credits, remainder } = creditsFor(amount, rupeesPerCredit);
  if (credits < 1) throw fail(400, `The approved amount is less than one credit (₹${rupeesPerCredit}).`, 'CREDIT_AMOUNT', [{ path: 'approvedAmount', message: `Must be at least ₹${rupeesPerCredit}` }]);
  const note = String(remarks || '').trim().slice(0, 300);
  // ONE transaction: the request becomes approved, the requester's balance goes up, and the ledger entry is written — all of it, or none of it
  const { done, txn } = await withTransaction(async (session) => {
    const { r, done: updated } = await decide(
      req, id,
      { status: 'approved', approvedAmount: amount, approvedRate: rupeesPerCredit, approvedCredits: credits, remainderAmount: remainder, ...reviewer(req), ...(note && { remarks: note }) },
      { action: 'APPROVED', note: `₹${amount} approved at ₹${rupeesPerCredit} per credit = ${credits} credit${credits === 1 ? '' : 's'}${remainder ? ` (₹${remainder} left over)` : ''}${note ? ` — ${note}` : ''}` },
      session,
    );
    const entry = await postCreditTransaction(req, session, {
      userId: r.userId, userName: r.userName, credits, type: 'CREDIT_APPROVAL', requestId: r._id, requestNo: r.requestNo,
      description: `${credits} credit${credits === 1 ? '' : 's'} for ₹${amount} approved on ${r.requestNo} (₹${rupeesPerCredit} per credit)`,
    });
    await audit(req, { action: 'CREDIT_REQUEST_APPROVE', entity: 'CreditRequest', entityId: r._id, message: `Credit request ${r.requestNo} approved: ₹${amount} (requested ₹${r.amount}) -> ${credits} credits at ₹${rupeesPerCredit}; ledger ${entry.txnNo}, balance ${entry.previousBalance} -> ${entry.newBalance}`, meta: { requestNo: r.requestNo, before: { status: 'pending', approvedAmount: null, approvedCredits: null }, after: { status: 'approved', approvedAmount: amount, approvedRate: rupeesPerCredit, approvedCredits: credits, remainderAmount: remainder }, requestedAmount: r.amount, txnNo: entry.txnNo, credits, previousBalance: entry.previousBalance, newBalance: entry.newBalance } }, session);
    return { done: updated, txn: entry };
  });
  return { ...present(done), transaction: { txnNo: txn.txnNo, credits: txn.credits, previousBalance: txn.previousBalance, newBalance: txn.newBalance } };
}

/** Rejects a request; a reason is required. Nothing is awarded. */
export async function rejectRequest(req, id, { remarks }) {
  const note = String(remarks || '').trim();
  if (note.length < 3) throw fail(400, 'Give a reason for rejecting (at least 3 characters).', 'CREDIT_REMARKS', [{ path: 'remarks', message: 'Give a reason (at least 3 characters)' }]);
  const { r, done } = await decide(req, id, { status: 'rejected', ...reviewer(req), remarks: note.slice(0, 300) }, { action: 'REJECTED', note: note.slice(0, 300) });
  await audit(req, { action: 'CREDIT_REQUEST_REJECT', entity: 'CreditRequest', entityId: r._id, message: `Credit request ${r.requestNo} rejected: ${note.slice(0, 120)}`, meta: { requestNo: r.requestNo, before: { status: 'pending' }, after: { status: 'rejected' }, requestedAmount: r.amount, rejectionReason: note.slice(0, 300), creditsAwarded: 0 } });
  return present(done);
}

/* ------------------------------------------------------------------------------------------------ balance and ledger */

const presentTxn = (t) => ({ ...t, typeLabel: CREDIT_TXN_LABEL[t.type] || t.type });

/** The signed-in person's credit balance (what the header shows) and the entry it last moved on. An administrator may ask for someone else's. */
export async function getBalance(req, { userId } = {}) {
  const target = userId && isAdmin(req.user) ? userId : req.user._id;
  if (!/^[a-f0-9]{24}$/i.test(String(target))) throw fail(404, 'User not found', 'NOT_FOUND');
  const [owner, last] = await Promise.all([
    User.findOne({ _id: target, organizationId: req.orgId }, 'name creditBalance').lean(),
    CreditTransaction.findOne({ organizationId: req.orgId, userId: target }).sort({ createdAt: -1, _id: -1 }).lean(),
  ]);
  if (!owner) throw fail(404, 'User not found', 'NOT_FOUND');
  return { userId: String(owner._id), userName: owner.name, balance: Number(owner.creditBalance || 0), lastTransaction: last ? presentTxn(last) : null };
}

/** The credit ledger, newest first: a person's own entries, or everyone's for an administrator (`scope: 'all'`, optionally narrowed to one `userId`). */
export async function listTransactions(req, { page = 1, limit = 10, scope = 'mine', userId, type, from, to, search } = {}) {
  const filter = { organizationId: req.orgId, ...(type && { type }) };
  if (scope === 'all' && isAdmin(req.user)) {
    if (userId) filter.userId = userId;
  } else filter.userId = req.user._id;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ txnNo: rx }, { requestNo: rx }, ...(filter.userId ? [] : [{ userName: rx }])];
  }
  if (from || to) filter.createdAt = { ...(from && { $gte: new Date(`${from}T00:00:00.000Z`) }), ...(to && { $lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000) }) };
  const [rows, total] = await Promise.all([
    CreditTransaction.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CreditTransaction.countDocuments(filter),
  ]);
  return paginated(rows.map(presentTxn), { page, limit, total });
}

/**
 * What to tell a person about their own credit requests, newest first: the ones an administrator has decided. Like the transfer notifications, these are derived
 * from the records themselves — nothing is stored twice and nothing can go stale.
 */
export async function creditNotifications(req, { limit = 10 } = {}) {
  const rows = await CreditRequest.find({ organizationId: req.orgId, userId: req.user._id, status: { $in: ['approved', 'rejected'] } })
    .sort({ reviewedAt: -1, updatedAt: -1 }).limit(limit).select('requestNo status amount approvedAmount approvedCredits remarks reviewedAt reviewedByName updatedAt').lean();
  return rows.map((r) => ({
    _id: String(r._id), requestNo: r.requestNo, status: r.status, at: r.reviewedAt || r.updatedAt, by: r.reviewedByName, remarks: r.remarks,
    message: r.status === 'approved'
      ? `${r.requestNo} approved: ${r.approvedCredits} credit${r.approvedCredits === 1 ? '' : 's'} added for ₹${r.approvedAmount}`
      : `${r.requestNo} rejected${r.remarks ? `: ${r.remarks}` : ''}`,
  }));
}
