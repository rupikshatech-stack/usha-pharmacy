import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, ChartNoAxesCombined, Download, Printer, RefreshCw, SlidersHorizontal, Table2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { inr, timeAgo } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { printExpiryReport } from '../../utils/printExpiry';
import { Button, Card, ErrorState, Pagination, cx } from '../../components/common/ui';
import { DEFAULTS, bulkActions, queryFromState, searchFromState, stateFromSearch } from '../../utils/expiryView';
import ExpiryKpis from '../../components/analytics/expiry/ExpiryKpis';
import ExpiryFilters from '../../components/analytics/expiry/ExpiryFilters';
import ExpiryInsights from '../../components/analytics/expiry/ExpiryInsights';
import ExpiryCalendar from '../../components/analytics/expiry/ExpiryCalendar';
import ExpiryRegister, { SelectionBar } from '../../components/analytics/expiry/ExpiryRegister';
import BatchDrawer from '../../components/analytics/expiry/BatchDrawer';
import ExpirySettingsDialog from '../../components/analytics/expiry/ExpirySettingsCard';
import { ExpiryActionDialog } from '../../components/analytics/expiry/ExpiryActionDialogs';

/**
 * Inventory Expiry Intelligence.
 *
 * A list of what expires soon is easy to produce and nearly useless to act on: a wholesaler with four hundred lots on
 * it still does not know which three to deal with this morning. So this screen answers a harder question — what will
 * NOT sell before it expires, and what does that cost — and ranks by that answer.
 *
 * Everything is one question asked once of the server: the store, the filters, the sort. The cards, the charts, the
 * calendar, the table and the CSV all come out of that same question, so they cannot disagree with each other. The
 * whole question lives in the address bar, which is what makes a narrowed view something you can send to a colleague.
 */
export default function ExpiryIntelligence() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => stateFromSearch(params.toString()), [params]);
  const { user } = useAuth();

  // The search box types faster than the server can answer, so the box keeps its own value and the question follows.
  const [searchDraft, setSearchDraft] = useState(state.search);
  const debouncedSearch = useDebounced(searchDraft);

  const [refresh, setRefresh] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [drawerRow, setDrawerRow] = useState(null);
  const [dialog, setDialog] = useState(null); // { action, rows }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [exporting, setExporting] = useState(false);

  /**
   * Narrowing the question always starts again at page one: page four of one question is no answer to another.
   * Everything goes through here, so the URL and the screen can never drift apart.
   */
  const set = useCallback(
    (patch) => {
      setParams(
        (prev) => {
          const next = { ...stateFromSearch(prev.toString()), ...patch };
          if (!('page' in patch)) next.page = 1;
          return searchFromState(next);
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const effective = useMemo(() => ({ ...state, search: debouncedSearch }), [state, debouncedSearch]);
  const query = useMemo(() => queryFromState(effective), [effective]);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );

  const summaryQuery = useMemo(() => ({ branchId: query.branchId, k: refresh }), [query.branchId, refresh]);
  const registerQuery = useMemo(() => ({ ...query, k: refresh }), [query, refresh]);
  // The charts and the calendar describe the whole filtered set, so they take the filters but never the paging.
  const unpaged = useMemo(() => Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'page' && k !== 'limit')), [query]);
  const insightsQuery = useMemo(() => ({ ...unpaged, k: refresh }), [unpaged, refresh]);
  const calendarQuery = useMemo(() => ({ ...unpaged, month: calendarMonth, k: refresh }), [unpaged, calendarMonth, refresh]);

  const summary = useFetch('/analytics/expiry/summary', summaryQuery);
  const register = useFetch('/analytics/expiry/batches', registerQuery);
  const insights = useFetch('/analytics/expiry/insights', insightsQuery);
  const calendar = useFetch('/analytics/expiry/calendar', calendarQuery);

  const rows = useMemo(() => register.data?.items || [], [register.data]);
  const selectedRows = useMemo(() => rows.filter((r) => selectedIds.has(r.id)), [rows, selectedIds]);

  const reloadAll = useCallback(() => {
    setRefresh((n) => n + 1);
    setLoadedAt(new Date());
  }, []);

  const onSort = (by) => set({ sortBy: by, sortDir: state.sortBy === by && state.sortDir === 'desc' ? 'asc' : 'desc' });

  const onSelect = (row) =>
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  const onSelectAll = (pageRows, select) =>
    setSelectedIds((s) => {
      const next = new Set(s);
      for (const r of pageRows) {
        if (select) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());

  /** After an action the figures have changed, so everything is asked again and the selection is dropped. */
  const onActionDone = () => {
    setDialog(null);
    setDrawerRow(null);
    clearSelection();
    reloadAll();
  };

  const clearFilters = () => {
    setSearchDraft('');
    set({ status: DEFAULTS.status, search: '', categoryId: '', manufacturer: '', supplierId: '', scheduleCategory: '', riskLevel: '', minValue: '', expiryFrom: '', expiryTo: '' });
  };

  /** The export asks the server the same question, which answers with every matching lot rather than the page. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportExpiry(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} lot${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  /**
   * Printing takes every lot the filters match, not the page on screen — a clipboard walked round the stockroom is
   * no use if it stops at row twenty-five.
   */
  const print = async () => {
    const t = toast.loading('Building the printable report…');
    try {
      const first = await analyticsService.expiryBatches({ ...query, page: 1, limit: 100 });
      let items = first.items;
      const pages = Math.min(first.pages, 20); // 2,000 lots is already more paper than anyone wants
      for (let page = 2; page <= pages; page++) {
        items = items.concat((await analyticsService.expiryBatches({ ...query, page, limit: 100 })).items);
      }
      const opened = printExpiryReport({
        rows: items,
        totals: first.totals,
        summary: summary.data,
        org: user?.organization,
        user,
        filters: effective,
        storeName: stores.find((b) => b._id === state.branchId)?.name || 'All stores',
      });
      toast.dismiss(t);
      if (!opened) toast.error('Your browser blocked the print window. Allow pop-ups for this site and try again.');
      else if (first.pages > 20) toast('Printed the first 2,000 lots. Narrow the filters to print the rest.');
    } catch (e) {
      toast.dismiss(t);
      toast.error(e.message);
    }
  };

  const options = register.data?.options;
  const settings = summary.data?.settings;
  const error = register.error || summary.error;
  const canManageSettings = user?.permissions?.includes('settings:manage');

  const VIEWS = [
    ['table', 'Table', Table2],
    ['calendar', 'Calendar', CalendarDays],
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Inventory Expiry Intelligence</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Not just what expires, but what will not sell before it does — and what that costs. Ranked so the first row is the one to deal with first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-xs text-muted sm:inline" title={loadedAt.toLocaleString('en-IN')}>
            Updated {timeAgo(loadedAt)}
          </span>
          <Link
            to="/analytics"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            <ChartNoAxesCombined className="h-4 w-4" aria-hidden="true" /> Overview
          </Link>
          {canManageSettings && settings && (
            <Button variant="secondary" onClick={() => setSettingsOpen(true)} title="What this organization means by “expiring soon”">
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Settings
            </Button>
          )}
          <Button variant="secondary" onClick={print} disabled={!register.data?.total}>
            <Printer className="h-4 w-4" aria-hidden="true" /> Print
          </Button>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={!register.data?.total}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
          <Button variant="secondary" onClick={reloadAll} loading={(register.loading || summary.loading) && Boolean(register.data)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </header>

      {error ? (
        <ErrorState message={error} onRetry={reloadAll} />
      ) : (
        <>
          <ExpiryKpis summary={summary.data} loading={summary.loading} activeStatus={state.status} onPick={(status) => set({ status })} />

          <ExpiryInsights
            data={insights.data}
            loading={insights.loading}
            onPickMonth={(month) => {
              setCalendarMonth(month);
              set({ view: 'calendar' });
            }}
          />

          <ExpiryFilters
            state={state}
            set={set}
            options={options}
            stores={stores}
            storesLoading={branches.loading}
            searchDraft={searchDraft}
            onSearchDraft={setSearchDraft}
            onClear={clearFilters}
          />

          {/* Table or calendar: two views of one question, so the toggle sits with the results rather than the filters. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex gap-1 rounded-lg border border-line bg-subtle p-1" role="group" aria-label="How to show the results">
              {VIEWS.map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => set({ view: value })}
                  aria-pressed={state.view === value}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors',
                    state.view === value ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            {register.data && (
              <p className="text-xs text-muted">
                {register.data.total.toLocaleString('en-IN')} lot{register.data.total === 1 ? '' : 's'} match this question
                {register.data.totals?.projectedLoss > 0 && ` · ${inr(register.data.totals.projectedLoss)} projected loss`}
              </p>
            )}
          </div>

          {state.view === 'calendar' ? (
            <ExpiryCalendar
              data={calendar.data}
              loading={calendar.loading}
              onMonth={setCalendarMonth}
              onPickDay={(day) => set({ expiryFrom: day.date, expiryTo: day.date, view: 'table' })}
            />
          ) : (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div>
                  <h2 className="text-[15px] font-bold">Risk Inventory Register</h2>
                  <p className="text-xs text-muted">Sorted by risk, so the first row is the one to deal with first.</p>
                </div>
              </div>

              <SelectionBar rows={selectedRows} actions={bulkActions(selectedRows)} onAction={(action, r) => setDialog({ action, rows: r })} onClear={clearSelection} />

              <ExpiryRegister
                data={register.data}
                loading={register.loading}
                state={state}
                onSort={onSort}
                onOpen={setDrawerRow}
                onAction={(action, r) => setDialog({ action, rows: r })}
                selected={selectedIds}
                onSelect={onSelect}
                onSelectAll={onSelectAll}
              />

              {register.data?.total > 0 && (
                <Pagination
                  page={register.data.page}
                  pages={register.data.pages}
                  total={register.data.total}
                  limit={register.data.limit}
                  limits={[10, 25, 50, 100]}
                  onPage={(page) => set({ page })}
                  onLimit={(limit) => set({ limit, page: 1 })}
                />
              )}
            </Card>
          )}
        </>
      )}

      {drawerRow && <BatchDrawer row={drawerRow} onClose={() => setDrawerRow(null)} onAction={(action, r) => setDialog({ action, rows: r })} />}

      {dialog && (
        <ExpiryActionDialog
          action={dialog.action}
          rows={dialog.rows}
          maxDiscount={settings?.clearanceMaxDiscount ?? 50}
          onClose={() => setDialog(null)}
          onDone={dialog.action === 'transfer' ? () => setDialog(null) : onActionDone}
        />
      )}

      {settingsOpen && settings && (
        <ExpirySettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            reloadAll();
          }}
        />
      )}
    </div>
  );
}
