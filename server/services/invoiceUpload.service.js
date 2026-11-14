import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { InvoiceOcr, InvoiceUpload, UPLOAD_STATUS_LABEL } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { hasPermission } from '../config/permissions.js';
import { audit } from './audit.service.js';
import { FILE_TYPES, MAX_FILE_BYTES, sniffType } from './aiBilling.service.js';
import { createOrder } from './order.service.js';
import { getStorage } from './storage/index.js';

/**
 * Uploaded supplier invoices: store the file safely, record it, scan it (in the background, with a status the screen can follow), and let a person
 * review the result and save a DRAFT ORDER from it. Uploading and scanning never touch stock or orders.
 */
const EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const oidOk = (id) => /^[a-f0-9]{24}$/i.test(String(id));

/** The record as the screens see it: never the storage location. */
export const presentUpload = ({ storageKey, ...u }) => ({ ...u, statusLabel: UPLOAD_STATUS_LABEL[u.status] || u.status, hasFile: Boolean(storageKey) });

/** A file name the user typed, made safe to keep and to show: no folders, no control characters, bounded. */
export function cleanFileName(name) {
  const base = String(name || 'invoice').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 150);
  return base || 'invoice';
}

/** An upload of this organization, by its record id or its public upload id (UP-…). */
export const loadUpload = async (orgId, id) => {
  const where = oidOk(id) ? { _id: id } : /^UP-[0-9a-f]{18}$/.test(String(id)) ? { uploadId: String(id) } : null;
  if (!where) throw fail(404, 'Upload not found');
  const u = await InvoiceUpload.findOne({ ...where, organizationId: orgId }).lean();
  if (!u) throw fail(404, 'Upload not found');
  return u;
};

/** Checks and stores a file and records it. `status` stays "uploaded": nothing is read until a scan is asked for. */
export async function createUpload(req, { buffer, fileName, contentType }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, 'No file was received. Upload a PDF, PNG or JPEG of the invoice.', 'UPLOAD_NO_FILE');
  if (buffer.length > MAX_FILE_BYTES) throw fail(413, `The file is larger than ${MAX_FILE_BYTES / 1048576} MB.`, 'UPLOAD_TOO_LARGE');
  const real = sniffType(buffer);
  if (!real || !FILE_TYPES.includes(real)) throw fail(415, 'Only PDF, PNG and JPEG files can be uploaded.', 'UPLOAD_UNSUPPORTED_TYPE');
  if (contentType && contentType !== real) throw fail(400, `The file says it is ${contentType} but its contents are ${real}.`, 'UPLOAD_TYPE_MISMATCH');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const same = await InvoiceUpload.findOne({ organizationId: req.orgId, sha256, status: { $ne: 'discarded' } }).sort({ createdAt: -1 }).select('uploadId fileName status orderId').lean();
  const uploadId = `UP-${crypto.randomBytes(9).toString('hex')}`; // unique and not guessable
  const storageKey = `${req.orgId}/${uploadId}${EXT[real]}`;
  const storage = getStorage();
  await storage.put(storageKey, buffer);
  try {
    const created = await InvoiceUpload.create({
      organizationId: req.orgId, uploadId, fileName: cleanFileName(fileName), mimeType: real, size: buffer.length, sha256, storageKey, status: 'uploaded', uploadedBy: req.user._id, uploadedByName: req.user.name,
    });
    await audit(req, { action: 'AI_INVOICE_UPLOAD', entity: 'InvoiceUpload', entityId: created._id, message: `Supplier invoice uploaded: ${created.fileName} (${created.uploadId}) — nothing read or saved yet` });
    return { ...presentUpload(created.toObject()), duplicateOf: same ? { uploadId: same.uploadId, fileName: same.fileName, status: same.status, orderId: same.orderId } : undefined };
  } catch (e) {
    await storage.remove(storageKey).catch(() => {}); // never leave a file behind without a record
    throw e;
  }
}

export async function listUploads(orgId, { status, search, page, limit }) {
  const filter = { organizationId: orgId };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ uploadId: rx }, { fileName: rx }];
  }
  const [rows, total] = await Promise.all([
    InvoiceUpload.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-extraction -reviewed').lean(),
    InvoiceUpload.countDocuments(filter),
  ]);
  return paginated(rows.map(presentUpload), { page, limit, total });
}

/** One upload with its status and what was read. A scan that has been "processing" for too long is reported as failed (see invoiceProcessingService). */
export async function getUpload(orgId, id) {
  const { getProcessingStatus } = await import('./invoiceProcessingService.js');
  await getProcessingStatus(orgId, id); // settles a lost run first
  return presentUpload(await loadUpload(orgId, id));
}

/** The stored file, for the authenticated download. */
export async function getUploadFile(orgId, id) {
  const u = await loadUpload(orgId, id);
  if (!u.storageKey) throw fail(410, 'The file for this upload has been removed.', 'UPLOAD_FILE_REMOVED');
  return { buffer: await getStorage().get(u.storageKey), mimeType: u.mimeType, fileName: u.fileName };
}

/** Removes the file for good (and what was read from it). The record stays, marked as removed. An upload that already became a draft order is kept. */
export async function discardUpload(req, id) {
  const u = await loadUpload(req.orgId, id);
  if (u.status === 'drafted') throw fail(409, 'A draft order was already made from this invoice, so it is kept.', 'UPLOAD_STATE');
  if (u.status === 'processing') throw fail(409, 'This invoice is being read. Wait for it to finish, then remove it.', 'UPLOAD_STATE');
  if (u.status === 'discarded') return presentUpload(u);
  const claimed = await InvoiceUpload.findOneAndUpdate({ _id: u._id, organizationId: req.orgId, status: u.status }, { $set: { status: 'discarded' }, $unset: { storageKey: 1, extraction: 1, reviewed: 1, ocrSummary: 1, aiStatus: 1, aiVersion: 1, aiError: 1 } }, { returnDocument: 'after' }).lean();
  if (!claimed) throw fail(409, 'This upload was just changed by someone else.', 'UPLOAD_STATE');
  if (u.storageKey) await getStorage().remove(u.storageKey);
  await InvoiceOcr.deleteMany({ organizationId: req.orgId, uploadObjectId: u._id }); // what was read from the file goes with it
  await (await import('./invoiceAiExtractionService.js')).deleteExtractions(req.orgId, u._id); // …including the AI's structured readings of it
  await audit(req, { action: 'AI_INVOICE_DISCARD', entity: 'InvoiceUpload', entityId: u._id, message: `Supplier invoice ${u.uploadId} removed` });
  return presentUpload(claimed);
}

/**
 * Saves what the user reviewed as a DRAFT ORDER (the same order rules and arithmetic as any order) and links it to the upload. It never touches stock:
 * stock only changes when goods are received against an order. The same upload always makes the same draft (the order's idempotency key is the upload),
 * so a double click or a retry cannot make two.
 */
export async function saveDraft(req, id, { reviewed, notes, acknowledgeDuplicate, ...order }) {
  const u = await loadUpload(req.orgId, id);
  if (u.status === 'drafted') {
    const existing = u.orderId ? await mongoose.model('Order').findOne({ _id: u.orderId, organizationId: req.orgId }).lean() : null;
    if (existing) return { upload: presentUpload(u), order: existing, replayed: true };
  }
  if (['processing', 'discarded', 'drafted'].includes(u.status)) throw fail(409, `This upload is ${UPLOAD_STATUS_LABEL[u.status].toLowerCase()}, so a draft can't be saved from it.`, 'UPLOAD_STATE');
  // The same supplier's invoice number already on an order (or another upload)? Don't make a second record by accident: an authorized person can confirm a legitimate case.
  if (order.referenceNo) {
    const supplier = mongoose.isValidObjectId(order.supplierId) ? await mongoose.model('Supplier').findOne({ _id: order.supplierId, organizationId: req.orgId }).select('name gstin').lean() : null;
    const { findDuplicates } = await import('./invoiceAiExtractionService.js');
    const dups = (await findDuplicates(req.orgId, { supplierName: supplier?.name, gstin: supplier?.gstin, invoiceNumber: order.referenceNo, exceptUploadId: u.uploadId })).filter((d) => d.type === 'order');
    if (dups.length) {
      const may = hasPermission(req.user, 'orders:approve');
      if (!acknowledgeDuplicate) throw fail(409, `An order for invoice ${order.referenceNo} from this supplier already exists (${dups.map((d) => d.reference).join(', ')}). Saving it again would duplicate it.`, 'DUPLICATE_INVOICE', dups);
      if (!may) throw fail(403, 'Only someone who can approve orders may save an invoice that already exists.', 'DUPLICATE_INVOICE_NOT_ALLOWED', dups);
      await audit(req, { action: 'AI_INVOICE_DUPLICATE_OVERRIDE', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${order.referenceNo} saved as a draft although ${dups.map((d) => d.reference).join(', ')} already exists` });
    }
  }
  const tag = `[AI Billing upload ${u.uploadId}]`;
  const { order: created } = await createOrder(req, { ...order, notes: `${notes ? `${notes} ` : ''}${tag}`.slice(0, 500), status: 'draft', idempotencyKey: `aibilling-${u._id}` });
  const claimed = await InvoiceUpload.findOneAndUpdate(
    { _id: u._id, organizationId: req.orgId, status: { $in: ['uploaded', 'completed', 'failed', 'drafted'] } },
    { $set: { status: 'drafted', orderId: created._id, reviewed: reviewed || undefined, draftedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw fail(409, 'This upload was just changed by someone else.', 'UPLOAD_STATE');
  await audit(req, { action: 'AI_INVOICE_DRAFT', entity: 'InvoiceUpload', entityId: u._id, message: `Draft order ${created.orderNo} saved from supplier invoice ${u.uploadId} — no stock changed` });
  return { upload: presentUpload(claimed), order: created, replayed: false };
}
