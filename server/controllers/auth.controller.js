import { AuditLog, Organization, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, clearAuthCookies, setAuthCookies, setCsrfCookie } from '../utils/cookies.js';
import * as authService from '../services/auth.service.js';
import * as sessions from '../services/session.service.js';

const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

export async function login(req, res) {
  const { email, password, rememberMe } = req.body;
  const { user, org, session, accessToken, refreshToken, csrfToken } = await authService.login({ email, password, rememberMe, ...clientInfo(req) });
  setAuthCookies(res, { accessToken, refreshToken, csrfToken, rememberMe: session.rememberMe });
  res.json({ success: true, data: { user: await authService.presentUser(user, org), csrfToken } });
}

/** Exchanges the refresh cookie for a new access token (and rotates the refresh token). */
export async function refresh(req, res) {
  const result = await sessions.rotateSession(req.cookies?.[REFRESH_COOKIE]);
  if (!result) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Session expired. Please sign in again.', undefined, 'SESSION_ENDED');
  }
  const { session, refreshToken } = result;
  const user = await User.findById(session.userId).lean();
  if (!user || !user.isActive) {
    await sessions.revokeSession(session._id, 'account-unavailable');
    clearAuthCookies(res);
    throw new ApiError(401, 'Account unavailable', undefined, 'ACCOUNT_UNAVAILABLE');
  }
  // Keep the CSRF token stable so requests already in flight aren't rejected.
  const csrfToken = req.cookies?.[CSRF_COOKIE] || sessions.newCsrfToken();
  setAuthCookies(res, { accessToken: sessions.signAccessToken(user._id, session._id), refreshToken, csrfToken, rememberMe: session.rememberMe });
  const org = await Organization.findById(user.organizationId).lean();
  res.json({ success: true, data: { user: await authService.presentUser(user, org), csrfToken } });
}

export async function me(req, res) {
  const org = req.tenant.organization;
  let csrfToken = req.cookies?.[CSRF_COOKIE];
  if (!csrfToken) {
    csrfToken = sessions.newCsrfToken();
    setCsrfCookie(res, csrfToken, req.session.rememberMe);
  }
  // req.user already carries the role's permissions: the authentication middleware attached them (withRolePermissions).
  res.json({ success: true, data: { user: authService.toPublicUser(req.user, org), csrfToken } });
}

/** Ends the session server-side (so the tokens stop working immediately) and clears the cookies. */
export async function logout(req, res) {
  // Identify the session from the access token (even if expired) or, failing that, the refresh cookie.
  let session = null;
  const access = req.cookies?.[ACCESS_COOKIE];
  if (access) {
    try {
      session = await sessions.findSessionById(sessions.verifyAccessToken(access, { ignoreExpiration: true }).sid);
    } catch {
      /* unreadable token: fall back to the refresh cookie */
    }
  }
  session ||= await sessions.findSessionByRefreshToken(req.cookies?.[REFRESH_COOKIE]);

  if (session && !session.revokedAt) {
    await sessions.revokeSession(session._id);
    const user = await User.findById(session.userId).lean();
    if (user?.organizationId) {
      await runWithTenant(user.organizationId, () =>
        AuditLog.create({
          userId: user._id,
          userName: user.name,
          action: 'AUTH_LOGOUT',
          entity: 'User',
          entityId: user._id,
          message: `${user.name} signed out`,
          ip: req.ip,
        }),
      );
    }
  }
  clearAuthCookies(res);
  res.json({ success: true });
}

export async function changePassword(req, res) {
  await authService.changePassword(req, req.body);
  res.json({ success: true, data: { message: 'Password updated' } });
}
