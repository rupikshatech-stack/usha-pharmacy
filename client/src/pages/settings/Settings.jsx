import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Building2, FileText, Loader2, RefreshCw, Settings2, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useFetch } from '../../hooks/useFetch';
import { useUnsavedGuard } from '../../hooks/useDirtyForm';
import { Button, Card, ConfirmDialog, ErrorState, Skeleton, cx } from '../../components/common/ui';
import OrganizationTab from './OrganizationTab';
import InvoiceTab from './InvoiceTab';
import GeneralTab from './GeneralTab';

const TABS = [
  { key: 'organization', label: 'Organization Profile', icon: Building2 },
  { key: 'invoice', label: 'Invoice Customization', icon: FileText },
  { key: 'general', label: 'Common Settings', icon: SlidersHorizontal },
];

/**
 * Settings & Configuration.
 *
 * ONE READ, THREE TABS. The server returns every tab in a single response, together with the `version` they were
 * all read at. That version is what each save carries back, so two people editing different tabs still find out
 * about each other rather than silently overwriting.
 *
 * THE TAB IS IN THE URL (`/settings/organization`), so a tab can be linked to, bookmarked and opened in a second
 * window — and the browser's back button does what it looks like it does.
 *
 * UNSAVED WORK IS GUARDED in both directions: switching tab, and leaving the page. Each is a question, never a
 * silent discard, because a settings form is exactly where somebody types for five minutes and then clicks away.
 */
export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  /**
   * The settings are read with the project's own `useFetch`, the one place that owns "load on mount, expose loading and
   * error, reload on demand". After a save the server hands back the settings it just stored, and that answer is shown
   * straight away (`saved`) rather than read a second time; a Reload drops it and reads afresh.
   */
  const { data: fetched, loading: fetching, error, reload } = useFetch('/settings');
  const [saved, setSaved] = useState(null);
  const data = saved ?? fetched;
  const loading = fetching && !saved;
  const load = useCallback(() => {
    setSaved(null);
    reload();
  }, [reload]);

  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState(null);
  const [discardSignal, setDiscardSignal] = useState(0);

  // Navigating away from the whole page with unsaved work.
  const guard = useUnsavedGuard(dirty);

  const active = TABS.find((t) => t.key === tab);
  const canManage = data?.permissions?.manage;

  /** Switching tab is navigation too, so it asks the same question before throwing work away. */
  const goToTab = (key) => {
    if (key === tab) return;
    if (dirty) {
      setPendingTab(key);
      return;
    }
    navigate(`/settings/${key}`);
  };

  const onSaved = useCallback(
    (next) => {
      setSaved(next);
      setDirty(false);
      // The logo and the organization name are shown in the sidebar and the breadcrumb, so the session's copy of
      // the organization has to catch up with what was just saved.
      refreshUser?.();
    },
    [refreshUser],
  );

  const tabProps = useMemo(
    () => ({ data, canManage, onSaved, onDirtyChange: setDirty, discardSignal, reload: load }),
    [data, canManage, onSaved, discardSignal, load],
  );

  if (!active) return <Navigate to="/settings/organization" replace />;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Configuration</p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Settings2 className="h-6 w-6 text-muted" aria-hidden="true" /> Settings &amp; Configuration
          </h1>
          <p className="mt-1 text-sm text-muted">
            Your store profile, licences, invoice numbering and the rules this system bills by.
            {data?.updatedBy && (
              <>
                {' '}
                Last changed by <strong className="text-ink">{data.updatedBy}</strong>
                {data.updatedAt ? ` on ${new Date(data.updatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.
              </>
            )}
          </p>
        </div>
        <Button variant="secondary" onClick={load} disabled={loading || dirty} title={dirty ? 'Save or discard your changes first' : undefined}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />} Reload
        </Button>
      </header>

      {!canManage && data && (
        <p className="rounded-xl border border-line bg-subtle/60 p-3 text-sm text-muted">
          You can read these settings but not change them. Bank account details are partly hidden, and saving needs the
          <strong className="text-ink"> settings:manage</strong> permission.
        </p>
      )}

      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-subtle p-1" aria-label="Settings sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => goToTab(t.key)}
              aria-current={isActive ? 'page' : undefined}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors',
                isActive ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
              {isActive && dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="unsaved changes" />}
            </button>
          );
        })}
      </nav>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading && !data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-72 w-full rounded-2xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-56 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        </div>
      ) : tab === 'organization' ? (
        <OrganizationTab {...tabProps} />
      ) : tab === 'invoice' ? (
        <InvoiceTab {...tabProps} />
      ) : tab === 'general' ? (
        <GeneralTab {...tabProps} />
      ) : (
        <Card className="p-8 text-center">
          <h2 className="text-[15px] font-bold">{active.label}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            Not built yet — this tab arrives in the next phase. The settings behind it already exist and are returned by{' '}
            <code className="rounded bg-subtle px-1.5 py-0.5 text-[12px]">GET /settings</code>, so nothing here is lost in the meantime.
          </p>
        </Card>
      )}

      {/* Switching tab with unsaved work. */}
      {pendingTab && (
        <ConfirmDialog
          title="Leave this tab?"
          message="You have unsaved changes on this tab. Leaving now discards them."
          confirmLabel="Discard and leave"
          danger
          onConfirm={() => {
            const next = pendingTab;
            setPendingTab(null);
            setDirty(false);
            setDiscardSignal((n) => n + 1);
            navigate(`/settings/${next}`);
          }}
          onClose={() => setPendingTab(null)}
        />
      )}

      {/* Leaving the page entirely, by a link inside the app. */}
      {guard.pending && (
        <ConfirmDialog
          title="Leave settings?"
          message="You have unsaved changes. Leaving now discards them."
          confirmLabel="Discard and leave"
          danger
          onConfirm={() => {
            setDirty(false);
            guard.proceed();
          }}
          onClose={guard.cancel}
        />
      )}
    </div>
  );
}
