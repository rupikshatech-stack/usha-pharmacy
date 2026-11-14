import { api } from './api';

/** Suppliers: the companies stock is bought from. The Orders module's quick "new supplier" dialog uses `create` from here too — one API, one place. */
export const supplierService = {
  /** { items, page, limit, total, pages } — search, active ('active' | 'inactive' | 'all'), type, preferred, page, limit. */
  list: (params) => api.get('/suppliers', { params }),
  /** One supplier with the statistics worked out from its real orders and goods receipts. */
  get: (id) => api.get(`/suppliers/${id}`),
  create: (body) => api.post('/suppliers', body),
  update: (id, body) => api.put(`/suppliers/${id}`, body),
  setPreferred: (id, preferred) => api.post(`/suppliers/${id}/preferred`, { preferred }),
  setStatus: (id, status) => api.post(`/suppliers/${id}/status`, { status }),
  /** Their purchase history, read from the existing orders and goods receipts: { items, page, limit, total, pages }. */
  purchases: (id, params) => api.get(`/suppliers/${id}/purchases`, { params }),
  /** Only for a supplier with no purchasing history; the server refuses the rest and says to deactivate instead. */
  remove: (id) => api.delete(`/suppliers/${id}`),
};
