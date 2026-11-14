import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * A form that knows what has actually changed.
 *
 * Settings screens are long and are edited a field at a time, so three things matter more than they would on a
 * small dialog:
 *
 *   WHAT CHANGED, not "something changed". The save sends only the fields that differ from what was loaded, which
 *   is what makes a PATCH safe when two people have the same screen open: editing the bank details cannot wipe a
 *   colleague's licence list, because the licence list is not in the request at all.
 *
 *   A CHANGE THAT IS UNDONE IS NOT A CHANGE. Typing a character and deleting it again leaves the form clean, so
 *   the save bar does not nag about work nobody did.
 *
 *   LEAVING WITH UNSAVED WORK IS HARD, NOT IMPOSSIBLE. Navigating away inside the app is intercepted so the person
 *   can decide, and the browser's own "leave site?" prompt covers closing the tab. Neither can be silent.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value at a dotted path. */
export const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

/** A copy of `obj` with `path` set to `value`, sharing everything it did not touch. */
export function setPath(obj, path, value) {
  const [head, ...rest] = String(path).split('.');
  if (!rest.length) return { ...obj, [head]: value };
  return { ...obj, [head]: setPath(isObject(obj?.[head]) ? obj[head] : {}, rest.join('.'), value) };
}

/** Every leaf path in an object, so two versions can be compared field by field. An array counts as one leaf. */
function leaves(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) leaves(v, path, out);
    else out.push(path);
  }
  return out;
}

/** Blank, null and undefined are the same emptiness as far as "did this change?" is concerned. */
const sameValue = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  return a === b;
};

export function useDirtyForm(initial) {
  /**
   * The baseline and the working copy are ONE piece of state, so they can never be a render out of step with each
   * other. When a fresh `initial` arrives (a reload, or a successful save) the state is adjusted during render —
   * the pattern React documents for deriving state from props — rather than in an effect that would paint the old
   * values once before correcting itself.
   */
  const [state, setState] = useState(() => ({ base: initial || {}, values: initial || {} }));
  const [errors, setErrors] = useState({});

  if (initial && initial !== state.base) {
    setState({ base: initial, values: initial });
    setErrors({});
  }

  const { base, values } = state;

  const changed = useMemo(() => {
    const paths = new Set([...leaves(base), ...leaves(values)]);
    return [...paths].filter((p) => !sameValue(getPath(values, p), getPath(base, p)));
  }, [base, values]);

  const set = useCallback((path, value) => {
    setState((s) => ({ ...s, values: setPath(s.values, path, value) }));
    // Correcting a field clears its error; the next blur or save decides whether it is still wrong.
    setErrors((e) => (e[path] === undefined ? e : { ...e, [path]: undefined }));
  }, []);

  /** Only what changed, as a nested object — the body of the PATCH. */
  const patch = useCallback(() => {
    let out = {};
    for (const path of changed) out = setPath(out, path, getPath(values, path));
    return out;
  }, [changed, values]);

  /** Throw the edits away and go back to what the server last gave us. */
  const reset = useCallback(() => {
    setState((s) => ({ ...s, values: s.base }));
    setErrors({});
  }, []);

  /** After a save: what the server now holds becomes the clean state. */
  const commit = useCallback((saved) => {
    setState({ base: saved, values: saved });
    setErrors({});
  }, []);

  return {
    values,
    baseline: base,
    set,
    errors,
    setErrors,
    changed,
    dirty: changed.length > 0,
    changedCount: changed.length,
    patch,
    reset,
    commit,
  };
}

/**
 * Stops a person walking away from unsaved work.
 *
 * WHY NOT `useBlocker`: react-router's own blocker only exists on a DATA router (`createBrowserRouter`), and this
 * application is mounted with `<BrowserRouter>`. Rather than convert every route in the app — and every provider
 * around them — for the sake of one screen, this watches the two ways a person actually leaves:
 *
 *   A LINK INSIDE THE APP — caught in the capture phase, before react-router sees the click, so the navigation can
 *   be held while the person decides. Modified clicks (new tab, new window) and links to other origins are left
 *   alone: those do not destroy anything, because this page stays open.
 *
 *   CLOSING OR RELOADING THE TAB — `beforeunload`, where the browser shows its own wording and we cannot.
 *
 * WHAT IS NOT COVERED: the browser's Back and Forward buttons. Intercepting those without a data router means
 * pushing history entries back as the person presses them, which breaks the history they are trying to use. It is
 * better to leave one route out than to make the Back button misbehave everywhere — so Back discards unsaved
 * edits, exactly as it would on any ordinary form. Converting the app to a data router would close that gap.
 */
export function useUnsavedGuard(dirty) {
  const [pending, setPending] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!dirty) return undefined;

    const onClick = (e) => {
      // A click that is already handled, or that opens somewhere else, takes nothing away from this page.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(url.pathname + url.search);
    };

    const warn = (e) => {
      e.preventDefault();
      e.returnValue = ''; // the browser decides the wording; this only asks for the prompt
    };

    document.addEventListener('click', onClick, true); // capture: ahead of the router's own handler
    window.addEventListener('beforeunload', warn);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  return {
    /** Where the person tried to go, or null when nothing is being held. */
    pending,
    cancel: useCallback(() => setPending(null), []),
    proceed: useCallback(() => {
      setPending((to) => {
        if (to) navigate(to);
        return null;
      });
    }, [navigate]),
  };
}

/**
 * Takes the person to the first field that is wrong and focuses it. A long form that simply refuses to save, with
 * the problem two screens up, is a form that looks broken.
 */
export function scrollToFirstError(errors) {
  const first = Object.entries(errors || {}).find(([, message]) => message)?.[0];
  if (!first) return false;
  const el = document.querySelector(`[data-field="${CSS.escape(first)}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusable = el.matches('input, select, textarea') ? el : el.querySelector('input, select, textarea');
  focusable?.focus({ preventScroll: true });
  return true;
}
