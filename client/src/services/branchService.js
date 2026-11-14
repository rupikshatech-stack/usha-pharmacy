import { api } from './api';

/** Branches (stores). Without paging options the list is every branch as a plain array, which is what the transfer, order and batch screens use. */
export const branchService = {
  /** One page: { items, page, limit, total, pages } — pass page / limit / search / status. */
  list: (params) => api.get('/branches', { params }),
  get: (id) => api.get(`/branches/${id}`),
  create: (body) => api.post('/branches', body),
  update: (id, body) => api.put(`/branches/${id}`, body),
  remove: (id) => api.delete(`/branches/${id}`),
};
