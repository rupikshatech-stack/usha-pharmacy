import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Download, Package, Percent, RefreshCw, RotateCcw, Truck, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, StatusBadge, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import KpiCard from '../../components/analytics/KpiCard';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ReportTrendChart from '../../components/analytics/ReportTrendChart';
import { Breakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  totalPurchases: Package,
  orders: ClipboardList,
  suppliers: Truck,
  purchaseReturns: RotateCcw,
  supplierOwed: Wallet,
  averageOrder: Wallet,
  purchaseGst: Percent,
};

const PAYMENT_TONE = { paid: 'success', partially_paid: 'warning', unpaid: 'danger' };
const PAYMENT_WORD = { paid: 'Paid', partially_paid: 'Part paid', unpaid: 'Unpaid' };

/**
 * The Purchase Report. What was ordered from suppliers in the period, what is still owed on it, and the cuts a buyer
 * asks for. As on the Sales Report, the question is asked once of the server and the figures describe the whole
 * matching set, not the page on screen.
 *
 * A draft order is never listed — nothing was ordered. A cancelled one is listed but counts towards nothing.
 */
export default function PurchaseReport() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
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
      status: status || undefined,
      paymentStatus: paymentStatus || undefined,
      supplierId: supplierId || undefined,
      search: q || undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, status, paymentStatus, supplierId, q, sort],
  );

  const { data, loading, error, reload } = useFetch('/analytics/purchases', { ...query, page, limit, k: refresh });
  const options = data?.options;

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportPurchases(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} order${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'orderNo',
      header: 'Order',
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold">{r.orderNo}</div>
          {r.referenceNo && <div className="truncate text-[11px] text-muted">ref {r.referenceNo}</div>}
          {!r.isPurchase && <div className="text-[11px] font-semibold text-danger">Not counted as a purchase</div>}
        </div>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      sortable: true,
      render: (r) => (
        <div className="min-w-0 max-w-[15rem]">
          <div className="truncate font-medium">{r.supplierName}</div>
          {r.supplierPhone && <div className="truncate text-[11px] text-muted">{r.supplierPhone}</div>}
        </div>
      ),
    },
    { key: 'branch', header: 'Store', hideBelow: 'lg', render: (r) => <span className="text-muted">{r.branchName || '—'}</span> },
    { key: 'date', header: 'Order date', sortable: true, render: (r) => <span className="whitespace-nowrap text-muted">{dateFmt(r.date)}</span> },
    { key: 'lines', header: 'Items', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{r.lines}</span> },
    { key: 'units', header: 'Units', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{r.units.toLocaleString('en-IN')}</span> },
    { key: 'taxable', header: 'Taxable', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums">{inr(r.taxable)}</span> },
    { key: 'tax', header: 'GST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{inr(r.tax)}</span> },
    {
      key: 'amount',
      header: 'Total',
      sortable: true,
      align: 'right',
      render: (r) => <span className={cx('font-semibold tabular-nums', !r.isPurchase && 'text-muted line-through')}>{inr(r.total)}</span>,
    },
    {
      key: 'due',
      header: 'Payment',
      sortable: true,
      align: 'right',
      render: (r) => (
        <div className="text-right">
          <Badge tone={PAYMENT_TONE[r.paymentStatus] || 'neutral'}>{PAYMENT_WORD[r.paymentStatus] || 'Not recorded'}</Badge>
          {r.due > 0 && <div className="mt-0.5 text-[11px] tabular-nums text-muted">{inr(r.due)} owed</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', hideBelow: 'md', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Purchase Report</h1>
          <p className="mt-1 text-sm text-muted">What was ordered from suppliers, what it cost, and what is still owed on it.</p>
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
          {data?.period && <p className="pb-2 text-xs text-muted">Compared with the {data.period.days} days before · times in {data.period.timezone}</p>}
        </PeriodFilters>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <Select
            label="Supplier"
            className="w-56"
            value={supplierId}
            onChange={(e) => narrow(setSupplierId)(e.target.value)}
            disabled={!options}
            hint={options && !options.suppliers.length ? 'Nothing was ordered in this period.' : undefined}
          >
            <option value="">All suppliers</option>
            {(options?.suppliers || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Order status" className="w-48" value={status} onChange={(e) => narrow(setStatus)(e.target.value)} disabled={!options}>
            <option value="">Any status</option>
            {(options?.statuses || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Payment status" className="w-44" value={paymentStatus} onChange={(e) => narrow(setPaymentStatus)(e.target.value)} disabled={!options}>
            <option value="">Any payment</option>
            {(options?.paymentStatuses || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search purchases" placeholder="Order number, supplier reference or name…" />
          </div>
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Purchase figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 7 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <ReportTrendChart
            title="Purchase trends"
            subtitle="What was ordered over the period"
            series={data?.charts?.overTime}
            period={data?.period}
            loading={loading}
            onRetry={reload}
            metrics={[
              { key: 'purchases', label: 'Purchases', colour: 'var(--info)' },
              { key: 'orders', label: 'Orders', colour: 'var(--purple)', format: 'number' },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Purchases by supplier"
              subtitle="Where the stock is bought, and what is still owed"
              rows={data?.charts?.bySupplier}
              loading={loading}
              limit={10}
              meta={(r) => (r.owed > 0 ? `${inr(r.owed)} owed` : `${r.orders} order${r.orders === 1 ? '' : 's'}`)}
            />
            <Breakdown
              title="Purchases by category"
              subtitle="From the category each order line recorded when it was placed"
              rows={data?.charts?.byCategory}
              loading={loading}
              meta={(r) => `${r.units.toLocaleString('en-IN')} units`}
            />
            <Breakdown
              title="Purchase value by store"
              subtitle="Which store the goods were ordered for"
              rows={data?.charts?.byBranch}
              loading={loading}
              meta={(r) => `${r.orders.toLocaleString('en-IN')} order${r.orders === 1 ? '' : 's'}`}
            />
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Purchase orders</h2>
                <p className="text-xs text-muted">
                  {data ? `${data.total.toLocaleString('en-IN')} order${data.total === 1 ? '' : 's'} match this question` : 'Loading…'}
                </p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={ClipboardList} title="No orders match this question" hint="Widen the period, or clear a filter." />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1120} />
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
        </>
      )}
    </div>
  );
}
