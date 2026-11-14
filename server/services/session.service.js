import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { Session } from '../models/index.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

export const newCsrfToken = () => randomToken(32);

export const signAccessToken = (userId, sessionId) =>
  jwt.sign({ sub: String(userId), sid: String(sessionId) }, env.jwtSecret, {
    expiresIn: env.auth.accessTokenSeconds,
    algorithm: 'HS256',
  });

export const verifyAccessToken = (token, { ignoreExpiration = false } = {}) =>
  jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], ignoreExpiration });

/**
 * Creates a session and the three tokens that go into the browser's cookies.
 *
 * `platform: true` is the only way to make a session with no organization, and it is asked for explicitly by the
 * platform sign-in path. Everything else keeps the behaviour it always had: the organization comes off the user,
 * and the model refuses the write if it is missing.
 */
export async function createSession(user, { rememberMe, ip, userAgent, platform = false }) {
  const refreshToken = randomToken();
  const ttl = rememberMe ? env.auth.rememberMs : env.auth.sessionMs;
  const session = await Session.create({
    organizationId: platform ? undefined : user.organizationId,
    isPlatform: platform,
    userId: user._id,
    refreshHash: sha256(refreshToken),
    rememberMe,
    expiresAt: new Date(Date.now() + ttl),
    lastUsedAt: new Date(),
    ip,
    userAgent: userAgent?.slice(0, 250),
  });
  return { session, accessToken: signAccessToken(user._id, session._id), refreshToken, csrfToken: newCsrfToken() };
}

/**
 * Exchanges a refresh token for fresh tokens and rotates the refresh token.
 * If an already-used (previous) token shows up again it was probably stolen, so the whole session is revoked.
 * Returns null when the token is unknown, revoked or expired.
 */
export async function rotateSession(refreshToken) {
  if (!refreshToken) return null;
  const h = sha256(refreshToken);
  const session = await Session.findOne({ $or: [{ refreshHash: h }, { prevRefreshHash: h }] });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;

  if (session.refreshHash !== h) {
    session.revokedAt = new Date();
    session.revokedReason = 'refresh-token-reuse';
    await session.save();
    return null;
  }

  const next = randomToken();
  session.prevRefreshHash = session.refreshHash;
  session.refreshHash = sha256(next);
  session.lastUsedAt = new Date();
  await session.save();
  return { session, refreshToken: next, csrfToken: newCsrfToken() };
}

export const findSessionById = (id) => Session.findById(id).lean();

export const findSessionByRefreshToken = (refreshToken) =>
  refreshToken ? Session.findOne({ $or: [{ refreshHash: sha256(refreshToken) }, { prevRefreshHash: sha256(refreshToken) }] }).lean() : null;

export const findActiveSession = (id) =>
  Session.findOne({ _id: id, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).lean();

export const revokeSession = (id, reason = 'logout') =>
  Session.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } });

export const revokeSessionByRefreshToken = (refreshToken, reason = 'logout') =>
  refreshToken
    ? Session.updateOne({ refreshHash: sha256(refreshToken), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } })
    : null;

/** Signs the user out everywhere, optionally keeping one session (e.g. the one that changed the password). */
export const revokeUserSessions = (userId, exceptSessionId, reason = 'password-changed') =>
  Session.updateMany(
    { userId, revokedAt: { $exists: false }, ...(exceptSessionId && { _id: { $ne: exceptSessionId } }) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
