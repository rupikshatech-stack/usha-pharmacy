import { api } from './api';

/**
 * Transfer workflow:  draft -> submit -> (approve | reject) -> dispatch -> receive.   A transfer can be cancelled until it is received.
 * Stock only moves at dispatch (units leave the source store) and receive (units enter the destination store).
 */
export const transferService = {
  get: (id) => api.get(`/transfers/${id}`),
  /** Save a draft. Nothing moves yet. */
  create: (body) => api.post('/transfers', body),
  update: (id, body) => api.put(`/transfers/${id}`, body),
  /** Drafts only. */
  remove: (id) => api.delete(`/transfers/${id}`),
  /** Hands the draft in: for approval when the organization requires it, otherwise it is approved straight away. */
  submit: (id) => api.post(`/transfers/${id}/submit`),
  approve: (id) => api.post(`/transfers/${id}/approve`),
  reject: (id, reason) => api.post(`/transfers/${id}/reject`, { reason }),
  /** Takes the units out of the source store; they are then in transit. */
  dispatch: (id, payload = {}) => api.post(`/transfers/${id}/dispatch`, payload),
  /** Adds the units to the destination store. */
  receive: (id, payload = {}) => api.post(`/transfers/${id}/receive`, payload),
  /** Before dispatch nothing has moved; after it, the units go back to the source store. */
  cancel: (id, reason = '') => api.post(`/transfers/${id}/cancel`, { reason }),
  settings: () => api.get('/transfers/settings'),
  saveSettings: (approvalRequired) => api.put('/transfers/settings', { approvalRequired }),
};

export const storeService = {
  create: (body) => api.post('/branches', body),
  update: (id, body) => api.put(`/branches/${id}`, body),
  remove: (id) => api.delete(`/branches/${id}`),
};
