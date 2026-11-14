import crypto from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { ACCESS_COOKIE, CSRF_COOKIE } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// login: there is no session/cookie yet. logout: forcing a sign-out is harmless and must always work.
const EXEMPT = new Set(['/auth/login', '/auth/logout']);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * CSRF protection for cookie-based auth ("double submit"): every state-changing request that
 * carries our auth cookies must also send the same random value in the X-CSRF-Token header.
 * A malicious site can make the browser send cookies but cannot read or set this header value.
 *
 * /auth/refresh can't use the token (after a page reload the page doesn't have it yet), so it
 * instead requires a custom header, which browsers only allow cross-origin after a CORS preflight
 * that our origin allow-list rejects.
 */
export function csrfProtect(req, _res, next) {
  if (SAFE_METHODS.has(req.method) || EXEMPT.has(req.path)) return next();

  if (req.path === '/auth/refresh') {
    return req.get('x-requested-with') === 'XMLHttpRequest' ? next() : next(new ApiError(403, 'Invalid request', undefined, 'CSRF_INVALID'));
  }

  // Requests authenticated with a Bearer header (non-browser clients) aren't exposed to CSRF.
  if (!req.cookies?.[ACCESS_COOKIE]) return next();

  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return next(new ApiError(403, 'Security check failed. Please refresh the page and try again.', undefined, 'CSRF_INVALID'));
  }
  next();
}
