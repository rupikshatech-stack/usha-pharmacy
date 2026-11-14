import { useCallback, useEffect, useState } from 'react';
import { Building2, LogOut, ShieldCheck } from 'lucide-react';
import { platformService } from '../../services/platformService';
import { setCsrfToken } from '../../services/api';
import { Spinner, cx } from '../../components/common/ui';
import PlatformLogin from './PlatformLogin';
import PlatformPasswordChange from './PlatformPasswordChange';
import NewOrganization from './NewOrganization';

/**
 * The platform area: one screen, its own shell, deliberately not the pharmacy app's.
 *
 * It does NOT use AppLayout, AuthContext, the sidebar or any tenant service. A platform administrator belongs to no
 * organization, so every one of those would be asking a question that has no answer here — which organization's
 * logo, whose notifications, which store. Reusing them would mean teaching each one to cope with "none", and the
 * first thing to slip through that would be a screen quietly showing one pharmacy's data to the operator.
 *
 * The visual difference is on purpose too. This page creates pharmacies and hands out their first credentials; it
 * should never be mistaken at a glance for the ordinary workspace.
 */
export default function PlatformApp() {
  const [state, setState] = useState({ status: 'loading', user: null });

  const load = useCallback(async () => {
    try {
      const data = await platformService.me();
      setCsrfToken(data.csrfToken);
      setState({ status: 'in', user: data.user });
    } catch (e) {
      // 403 PASSWORD_CHANGE_REQUIRED means the session is good but the password has to change first.
      if (e.code === 'PASSWORD_CHANGE_REQUIRED') setState({ status: 'change-password', user: null });
      else setState({ status: 'out', user: null });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onSignedIn = (user) => {
    if (user.mustChangePassword) setState({ status: 'change-password', user });
    else setState({ status: 'in', user });
  };

  const signOut = async () => {
    try {
      await platformService.logout();
    } catch {
      /* signing out must always appear to work */
    }
    setCsrfToken(null);
    setState({ status: 'out', user: null });
  };

  if (state.status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-app">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (state.status === 'out') return <Shell><PlatformLogin onSignedIn={onSignedIn} /></Shell>;
  if (state.status === 'change-password') return <Shell><PlatformPasswordChange onDone={load} /></Shell>;

  return (
    <Shell user={state.user} onSignOut={signOut}>
      <NewOrganization />
    </Shell>
  );
}

/** The frame. A dark header and the word "Platform" everywhere, so this is never mistaken for a pharmacy's app. */
function Shell({ user, onSignOut, children }) {
  return (
    <div className="min-h-screen bg-app">
      <header className="border-b border-line bg-ink text-white">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/60">Platform administration</p>
              <h1 className="text-base font-bold leading-tight">Usha Pharmacy — onboarding</h1>
            </div>
          </div>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-white/70">{user.email}</span>
              <button type="button" onClick={onSignOut} className={cx('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold', 'bg-white/10 hover:bg-white/20')}>
                <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">{children}</main>

      <footer className="mx-auto max-w-[1100px] px-4 pb-8 text-xs text-muted sm:px-6">
        <p className="flex items-start gap-2">
          <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          This area creates pharmacies and their first administrator. It has no access to any pharmacy&apos;s own
          data — invoices, stock and customers are reachable only by that pharmacy&apos;s own accounts.
        </p>
      </footer>
    </div>
  );
}
