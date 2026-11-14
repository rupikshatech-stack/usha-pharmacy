import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Boxes, CalendarClock, Download, Info, PackageX, RefreshCw, Snowflake, TrendingUp, Warehouse } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { expiryFmt, inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, Skeleton, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import KpiCard from '../../components/analytics/KpiCard';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ReportTrendChart from '../../components/analytics/ReportTrendChart';
import { Breakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  units: Boxes,
  valuation: Warehouse,
  lowStock: AlertTriangle,
  outOfStock: PackageX,
  nearExpiry: CalendarClock,
  expiredValue: Snowflake,
  stockIn: TrendingUp,
  stockOut: TrendingUp,
};

const STATUS = {
  in_stock: { tone: 'success', label: 'In stock' },
  low: { tone: 'warning', label: 'Low' },
  out: { tone: 'neutral', label: 'Nothing sellable' },
  near_expiry: { tone: 'warning', label: 'Near expiry' },
  expired: { tone: 'danger', label: 'Expired' },
  quarantined: { tone: 'info', label: 'Quarantined' },
};

/**
 * Inventory analytics.
 *
 * Two kinds of figure share this page and the difference matters, so the page states it rather than hoping the reader
 * works it out: the cards and the register are a POSITION — what is on the shelves right now, which no date range can
 * change — while the movement chart and the fast/slow lists are PERIOD figures that follow the dates above them.
 *
 * Stock is valued at what it cost, from each batch's own purchase price. Never at MRP: valuing stock at what you hope
 * to sell it for books the profit before the sale.
 */
export default function InventoryAnalytics() {
  const [period, setPeriod] = useState(() => initialPeriod('last30'));
  const [categoryId, setCategoryId] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [stockStatus, setStockStatus] = useState('');
  const [expiryWindow, setExpiryWindow] = useState('');
  const [search, setSearch] = useState('');
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
      categoryId: categoryId || undefined,
      manufacturer: manufacturer || undefined,
      stockStatus: stockStatus || undefined,
      expiryWindow: expiryWindow || undefined,
      search: q || undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, categoryId, manufacturer, stockStatus, expiryWindow, q, sort],
  );

  const { data, loading, error, reload } = useFetch('/analytics/inventory', { ...query, page, limit, k: refresh });
  const options = data?.options;

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportInventory(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} batch${file.rows === 1 ? '' : 'es'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      key: 'medicine',
      header: 'Medicine',
      sortable: true,
      render: (r) => (
        <div className="min-w-0 max-w-[16rem]">
          <div className="truncate font-medium">{r.medicineName}</div>
          {r.manufacturer && <div className="truncate text-[11px] text-muted">{r.manufacturer}</div>}
        </div>
      ),
    },
    { key: 'branch', header: 'Store', hideBelow: 'lg', render: (r) => <span className="text-muted">{r.branchName || '—'}</span> },
    { key: 'batch', header: 'Batch', render: (r) => <span className="font-mono text-[12px]">{r.batchNumber}</span> },
    {
      key: 'expiry',
      header: 'Expiry',
      sortable: true,
      render: (r) => (
        <div className="whitespace-nowrap">
          <div>{expiryFmt(r.expiryDate)}</div>
          {r.daysToExpiry !== null && (
            <div className={cx('text-[11px]', r.daysToExpiry < 0 ? 'text-danger' : r.daysToExpiry <= 90 ? 'text-warning' : 'text-muted')}>
              {r.daysToExpiry < 0 ? `${Math.abs(r.daysToExpiry)} days ago` : `in ${r.daysToExpiry} days`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'quantity',
      header: 'Available',
      sortable: true,
      align: 'right',
      render: (r) => (
        <div className="text-right tabular-nums">
          <div>{r.availableQuantity.toLocaleString('en-IN')}</div>
          {r.reservedQuantity > 0 && <div className="text-[11px] text-muted">{r.reservedQuantity} reserved</div>}
        </div>
      ),
    },
    { key: 'cost', header: 'Purchase cost', sortable: true, align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums">{r.costKnown ? inr(r.purchasePrice) : <span className="text-muted">not recorded</span>}</span> },
    { key: 'selling', header: 'Selling price', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{inr(r.sellingPrice)}</span> },
    { key: 'value', header: 'Stock value', sortable: true, align: 'right', render: (r) => <span className="font-semibold tabular-nums">{inr(r.stockValue)}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS[r.stockStatus]?.tone || 'neutral'}>{STATUS[r.stockStatus]?.label || r.stockStatus}</Badge> },
  ];

  const notes = [data?.notes?.valuation, data?.notes?.stockHasNoPeriod, data?.notes?.noCost, data?.notes?.neverSold].filter(Boolean);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Inventory Analytics</h1>
          <p className="mt-1 text-sm text-muted">What is on the shelves, what it is worth at cost, and what is actually moving.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics/expiry"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            <CalendarClock className="h-4 w-4" aria-hidden="true" /> Expiry
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
          <p className="pb-2 text-xs text-muted">The period applies to movement only — stock figures are as they stand now.</p>
        </PeriodFilters>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <Select label="Category" className="w-44" value={categoryId} onChange={(e) => narrow(setCategoryId)(e.target.value)} disabled={!options}>
            <option value="">All categories</option>
            {(options?.categories || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Manufacturer" className="w-48" value={manufacturer} onChange={(e) => narrow(setManufacturer)(e.target.value)} disabled={!options}>
            <option value="">All manufacturers</option>
            {(options?.manufacturers || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Stock status" className="w-44" value={stockStatus} onChange={(e) => narrow(setStockStatus)(e.target.value)} disabled={!options}>
            <option value="">Any status</option>
            {(options?.stockStatuses || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Expiry" className="w-44" value={expiryWindow} onChange={(e) => narrow(setExpiryWindow)(e.target.value)} disabled={!options}>
            <option value="">Any expiry</option>
            {(options?.expiryWindows || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[14rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search stock" placeholder="Medicine, batch number or SKU…" />
          </div>
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Stock figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 8 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          {notes.length > 0 && (
            <Card className="space-y-1.5 p-4 text-xs text-muted">
              {notes.map((note) => (
                <p key={note} className="flex gap-2">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{note}</span>
                </p>
              ))}
            </Card>
          )}

          <ReportTrendChart
            title="Stock movement"
            subtitle="Units in and out over the period, from the stock ledger"
            series={data?.charts?.movement}
            period={data?.period}
            loading={loading}
            onRetry={reload}
            metrics={[
              { key: 'outUnits', label: 'Units out', colour: 'var(--orange)', format: 'number' },
              { key: 'inUnits', label: 'Units in', colour: 'var(--primary)', format: 'number' },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Inventory valuation by category"
              subtitle="At each batch's purchase cost; expired stock excluded"
              rows={data?.charts?.byCategory}
              loading={loading}
              meta={(r) => `${r.units.toLocaleString('en-IN')} units · ${r.medicines} medicines`}
              emptyTitle="Nothing is in stock"
            />
            <Card className="p-5">
              <div className="mb-3">
                <h2 className="text-[15px] font-bold">Fast and slow movers</h2>
                <p className="text-xs text-muted">Units sold in the period against the stock still on hand.</p>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <MoverList title="Fastest" rows={data?.charts?.fastMoving} loading={loading} meta={(r) => `${r.units.toLocaleString('en-IN')} sold`} hint={(r) => (r.daysOfCover === null ? '' : `${r.daysOfCover}d cover`)} />
                <MoverList title="Slowest" rows={data?.charts?.slowMoving} loading={loading} meta={(r) => (r.units ? `${r.units.toLocaleString('en-IN')} sold` : 'none sold')} hint={(r) => inr(r.stockValue)} />
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Stock register</h2>
                <p className="text-xs text-muted">
                  {data
                    ? `${data.total.toLocaleString('en-IN')} batch${data.total === 1 ? '' : 'es'} · ${data.filteredTotals.units.toLocaleString('en-IN')} units worth ${inr(data.filteredTotals.value)} at cost`
                    : 'Loading…'}
                </p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={Warehouse} title="No stock matches this question" hint="Clear a filter, or choose another store." />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1100} />
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

/** One short ranked list of medicines by how they moved. */
function MoverList({ title, rows, loading, meta, hint }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">{title}</p>
      {loading && !rows ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : !rows?.length ? (
        <p className="text-xs text-muted">Nothing to compare in this period.</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.slice(0, 8).map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="truncate">{r.label}</span>
              <span className="shrink-0 text-right">
                <span className="font-semibold tabular-nums">{meta(r)}</span>
                {hint(r) && <span className="ml-1.5 text-[11px] text-muted">{hint(r)}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
