import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Keeps an unsaved settings tab from being lost.
 *
 * The in-app guard catches links, and `beforeunload` catches closing the tab — but neither can catch the browser's
 * Back button, or a sign-out, or any button that navigates by calling `navigate()` instead of rendering a link.
 * Rather than fight the history stack for those, the work itself is kept: the edits are written to
 * `sessionStorage` as they are made, and when the person comes back the screen offers to restore them.
 *
 * WHY sessionStorage AND NOT localStorage: a draft belongs to this browser tab and this sitting. localStorage
 * would hand a half-finished edit to a different tab, or to whoever opens the browser tomorrow — on a shared
 * counter machine that is somebody else.
 *
 * WHAT IS NEVER WRITTEN: anything in `exclude`. The bank account number is there by name. A draft is unencrypted
 * text sitting in the browser, and a field the API itself masks for most people has no business being written to
 * disk by the screen that shows it.
 *
 * The key names the organization, the person and the tab, so two accounts on one machine — or the same person in
 * two organizations — never see each other's drafts.
 */
const PREFIX = 'usha:settings-draft';
const DEBOUNCE_MS = 500;

export const draftKey = ({ orgId, userId, tab }) => `${PREFIX}:${orgId || 'org'}:${userId || 'user'}:${tab}`;

/** Storage that a private window, a blocked-cookies setting or a full disk cannot turn into a crash. */
const safeStorage = {
  read(key) {
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // a draft is a convenience; losing it must never break the form
    }
  },
  clear(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};

/** A copy of `values` with the excluded paths removed, so they are never written anywhere. */
export function stripExcluded(values, exclude = []) {
  const clone = JSON.parse(JSON.stringify(values ?? {}));
  for (const path of exclude) {
    const parts = path.split('.');
    const last = parts.pop();
    const parent = parts.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), clone);
    if (parent && typeof parent === 'object') delete parent[last];
  }
  return clone;
}

/** Which fields a restored draft would actually change, so the banner can say how many. */
export function draftDifferences(draft, serverValues, exclude = []) {
  if (!draft) return [];
  const a = stripExcluded(draft, exclude);
  const b = stripExcluded(serverValues, exclude);
  const out = [];
  const walk = (x, y, prefix = '') => {
    for (const key of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
      const path = prefix ? `${prefix}.${key}` : key;
      const left = x?.[key];
      const right = y?.[key];
      const bothPlainObjects = left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right);
      if (bothPlainObjects) walk(left, right, path);
      else if (JSON.stringify(left ?? '') !== JSON.stringify(right ?? '')) out.push(path);
    }
  };
  walk(a, b);
  return out;
}

/**
 * @param {object}   options.values   what is on screen now
 * @param {object}   options.server   what the server last gave us, to tell a real draft from a stale copy
 * @param {boolean}  options.dirty    whether there is anything worth keeping
 * @param {string[]} options.exclude  dotted paths that must never be written
 */
export function useSettingsDraft({ key, values, server, dirty, exclude = [], enabled = true }) {
  // Read once, before the first write can overwrite it.
  const [found, setFound] = useState(() => (enabled && key ? safeStorage.read(key) : null));
  const timer = useRef(null);

  useEffect(() => {
    if (!enabled || !key) return undefined;
    clearTimeout(timer.current);
    // Debounced: a settings form is typed in, and writing on every keystroke would be a write per character.
    timer.current = setTimeout(() => {
      if (dirty) safeStorage.write(key, { at: Date.now(), values: stripExcluded(values, exclude) });
      else safeStorage.clear(key);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [enabled, key, values, dirty, exclude]);

  const differences = useMemo(() => draftDifferences(found?.values, server, exclude), [found, server, exclude]);

  const discard = useCallback(() => {
    if (key) safeStorage.clear(key);
    setFound(null);
  }, [key]);

  /** Stop offering the draft, without touching what is stored — used once it has been restored onto the form. */
  const accept = useCallback(() => setFound(null), []);

  return {
    /** The draft worth offering: one that exists and would actually change something. */
    draft: differences.length ? found : null,
    changedFields: differences,
    savedAt: found?.at || null,
    discard,
    accept,
    clear: discard,
  };
}
