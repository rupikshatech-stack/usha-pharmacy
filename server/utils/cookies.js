import { env } from '../config/env.js';

export const ACCESS_COOKIE = 'usha_access';
export const REFRESH_COOKIE = 'usha_refresh';
export const CSRF_COOKIE = 'usha_csrf';

const { sameSite, secure } = env.auth.cookie;
const base = { httpOnly: true, sameSite, secure };

/**
 * Sets the three auth cookies:
 *  - access:  short-lived JWT, sent on every request
 *  - refresh: opaque token, only sent to /api/auth (so it never travels with normal API calls)
 *  - csrf:    double-submit token; the page must echo it in the X-CSRF-Token header
 * Without "remember me" the refresh/CSRF cookies are session cookies (cleared when the browser closes).
 */
export function setAuthCookies(res, { accessToken, refreshToken, csrfToken, rememberMe }) {
  const persistent = rememberMe ? { maxAge: env.auth.rememberMs } : {};
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: '/', maxAge: env.auth.accessTokenSeconds * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: '/api/auth', ...persistent });
  res.cookie(CSRF_COOKIE, csrfToken, { ...base, path: '/', ...persistent });
}

export function setCsrfCookie(res, csrfToken, rememberMe) {
  res.cookie(CSRF_COOKIE, csrfToken, { ...base, path: '/', ...(rememberMe ? { maxAge: env.auth.rememberMs } : {}) });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { ...base, path: '/' });
}
