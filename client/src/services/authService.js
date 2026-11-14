import { api } from './api';

export const authService = {
  me: () => api.get('/auth/me'),
  login: (email, password, rememberMe) => api.post('/auth/login', { email, password, rememberMe }),
  logout: () => api.post('/auth/logout'),
  changePassword: (currentPassword, newPassword) => api.post('/auth/change-password', { currentPassword, newPassword }),
};
