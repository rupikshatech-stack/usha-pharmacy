import { api } from './api';

export const importService = {
  /** The sample CSV: { fileName, csv }. */
  template: () => api.get('/import/inventory/template'),
  /** Upload for checking. Nothing is imported yet; the server validates every row and returns the preview. */
  preview: (fileName, csvText) =>
    api.post('/import/inventory/preview', csvText, {
      params: { fileName },
      headers: { 'Content-Type': 'text/csv' },
      transformRequest: [(d) => d], // send the text as-is (axios would otherwise JSON-encode a string)
    }),
  /** Import the previewed file. The server uses its own validated copy; only the choice to skip invalid rows is sent. */
  confirm: (id, skipInvalid) => api.post(`/import/inventory/${id}/confirm`, { skipInvalid }),
  cancel: (id) => api.post(`/import/inventory/${id}/cancel`),
  get: (id) => api.get(`/import/inventory/${id}`),
};
