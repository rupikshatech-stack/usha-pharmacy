import { api } from './api';

/**
 * Settings. One read for all three tabs; one PATCH per tab, carrying only what changed plus the `version` the
 * screen was looking at — the server refuses the save if somebody else got there first.
 */
export const settingsService = {
  get: () => api.get('/settings'),
  saveOrganization: (patch) => api.patch('/settings/organization', patch),
  saveInvoice: (patch) => api.patch('/settings/invoice', patch),
  saveGeneral: (patch) => api.patch('/settings/general', patch),
  resetInvoice: (version) => api.post('/settings/invoice/reset', { version, confirm: 'RESET' }),
  previewNumber: (params) => api.get('/settings/invoice/preview-number', { params }),

  /**
   * Files are sent as the request body itself — there is no multipart here. The server decides the type from the
   * bytes, so the Content-Type we send is only a hint and the name travels in a header, never on disk.
   */
  uploadLogo: (file) =>
    api.post('/settings/logo', file, {
      headers: { 'Content-Type': file.type || 'image/png', 'X-File-Name': file.name || 'logo' },
      transformRequest: [(d) => d],
    }),
  deleteLogo: () => api.delete('/settings/logo'),
  uploadDocument: (file) =>
    api.post('/settings/documents', file, {
      headers: { 'Content-Type': file.type || 'application/pdf', 'X-File-Name': file.name || 'document' },
      transformRequest: [(d) => d],
    }),
};
