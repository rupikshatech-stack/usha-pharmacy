import { InvoiceOcr, InvoiceUpload, UPLOAD_STATUS_LABEL } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { runInBackground } from '../utils/background.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { audit } from './audit.service.js';
import { reviewDraft } from './aiBilling.service.js';
import { extractWithProvider, providerStatus } from './invoiceExtraction/index.js';
import { loadUpload, presentUpload } from './invoiceUpload.service.js';
import { aiStatus } from './aiExtraction/aiInvoiceExtractionService.js';
import { ocrStatus, runOcr } from './ocr/ocrService.js';
import { getStorage } from './storage/index.js';

/**
 * Processing an uploaded invoice: the file is read by the OCR service (Phase 2) and, if one is connected, by the structured-extraction service
 * (Phase 1's provider; Phase 3's job), in the background, with a status the screen can follow. What OCR returns is stored as it is — raw and UNVERIFIED —
 * in its own record. Nothing here matches products, makes an order, receives goods, touches stock or pays anyone: those are for people, later phases
 * and other modules. This file knows nothing about any particular OCR vendor (that is ocr/); the screens know nothing about this file's internals.
 */
const STUCK_MS = 10 * 60 * 1000; // a run that has been "processing" this long is treated as lost (e.g. the server restarted)
const MAX_OCR_BYTES = 12 * 1024 * 1024; // a MongoDB document may not exceed 16 MB; leave room

const fail = (status, message, code) => new ApiError(status, message, undefined, code);

/**
 * What the screens need to know before offering a scan: is any reading service ready, and what is missing? The top-level fields are the structured
 * provider's (as in Phase 1, so nothing that reads them breaks) with `configured` meaning "anything can read a file"; `ocr` is the OCR service.
 */
export function readiness() {
  const ocr = ocrStatus();
  const structured = providerStatus();
  const configured = ocr.configured || structured.configured;
  const setup = configured ? undefined : [structured.setup, ocr.setup].filter(Boolean).join(' ');
  return { ...structured, configured, ai: aiStatus(), ocr, structured: { configured: structured.configured, provider: structured.provider, label: structured.label }, setup };
}

/** The result as stored: if it is too large for one record, the line geometry (never the text) is left out. */
function fit(result) {
  const size = (r) => Buffer.byteLength(JSON.stringify(r));
  if (size(result) <= MAX_OCR_BYTES) return result;
  const noBoxes = { ...result, reduced: 'line positions were left out because the result was very large', pages: result.pages.map((p) => ({ ...p, lines: p.lines.map(({ box, ...l }) => l) })) };
  if (size(noBoxes) <= MAX_OCR_BYTES) return noBoxes;
  return { ...noBoxes, reduced: 'the per-line layout was left out because the result was very large; the full text is kept', pages: result.pages.map((p) => ({ ...p, lines: [] })) };
}

async function run(orgId, id, userId, userName) {
  await runWithTenant(orgId, async () => {
    const u = await InvoiceUpload.findOne({ _id: id, organizationId: orgId, status: 'processing' }).lean();
    if (!u) return;
    const finish = (set, unset) => InvoiceUpload.updateOne({ _id: id, organizationId: orgId, status: 'processing' }, { $set: { finishedAt: new Date(), ...set }, ...(unset && { $unset: unset }) });
    try {
      const buffer = await getStorage().get(u.storageKey);
      const input = { buffer, mimeType: u.mimeType, fileName: u.fileName };
      let ocr;
      let ocrErr;
      let extraction;
      let extractionErr;
      let structuredProvider;
      if (ocrStatus().configured) {
        try {
          ocr = await runOcr(input);
        } catch (e) {
          ocrErr = e;
        }
      }
      if (providerStatus().configured) {
        try {
          const out = await extractWithProvider(input);
          structuredProvider = out.provider;
          extraction = await reviewDraft(orgId, out.raw);
        } catch (e) {
          extractionErr = e;
        }
      }
      if (!ocr && !extraction) {
        const e = ocrErr || extractionErr || fail(501, 'No reading service is connected.', 'AI_NOT_CONFIGURED');
        await finish({ status: 'failed', error: { code: e.code || 'PROCESSING_FAILED', message: e.code || e.status < 500 ? e.message : 'The invoice could not be read.' } });
        return;
      }
      const notes = [ocrErr && `OCR failed: ${ocrErr.message}`, extractionErr && `Structured extraction failed: ${extractionErr.message}`, ...(ocr?.warnings || [])].filter(Boolean);
      let ocrSummary;
      if (ocr) {
        const stored = fit({ ...ocr });
        await InvoiceOcr.findOneAndUpdate(
          { organizationId: orgId, uploadObjectId: u._id },
          { $set: { uploadId: u.uploadId, provider: ocr.provider, processor: ocr.processor, mimeType: u.mimeType, pageCount: stored.pageCount, text: stored.text, pages: stored.pages, tables: stored.tables, entities: stored.entities || [], fields: stored.fields || {}, lineItems: stored.lineItems || [], warnings: stored.warnings || [], reduced: stored.reduced, durationMs: stored.durationMs, processedAt: new Date(), processedBy: userId } },
          { upsert: true, returnDocument: 'after' },
        );
        ocrSummary = { provider: ocr.provider, pageCount: stored.pageCount, textLength: stored.text.length, tableCount: stored.tables.length, warningCount: (stored.warnings || []).length, durationMs: stored.durationMs, processedAt: new Date() };
      }
      await finish(
        { status: 'completed', provider: ocr?.provider || structuredProvider, notes, ...(ocrSummary && { ocrSummary }), ...(extraction && { extraction }) },
        { error: 1 },
      );
      await audit({ orgId, user: { _id: userId, name: userName } }, { action: 'AI_INVOICE_SCAN', entity: 'InvoiceUpload', entityId: id, message: `Supplier invoice ${u.uploadId} read${ocrSummary ? ` by ${ocr.provider} (${ocrSummary.pageCount} page${ocrSummary.pageCount === 1 ? '' : 's'}, ${ocrSummary.tableCount} table${ocrSummary.tableCount === 1 ? '' : 's'})` : ''} — unverified; nothing saved yet` });
    } catch (e) {
      await finish({ status: 'failed', error: { code: e.code || 'PROCESSING_FAILED', message: e.code ? e.message : 'The invoice could not be read.' } });
    }
  });
}

/**
 * Starts reading an uploaded invoice (POST /:id/extract) or reading it again (POST /:id/reprocess). It runs in the background: the answer is "202,
 * processing" and the screen follows the status until "completed" or "failed". A document that is already being read, or that is already read (extract
 * only starts the first reading; reprocess replaces it), is refused, so the same invoice is never processed twice at once or by accident.
 */
export async function startProcessing(req, id, { again = false } = {}) {
  const u = await loadUpload(req.orgId, id);
  const allowed = again ? ['completed', 'failed'] : ['uploaded', 'failed'];
  if (!allowed.includes(u.status)) {
    const why =
      u.status === 'processing' ? 'This invoice is already being read.'
      : u.status === 'completed' && !again ? 'This invoice has already been read. Use reprocess to read it again.'
      : u.status === 'uploaded' && again ? 'This invoice has not been read yet. Scan it first.'
      : `This upload is ${UPLOAD_STATUS_LABEL[u.status].toLowerCase()} and can't be ${again ? 'reprocessed' : 'scanned'}.`;
    throw fail(409, why, 'UPLOAD_STATE');
  }
  if (!u.storageKey) throw fail(410, 'The file for this upload has been removed.', 'UPLOAD_FILE_REMOVED');
  const ready = readiness();
  if (!ready.configured) throw fail(501, `No invoice-reading service is connected. ${ready.setup}`, 'AI_NOT_CONFIGURED');
  const claimed = await InvoiceUpload.findOneAndUpdate(
    { _id: u._id, organizationId: req.orgId, status: u.status },
    { $set: { status: 'processing', startedAt: new Date(), provider: ready.ocr.configured ? ready.ocr.provider : ready.structured.provider }, $unset: { finishedAt: 1, error: 1 }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw fail(409, 'This invoice is already being read.', 'UPLOAD_STATE');
  await audit(req, { action: again ? 'AI_INVOICE_REPROCESS' : 'AI_INVOICE_SCAN_START', entity: 'InvoiceUpload', entityId: u._id, message: `${again ? 'Reading again' : 'Reading'} supplier invoice ${u.uploadId}${ready.ocr.configured ? ` with ${ready.ocr.label}` : ''}` });
  runInBackground(() => run(req.orgId, u._id, req.user._id, req.user.name));
  return presentUpload(claimed);
}

/** Where processing stands. A run that has been "processing" for too long is reported (and recorded) as failed so nobody waits forever. */
export async function getProcessingStatus(orgId, id) {
  let u = await loadUpload(orgId, id);
  if (u.status === 'processing' && u.startedAt && Date.now() - new Date(u.startedAt).getTime() > STUCK_MS) {
    const msg = 'The scan did not finish (it timed out). Scan the invoice again.';
    u = (await InvoiceUpload.findOneAndUpdate({ _id: u._id, organizationId: orgId, status: 'processing' }, { $set: { status: 'failed', finishedAt: new Date(), error: { code: 'SCAN_TIMED_OUT', message: msg } } }, { returnDocument: 'after' }).lean()) || u;
  }
  const hasOcr = Boolean(u.ocrSummary);
  return {
    _id: u._id, uploadId: u.uploadId, status: u.status, statusLabel: UPLOAD_STATUS_LABEL[u.status] || u.status, attempts: u.attempts || 0, provider: u.provider || null,
    startedAt: u.startedAt, finishedAt: u.finishedAt, error: u.error, notes: u.notes || [], hasOcr, hasExtraction: Boolean(u.extraction), ocr: u.ocrSummary || null,
  };
}

/** The OCR results of an upload: the text, page by page, the tables and anything the provider detected. Raw and unverified. */
export async function getOcrResult(orgId, id) {
  const u = await loadUpload(orgId, id);
  const r = await InvoiceOcr.findOne({ organizationId: orgId, uploadObjectId: u._id }).lean();
  if (!r) {
    const why = u.status === 'processing' ? 'This invoice is still being read.' : u.status === 'failed' ? `Reading failed: ${u.error?.message || 'no reason was recorded'}` : 'This invoice has not been read yet.';
    throw fail(409, `There are no OCR results yet. ${why}`, 'OCR_NOT_READY');
  }
  const { _id, organizationId, uploadObjectId, __v, ...rest } = r;
  return { ...rest, ocrId: _id, upload: { _id: u._id, uploadId: u.uploadId, fileName: u.fileName, mimeType: u.mimeType, status: u.status, statusLabel: UPLOAD_STATUS_LABEL[u.status] }, verified: false };
}
