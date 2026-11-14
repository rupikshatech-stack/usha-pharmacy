import { api } from './api';

/**
 * AI Billing: upload a supplier invoice, scan it, review it, save a draft order. The server chooses the reading service (OCR / AI); this client only
 * talks to one set of endpoints, so changing the provider never changes the screens. Nothing here changes stock.
 */
export const aiBillingService = {
  /** Is a reading service chosen and ready? (There is no OCR or AI built in.) */
  status: () => api.get('/ai-billing/status'),
  /** Stores the file and records it; nothing is read yet. onProgress gets 0–100 while the file travels. */
  upload: (file, onProgress) =>
    api.post(`/ai-billing/uploads?fileName=${encodeURIComponent(file.name)}`, file, {
      headers: { 'Content-Type': file.type },
      transformRequest: [(d) => d],
      onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
    }),
  list: (params) => api.get('/ai-billing/uploads', { params }),
  /** The upload with its status (uploaded / processing / completed / failed / drafted / discarded) and what was read. */
  get: (id) => api.get(`/ai-billing/uploads/${id}`),
  /** The stored file as a Blob, for the preview. */
  file: (id) => api.get(`/ai-billing/uploads/${id}/file`, { responseType: 'blob' }),
  /** Starts reading in the background (202); follow get() until it is no longer "processing". 501 when no service is connected. */
  scan: (id) => api.post(`/ai-billing/uploads/${id}/scan`),
  /** Where reading stands: { status: uploaded | processing | completed | failed, error, notes, hasOcr, ocr: summary }. */
  processing: (id) => api.get(`/ai-billing/${id}/status`),
  /** The OCR results (raw, unverified): text, pages, tables, detected fields. 409 until there are some. */
  ocr: (id) => api.get(`/ai-billing/${id}/ocr`),
  /** Reads a document that has already been read once again, replacing the earlier result (202; follow get()). */
  reprocess: (id) => api.post(`/ai-billing/${id}/reprocess`),
  /** AI structured extraction of the OCR text (202; follow extractionStatus). Needs the OCR scan first; 501 when no AI provider is set up. */
  aiExtract: (id) => api.post(`/ai-billing/${id}/ai-extract`),
  /** Runs it again: a new version is added and the old ones are kept. */
  reprocessAi: (id) => api.post(`/ai-billing/${id}/reprocess-ai`),
  /** { state: ocr_pending | ocr_completed | ai_processing | ai_completed | validation_required | ready_for_review | reviewed | failed, error, version, … } */
  extractionStatus: (id) => api.get(`/ai-billing/${id}/extraction-status`),
  /** The extracted invoice: the AI's original, the working copy, where each value came from, the checks and any duplicates. */
  extracted: (id, version) => api.get(`/ai-billing/${id}/extracted`, { params: version ? { version } : undefined }),
  /** A person's corrections (and, with reviewed + confirmed, their review). */
  saveExtracted: (id, body) => api.put(`/ai-billing/${id}/extracted`, body),
  /** Runs the backend checks again. */
  validate: (id) => api.post(`/ai-billing/${id}/validate`),
  /** Product matching (Phase 4): compares the extracted medicines with the existing products; nothing is confirmed, created or changed in stock. */
  matchProducts: (id, body = {}) => api.post(`/ai-billing/${id}/match-products`, body),
  productMatches: (id, params) => api.get(`/ai-billing/${id}/product-matches`, { params }),
  suggestions: (id, itemId, search) => api.get(`/ai-billing/${id}/product-matches/${itemId}/suggestions`, { params: search ? { search } : undefined }),
  selectProduct: (id, itemId, body) => api.put(`/ai-billing/${id}/product-matches/${itemId}`, body),
  confirmMatch: (id, itemId, body = {}) => api.post(`/ai-billing/${id}/product-matches/${itemId}/confirm`, body),
  confirmAllMatches: (id) => api.post(`/ai-billing/${id}/product-matches/confirm-all`),
  markUnmatched: (id, itemId, body = {}) => api.post(`/ai-billing/${id}/product-matches/${itemId}/mark-unmatched`, body),
  verifiedLines: (id) => api.get(`/ai-billing/${id}/verified-lines`),
  /** Purchasing (Phase 5): the final review, the person's verification, and creating or linking the purchase order. Receiving goods is goodsReceiptService. */
  finalReview: (id) => api.get(`/ai-billing/${id}/final-review`),
  verifyInvoice: (id, body) => api.post(`/ai-billing/${id}/final-review`, body),
  purchaseOrderOptions: (id, search) => api.get(`/ai-billing/${id}/purchase-order-options`, { params: search ? { search } : undefined }),
  createPurchaseOrder: (id, body = {}) => api.post(`/ai-billing/${id}/create-purchase-order`, body),
  linkPurchaseOrder: (id, body) => api.post(`/ai-billing/${id}/link-purchase-order`, body),
  /** Removes the file for good. */
  remove: (id) => api.delete(`/ai-billing/uploads/${id}`),
  /** The reviewed invoice becomes a DRAFT order, linked to the upload. Never touches stock. */
  draft: (id, body) => api.post(`/ai-billing/uploads/${id}/draft`, body),
  /** Matches typed or corrected lines against the products. */
  match: (body) => api.post('/ai-billing/match', body),
};
