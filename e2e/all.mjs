// One command for the whole browser test run:  npm run e2e   (from /e2e)
// Starts a throwaway API + demo data (port 4100) and a web server (port 5200), runs run.mjs, then shuts everything down.
// Your development servers (4000 / 5173) and database are never touched.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logs = path.resolve(here, '..', '.tmp');
fs.mkdirSync(logs, { recursive: true });
const children = [];

const start = (name, cmd, args, opts) => {
  const out = fs.openSync(path.join(logs, `e2e-${name}.log`), 'w');
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', out, out], shell: process.platform === 'win32' && cmd === 'npx' });
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const c of children) {
    if (!c.pid) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
};
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const waitFor = async (what, test, ms = 120000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what} (see .tmp/e2e-*.log)`);
};

start('stack', process.execPath, [path.join(here, 'stack.mjs')], { cwd: here });
await waitFor('the test API and its demo data', async () => /READY/.test(fs.readFileSync(path.join(logs, 'e2e-stack.log'), 'utf8')));
start('vite', 'npx', ['vite', '--port', '5200'], { cwd: path.resolve(here, '..', 'client'), env: { ...process.env, VITE_DEV_API_TARGET: 'http://127.0.0.1:4100' } });
await waitFor('the web server', async () => (await fetch('http://localhost:5200/')).ok);

const run = spawn(process.execPath, [path.join(here, process.env.E2E_SCRIPT || 'run.mjs')], { cwd: here, stdio: 'inherit' });
const code = await new Promise((r) => run.on('exit', r));
process.exit(code ?? 1);
