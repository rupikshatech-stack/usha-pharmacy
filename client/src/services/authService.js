import { api } from './api';

export const authService = {
  me: () => api.get('/auth/me'),
  /** Like me(), but a browser with no session cookies gets `{ user: null }` (HTTP 200) rather than a 401. */
  session: () => api.get('/auth/session'),
  login: (email, password, rememberMe) => api.post('/auth/login', { email, password, rememberMe }),
  logout: () => api.post('/auth/logout'),
  changePassword: (currentPassword, newPassword) => api.post('/auth/change-password', { currentPassword, newPassword }),
};
