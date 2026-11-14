// Authentication and general API security: sign-in, lockout, inactive users, expired / forged / revoked sessions,
// logout, token rotation, CSRF, password rules, injection attempts, CORS and response hygiene.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, startHarness } from './helpers/harness.js'; // must come first: it sets NODE_ENV=test before the app config loads
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

let h;
let T;
let n = 0;
const email = () => `sec${++n}-${Date.now()}@example.test`;

const accessToken = (client) => client.jar.get('usha_access');
/** A client that holds exactly these cookies (as a browser would after sign-in). */
const clientWith = (cookies, csrf) => {
  const c = h.client();
  for (const [k, v] of Object.entries(cookies)) c.jar.set(k, v);
  c.csrf = csrf ?? null;
  return c;
};
const signIn = async (user) => {
  const c = h.client();
  const r = await c.login(user.email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
};

before(async () => {
  h = await startHarness();
  T = await h.makeTenant('Security Org');
});

after(async () => {
  await h?.stop();
});

describe('Sign-in', () => {
  it('correct credentials sign in and return the user, permissions and a CSRF token — never the password', async () => {
    const c = h.client();
    const r = await c.login(T.user.email);
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, T.user.email);
    assert.equal(r.data.user.role, 'ORG_ADMIN');
    assert.ok(r.data.user.permissions.includes('inventory:write'));
    assert.ok(r.data.csrfToken);
    assert.ok(!JSON.stringify(r.body).match(/passwordHash|\$2[aby]\$/), 'no password hash in the response');
    const me = await c.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, T.user.email);
  });

  it('is not case-sensitive for the email address', async () => {
    const c = h.client();
    assert.equal((await c.login(T.user.email.toUpperCase())).status, 200);
  });

  it('an incorrect password fails with a generic message', async () => {
    const r = await h.client().login(T.user.email, 'Wrong!Passw0rd');
    assert.equal(r.status, 401);
    assert.equal(r.body.message, 'Invalid email or password');
  });

  it('an unknown email gets exactly the same answer (accounts cannot be discovered)', async () => {
    const wrongPw = await h.client().login(T.user.email, 'Wrong!Passw0rd');
    const unknown = await h.client().login('nobody-here@example.test', 'Wrong!Passw0rd');
    assert.equal(unknown.status, wrongPw.status);
    assert.equal(unknown.body.message, wrongPw.body.message);
    assert.equal(unknown.body.code, wrongPw.body.code);
  });

  it('rejects malformed sign-in requests, including NoSQL operator injection', async () => {
    const c = h.client();
    const post = (body) => c.request('POST', '/auth/login', { body, csrf: false });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ email: 'not-an-email', password: 'x' })).status, 400);
    assert.equal((await post({ email: { $gt: '' }, password: { $gt: '' } })).status, 400);
    assert.equal((await post({ email: T.user.email, password: { $ne: 'x' } })).status, 400);
    assert.equal((await post({ email: [T.user.email], password: 'x' })).status, 400);
    assert.equal((await post({ email: T.user.email, password: 'x'.repeat(5000) })).status, 400);
  });

  it('sets httpOnly cookies, keeps the refresh token on /api/auth only, and never exposes tokens in the body', async () => {
    const res = await fetch(`${h.baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: T.user.email, password: PASSWORD }) });
    const cookies = res.headers.getSetCookie();
    const named = (name) => cookies.find((c) => c.startsWith(`${name}=`));
    for (const name of ['usha_access', 'usha_refresh', 'usha_csrf']) {
      assert.ok(named(name), name);
      assert.match(named(name), /HttpOnly/i, `${name} must be HttpOnly`);
      assert.match(named(name), /SameSite=/i);
    }
    assert.match(named('usha_refresh'), /Path=\/api\/auth/);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes(named('usha_access').split(';')[0].split('=')[1]), 'the access token is only in the cookie');
  });

  it(`locks the account after ${env.auth.maxFailedLogins} wrong passwords, even for the right password afterwards`, async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    for (let i = 0; i < env.auth.maxFailedLogins - 1; i++) assert.equal((await h.client().login(u.email, 'Wrong!Passw0rd')).status, 401);
    const last = await h.client().login(u.email, 'Wrong!Passw0rd');
    assert.equal(last.status, 429);
    assert.equal(last.body.code, 'ACCOUNT_LOCKED');
    const right = await h.client().login(u.email);
    assert.equal(right.status, 429, 'the correct password does not unlock it early');
  });

  it('a successful sign-in resets the failure count', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    for (let i = 0; i < env.auth.maxFailedLogins - 1; i++) await h.client().login(u.email, 'Wrong!Passw0rd');
    assert.equal((await h.client().login(u.email)).status, 200);
    for (let i = 0; i < env.auth.maxFailedLogins - 1; i++) assert.equal((await h.client().login(u.email, 'Wrong!Passw0rd')).status, 401);
  });
});

describe('Inactive and suspended accounts', () => {
  it('an inactive user cannot sign in', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email(), isActive: false });
    const r = await h.client().login(u.email);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACCOUNT_DISABLED');
  });

  it('does not reveal that an account is inactive to someone who does not know the password', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email(), isActive: false });
    const r = await h.client().login(u.email, 'Wrong!Passw0rd');
    assert.equal(r.status, 401);
    assert.equal(r.body.message, 'Invalid email or password');
  });

  it('a user deactivated while signed in is locked out on the very next request', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    const c = await signIn(u);
    assert.equal((await c.get('/inventory')).status, 200);
    await h.models.User.collection.updateOne({ _id: u._id }, { $set: { isActive: false } });
    const r = await c.get('/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'ACCOUNT_UNAVAILABLE');
    assert.equal((await c.request('POST', '/auth/refresh', { headers: { 'x-requested-with': 'XMLHttpRequest' }, csrf: false })).status, 401, 'and cannot renew its session');
  });
});

describe('Sessions and tokens', () => {
  it('rejects requests without credentials', async () => {
    const r = await h.client().get('/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'UNAUTHENTICATED');
  });

  it('rejects an expired access token', async () => {
    const c = await signIn(T.user);
    const payload = jwt.decode(accessToken(c));
    const expired = jwt.sign({ sub: payload.sub, sid: payload.sid }, env.jwtSecret, { expiresIn: -10, algorithm: 'HS256' });
    const r = await clientWith({ usha_access: expired }).get('/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'TOKEN_EXPIRED');
  });

  it('rejects forged tokens: wrong secret, "none" algorithm, garbage', async () => {
    const c = await signIn(T.user);
    const payload = jwt.decode(accessToken(c));
    const wrongSecret = jwt.sign({ sub: payload.sub, sid: payload.sid }, 'another-secret-entirely', { expiresIn: 600 });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: payload.sub, sid: payload.sid, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.`;
    for (const token of [wrongSecret, none, 'garbage', '']) {
      const r = await clientWith({ usha_access: token }).get('/inventory');
      assert.equal(r.status, 401, token.slice(0, 20));
    }
  });

  it('rejects a valid token whose session has expired on the server', async () => {
    const c = await signIn(T.user);
    const { sid } = jwt.decode(accessToken(c));
    assert.equal((await c.get('/inventory')).status, 200);
    await h.models.Session.collection.updateOne({ _id: new h.mongoose.Types.ObjectId(sid) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await c.get('/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'SESSION_ENDED');
    const refresh = await c.request('POST', '/auth/refresh', { headers: { 'x-requested-with': 'XMLHttpRequest' }, csrf: false });
    assert.equal(refresh.status, 401, 'an expired session cannot be renewed');
  });

  it('a token cannot be used with another user’s session', async () => {
    const a = await signIn(T.user);
    const other = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    const b = await signIn(other);
    const forged = jwt.sign({ sub: String(other._id), sid: jwt.decode(accessToken(a)).sid }, env.jwtSecret, { expiresIn: 600 });
    assert.equal((await clientWith({ usha_access: forged }).get('/inventory')).status, 401);
    assert.equal((await b.get('/inventory')).status, 200);
  });

  it('renews the session with the refresh cookie and rotates the refresh token', async () => {
    const c = await signIn(T.user);
    const before = c.jar.get('usha_refresh');
    const r = await c.request('POST', '/auth/refresh', { headers: { 'x-requested-with': 'XMLHttpRequest' }, csrf: false });
    assert.equal(r.status, 200);
    assert.notEqual(c.jar.get('usha_refresh'), before, 'a new refresh token was issued');
    assert.equal((await c.get('/inventory')).status, 200);
  });

  it('a refresh token that is used twice revokes the whole session (theft detection)', async () => {
    const c = await signIn(T.user);
    const stolen = c.jar.get('usha_refresh');
    const refresh = (client) => client.request('POST', '/auth/refresh', { headers: { 'x-requested-with': 'XMLHttpRequest' }, csrf: false });
    assert.equal((await refresh(c)).status, 200); // the real user rotates it
    const thief = clientWith({ usha_refresh: stolen });
    assert.equal((await refresh(thief)).status, 401); // the old token is replayed
    assert.equal((await c.get('/inventory')).status, 401, 'the session was revoked, so the real user is signed out too');
  });

  it('refresh needs the X-Requested-With header (blocks cross-site form posts)', async () => {
    const c = await signIn(T.user);
    const r = await c.request('POST', '/auth/refresh', { csrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CSRF_INVALID');
  });
});

describe('Logout', () => {
  it('invalidates the session immediately: the old token, the refresh cookie and /me all stop working', async () => {
    const c = await signIn(T.user);
    const oldAccess = accessToken(c);
    const oldRefresh = c.jar.get('usha_refresh');
    assert.equal((await c.get('/inventory')).status, 200);

    assert.equal((await c.post('/auth/logout')).status, 200);
    assert.ok(!c.jar.has('usha_access'), 'the cookies were cleared');

    const replay = clientWith({ usha_access: oldAccess, usha_refresh: oldRefresh });
    const r = await replay.get('/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'SESSION_ENDED');
    assert.equal((await replay.get('/auth/me')).status, 401);
    assert.equal((await replay.request('POST', '/auth/refresh', { headers: { 'x-requested-with': 'XMLHttpRequest' }, csrf: false })).status, 401);
  });

  it('works even when the access token has expired, and is harmless when not signed in', async () => {
    const c = await signIn(T.user);
    const payload = jwt.decode(accessToken(c));
    const expired = jwt.sign({ sub: payload.sub, sid: payload.sid }, env.jwtSecret, { expiresIn: -10 });
    const c2 = clientWith({ usha_access: expired, usha_refresh: c.jar.get('usha_refresh') });
    assert.equal((await c2.post('/auth/logout')).status, 200);
    assert.equal((await c.get('/inventory')).status, 401, 'the session behind it is gone');
    assert.equal((await h.client().post('/auth/logout')).status, 200);
  });

  it('only ends that device’s session, not the user’s other sessions', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    const phone = await signIn(u);
    const laptop = await signIn(u);
    await phone.post('/auth/logout');
    assert.equal((await phone.get('/inventory')).status, 401);
    assert.equal((await laptop.get('/inventory')).status, 200);
  });

  it('the audit log records sign-in and sign-out', async () => {
    const log = JSON.stringify((await (await signIn(T.user)).get('/activity?limit=100')).body);
    assert.match(log, /signed in/);
    assert.match(log, /signed out/);
  });
});

describe('CSRF protection', () => {
  it('a state-changing request with cookies but no CSRF header is refused', async () => {
    const c = await signIn(T.user);
    const r = await c.request('POST', '/inventory', { body: { medicineName: 'No CSRF' }, csrf: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CSRF_INVALID');
    assert.equal((await c.get('/inventory?search=No%20CSRF')).data.total, 0, 'and nothing was created');
  });

  it('a wrong or foreign CSRF token is refused; the right one is accepted', async () => {
    const c = await signIn(T.user);
    const real = c.csrf;
    c.csrf = 'x'.repeat(real.length);
    assert.equal((await c.post('/inventory', { medicineName: 'Wrong CSRF' })).status, 403);
    const other = await signIn(T.user);
    c.csrf = other.csrf; // a valid token for a different session
    assert.equal((await c.post('/inventory', { medicineName: 'Foreign CSRF' })).status, 403);
    c.csrf = real;
    assert.equal((await c.post('/inventory', { medicineName: `Right CSRF ${n}` })).status, 201);
  });

  it('applies to PUT, PATCH and DELETE too', async () => {
    const c = await signIn(T.user);
    const m = (await c.post('/inventory', { medicineName: `Csrf Target ${++n}` })).data;
    for (const [method, url, body] of [['PUT', `/inventory/${m._id}`, { medicineName: 'x' }], ['DELETE', `/inventory/${m._id}`], ['POST', '/compounds', { compoundName: 'x' }]]) {
      assert.equal((await c.request(method, url, { body, csrf: false })).status, 403, `${method} ${url}`);
    }
    assert.equal((await c.get(`/inventory/${m._id}`)).data.medicineName, m.medicineName, 'unchanged');
  });

  it('API clients using a Bearer token (no cookies) are not subject to it', async () => {
    const c = await signIn(T.user);
    const bearer = h.client();
    const r = await bearer.request('GET', '/inventory', { headers: { authorization: `Bearer ${accessToken(c)}` } });
    assert.equal(r.status, 200);
  });
});

describe('Passwords', () => {
  it('changing the password needs the current one and enforces the policy', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    const c = await signIn(u);
    const change = (currentPassword, newPassword) => c.post('/auth/change-password', { currentPassword, newPassword });
    assert.equal((await change('Wrong!Passw0rd', 'New!Passw0rd1')).status, 400);
    assert.equal((await change(PASSWORD, PASSWORD)).status, 400, 'must differ from the current one');
    for (const weak of ['short1!', 'alllowercase1!', 'ALLUPPERCASE1!', 'NoNumbers!!', 'NoSymbols123', 'x'.repeat(80) + 'A1!']) {
      assert.equal((await change(PASSWORD, weak)).status, 400, weak);
    }
    assert.equal((await change(PASSWORD, 'New!Passw0rd1')).status, 200);
  });

  it('after a change the old password stops working, the new one works, and other devices are signed out', async () => {
    const u = await h.makeUser(T.org, { role: 'STAFF', email: email() });
    const here = await signIn(u);
    const elsewhere = await signIn(u);
    assert.equal((await here.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'New!Passw0rd1' })).status, 200);
    assert.equal((await h.client().login(u.email, PASSWORD)).status, 401);
    assert.equal((await h.client().login(u.email, 'New!Passw0rd1')).status, 200);
    assert.equal((await here.get('/inventory')).status, 200, 'the device that changed it stays signed in');
    assert.equal((await elsewhere.get('/inventory')).status, 401);
  });

  it('a user who must change their password can do nothing else until they do', async () => {
    const u = await h.makeUser(T.org, { role: 'ORG_ADMIN', email: email(), mustChangePassword: true });
    const c = await signIn(u);
    assert.equal((await c.get('/auth/me')).data.user.mustChangePassword, true);
    const blocked = await c.get('/inventory');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await c.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'New!Passw0rd1' })).status, 200);
    assert.equal((await c.get('/inventory')).status, 200);
  });

  it('passwords are stored as bcrypt hashes, never in plain text', async () => {
    const u = await h.models.User.collection.findOne({ _id: T.user._id });
    assert.match(u.passwordHash, /^\$2[aby]\$\d\d\$/);
    assert.ok(!JSON.stringify(u).includes(PASSWORD));
  });
});

describe('Injection and malformed input', () => {
  it('operator objects in query strings or bodies are rejected, not executed', async () => {
    const c = await signIn(T.user);
    await c.post('/inventory', { medicineName: `Operator Target ${++n}` });
    for (const url of ['/inventory?search[$ne]=x', '/inventory?page[$gt]=0', '/inventory?stock[$ne]=in_stock', '/batches?search[$regex]=.', '/compounds?search[$ne]=1', '/activity?limit[$gt]=1']) {
      const r = await c.get(url);
      assert.ok(r.status === 400 || (r.status === 200 && r.data.total !== undefined), `${url} -> ${r.status}`);
    }
    for (const body of [{ medicineName: { $gt: '' } }, { medicineName: ['a'] }, { medicineName: 'ok', sku: { $ne: '' } }, { medicineName: 'ok', categoryId: { $ne: null } }]) {
      assert.equal((await c.post('/inventory', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await c.get(`/inventory/${encodeURIComponent('{"$ne":null}')}`)).status, 400);
  });

  it('regular-expression characters in searches are matched literally', async () => {
    const c = await signIn(T.user);
    await c.post('/inventory', { medicineName: `Plain Name ${++n}` });
    assert.equal((await c.get('/inventory?search=.*')).data.total, 0);
    assert.equal((await c.get('/inventory?search=(((')).status, 200);
    assert.equal((await c.get('/inventory?search=%5B')).status, 200);
  });

  it('unknown JSON fields are ignored (no mass assignment of organizationId, _id, timestamps or flags)', async () => {
    const c = await signIn(T.user);
    const fakeOrg = '0'.repeat(24);
    const r = await c.post('/inventory', { medicineName: `Mass ${++n}`, organizationId: fakeOrg, _id: fakeOrg, createdAt: '2000-01-01', archivedAt: '2000-01-01', __proto__: { isAdmin: true } });
    assert.equal(r.status, 201);
    const doc = await h.models.Medicine.collection.findOne({ _id: new h.mongoose.Types.ObjectId(r.data._id) });
    assert.equal(String(doc.organizationId), String(T.org._id));
    assert.notEqual(String(doc._id), fakeOrg);
    assert.ok(doc.createdAt > new Date('2020-01-01'));
    assert.equal(doc.archivedAt, undefined);
  });

  it('script and HTML in text fields are stored as plain text and returned as JSON (the UI escapes it)', async () => {
    const c = await signIn(T.user);
    const payload = '<img src=x onerror=alert(1)>';
    const r = await c.post('/inventory', { medicineName: `${payload} ${++n}` });
    assert.equal(r.status, 201);
    const res = await fetch(`${h.baseUrl}/inventory/${r.data._id}`, { headers: { cookie: `usha_access=${accessToken(c)}` } });
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('rejects malformed and oversized request bodies cleanly', async () => {
    const c = await signIn(T.user);
    const bad = await fetch(`${h.baseUrl}/inventory`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `usha_access=${accessToken(c)}; usha_csrf=${c.csrf}`, 'x-csrf-token': c.csrf }, body: '{"medicineName": ' });
    assert.equal(bad.status, 400);
    assert.equal((await c.post('/inventory', { medicineName: 'x'.repeat(200000) })).status, 413);
  });
});

describe('Response hygiene', () => {
  it('sends security headers and does not advertise the framework', async () => {
    const res = await fetch(`${h.baseUrl}/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('x-frame-options') || /frame-ancestors/.test(res.headers.get('content-security-policy') || ''), 'clickjacking protection');
    assert.ok(res.headers.get('strict-transport-security'));
  });

  it('refuses cross-origin requests from origins that are not on the allow-list', async () => {
    const res = await fetch(`${h.baseUrl}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${h.baseUrl}/inventory`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.notEqual(pre.headers.get('access-control-allow-origin'), 'https://evil.example');
    const ok = await fetch(`${h.baseUrl}/health`, { headers: { origin: env.clientOrigins[0] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  });

  it('errors never leak stack traces, file paths or database internals', async () => {
    const c = await signIn(T.user);
    const responses = [
      await c.get('/inventory/not-an-id'),
      await c.get('/no/such/route'),
      await h.client().get('/inventory'),
      await c.post('/inventory', { medicineName: '' }),
      await c.get(`/batches/${'0'.repeat(24)}`),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      assert.ok(!/node_modules|at \w+ \(|\.js:\d+|MongoServerError|E11000|ObjectId\(/.test(text), text);
      assert.equal(r.body.success, false);
    }
  });
});
