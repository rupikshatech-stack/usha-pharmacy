import { api } from './api';

export const batchService = {
  /** Expiry alert counters (expired / within 30, 60, 90 days) and the manufacturers that appear on batches. */
  summary: () => api.get('/batches/summary'),
  get: (id) => api.get(`/batches/${id}`),
  /** Receive a new batch for a medicine. */
  create: (body) => api.post('/batches', body),
  /** Edit the permitted fields only: prices, manufacturer, status, reserved quantity. */
  update: (id, body) => api.patch(`/batches/${id}`, body),
  /** The batch's stock movement history (append-only ledger), newest first. */
  movements: (id, params) => api.get(`/batches/${id}/movements`, { params }),
};
