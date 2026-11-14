import axios from 'axios';

/**
 * Shared axios instance. In development requests go to the same origin and Vite proxies /api to the
 * server. In production set VITE_API_URL (e.g. https://api.example.com/api) at build time.
 *
 * Auth model: the browser holds httpOnly cookies (invisible to JavaScript). This module adds the
 * CSRF header to state-changing requests and silently renews the short-lived access token when
 * the server answers 401.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// ---- CSRF token (kept in memory only; the server hands it out on login / refresh / me)
let csrfToken = null;
export const setCsrfToken = (t) => {
  csrfToken = t || null;
};
const SAFE = new Set(['get', 'head', 'options']);

api.interceptors.request.use((config) => {
  if (csrfToken && !SAFE.has((config.method || 'get').toLowerCase())) config.headers['X-CSRF-Token'] = csrfToken;
  return config;
});

// ---- Silent session renewal (one refresh at a time, shared by all failing requests)
let refreshing = null;
const refreshSession = () =>
  (refreshing ||= api
    .post('/auth/refresh', null, { _skipRefresh: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then((d) => {
      setCsrfToken(d.csrfToken);
      return d;
    })
    .finally(() => {
      refreshing = null;
    }));

const isAuthEndpoint = (url = '') => /\/auth\/(login|refresh|logout)/.test(url);

// Unwrap { success, data } and turn failures into Error objects with .status and .code.
api.interceptors.response.use(
  (res) => res.data.data ?? res.data,
  async (err) => {
    const cfg = err.config;
    const status = err.response?.status;
    const body = err.response?.data;

    if (status === 401 && cfg && !cfg._retried && !cfg._skipRefresh && !isAuthEndpoint(cfg.url)) {
      cfg._retried = true;
      try {
        await refreshSession();
        return api(cfg); // replay the original request with the fresh session
      } catch {
        window.dispatchEvent(new Event('usha:unauthorized'));
      }
    }
    if (status === 403 && body?.code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event('usha:password-change-required'));
    }

    const message = body?.message || (err.request ? 'Cannot reach the server. Check your connection.' : err.message);
    return Promise.reject(Object.assign(new Error(message), { status, code: body?.code, details: body?.details }));
  },
);
