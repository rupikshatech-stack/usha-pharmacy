import { InvoiceExtraction, InvoiceOcr, InvoiceUpload, Order, UPLOAD_STATUS_LABEL } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { audit } from './audit.service.js';
import { aiStatus, extractInvoice } from './aiExtraction/aiInvoiceExtractionService.js';
import { assignItemIds, normalizeExtraction } from './aiExtraction/invoiceExtractionSchema.js';
import { issueMap, validateExtraction } from './aiExtraction/invoiceValidationService.js';
import { buildMeta, mergeEdits, traceIssues } from './aiExtraction/sourceTracking.js';
import { loadUpload } from './invoiceUpload.service.js';

/**
 * AI structured extraction (Phase 3): the OCR result of an upload is turned into a structured invoice by a language model, then CHECKED by the backend
 * (re-calculated money, formats, dates, links back to the OCR text) and shown to a person for review. The AI's output is kept apart from the working
 * copy people edit, every run is a new version, and nothing here makes an order, matches a product, receives stock, records a payment or marks anything
 * verified: only a person reviewing it does that. The OCR record is read, never changed.
 */
const STUCK_MS = 10 * 60 * 1000;
const fail = (status, message, code, details) => new ApiError(status, message, details, code);

export const STATE_LABEL = {
  ocr_pending: 'OCR Pending', ocr_completed: 'OCR Completed', ai_processing: 'AI Processing', ai_completed: 'AI Extraction Completed',
  validation_required: 'Validation Required', ready_for_review: 'Ready for Review', reviewed: 'Reviewed', failed: 'Failed',
};

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Where an invoice stands, as one of the eight states the screens show. AI success alone never reaches "Reviewed". */
export function stateOf(u, ex) {
  if (['uploaded', 'processing'].includes(u.status)) return 'ocr_pending';
  if (u.status === 'failed') return 'failed';
  if (u.aiStatus === 'processing') return 'ai_processing';
  if (u.aiStatus === 'failed') return 'failed';
  if (!ex) return 'ocr_completed';
  if (ex.reviewStatus === 'reviewed') return 'reviewed';
  if (!ex.validation) return 'ai_completed';
  return ex.validation.requiresReview ? 'validation_required' : 'ready_for_review';
}

const latest = (orgId, uploadObjectId, version) =>
  InvoiceExtraction.findOne({ organizationId: orgId, uploadObjectId, ...(version && { version }) }).sort({ version: -1 }).lean();

/* ------------------------------------------------------------------------------------------------ duplicates */

/**
 * Invoices that look like this one: the same supplier (GSTIN, or the same name) and the same invoice number — among orders already made (not cancelled)
 * and among other uploads that have been read. Nothing is merged or blocked here; the callers decide what a duplicate means.
 */
export async function findDuplicates(orgId, { supplierName, gstin, invoiceNumber, exceptUploadId }) {
  const number = squash(invoiceNumber);
  if (number.length < 2) return [];
  const sameSupplier = (name, g) => (gstin && g && gstin.replace(/\s/g, '').toUpperCase() === String(g).replace(/\s/g, '').toUpperCase()) || (supplierName && name && squash(supplierName) === squash(name));
  const out = [];
  const raw = String(invoiceNumber).trim();
  const orders = await Order.find({ organizationId: orgId, status: { $ne: 'cancelled' }, referenceNo: new RegExp(`^\\s*${escapeRegex(raw)}\\s*$`, 'i') }).select('orderNo status referenceNo supplier orderDate').lean();
  for (const o of orders) {
    if (sameSupplier(o.supplier?.name, o.supplier?.gstin)) out.push({ type: 'order', id: String(o._id), reference: o.orderNo, status: o.status, supplier: o.supplier?.name, date: o.orderDate });
  }
  const others = await InvoiceExtraction.find({ organizationId: orgId, 'current.invoice.invoiceNumber': new RegExp(`^\\s*${escapeRegex(raw)}\\s*$`, 'i'), ...(exceptUploadId && { uploadId: { $ne: exceptUploadId } }) })
    .select('uploadId uploadObjectId version current.supplier current.invoice reviewStatus').lean();
  for (const e of others) {
    const up = await InvoiceUpload.findOne({ _id: e.uploadObjectId, organizationId: orgId }).select('status aiVersion fileName').lean();
    if (!up || up.status === 'discarded' || up.aiVersion !== e.version) continue; // only the invoice's current reading counts
    if (sameSupplier(e.current.supplier?.name, e.current.supplier?.gstin)) out.push({ type: 'upload', id: String(e.uploadObjectId), reference: e.uploadId, status: up.status === 'drafted' ? 'draft saved' : e.reviewStatus.replace('_', ' '), supplier: e.current.supplier?.name, date: null, fileName: up.fileName });
  }
  return out;
}

const duplicatesFor = (orgId, uploadId, current) =>
  findDuplicates(orgId, { supplierName: current.supplier?.name, gstin: current.supplier?.gstin, invoiceNumber: current.invoice?.invoiceNumber, exceptUploadId: uploadId });

/** Validation + links back to the OCR + duplicates, all computed fresh from the data and never written into it. */
async function check(orgId, uploadId, current, meta) {
  const v = validateExtraction(current);
  const trace = traceIssues(meta, current);
  const duplicates = await duplicatesFor(orgId, uploadId, current);
  const dupIssues = duplicates.map((d) => ({ severity: 'error', code: 'DUPLICATE_INVOICE', path: 'invoice.invoiceNumber', message: `An invoice ${current.invoice.invoiceNumber} from this supplier already exists (${d.type === 'order' ? 'order' : 'upload'} ${d.reference}, ${d.status}).`, reference: d.reference }));
  const issues = [...v.issues, ...trace, ...dupIssues].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a.severity] - ({ error: 0, warning: 1, info: 2 })[b.severity]);
  const count = (s) => issues.filter((i) => i.severity === s).length;
  const validation = { ...v, issues, summary: { errors: count('error'), warnings: count('warning'), info: count('info') }, requiresReview: count('error') + count('warning') > 0 };
  return { validation, duplicates };
}

/* ------------------------------------------------------------------------------------------------ running it */

async function run(orgId, id, user) {
  await runWithTenant(orgId, async () => {
    const u = await InvoiceUpload.findOne({ _id: id, organizationId: orgId, aiStatus: 'processing' }).lean();
    if (!u) return;
    const finish = (set, unset) => InvoiceUpload.updateOne({ _id: id, organizationId: orgId, aiStatus: 'processing' }, { $set: { aiFinishedAt: new Date(), ...set }, ...(unset && { $unset: unset }) });
    try {
      const ocr = await InvoiceOcr.findOne({ organizationId: orgId, uploadObjectId: id }).lean();
      if (!ocr) throw fail(409, 'The OCR result for this invoice is missing. Scan the invoice again.', 'OCR_NOT_READY');
      const started = Date.now();
      const out = await extractInvoice(ocr);
      let normalized;
      try {
        normalized = normalizeExtraction(out.raw);
      } catch (e) {
        throw fail(502, `The AI service did not return an invoice in the expected form (${e.message}).`, 'AI_BAD_RESPONSE');
      }
      const { data, problems, warnings } = normalized;
      assignItemIds(data.items); // each row gets a stable id (later steps attach to it)
      const { meta } = buildMeta(ocr, data);
      const { validation, duplicates } = await check(orgId, u.uploadId, data, meta);
      const last = await InvoiceExtraction.findOne({ organizationId: orgId, uploadObjectId: id }).sort({ version: -1 }).select('version').lean();
      const version = (last?.version || 0) + 1;
      const aiWarnings = [...warnings, ...(out.truncated ? ['The OCR text was very long and was cut before it was sent to the AI; rows near the end may be missing.'] : []), ...problems.map((p) => `${p.message}${p.interpreted ? '' : ' (left empty)'}`)];
      if (!data.items.length) aiWarnings.push('The AI did not find any medicine rows.');
      await InvoiceExtraction.create({
        organizationId: orgId, uploadObjectId: id, uploadId: u.uploadId, version, provider: out.provider, model: out.model, usage: out.usage || undefined, durationMs: Date.now() - started,
        ocrId: ocr._id, ocrProcessedAt: ocr.processedAt, data, problems, aiWarnings, current: data, meta, validation, validatedAt: new Date(), duplicates,
        reviewStatus: validation.requiresReview ? 'needs_review' : 'ready_for_review', initiatedBy: user._id, initiatedByName: user.name, extractedAt: new Date(),
      });
      await finish({ aiStatus: 'completed', aiVersion: version }, { aiError: 1 });
      await audit({ orgId, user: { _id: user._id, name: user.name } }, { action: 'AI_EXTRACT', entity: 'InvoiceUpload', entityId: id, message: `Invoice ${u.uploadId} read by ${out.provider} (${out.model}): ${data.items.length} line${data.items.length === 1 ? '' : 's'}, ${validation.summary.errors} error(s), ${validation.summary.warnings} warning(s) — unverified; nothing saved yet` });
    } catch (e) {
      await finish({ aiStatus: 'failed', aiError: { code: e.code || 'AI_FAILED', message: e.code ? e.message : 'The invoice could not be read by the AI.' } });
    }
  });
}

/**
 * Starts the AI extraction (POST /:id/ai-extract) or runs it again (POST /:id/reprocess-ai, which adds a new version and keeps the old ones). The OCR scan
 * must have completed first. It runs in the background (202); a second request while it runs, or a first-time request for an invoice already extracted, is
 * refused so one invoice is never extracted twice at once or by accident.
 */
export async function startAiExtraction(req, id, { again = false } = {}) {
  const u = await loadUpload(req.orgId, id);
  if (u.status !== 'completed' || !u.ocrSummary) throw fail(409, u.status === 'processing' ? 'The invoice is still being read by OCR.' : u.status === 'drafted' ? 'A draft order was already saved from this invoice.' : 'Scan the invoice with OCR first. The AI reads the OCR text.', 'OCR_NOT_READY');
  if (u.aiStatus === 'processing') throw fail(409, 'The AI is already reading this invoice.', 'AI_ALREADY_RUNNING');
  const existing = await latest(req.orgId, u._id);
  if (!again && existing) throw fail(409, 'This invoice has already been extracted. Use re-extract to run it again.', 'AI_ALREADY_EXTRACTED');
  if (again && !existing && u.aiStatus !== 'failed') throw fail(409, 'This invoice has not been extracted yet. Use “Extract Invoice with AI” first.', 'AI_NOT_EXTRACTED');
  const status = aiStatus();
  if (!status.configured) throw fail(501, `AI extraction is not set up. ${status.setup}`, 'AI_EXTRACTION_NOT_CONFIGURED');
  const claimed = await InvoiceUpload.findOneAndUpdate(
    { _id: u._id, organizationId: req.orgId, status: 'completed', aiStatus: { $ne: 'processing' } },
    { $set: { aiStatus: 'processing', aiStartedAt: new Date() }, $unset: { aiFinishedAt: 1, aiError: 1 }, $inc: { aiAttempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw fail(409, 'The AI is already reading this invoice.', 'AI_ALREADY_RUNNING');
  await audit(req, { action: again ? 'AI_EXTRACT_REPROCESS' : 'AI_EXTRACT_START', entity: 'InvoiceUpload', entityId: u._id, message: `${again ? 'Re-extracting' : 'Extracting'} invoice ${u.uploadId} with ${status.label}` });
  setImmediate(() => run(req.orgId, u._id, { _id: req.user._id, name: req.user.name }).catch(() => {}));
  return extractionStatus(req.orgId, u._id);
}

/** Where AI extraction stands. A run that has been "processing" for too long is reported (and recorded) as failed so nobody waits forever. */
export async function extractionStatus(orgId, id) {
  let u = await loadUpload(orgId, id);
  if (u.aiStatus === 'processing' && u.aiStartedAt && Date.now() - new Date(u.aiStartedAt).getTime() > STUCK_MS) {
    u = (await InvoiceUpload.findOneAndUpdate({ _id: u._id, organizationId: orgId, aiStatus: 'processing' }, { $set: { aiStatus: 'failed', aiFinishedAt: new Date(), aiError: { code: 'AI_TIMED_OUT', message: 'The AI extraction did not finish (it timed out). Try again.' } } }, { returnDocument: 'after' }).lean()) || u;
  }
  const stored = await latest(orgId, u._id);
  const fresh = stored ? await check(orgId, u.uploadId, stored.current, stored.meta) : null; // checked again on every read, so a later duplicate shows up on the earlier invoice too
  const ex = stored && { ...stored, validation: fresh.validation, duplicates: fresh.duplicates };
  const state = stateOf(u, ex);
  return {
    _id: u._id, uploadId: u.uploadId, uploadStatus: u.status, state, stateLabel: STATE_LABEL[state], aiStatus: u.aiStatus || null, attempts: u.aiAttempts || 0, startedAt: u.aiStartedAt, finishedAt: u.aiFinishedAt,
    error: u.aiStatus === 'failed' ? u.aiError : u.status === 'failed' ? u.error : undefined,
    hasExtraction: Boolean(ex), version: ex?.version ?? null, provider: ex?.provider ?? null, model: ex?.model ?? null, extractedAt: ex?.extractedAt ?? null,
    reviewStatus: ex?.reviewStatus ?? null, requiresReview: ex ? ex.validation?.requiresReview ?? true : null, validation: ex?.validation?.summary ?? null,
    duplicateCount: ex?.duplicates?.length ?? 0, stale: Boolean(ex && u.ocrSummary?.processedAt && ex.ocrProcessedAt && new Date(u.ocrSummary.processedAt) > new Date(ex.ocrProcessedAt)),
    humanReviewed: ex?.reviewStatus === 'reviewed',
  };
}

/** The structured extraction (the latest version, or a named one), with the AI's original beside the working copy, the links back to the OCR and the checks. */
export async function getExtraction(orgId, id, { version } = {}) {
  const u = await loadUpload(orgId, id);
  const stored = await latest(orgId, u._id, version);
  const ex = stored && { ...stored, ...(await check(orgId, u.uploadId, stored.current, stored.meta)) };
  if (!ex) {
    const why = u.aiStatus === 'processing' ? 'The AI is still reading this invoice.' : u.aiStatus === 'failed' ? `The AI extraction failed: ${u.aiError?.message || 'no reason was recorded'}` : version ? `There is no version ${version}.` : 'This invoice has not been extracted yet.';
    throw fail(409, `There is no extracted invoice yet. ${why}`, 'AI_NOT_EXTRACTED');
  }
  const versions = (await InvoiceExtraction.find({ organizationId: orgId, uploadObjectId: u._id }).sort({ version: -1 }).select('version extractedAt provider model initiatedByName reviewStatus').lean()).map((v) => ({ version: v.version, extractedAt: v.extractedAt, provider: v.provider, model: v.model, initiatedByName: v.initiatedByName, reviewStatus: v.reviewStatus }));
  const state = stateOf({ ...u, aiStatus: u.aiStatus === 'processing' ? 'processing' : 'completed' }, ex);
  return {
    upload: { _id: u._id, uploadId: u.uploadId, fileName: u.fileName, mimeType: u.mimeType, status: u.status, statusLabel: UPLOAD_STATUS_LABEL[u.status] },
    version: ex.version, latest: !version || ex.version === versions[0]?.version, versions, provider: ex.provider, model: ex.model, extractedAt: ex.extractedAt, durationMs: ex.durationMs, initiatedByName: ex.initiatedByName,
    original: ex.data, current: ex.current, meta: ex.meta, validation: ex.validation, issueMap: issueMap(ex.validation?.issues || []), duplicates: ex.duplicates, aiWarnings: ex.aiWarnings, problems: ex.problems,
    state, stateLabel: STATE_LABEL[state], reviewStatus: ex.reviewStatus, humanReviewed: ex.reviewStatus === 'reviewed', reviewedByName: ex.reviewedByName, reviewedAt: ex.reviewedAt,
    editCount: ex.editCount, editedByName: ex.editedByName, editedAt: ex.editedAt, stale: Boolean(u.ocrSummary?.processedAt && ex.ocrProcessedAt && new Date(u.ocrSummary.processedAt) > new Date(ex.ocrProcessedAt)),
    verified: false, // the AI's output is never verified by itself; see humanReviewed
  };
}

/** Runs the backend checks again on the current working copy (after edits, or on request) and stores the result. Never changes the data. */
export async function revalidate(req, id) {
  const u = await loadUpload(req.orgId, id);
  const ex = await latest(req.orgId, u._id);
  if (!ex) throw fail(409, 'This invoice has not been extracted yet.', 'AI_NOT_EXTRACTED');
  const { validation, duplicates } = await check(req.orgId, u.uploadId, ex.current, ex.meta);
  const reviewStatus = ex.reviewStatus === 'reviewed' ? 'reviewed' : validation.requiresReview ? 'needs_review' : 'ready_for_review';
  await InvoiceExtraction.updateOne({ _id: ex._id, organizationId: req.orgId }, { $set: { validation, duplicates, validatedAt: new Date(), reviewStatus } });
  await audit(req, { action: 'AI_EXTRACT_VALIDATE', entity: 'InvoiceUpload', entityId: u._id, message: `Invoice ${u.uploadId} validated: ${validation.summary.errors} error(s), ${validation.summary.warnings} warning(s)` });
  return getExtraction(req.orgId, id);
}

/**
 * A person's corrections to the working copy (PUT /:id/extracted). The submitted invoice is checked as strictly as the AI's answer: a value that is not
 * the right type is REFUSED (422) rather than quietly dropped. The AI's original is untouched. `reviewed: true` records that this person checked it — it
 * needs `confirmed: true`, and `acknowledgeIssues: true` while errors remain — and any later change takes the "reviewed" mark away again.
 */
export async function updateExtraction(req, id, { data, reviewed = false, confirmed = false, acknowledgeIssues = false, expectedEditCount }) {
  const u = await loadUpload(req.orgId, id);
  if (u.status === 'drafted') throw fail(409, 'A draft order was already saved from this invoice, so it can no longer be changed here.', 'UPLOAD_STATE');
  if (u.aiStatus === 'processing') throw fail(409, 'The AI is reading this invoice right now. Wait for it to finish.', 'AI_ALREADY_RUNNING');
  const ex = await latest(req.orgId, u._id);
  if (!ex) throw fail(409, 'This invoice has not been extracted yet.', 'AI_NOT_EXTRACTED');
  if (ex.purchase?.orderId) throw fail(409, `A purchase order (${ex.purchase.orderNo}) was already ${ex.purchase.mode === 'linked' ? 'linked to' : 'made from'} this invoice, so it can no longer be changed.`, 'UPLOAD_STATE');
  if (expectedEditCount !== undefined && expectedEditCount !== ex.editCount) throw fail(409, 'Someone else changed this invoice while you were editing. Reload it and try again.', 'EXTRACTION_CHANGED');
  let normalized;
  try {
    normalized = normalizeExtraction({ ...data, warnings: [] });
  } catch (e) {
    throw fail(422, `The invoice could not be saved: ${e.message}`, 'EXTRACTION_INVALID');
  }
  const refused = normalized.problems.filter((p) => !p.interpreted && p.original !== null && p.original !== '');
  if (refused.length) throw fail(422, `Some values are not valid: ${refused.slice(0, 5).map((p) => p.message).join('; ')}.`, 'EXTRACTION_INVALID', refused.map((p) => ({ path: p.path, message: p.message })));
  const current = normalized.data;
  assignItemIds(current.items);
  const meta = mergeEdits(ex.meta, ex.current, current);
  const { validation, duplicates } = await check(req.orgId, u.uploadId, current, meta);
  if (reviewed) {
    if (!confirmed) throw fail(400, 'Confirm that you have checked the invoice against the document before marking it reviewed.', 'REVIEW_NOT_CONFIRMED');
    if (validation.summary.errors > 0 && !acknowledgeIssues) throw fail(409, `${validation.summary.errors} error(s) remain. Fix them, or acknowledge them to mark the invoice reviewed.`, 'REVIEW_ERRORS_REMAIN', validation.issues.filter((i) => i.severity === 'error'));
  }
  const reviewStatus = reviewed ? 'reviewed' : validation.requiresReview ? 'needs_review' : 'ready_for_review';
  const claimed = await InvoiceExtraction.findOneAndUpdate(
    { _id: ex._id, organizationId: req.orgId, editCount: ex.editCount },
    {
      $set: { current, meta, validation, duplicates, validatedAt: new Date(), reviewStatus, editedBy: req.user._id, editedByName: req.user.name, editedAt: new Date(), ...(reviewed ? { reviewedBy: req.user._id, reviewedByName: req.user.name, reviewedAt: new Date() } : {}) },
      ...(reviewed ? {} : { $unset: { reviewedBy: 1, reviewedByName: 1, reviewedAt: 1 } }),
      $inc: { editCount: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw fail(409, 'Someone else changed this invoice while you were editing. Reload it and try again.', 'EXTRACTION_CHANGED');
  await audit(req, { action: reviewed ? 'AI_EXTRACT_REVIEWED' : 'AI_EXTRACT_EDIT', entity: 'InvoiceUpload', entityId: u._id, message: reviewed ? `Extracted invoice ${u.uploadId} marked reviewed by ${req.user.name}` : `Extracted invoice ${u.uploadId} corrected (edit ${claimed.editCount})` });
  return getExtraction(req.orgId, id);
}

/** Removes the readings of an upload that is discarded. */
export const deleteExtractions = (orgId, uploadObjectId) => InvoiceExtraction.deleteMany({ organizationId: orgId, uploadObjectId });
