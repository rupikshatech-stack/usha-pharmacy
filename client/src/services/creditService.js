import { api } from './api';

/** Credit requests. The screenshot travels as the request body (an image); the amount and file name go in the query; the key makes a repeat the same request. */
export const creditService = {
  /** The conversion rate (rupees per credit) and the upload limits: one source for every screen. */
  settings: () => api.get('/credits/settings'),
  updateSettings: (rupeesPerCredit) => api.put('/credits/settings', { rupeesPerCredit }),
  submit: (file, amount, key, onProgress) =>
    api.post(`/credits/requests?amount=${encodeURIComponent(amount)}&fileName=${encodeURIComponent(file.name)}`, file, {
      headers: { 'Content-Type': file.type, ...(key && { 'Idempotency-Key': key }) },
      transformRequest: [(d) => d],
      onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
    }),
  /** { items, page, limit, total, pages } — pass page / limit / status, and scope: 'all' (administrators). */
  list: (params) => api.get('/credits/requests', { params }),
  get: (id) => api.get(`/credits/requests/${id}`),
  /** Credits awarded and request counts, worked out from the requests (scope 'all' for administrators). */
  summary: (scope) => api.get('/credits/summary', { params: scope ? { scope } : undefined }),
  /** An administrator approves with the payment amount they approve; the SERVER works out the credits (none are sent). */
  approve: (id, approvedAmount, remarks) => api.post(`/credits/requests/${id}/approve`, { approvedAmount, ...(remarks && { remarks }) }),
  reject: (id, remarks) => api.post(`/credits/requests/${id}/reject`, { remarks }),
  /** The signed-in person's credit balance (the header shows it); an administrator may pass someone else's id. */
  balance: (userId) => api.get('/credits/balance', { params: userId ? { userId } : undefined }),
  /** The credit ledger: { items, page, limit, total, pages } — page / limit / scope / userId / type / search / from / to. */
  transactions: (params) => api.get('/credits/transactions', { params }),
  /** The stored screenshot as a Blob, for the preview. */
  screenshot: (id) => api.get(`/credits/requests/${id}/screenshot`, { responseType: 'blob' }),
};
