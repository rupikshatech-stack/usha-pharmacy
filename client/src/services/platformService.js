import { api } from './api';

/**
 * The platform API: creating pharmacies, and the sign-in that guards it.
 *
 * It shares the axios instance with the tenant app only for cookies, CSRF and the 401 refresh. Nothing else is
 * shared — there is no organization here, so none of the tenant services or contexts apply.
 */
export const platformService = {
  login: (email, password) => api.post('/platform/auth/login', { email, password }),
  me: () => api.get('/platform/auth/me'),
  logout: () => api.post('/platform/auth/logout'),
  changePassword: (currentPassword, newPassword) => api.post('/platform/auth/change-password', { currentPassword, newPassword }),
  listOrganizations: (params) => api.get('/platform/organizations', { params }),
  createOrganization: (body) => api.post('/platform/organizations', body),
};
