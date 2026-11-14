// Test harness: a throwaway MongoDB replica set + the real Express app on a random port.
// It never touches the development database (server/.data).
//
// IMPORTANT: this file sets environment variables before loading any app code, so the app is
// imported dynamically below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-automated-tests-only-0123456789';
process.env.MONGODB_URI = ''; // tests connect to their own database below
process.env.ADMIN_INITIAL_PASSWORD = '';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PASSWORD = 'Str0ng!Passw0rd';

/** Minimal cookie-aware API client that behaves like the browser app (cookies + CSRF header). */
export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.jar = new Map();
    this.csrf = null;
  }

  async request(method, url, { body, headers = {}, csrf = true } = {}) {
    const h = { 'content-type': 'application/json', cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    if (csrf && this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    const res = await fetch(this.baseUrl + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }); // a string or binary body is sent as-is (e.g. CSV, a PDF)
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { status: res.status, body: json, data: json?.data };
  }

  get(url, o) { return this.request('GET', url, o); }
  post(url, body, o) { return this.request('POST', url, { body, ...o }); }
  put(url, body, o) { return this.request('PUT', url, { body, ...o }); }
  patch(url, body, o) { return this.request('PATCH', url, { body, ...o }); }
  del(url, o) { return this.request('DELETE', url, o); }

  async login(email, password = PASSWORD) {
    const r = await this.request('POST', '/auth/login', { body: { email, password }, csrf: false });
    if (r.status === 200) this.csrf = r.data.csrfToken;
    return r;
  }
}

export async function startHarness() {
  const { useCachedMongoBinary } = await import('../../config/mongoBinary.js');
  useCachedMongoBinary();
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const { default: mongoose } = await import('mongoose');
  const bcrypt = (await import('bcryptjs')).default;

  fs.mkdirSync(path.join(serverRoot, '.test-data'), { recursive: true });
  const dbPath = fs.mkdtempSync(path.join(serverRoot, '.test-data', 'run-'));
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ dbPath }] });
  await mongoose.connect(mongo.getUri('usha_test'));

  const models = await import('../../models/index.js');
  await Promise.all(Object.values(models).filter((m) => m?.init).map((m) => m.init())); // build indexes before tests run

  const { createApp } = await import('../../app.js');
  const server = createApp().listen(Number(process.env.HARNESS_PORT) || 0); // a fixed port only for the browser tests (e2e/)
  await new Promise((r) => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  const { uniqueSlug } = await import('../../services/seed.service.js');
  const tenant = await import('../../utils/tenantContext.js');
  const sessions = await import('../../services/session.service.js');

  let seq = 0;
  const api = {
    baseUrl,
    mongoose,
    models,
    tenant,
    sessions,
    client: () => new Client(baseUrl),

    async makeOrg(name, extra = {}) {
      return models.Organization.create({ name, slug: await uniqueSlug(name), ...extra });
    },

    async makeUser(org, { role = 'ORG_ADMIN', email, password = PASSWORD, ...extra } = {}) {
      return models.User.create({
        organizationId: org?._id,
        name: `${role} ${++seq}`,
        email: email || `user${seq}-${Date.now()}@example.test`,
        passwordHash: await bcrypt.hash(password, 4), // low cost: tests only
        role,
        ...extra,
      });
    },

    /** Creates an org + admin, signs in, and returns a ready-to-use client. */
    async makeTenant(name, userExtra = {}) {
      const org = await api.makeOrg(name);
      const user = await api.makeUser(org, { role: 'ORG_ADMIN', ...userExtra });
      const client = api.client();
      const r = await client.login(user.email);
      if (r.status !== 200) throw new Error(`test login failed for ${name}: ${r.status} ${JSON.stringify(r.body)}`);
      return { org, user, client };
    },

    async stop() {
      await new Promise((r) => server.close(r));
      await mongoose.disconnect();
      await mongo.stop();
      fs.rmSync(dbPath, { recursive: true, force: true });
    },
  };
  return api;
}

export const futureDate = (years = 2) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
};

/** Creates a medicine with one batch through the real API. */
export async function addMedicine(client, name, { stock = 10, batchNo = 'B1', category = 'Tablets', manufacturer = 'ACME' } = {}) {
  const r = await client.post('/medicines', {
    medicineName: name,
    categoryName: category,
    manufacturer,
    batch: { batchNumber: batchNo, expiryDate: futureDate(), mrp: 100, sellingPrice: 90, initialQuantity: stock },
  });
  if (r.status !== 201) throw new Error(`addMedicine failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data;
}
