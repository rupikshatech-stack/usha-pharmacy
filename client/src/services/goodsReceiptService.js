import { api } from './api';

/**
 * Goods receipts and purchase history. A draft is prepared and edited here; confirming it is the one step that adds the accepted units to stock, on the
 * server, in one transaction. Nothing in the browser changes stock.
 */
export const goodsReceiptService = {
  /** A draft from an AI Billing invoice ({ uploadId }) or from an order ({ orderId }). Repeating it returns the open draft. */
  createDraft: (body) => api.post('/goods-receipts', body),
  list: (params) => api.get('/goods-receipts', { params }),
  get: (id) => api.get(`/goods-receipts/${id}`),
  update: (id, body) => api.put(`/goods-receipts/${id}`, body),
  /** Adds the accepted units to stock, once. */
  confirm: (id) => api.post(`/goods-receipts/${id}/confirm`, { confirmed: true }),
  /** Takes a confirmed receipt back out (needs permission to approve orders). */
  reverse: (id, reason) => api.post(`/goods-receipts/${id}/reverse`, { reason }),
  history: (orderId) => api.get(`/purchases/${orderId}/history`),
};
