import { useCallback, useEffect, useState } from 'react';
import { LogOut, Moon, ShieldCheck, Sun } from 'lucide-react';
import { platformService } from '../../services/platformService';
import { setCsrfToken } from '../../services/api';
import { useTheme } from '../../context/ThemeContext';
import { Logo, Spinner } from '../../components/common/ui';
import PlatformLogin from './PlatformLogin';
import PlatformPasswordChange from './PlatformPasswordChange';
import NewOrganization from './NewOrganization';

/**
 * The platform area: its own shell, deliberately not the pharmacy app's.
 *
 * It does NOT use AppLayout, AuthContext, the sidebar or any tenant service. A platform administrator belongs to
 * no organization, so every one of those would be asking a question that has no answer here — which organization's
 * logo, whose notifications, which store. Reusing them would mean teaching each one to cope with "none", and the
 * first thing to slip through that would be a screen quietly showing one pharmacy's data to the operator.
 *
 * The visual difference is on purpose too. This console creates pharmacies and hands out their first credentials;
 * it should never be mistaken at a glance for the ordinary workspace. Hence the dark bar, the word "platform"
 * where a pharmacy's own name would be, and no pharmacy-shaped navigation anywhere on it.
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
        <Spinner label="Opening the platform console…" />
      </div>
    );
  }

  if (state.status === 'out') {
    return (
      <Shell narrow>
        <PlatformLogin onSignedIn={onSignedIn} />
      </Shell>
    );
  }
  if (state.status === 'change-password') {
    return (
      <Shell narrow>
        <PlatformPasswordChange onDone={load} />
      </Shell>
    );
  }

  return (
    <Shell user={state.user} onSignOut={signOut}>
      <NewOrganization />
    </Shell>
  );
}

/** The frame: a dark bar that says "platform" in every register, so this is never mistaken for a pharmacy's app. */
function Shell({ user, onSignOut, narrow, children }) {
  const { theme, toggle } = useTheme();
  const width = narrow ? 'max-w-xl' : 'max-w-[1240px]';

  return (
    <div className="flex min-h-screen flex-col bg-app">
      {/* `--side`, not `--ink`: ink flips to near-white in the dark theme and would leave this white-on-white.
          `--side` is the one colour held at the same dark green in both themes, which is why the app's sidebar
          uses it — and it makes the console read as a sibling of that sidebar rather than of a pharmacy's page. */}
      <header className="sticky top-0 z-30 border-b border-black/20 bg-side text-white">
        <div className={`mx-auto flex ${width} flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6`}>
          <div className="flex min-w-0 items-center gap-3">
            <Logo onDark className="w-32 shrink-0" />
            <span className="hidden h-8 w-px bg-white/20 sm:block" aria-hidden="true" />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/60">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Platform
              </p>
              <h1 className="truncate text-sm font-bold leading-tight sm:text-base">Pharmacy onboarding</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* The console's own toggle: an operator never passes through the pharmacy app, where the app's one lives. */}
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
              className="grid h-9 w-9 place-items-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" aria-hidden="true" /> : <Moon className="h-[18px] w-[18px]" aria-hidden="true" />}
            </button>
            {user && (
              <>
                <span className="hidden max-w-[16rem] truncate text-sm text-white/70 sm:block">{user.email}</span>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-sm font-semibold transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 ${width} px-4 py-6 sm:px-6 sm:py-8`}>{children}</main>

      <footer className={`mx-auto w-full ${width} px-4 pb-8 sm:px-6`}>
        <p className="flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            This console creates pharmacies and their first administrator. It has no access to any pharmacy&apos;s own data — invoices, stock and customers are
            reachable only by that pharmacy&apos;s own accounts.
          </span>
        </p>
      </footer>
    </div>
  );
}
