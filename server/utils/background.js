import { waitUntil } from '@vercel/functions';

/**
 * Runs work after the response has been sent.
 *
 * On a long-running server a bare setImmediate is enough. On Vercel the function is frozen as soon as the response
 * ends, so the work would silently never finish; waitUntil keeps the invocation alive (up to the function's
 * maxDuration) until the promise settles. Callers pass a function that already handles its own errors.
 */
export function runInBackground(fn) {
  if (process.env.VERCEL) {
    waitUntil(Promise.resolve().then(fn).catch(() => {}));
  } else {
    setImmediate(() => Promise.resolve().then(fn).catch(() => {}));
  }
}
