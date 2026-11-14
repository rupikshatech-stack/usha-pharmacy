import { api } from './api';

export const invoiceService = {
  get: (id) => api.get(`/invoices/${id}`),
  create: (body) => api.post('/invoices', body),
};
