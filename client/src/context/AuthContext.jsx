import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { authService } from '../services/authService';
import { setCsrfToken } from '../services/api';
import { setDisplayDateFormat, setDisplayTimezone } from '../utils/format';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef(null);
  userRef.current = user;

  // Load the current user once on startup. A 401 here means "not signed in" (the API client has
  // already tried to renew the session silently).
  useEffect(() => {
    authService
      .me()
      .then((d) => {
        setCsrfToken(d.csrfToken);
        setDisplayTimezone(d.user.organization?.timezone);
        setDisplayDateFormat(d.user.organization?.dateFormat);
        setUser(d.user);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password, rememberMe) => {
    const d = await authService.login(email, password, rememberMe);
    setCsrfToken(d.csrfToken);
    setDisplayTimezone(d.user.organization?.timezone);
    setDisplayDateFormat(d.user.organization?.dateFormat);
    setUser(d.user);
    return d.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      /* the server may be unreachable; still sign out locally */
    }
    setCsrfToken(null);
    setUser(null);
  }, []);

  /** Called after a successful password change so the "must change" gate lifts. */
  const passwordChanged = useCallback(() => setUser((u) => (u ? { ...u, mustChangePassword: false } : u)), []);

  // Events from the API client: session ended (refresh failed) / server requires a password change.
  useEffect(() => {
    const onUnauthorized = () => {
      if (userRef.current) toast.error('Your session has expired. Please sign in again.', { id: 'session-expired' });
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
