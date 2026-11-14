import { api } from './api';

export const stockService = {
  /** Manual stock correction: signed quantity (+ adds, − removes) with a required reason. */
  adjust: (body) => api.post('/stock/adjustments', body),
  movements: (params) => api.get('/stock/movements', { params }),
};
