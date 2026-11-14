import { api } from './api';

export const medicineService = {
  get: (id) => api.get(`/inventory/${id}`),
  /** Live check: is this SKU / barcode already used by another medicine in the organization? */
  duplicates: (params) => api.get('/inventory/duplicates', { params }),
  create: (body) => api.post('/inventory', body),
  update: (id, body) => api.put(`/inventory/${id}`, body),
  /** Soft delete: archives a medicine with history, permanently deletes one that never had any. */
  remove: (id) => api.delete(`/inventory/${id}`),
  restore: (id) => api.post(`/inventory/${id}/restore`),
  /** Uploads a product photograph and returns where it is kept; the medicine's `image` field holds that address. */
  uploadImage: (file) =>
    api.post('/inventory/images', file, { headers: { 'Content-Type': file.type }, transformRequest: [(d) => d] }).then((r) => r.url),
  addBatch: (id, body) => api.post(`/inventory/${id}/batches`, body),
  updateBatch: (id, batchId, body) => api.patch(`/inventory/${id}/batches/${batchId}`, body),
};
