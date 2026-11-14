// Usage:  npm run crossings            (from e2e/)
//         node crossings.mjs
//         node crossings.mjs --keep     leaves the stack running afterwards, to poke at it by hand
//
// End-to-end CROSSING checks: seventeen journeys that each span several modules, run as one continuous story
// against a throwaway stack. They are deliberately not unit tests — every assertion goes through the HTTP API the
// browser uses, so what passes here is what a person would actually get.
//
// WHY THIS OWNS THE STACK. Several steps only hold on a clean database (see the header in crossings/steps-1-9.mjs),
// so this starts its own copy of stack.mjs, runs against it, and stops it. Freshness is then guaranteed by
// construction rather than by anybody remembering to restart something — and there is no way to point it at the
// development database by accident.
//
// It is NOT part of `npm run verify`: it takes about a minute of wall clock, most of it starting MongoDB and
// seeding, and `verify` already runs on every push. Run it before a release, or after touching anything that
// spans modules.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Steps } from './crossings/lib.mjs';
import stepsOneToNine from './crossings/steps-1-9.mjs';
import stepsTenToSeventeen from './crossings/steps-10-17.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes('--keep');

/**
 * A port nobody else is on, asked of the operating system rather than assumed.
 *
 * This runs inside `npm run verify`, which runs on every push. Hard-coding 4100 would mean a developer with a
 * stack already up could not push - a failure about their desktop rather than their code. The stack takes the
 * port it is given.
 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/api`;
process.env.CROSSINGS_BASE = BASE;

const reachable = async () => {
  try {
    await fetch(`${BASE}/health`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Readiness is the stack's own READY line, not a reachable port.
 *
 * The HTTP server starts listening well before the seed has finished writing medicines, suppliers and invoices,
 * so polling /health answers "ready" after about three seconds and the first check then fails on data that does
 * not exist yet. stack.mjs prints READY only once everything is in place.
 */
const seeded = () => /READY https?:\/\//.test(stackOutput);

console.log(`\nStarting a throwaway stack on ${PORT}…`);
const stack = spawn(process.execPath, ['stack.mjs'], {
  cwd: here,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HARNESS_PORT: String(PORT) },
});
let stackOutput = '';
stack.stdout.on('data', (d) => { stackOutput += d; });
stack.stderr.on('data', (d) => { stackOutput += d; });

const stop = () => {
  if (!keep && !stack.killed) stack.kill();
};
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

// Wait for it to answer, or report what it said instead of hanging.
const startedAt = Date.now();
while (!seeded()) {
  if (stack.exitCode !== null) {
    console.error(`\nThe stack exited before it was ready (code ${stack.exitCode}):\n${stackOutput.slice(-2000)}`);
    process.exit(1);
  }
  if (Date.now() - startedAt > 120000) {
    console.error(`\nThe stack did not become ready within two minutes:\n${stackOutput.slice(-2000)}`);
    stop();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

const S = new Steps();
const ran = Date.now();
await stepsOneToNine(S);
await stepsTenToSeventeen(S);

const { pass, fail, notRun } = S.report(path.join(here, '..', '.tmp', 'crossings-results.json'));
console.log(`checks took ${((Date.now() - ran) / 1000).toFixed(1)}s\n`);

if (keep) console.log(`The stack is still running on ${BASE} (--keep). Stop it yourself when you are done.\n`);
else stop();

process.exit(fail || notRun ? 1 : 0);
