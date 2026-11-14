import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Download, Info, Package, RefreshCw, RotateCcw, Truck, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import KpiCard from '../../components/analytics/KpiCard';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ReportTrendChart from '../../components/analytics/ReportTrendChart';
import { Breakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  totalSuppliers: Truck,
  activeSuppliers: Truck,
  purchaseValue: Package,
  orders: Package,
  returnValue: RotateCcw,
  outstanding: Wallet,
};

/**
 * Supplier Performance.
 *
 * Buying well is not only about price: a supplier who sends the wrong goods, or who is owed money nobody has
 * reconciled, costs more than the invoice says. So the two figures this screen puts next to purchase value are the
 * RETURN RATE and what is still OWED — and the lead time, which is the only one of the three a purchase order can
 * tell you about itself.
 */
export default function SupplierPerformance() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [owing, setOwing] = useState(false);
  const [sort, setSort] = useState({ by: 'value', dir: 'desc' });
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
      supplierId: supplierId || undefined,
      search: q || undefined,
      owing: owing ? 'true' : undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, supplierId, q, owing, sort],
  );
  const { data, loading, error, reload } = useFetch('/analytics/suppliers', { ...query, page, limit, k: refresh });

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportSuppliers(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} supplier${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Supplier',
      sortable: true,
      render: (r) => (
        <div className="min-w-0 max-w-[16rem]">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{r.name}</span>
            {!r.linked && <Badge tone="neutral">Name only</Badge>}
          </div>
          {r.phone && <div className="truncate text-[11px] text-muted">{r.phone}</div>}
        </div>
      ),
    },
    { key: 'orders', header: 'Orders', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{r.orders.toLocaleString('en-IN')}</span> },
    { key: 'value', header: 'Purchase value', sortable: true, align: 'right', render: (r) => <span className="font-semibold tabular-nums">{inr(r.value)}</span> },
    {
      key: 'returns',
      header: 'Returns',
      align: 'right',
      hideBelow: 'md',
      render: (r) => (
        <div className="text-right">
          <div className="tabular-nums text-muted">{r.returnValue ? inr(r.returnValue) : '—'}</div>
          {r.returnRate > 0 && <div className={cx('text-[11px] font-semibold', r.returnRate >= 5 ? 'text-danger' : 'text-warning')}>{r.returnRate}% of purchases</div>}
        </div>
      ),
    },
    {
      key: 'lead',
      header: 'Lead time',
      align: 'right',
      hideBelow: 'lg',
      render: (r) => (
        <div className="text-right">
          {r.leadTime === null ? <span className="text-muted">—</span> : <span className="tabular-nums">{r.leadTime} days</span>}
          {r.receivedOrders > 0 && <div className="text-[11px] text-muted">{r.receivedOrders} received</div>}
        </div>
      ),
    },
    {
      key: 'owed',
      header: 'Outstanding',
      sortable: true,
      align: 'right',
      render: (r) => <span className={cx('tabular-nums', r.owed > 0 ? 'font-semibold text-danger' : 'text-muted')}>{r.owed > 0 ? inr(r.owed) : '—'}</span>,
    },
    { key: 'last', header: 'Last order', sortable: true, render: (r) => <span className="whitespace-nowrap text-muted">{r.lastOrder ? dateFmt(r.lastOrder) : '—'}</span> },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Supplier Performance</h1>
          <p className="mt-1 text-sm text-muted">Where the stock comes from, what comes back, and what is still owed.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics/purchases"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            <Package className="h-4 w-4" aria-hidden="true" /> Purchases
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
          {data?.period && <p className="pb-2 text-xs text-muted">Outstanding is a balance as it stands now · times in {data.period.timezone}</p>}
        </PeriodFilters>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <Select label="Supplier" className="w-56" value={supplierId} onChange={(e) => narrow(setSupplierId)(e.target.value)} disabled={!data}>
            <option value="">All suppliers</option>
            {(data?.options?.suppliers || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search suppliers" placeholder="Name, phone or GSTIN…" />
          </div>
          <button
            type="button"
            aria-pressed={owing}
            onClick={() => narrow(setOwing)(!owing)}
            className={cx(
              'h-10 rounded-lg border px-3 text-sm font-semibold transition-colors',
              owing ? 'border-primary bg-sage text-sage-ink' : 'border-line bg-card text-muted hover:bg-subtle hover:text-ink',
            )}
          >
            Only those owed money
          </button>
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Supplier figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(data?.kpis || Array.from({ length: 6 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <ReportTrendChart
            title="Purchases over time"
            subtitle="What was ordered in the period"
            series={data?.charts?.trend}
            period={data?.period}
            loading={loading}
            onRetry={reload}
            metrics={[
              { key: 'value', label: 'Purchase value', colour: 'var(--info)' },
              { key: 'orders', label: 'Orders', colour: 'var(--purple)', format: 'number' },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Biggest suppliers"
              subtitle="By what was ordered in this period"
              rows={(data?.charts?.topSuppliers || []).map((x) => ({ id: x.key, label: x.name, amount: x.value, share: 0, orders: x.orders, rate: x.returnRate }))}
              loading={loading}
              limit={10}
              meta={(r) => `${r.orders} order${r.orders === 1 ? '' : 's'}${r.rate ? ` · ${r.rate}% returned` : ''}`}
              emptyTitle="Nothing was ordered in this period"
            />
            <Breakdown
              title="Most owed"
              subtitle="What the orders record as still unpaid, as a balance now"
              rows={(data?.charts?.mostOwed || []).map((x) => ({ id: x.key, label: x.name, amount: x.owed, share: 0, orders: x.ordersAll }))}
              loading={loading}
              limit={10}
              meta={(r) => `${r.orders} order${r.orders === 1 ? '' : 's'} all time`}
              emptyTitle="Nothing is outstanding"
            />
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Suppliers</h2>
                <p className="text-xs text-muted">{data ? `${data.total.toLocaleString('en-IN')} supplier${data.total === 1 ? '' : 's'} match this question` : 'Loading…'}</p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={Truck} title="No suppliers match this question" hint="Clear the search, or widen the period." />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.key} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1020} />
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
            <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-ink">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" /> How these figures are arrived at
            </p>
            {[data?.notes?.outstanding, data?.notes?.leadTime, data?.notes?.returns, data?.notes?.unlinked].filter(Boolean).map((note) => (
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
