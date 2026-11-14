import { ApiError } from '../utils/ApiError.js';
import { CSRF_COOKIE, REFRESH_COOKIE, clearAuthCookies, setAuthCookies, setCsrfCookie } from '../utils/cookies.js';
import * as authService from '../services/auth.service.js';
import * as sessions from '../services/session.service.js';
import * as orgs from '../services/platformOrganizations.service.js';

const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
const ok = (res, data) => res.json({ success: true, data });

/**
 * Platform sign-in. Same cookies as the workspace, so the browser machinery is identical; what differs is the
 * session behind them, which carries no organization and therefore cannot open any tenant route.
 *
 * `rememberMe` is not offered. A platform session creates pharmacies and their first administrators, so it should
 * expire with the browser rather than sit on a laptop for thirty days.
 */
export async function login(req, res) {
  const { email, password } = req.body;
  const { user, session, accessToken, refreshToken, csrfToken } = await authService.platformLogin({ email, password, ...clientInfo(req) });
  setAuthCookies(res, { accessToken, refreshToken, csrfToken, rememberMe: session.rememberMe });
  ok(res, { user: authService.toPlatformUser(user), csrfToken });
}

/** Who the platform administrator is. There is no organization to report, by design. */
export async function me(req, res) {
  let csrfToken = req.cookies?.[CSRF_COOKIE];
  if (!csrfToken) {
    csrfToken = sessions.newCsrfToken();
    setCsrfCookie(res, csrfToken, false);
  }
  ok(res, { user: authService.toPlatformUser(req.user), csrfToken });
}

export async function logout(req, res) {
  await sessions.revokeSessionByRefreshToken(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  ok(res, { ok: true });
}

/**
 * Changing a platform password. It reaches this route through `authenticateAllowPending`, because a brand-new
 * platform account is created with `mustChangePassword` set and `authenticate` refuses such an account everywhere
 * else - which is the point: the only thing a freshly created platform administrator can do is choose their own
 * password.
 */
export async function changePassword(req, res) {
  await authService.changePassword(req, req.body);
  ok(res, { ok: true });
}

/** The pharmacies on this installation: names and contact details only, never anything from inside one. */
export const listOrganizations = async (req, res) => ok(res, await orgs.listOrganizations(req.query));

/** Creates a pharmacy, its five built-in roles and its first administrator, and returns the credentials once. */
export const createOrganization = async (req, res) => res.status(201).json({ success: true, data: await orgs.createOrganization(req, req.body) });
