import { api } from './api';

/** Compounds: formulations that several medicines can share. */
export const compoundService = {
  get: (id) => api.get(`/compounds/${id}`),
  create: (body) => api.post('/compounds', body),
  update: (id, body) => api.put(`/compounds/${id}`, body),
  /** Only an unused compound can be deleted; a linked one is archived (status "inactive") instead. */
  remove: (id) => api.delete(`/compounds/${id}`),
  link: (id, medicineIds) => api.post(`/compounds/${id}/medicines`, { medicineIds }),
  unlink: (id, medicineId) => api.delete(`/compounds/${id}/medicines/${medicineId}`),
};

/** Attributes: organization-specific lists (categories, dosage forms, strengths, units) and custom medicine fields. */
export const attributeService = {
  create: (body) => api.post('/attributes', body),
  update: (id, body) => api.put(`/attributes/${id}`, body),
  remove: (id) => api.delete(`/attributes/${id}`),
};
