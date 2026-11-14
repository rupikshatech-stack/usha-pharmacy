import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Info, RefreshCw, Repeat, UserPlus, UserRound, Users, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Skeleton, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import KpiCard from '../../components/analytics/KpiCard';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ReportTrendChart from '../../components/analytics/ReportTrendChart';
import { Breakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  totalCustomers: Users,
  activeCustomers: UserRound,
  newCustomers: UserPlus,
  repeatCustomers: Repeat,
  customerSales: Wallet,
  averageSpend: Wallet,
  outstanding: Wallet,
  walkInSales: UserRound,
};

/**
 * Customer Insights.
 *
 * The screen is built around one fact that shapes everything on it: this system has no customer records, so a
 * customer is a phone number on an invoice. That makes anonymous counter sales a genuine category rather than an
 * inconvenience — they are shown on their own line and kept out of every count, because a sale to a stranger says
 * nothing about loyalty, and folding it in would quietly corrupt every average on the page.
 */
export default function CustomerInsights() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [search, setSearch] = useState('');
  const [owing, setOwing] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [sort, setSort] = useState({ by: 'spent', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const q = useDebounced(search);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );

  const query = useMemo(
    () => ({
      ...periodQuery(period),
      search: q || undefined,
      owing: owing ? 'true' : undefined,
      activeOnly: activeOnly ? 'true' : undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, q, owing, activeOnly, sort],
  );
  const { data, loading, error, reload } = useFetch('/analytics/customers', { ...query, page, limit, k: refresh });

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportCustomers(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} customer${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <div className="min-w-0 max-w-[16rem]">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{r.name}</span>
            {r.isNew && <Badge tone="info">New</Badge>}
          </div>
          {r.phone ? (
            <div className="truncate text-[11px] text-muted">{r.phone}</div>
          ) : (
            data?.permissions?.contacts === false && <div className="text-[11px] italic text-muted">contact withheld</div>
          )}
        </div>
      ),
    },
    { key: 'orders', header: 'Invoices', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{r.orders.toLocaleString('en-IN')}</span> },
    { key: 'spent', header: 'Spent in period', sortable: true, align: 'right', render: (r) => <span className="font-semibold tabular-nums">{inr(r.spent)}</span> },
    { key: 'units', header: 'Units', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{r.units.toLocaleString('en-IN')}</span> },
    { key: 'spentAll', header: 'Spent all time', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{inr(r.spentAll)}</span> },
    { key: 'last', header: 'Last purchase', sortable: true, render: (r) => <span className="whitespace-nowrap text-muted">{r.lastPurchase ? dateFmt(r.lastPurchase) : '—'}</span> },
    {
      key: 'due',
      header: 'Outstanding',
      sortable: true,
      align: 'right',
      render: (r) => <span className={cx('tabular-nums', r.due > 0 ? 'font-semibold text-danger' : 'text-muted')}>{r.due > 0 ? inr(r.due) : '—'}</span>,
    },
  ];

  const toggle = (label, value, set) => (
    <button
      type="button"
      aria-pressed={value}
      onClick={() => narrow(set)(!value)}
      className={cx(
        'h-10 rounded-lg border px-3 text-sm font-semibold transition-colors',
        value ? 'border-primary bg-sage text-sage-ink' : 'border-line bg-card text-muted hover:bg-subtle hover:text-ink',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Customer Insights</h1>
          <p className="mt-1 text-sm text-muted">Who buys, how often they come back, and what they still owe.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            Overview
          </Link>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={!data?.total}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setRefresh((n) => n + 1);
              reload();
            }}
            loading={loading && Boolean(data)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </header>

      <Card className="space-y-3 p-3 sm:p-4">
        <PeriodFilters value={period} onChange={narrow(setPeriod)} stores={stores} storesLoading={branches.loading}>
          {data?.period && <p className="pb-2 text-xs text-muted">Counts of new customers look at their first ever purchase · times in {data.period.timezone}</p>}
        </PeriodFilters>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search customers" placeholder="Name or phone number…" />
          </div>
          {toggle('Only those who owe', owing, setOwing)}
          {toggle('Only active in period', activeOnly, setActiveOnly)}
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Customer figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 8 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <ReportTrendChart
              title="New customers over time"
              subtitle="Counted on their first ever purchase"
              series={data?.charts?.growth}
              period={data?.period}
              loading={loading}
              onRetry={reload}
              metrics={[
                { key: 'customers', label: 'New customers', colour: 'var(--primary)', format: 'number' },
                { key: 'spent', label: 'What they spent', colour: 'var(--info)' },
              ]}
            />
            <Card className="p-5">
              <div className="mb-3">
                <h2 className="text-[15px] font-bold">How often they bought</h2>
                <p className="text-xs text-muted">Identified customers, by number of invoices in the period.</p>
              </div>
              {loading && !data ? (
                <Skeleton className="h-48 w-full" />
              ) : !data?.summary?.active ? (
                <EmptyState icon={Users} title="Nobody bought in this period" />
              ) : (
                <ul className="space-y-2.5">
                  {data.charts.frequency.map((b) => {
                    const share = data.summary.active ? Math.round((b.customers / data.summary.active) * 1000) / 10 : 0;
                    return (
                      <li key={b.key}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="truncate">{b.label}</span>
                          <span className="shrink-0 tabular-nums">
                            <span className="font-semibold">{b.customers.toLocaleString('en-IN')}</span>
                            <span className="ml-2 text-[11px] text-muted">{inr(b.spent)}</span>
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(share, b.customers ? 1.5 : 0)}%` }} />
                        </div>
                      </li>
                    );
                  })}
                  <li className="border-t border-line pt-2 text-xs text-muted">
                    {data.summary.repeat.toLocaleString('en-IN')} of {data.summary.active.toLocaleString('en-IN')} active customers came back more than once
                    {data.summary.repeatShare ? ` (${data.summary.repeatShare}%)` : ''}.
                  </li>
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Top customers by revenue"
              subtitle="What each one was billed in this period"
              rows={(data?.charts?.topCustomers || []).map((c) => ({ id: c.phone || c.name, label: c.name, amount: c.spent, share: 0, orders: c.orders }))}
              loading={loading}
              limit={10}
              meta={(r) => `${r.orders} invoice${r.orders === 1 ? '' : 's'}`}
              emptyTitle="Nobody identified bought in this period"
            />
            <Card className="p-5">
              <div className="mb-3">
                <h2 className="text-[15px] font-bold">Sales that cannot be attributed</h2>
                <p className="text-xs text-muted">Counter sales with no phone number recorded.</p>
              </div>
              {loading && !data ? (
                <Skeleton className="h-28 w-full" />
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      ['Sales', inr(data?.summary?.walkIn?.sales)],
                      ['Invoices', (data?.summary?.walkIn?.orders || 0).toLocaleString('en-IN')],
                      ['Share of sales', `${
                        data?.summary && data.summary.customerSales + data.summary.walkIn.sales
                          ? Math.round((data.summary.walkIn.sales / (data.summary.customerSales + data.summary.walkIn.sales)) * 1000) / 10
                          : 0
                      }%`],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-subtle p-3">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</p>
                        <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted">{data?.notes?.anonymous}</p>
                </>
              )}
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Customers</h2>
                <p className="text-xs text-muted">{data ? `${data.total.toLocaleString('en-IN')} customer${data.total === 1 ? '' : 's'} match this question` : 'Loading…'}</p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={Users} title="No customers match this question" hint="Clear the search, or widen the period." />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.phone || r.name} loading={loading && !data} sort={sort} onSort={onSort} minWidth={940} />
                <Pagination
                  page={page}
                  pages={data?.pages || 1}
                  total={data?.total || 0}
                  limit={limit}
                  onPage={setPage}
                  onLimit={(n) => {
                    setLimit(n);
                    setPage(1);
                  }}
                  pageSummary
                />
              </>
            )}
          </Card>

          <Card className="space-y-1.5 p-4 text-xs text-muted">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink">How a customer is identified</p>
            {[data?.notes?.identity, data?.notes?.outstanding, data?.notes?.contacts].filter(Boolean).map((note) => (
              <p key={note} className="flex gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{note}</span>
              </p>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
