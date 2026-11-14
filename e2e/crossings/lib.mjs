// Shared helpers for the end-to-end crossing checks. Real HTTP against the running isolated stack on :4100 —
// nothing here imports a service or touches the database directly.
import fs from 'node:fs';
import path from 'node:path';

// The throwaway stack started by crossings.mjs. Never a development server. Read per call, because this module is
// imported (and so evaluated) before the runner has chosen its port.
export const base = () => process.env.CROSSINGS_BASE || 'http://127.0.0.1:4100/api';
export const PASSWORD = 'Str0ng!Passw0rd';

/** A cookie-aware client, behaving like the browser app: cookies plus the CSRF header on writes. */
export class Client {
  constructor(label = 'client') {
    this.label = label;
    this.jar = new Map();
    this.csrf = null;
    this.last = null;
  }

  async request(method, url, body, extraHeaders = {}) {
    const headers = {
      'content-type': 'application/json',
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      ...extraHeaders,
    };
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const res = await fetch(base() + url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
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
    this.last = { method, url, status: res.status, body: json };
    return { status: res.status, body: json, data: json?.data };
  }

  get(url) { return this.request('GET', url); }
  post(url, body) { return this.request('POST', url, body); }
  patch(url, body) { return this.request('PATCH', url, body); }
  put(url, body) { return this.request('PUT', url, body); }
  del(url) { return this.request('DELETE', url); }

  async login(email, password = PASSWORD) {
    const r = await this.request('POST', '/auth/login', { email, password });
    if (r.status === 200) this.csrf = r.data.csrfToken;
    return r;
  }
}

/** Throws with the full request and response when a call did not return the status we required. */
export function must(r, expected, what) {
  const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
  if (!ok) {
    const e = new Error(
      `${what}\n      expected HTTP ${expected}, got ${r.status}\n      response: ${JSON.stringify(r.body)?.slice(0, 500)}`,
    );
    e.httpDetail = { expected, got: r.status, body: r.body };
    throw e;
  }
  return r.data;
}

export const futureDate = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
export const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** A tiny ordered test runner that stops at the first failure, as the brief requires. */
export class Steps {
  constructor() {
    this.results = [];
    this.stopped = false;
  }

  async step(n, title, fn) {
    if (this.stopped) {
      this.results.push({ n, title, status: 'not run' });
      return undefined;
    }
    const started = Date.now();
    try {
      const notes = await fn();
      this.results.push({ n, title, status: 'PASS', ms: Date.now() - started, notes: notes || [] });
      console.log(`  PASS  ${String(n).padStart(2)}. ${title}`);
      for (const line of notes || []) console.log(`           ${line}`);
      return notes;
    } catch (e) {
      this.results.push({ n, title, status: 'FAIL', ms: Date.now() - started, error: e.message, detail: e.httpDetail });
      this.stopped = true;
      console.log(`  FAIL  ${String(n).padStart(2)}. ${title}`);
      console.log(`      ${e.message}`);
      return undefined;
    }
  }

  report(file) {
    const pass = this.results.filter((r) => r.status === 'PASS').length;
    const fail = this.results.filter((r) => r.status === 'FAIL').length;
    const notRun = this.results.filter((r) => r.status === 'not run').length;
    console.log(`\n${pass} passed, ${fail} failed, ${notRun} not run`);
    if (file) {
      // The results go under <repo>/.tmp, which is gitignored and so does not exist in a fresh checkout. Without
      // this the runner passed every check and then crashed writing the report, failing `npm run verify`.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.results, null, 2));
    }
    return { pass, fail, notRun };
  }
}

/** Analytics reports return `kpis` as an array of { key, value }; this reads one by key. */
export const kpi = (report, key) => report?.kpis?.find((k) => k.key === key)?.value;
