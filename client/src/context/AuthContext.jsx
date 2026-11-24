import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useLocation } from 'react-router-dom';
import { authService } from '../services/authService';
import { setCsrfToken } from '../services/api';
import { setDisplayDateFormat, setDisplayTimezone } from '../utils/format';
import { clearSessionHint, readSessionHint, shouldAskServer, writeSessionHint } from '../utils/sessionHint';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Whether the server has answered "who is signed in?" (or this visitor never needed it to).
  const [checked, setChecked] = useState(false);
  const { pathname } = useLocation();
  const userRef = useRef(null);
  userRef.current = user;

  // Ask only where the answer matters. A signed-out visitor on the landing, sign-in or forgot-password page has
  // nothing to find, so asking costs two failing requests (me, then refresh) on every view. `loading` is derived
  // rather than stored so that the render which first lands on a protected page already reads "loading": a guard
  // never sees "no user, not loading" in between and bounces a signed-in person to /login.
  const mustAsk = !checked && shouldAskServer(pathname, readSessionHint());
  const loading = mustAsk;

  // Load the current user the first time a page needs to know. A 401 here means "not signed in" (the API client
  // has already tried to renew the session silently), and it also retires a stale hint.
  useEffect(() => {
    if (!mustAsk) return;
    authService
      .session()
      .then((d) => {
        if (!d.user) throw new Error('not signed in'); // no session cookies: a stale hint, retired in the catch below
        setCsrfToken(d.csrfToken);
        setDisplayTimezone(d.user.organization?.timezone);
        setDisplayDateFormat(d.user.organization?.dateFormat);
        writeSessionHint();
        setUser(d.user);
      })
      .catch(() => {
        clearSessionHint();
        setUser(null);
      })
      .finally(() => setChecked(true));
  }, [mustAsk]);

  const login = useCallback(async (email, password, rememberMe) => {
    const d = await authService.login(email, password, rememberMe);
    setCsrfToken(d.csrfToken);
    setDisplayTimezone(d.user.organization?.timezone);
    setDisplayDateFormat(d.user.organization?.dateFormat);
    writeSessionHint();
    setChecked(true); // signing in IS the answer: nothing left to ask
    setUser(d.user);
    return d.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      /* the server may be unreachable; still sign out locally */
    }
    clearSessionHint();
    setCsrfToken(null);
    setChecked(true);
    setUser(null);
  }, []);

  /** Called after a successful password change so the "must change" gate lifts. */
  const passwordChanged = useCallback(() => setUser((u) => (u ? { ...u, mustChangePassword: false } : u)), []);

  // Events from the API client: session ended (refresh failed) / server requires a password change.
  useEffect(() => {
    const onUnauthorized = () => {
      if (userRef.current) toast.error('Your session has expired. Please sign in again.', { id: 'session-expired' });
      clearSessionHint();
      setCsrfToken(null);
      setUser(null);
    };
    const onPasswordRequired = () => setUser((u) => (u ? { ...u, mustChangePassword: true } : u));
    window.addEventListener('usha:unauthorized', onUnauthorized);
    window.addEventListener('usha:password-change-required', onPasswordRequired);
    return () => {
      window.removeEventListener('usha:unauthorized', onUnauthorized);
      window.removeEventListener('usha:password-change-required', onPasswordRequired);
    };
  }, []);

  /**
   * Re-reads the signed-in user after something they changed is also shown outside this page — the organization's
   * name, its logo or its timezone all live in the sidebar and the header. Without this they would stay stale
   * until the next full page load, which looks like the save did not work.
   */
  const refreshUser = useCallback(
    () =>
      authService
        .me()
        .then((d) => {
          setCsrfToken(d.csrfToken);
          setDisplayTimezone(d.user.organization?.timezone);
          setDisplayDateFormat(d.user.organization?.dateFormat);
          setUser(d.user);
          return d.user;
        })
        .catch(() => null),
    [],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, passwordChanged, refreshUser }),
    [user, loading, login, logout, passwordChanged, refreshUser],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
