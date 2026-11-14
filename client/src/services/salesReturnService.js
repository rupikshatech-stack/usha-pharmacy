import { api } from './api';

/** Sales returns. Processing one records the return against an invoice; stock only goes back when staff verify the units. */
export const salesReturnService = {
  meta: () => api.get('/sales-returns/meta'),
  /** Completed invoices matching an invoice number, customer name or phone. */
  findInvoices: (search = '') => api.get('/sales-returns/invoices', { params: { search } }),
  /** One invoice with, for each line, what was bought, what already came back and what can still be returned. */
  invoice: (id) => api.get(`/sales-returns/invoices/${id}`),
  /** The server decides the amounts, the status and the numbers; the body only carries ids, quantities and choices. */
  create: (body) => api.post('/sales-returns', body),
  /** Needs approval rights. Adds only the units staff already verified for restocking (unless doNotRestock). */
  approve: (id, body = {}) => api.post(`/sales-returns/${id}/approve`, body),
  reject: (id, reason) => api.post(`/sales-returns/${id}/reject`, { reason }),
  /** Records refund progress only; a completed refund is final. */
  refund: (id, body) => api.post(`/sales-returns/${id}/refund`, body),
  update: (id, body) => api.patch(`/sales-returns/${id}`, body),
};
