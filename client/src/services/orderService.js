import { api } from './api';

/** Supplier orders. The server works out every total, status and stock figure; the body only carries ids, quantities, prices, dates and choices. */
export const orderService = {
  meta: () => api.get('/orders/meta'),
  products: (search = '') => api.get('/orders/products', { params: { search } }),
  get: (id) => api.get(`/orders/${id}`),
  /** status: 'draft' saves it for later, 'submitted' sends it for approval (or approves it when approval is not required). Payment is only recorded. */
  create: (body) => api.post('/orders', body),
  /** Drafts only: the same body as creating (the status never changes). */
  update: (id, body) => api.put(`/orders/${id}`, body),
  /** the printable order: organization details + the order */
  print: (id) => api.get(`/orders/${id}/print`),
  /** draft → pending / approved */
  submit: (id) => api.post(`/orders/${id}/submit`),
  /** pending → approved (needs orders:approve) */
  approve: (id) => api.post(`/orders/${id}/approve`),
  /** pending → back to draft, with a reason (needs orders:approve) */
  reject: (id, reason) => api.post(`/orders/${id}/reject`, { reason }),
  /** approved → ordered: it has been sent to the supplier */
  markOrdered: (id) => api.post(`/orders/${id}/order`),
  /** before anything has arrived */
  cancel: (id, reason = '') => api.post(`/orders/${id}/cancel`, { reason }),
  /** the Goods Received form's data: each product with ordered, previously received, remaining and batch defaults */
  receivable: (id) => api.get(`/orders/${id}/receivable`),
  /** adds only the verified, accepted units to stock; records rejected and damaged units separately */
  receive: (id, body) => api.post(`/orders/${id}/receive`, body),
  receipts: (params) => api.get('/orders/receipts', { params }),
  settings: () => api.get('/orders/settings'),
  saveSettings: (approvalRequired) => api.put('/orders/settings', { approvalRequired }),
};

// Suppliers live in their own service; re-exported here so the order screens that already import it keep working.
export { supplierService } from './supplierService';
