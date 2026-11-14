import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppLayout from '../layouts/AppLayout';
import { Spinner } from '../components/common/ui';

/**
 * Guards every application page.
 *  - not signed in            -> /login (remembering where they were going)
 *  - password change pending  -> /change-password (nothing else is reachable)
 *  - otherwise                -> the app shell
 */
export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Loading workspace…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <AppLayout />;
}

/** For pages that need a signed-in user but not the app shell (e.g. change password). */
export function AuthOnlyRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
}

/** Login/forgot-password are only for signed-out visitors. */
export function GuestRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return children;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  const from = location.state?.from?.pathname;
  return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />;
}
