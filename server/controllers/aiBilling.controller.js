import { ApiError } from '../utils/ApiError.js';
import { FILE_TYPES, reviewDraft } from '../services/aiBilling.service.js';
import * as uploads from '../services/invoiceUpload.service.js';
import * as processing from '../services/invoiceProcessingService.js';
import * as ai from '../services/invoiceAiExtractionService.js';
import * as pm from '../services/productMatching/productMatchingService.js';
import { assertMayUseBranch } from '../services/orderAccess.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const status = async (req, res) => ok(res, processing.readiness());
export const list = async (req, res) => ok(res, await uploads.listUploads(req.orgId, req.query));
export const get = async (req, res) => ok(res, await uploads.getUpload(req.orgId, req.params.id));

export const upload = async (req, res) => {
  const type = (req.headers['content-type'] || '').split(';')[0];
  if (!FILE_TYPES.includes(type)) throw new ApiError(415, 'Only PDF, PNG and JPEG files can be uploaded.', undefined, 'UPLOAD_UNSUPPORTED_TYPE');
  ok(res, await uploads.createUpload(req, { buffer: Buffer.isBuffer(req.body) ? req.body : undefined, fileName: String(req.query.fileName || 'invoice'), contentType: type }), 201);
};

/** The stored file, to people who may see uploads. Served as itself (never sniffed into something else) and never cached. */
export const file = async (req, res) => {
  const f = await uploads.getUploadFile(req.orgId, req.params.id);
  res.set({
    'Content-Type': f.mimeType,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.send(f.buffer);
};

export const scan = async (req, res) => ok(res, await processing.startProcessing(req, req.params.id), 202); // Scan Invoice: start reading (OCR), 202
export const reprocess = async (req, res) => ok(res, await processing.startProcessing(req, req.params.id, { again: true }), 202);
export const processingStatus = async (req, res) => ok(res, await processing.getProcessingStatus(req.orgId, req.params.id));
export const ocr = async (req, res) => ok(res, await processing.getOcrResult(req.orgId, req.params.id));
export const remove = async (req, res) => ok(res, await uploads.discardUpload(req, req.params.id));
export const draft = async (req, res) => {
  await assertMayUseBranch(req, req.body.branchId);
  const r = await uploads.saveDraft(req, req.params.id, req.body);
  ok(res, r, r.replayed ? 200 : 201);
};
export const match = async (req, res) => ok(res, await reviewDraft(req.orgId, req.body));

// AI structured extraction (Phase 3)
export const aiExtract = async (req, res) => ok(res, await ai.startAiExtraction(req, req.params.id), 202);
export const aiReprocess = async (req, res) => ok(res, await ai.startAiExtraction(req, req.params.id, { again: true }), 202);
export const aiStatus = async (req, res) => ok(res, await ai.extractionStatus(req.orgId, req.params.id));
export const extracted = async (req, res) => ok(res, await ai.getExtraction(req.orgId, req.params.id, { version: req.query.version }));
export const aiValidate = async (req, res) => ok(res, await ai.revalidate(req, req.params.id));
export const aiUpdate = async (req, res) => ok(res, await ai.updateExtraction(req, req.params.id, req.body));

// Product matching (Phase 4)
export const matchProducts = async (req, res) => ok(res, await pm.runMatching(req, req.params.id, req.body));
export const productMatches = async (req, res) => ok(res, await pm.getMatches(req.orgId, req.params.id, req.query));
export const suggestions = async (req, res) => ok(res, await pm.getSuggestions(req.orgId, req.params.id, req.params.itemId, req.query));
export const selectProduct = async (req, res) => ok(res, await pm.selectProduct(req, req.params.id, req.params.itemId, req.body));
export const confirmMatch = async (req, res) => ok(res, await pm.confirmItem(req, req.params.id, req.params.itemId, req.body));
export const confirmAllMatches = async (req, res) => ok(res, await pm.confirmAll(req, req.params.id));
export const markUnmatched = async (req, res) => ok(res, await pm.markUnmatched(req, req.params.id, req.params.itemId, req.body));
export const verifiedLines = async (req, res) => ok(res, await pm.verifiedLines(req.orgId, req.params.id));
