/**
 * Whether the app needs to ask the server "who is signed in?" on a given page.
 *
 * The session cookies are httpOnly, so the page cannot look for them. Without some other signal the app asked on
 * EVERY page, including the public landing page, and for a signed-out visitor that is two failing requests
 * (GET /api/auth/me, then POST /api/auth/refresh), two serverless invocations and two red console errors, on every
 * single view. But the landing, sign-in and forgot-password pages do have a reason to ask: a signed-in person who
 * opens the site address is sent straight to their dashboard rather than shown the marketing page.
 *
 * So this browser remembers, in localStorage, that it last had a session. It is only a HINT to skip a pointless
 * request, never a credential and never trusted for anything: the server decides who is signed in.
 *
 *   - A STALE hint (session gone, hint left) costs one round of failing requests; the 401 clears it.
 *   - A MISSING hint (session alive, no hint) means the public pages do not look for it: the landing page shows
 *     the marketing page instead of forwarding to the dashboard, and the sign-in page shows its form instead of
 *     forwarding. Opening any application page asks the server regardless, finds the session and restores the
 *     hint. This happens once for anyone already signed in when this shipped, and after the browser's site data
 *     is cleared.
 */
const KEY = 'usha:session';

/** Pages that work without a session, and where a signed-in visitor is simply forwarded on. */
export const PUBLIC_PATHS = ['/', '/login', '/forgot-password'];

/** The platform console has its own session and never reads this one, so it never needs to ask. */
export const isPlatformPath = (pathname) => pathname === '/platform' || pathname.startsWith('/platform/');

export const isPublicPath = (pathname) => PUBLIC_PATHS.includes(pathname);

/**
 * @param {string} pathname  the current location
 * @param {boolean} hasHint  whether this browser remembers having a session
 */
export function shouldAskServer(pathname, hasHint) {
  if (isPlatformPath(pathname)) return false;
  if (isPublicPath(pathname)) return Boolean(hasHint);
  return true; // every application page needs the answer, hint or not: the cookie may exist without it
}

const store = () => {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked storage (private mode, policy): behave as if there is never a hint
  }
};

export function readSessionHint(storage = store()) {
  try {
    return storage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSessionHint(storage = store()) {
  try {
    storage?.setItem(KEY, '1');
  } catch {
    /* nothing to remember it in: the cost is one extra request later */
  }
}

export function clearSessionHint(storage = store()) {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* as above */
  }
}
