import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Download, FileText, Package, Percent, Receipt, RefreshCw, Undo2, Wallet } from 'lucide-react';
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
import { Breakdown, DonutBreakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  totalSales: Banknote,
  netSales: Receipt,
  invoices: FileText,
  averageInvoice: Wallet,
  discounts: Percent,
  gst: Package,
  salesReturns: Undo2,
};

const PAYMENT_TONE = { paid: 'success', partially_paid: 'warning', unpaid: 'danger' };
const PAYMENT_WORD = { paid: 'Paid', partially_paid: 'Part paid', unpaid: 'Unpaid' };

/**
 * The Sales Report. Every figure, every chart and every row comes from one question asked once of the server: the
 * period, the store and the filters. The table is paged, sorted and filtered in the database, so the figures above it
 * always describe the WHOLE matching set rather than the page on screen — and the export carries that same whole set.
 *
 * A cancelled or reversed invoice is listed, because it happened and people need to find it, but it is marked and adds
 * nothing to any money figure.
 */
export default function SalesReport() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [status, setStatus] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [cashier, setCashier] = useState('');
  const [customer, setCustomer] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const who = useDebounced(customer);
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
      paymentMode: paymentMode || undefined,
      cashier: cashier || undefined,
      customer: who || undefined,
      search: q || undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, status, paymentMode, cashier, who, q, sort],
  );

  const { data, loading, error, reload } = useFetch('/analytics/sales', { ...query, page, limit, k: refresh });
  const options = data?.options;

  /** Narrowing the question always starts again at page one: page 4 of one question is no answer to another. */
  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  /** The export asks the server the same question, which answers with every matching invoice. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportSales(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} invoice${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'invoiceNo',
      header: 'Invoice',
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold">{r.invoiceNo}</div>
          {!r.isSale && <div className="text-[11px] font-semibold text-danger">Not counted as a sale</div>}
        </div>
      ),
    },
    { key: 'date', header: 'Date', sortable: true, render: (r) => <span className="whitespace-nowrap text-muted">{dateFmt(r.date)}</span> },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <div className="min-w-0 max-w-[14rem]">
          <div className="truncate font-medium">{r.customerName}</div>
          {r.customerPhone && <div className="truncate text-[11px] text-muted">{r.customerPhone}</div>}
        </div>
      ),
    },
    { key: 'branch', header: 'Store', hideBelow: 'lg', render: (r) => <span className="text-muted">{r.branchName || '—'}</span> },
    { key: 'lines', header: 'Items', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{r.lines}</span> },
    { key: 'taxable', header: 'Taxable', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums">{inr(r.taxable)}</span> },
    { key: 'discount', header: 'Discount', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{r.discount ? inr(r.discount) : '—'}</span> },
    { key: 'tax', header: 'GST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{inr(r.tax)}</span> },
    {
      key: 'amount',
      header: 'Total',
      sortable: true,
      align: 'right',
      render: (r) => <span className={cx('font-semibold tabular-nums', !r.isSale && 'text-muted line-through')}>{inr(r.total)}</span>,
    },
    {
      key: 'due',
      header: 'Payment',
      sortable: true,
      align: 'right',
      render: (r) => (
        <div className="text-right">
          <Badge tone={PAYMENT_TONE[r.paymentStatus] || 'neutral'}>{PAYMENT_WORD[r.paymentStatus] || r.paymentStatus}</Badge>
          {r.due > 0 && <div className="mt-0.5 text-[11px] tabular-nums text-muted">{inr(r.due)} due</div>}
        </div>
      ),
    },
    { key: 'mode', header: 'Mode', hideBelow: 'md', render: (r) => <span className="text-muted">{r.paymentMode || '—'}</span> },
    { key: 'status', header: 'Status', hideBelow: 'lg', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'cashier', header: 'Billed by', hideBelow: 'lg', render: (r) => <span className="truncate text-muted">{r.cashier || '—'}</span> },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Sales Report</h1>
          <p className="mt-1 text-sm text-muted">What was sold, to whom, through which store — and what it came to.</p>
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
          <Select label="Invoice status" className="w-44" value={status} onChange={(e) => narrow(setStatus)(e.target.value)} disabled={!options}>
            <option value="">Any status</option>
            {(options?.statuses || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Payment mode" className="w-40" value={paymentMode} onChange={(e) => narrow(setPaymentMode)(e.target.value)} disabled={!options}>
            <option value="">Any mode</option>
            {(options?.paymentModes || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select
            label="Billed by"
            className="w-44"
            value={cashier}
            onChange={(e) => narrow(setCashier)(e.target.value)}
            disabled={!options}
            hint={options && !options.cashiers.length ? 'Nobody billed in this period.' : undefined}
          >
            <option value="">Anyone</option>
            {(options?.cashiers || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[13rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Customer</span>
            <SearchInput value={customer} onChange={narrow(setCustomer)} label="Search customer" placeholder="Name or phone…" />
          </div>
          <div className="min-w-[11rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Invoice number</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search invoice number" placeholder="INV-0001…" />
          </div>
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Sales figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 7 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <ReportTrendChart
            title="Sales over time"
            subtitle="Trade over the period"
            series={data?.charts?.overTime}
            period={data?.period}
            loading={loading}
            onRetry={reload}
            metrics={[
              { key: 'sales', label: 'Sales', colour: 'var(--primary)' },
              { key: 'invoices', label: 'Invoices', colour: 'var(--purple)', format: 'number' },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <DonutBreakdown
              title="Sales by payment mode"
              subtitle="How customers paid, as a share of total sales"
              rows={data?.charts?.byPaymentMode}
              loading={loading}
            />
            <Breakdown
              title="Sales by store"
              subtitle="Which store the sale came out of"
              rows={data?.charts?.byBranch}
              loading={loading}
              meta={(r) => `${r.invoices.toLocaleString('en-IN')} invoice${r.invoices === 1 ? '' : 's'}`}
            />
            <Breakdown
              title="Sales by category"
              subtitle="At the price the lines were sold for, from the catalogue's own categories"
              rows={data?.charts?.byCategory}
              loading={loading}
              meta={(r) => `${r.units.toLocaleString('en-IN')} units`}
            />
            <Breakdown
              title="Top-selling medicines"
              subtitle="The ten that brought in the most, by line value"
              rows={(data?.charts?.topMedicines || []).map((m) => ({ ...m, share: 0 }))}
              loading={loading}
              limit={10}
              meta={(r) => `${r.units.toLocaleString('en-IN')} units`}
              emptyTitle="Nothing was sold in this period"
            />
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Invoices</h2>
                <p className="text-xs text-muted">
                  {data ? `${data.total.toLocaleString('en-IN')} invoice${data.total === 1 ? '' : 's'} match this question` : 'Loading…'}
                </p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={Receipt} title="No invoices match this question" hint="Widen the period, or clear a filter." />
            ) : (
              <>
                <DataTable
                  columns={columns}
                  rows={data?.items || []}
                  rowKey={(r) => r.id}
                  loading={loading && !data}
                  sort={sort}
                  onSort={onSort}
                  minWidth={1180}
                />
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
