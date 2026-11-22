/**
 * Recovering a tab that was open across a deploy.
 *
 * Every build gives its JavaScript chunks new hashed names and the old files are gone once the new deployment is
 * live. A tab that was loaded before the deploy still points at the OLD names, so the next lazy import in it (today:
 * the 3D scene on the landing page) asks for a file that no longer exists. Vite reports that as `vite:preloadError`.
 * A fresh page load fetches the new names, so the right response is to reload - once.
 *
 * "Once" matters: if the file is missing for some other reason, reloading again and again would trap the person in a
 * loop. The time of the last attempt is kept in sessionStorage; a second failure inside the window is left to surface
 * as the ordinary error. If storage is unavailable there is no way to guard against a loop, so no reload is tried.
 */
const KEY = 'usha:chunk-reload';
export const RELOAD_WINDOW_MS = 30_000;

/** True when a reload may be tried now, and records that it was. */
export function canReloadOnce(getStorage, now = Date.now()) {
  try {
    const storage = getStorage();
    const last = Number(storage.getItem(KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function installChunkReload(win = window) {
  win.addEventListener('vite:preloadError', (event) => {
    if (!canReloadOnce(() => win.sessionStorage)) return; // already tried: let the error show
    event.preventDefault(); // we are handling it; stop Vite rethrowing into the page
    win.location.reload();
  });
}
