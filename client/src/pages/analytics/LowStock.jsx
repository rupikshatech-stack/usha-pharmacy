import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, Info, PackageX, Printer, RefreshCw, ShieldAlert, Package } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { printLowStockReport } from '../../utils/printLowStock';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, Skeleton, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';

/** The three figures at the top, in the order a buyer reads them. */
const CARD_ICON = { total: AlertTriangle, out: PackageX, critical: ShieldAlert };
const CARD_TONE = {
  warning: { ring: 'border-warning/50', wash: 'bg-warning/10', text: 'text-warning' },
  danger: { ring: 'border-danger/40', wash: 'bg-danger/10', text: 'text-danger' },
  accent: { ring: 'border-accent/40', wash: 'bg-accent/10', text: 'text-accent' },
};
const STATUS_TONE = { out: 'danger', critical: 'warning', low: 'neutral' };

/** How many rows the printed sheet can carry in one request. Beyond this the screen says so and points at the CSV. */
const PRINT_LIMIT = 500;

/**
 * The Low Stock Report: the buying list.
 *
 * This screen has no date range, and that is deliberate — everything on it is the position on the shelves right
 * now. Every other analytics screen opens with a period picker; this one opens with a store, and says why, because
 * a date range here would be a control that looked like it did something and did not.
 *
 * Two columns are suggestions rather than facts, and are labelled as such: the suggested order brings a medicine
 * back to its own reorder level and knows nothing about how fast it sells, and the estimated cost values that order
 * at the last price actually paid. Where there is no reorder level or nothing was ever paid, the cell says so
 * instead of showing a zero that would read as "free".
 */
export default function LowStock() {
  const { user } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'urgency', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(null);
  const q = useDebounced(search);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );

  const query = useMemo(
    () => ({ branchId: branchId || undefined, status: status || undefined, search: q || undefined, sortBy: sort.by, sortDir: sort.dir }),
    [branchId, status, q, sort],
  );
  const { data, loading, error, reload } = useFetch('/analytics/low-stock', { ...query, page, limit, k: refresh });
  const storeName = stores.find((b) => b._id === branchId)?.name || 'All stores';

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setBusy('export');
    try {
      const file = await analyticsService.exportLowStock(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} medicine${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  // The printed sheet is the whole filtered list, not the page on screen, so it is fetched again in one go.
  const print = async () => {
    setBusy('print');
    try {
      const full = await analyticsService.lowStock({ ...query, page: 1, limit: PRINT_LIMIT });
      const opened = printLowStockReport({ data: full, rows: full.items, org: full.organization, user, storeName });
      if (!opened) toast.error('Your browser blocked the print window. Allow pop-ups for this site and try again.');
      else if (full.total > full.items.length) {
        toast(`The sheet covers the first ${full.items.length.toLocaleString('en-IN')} of ${full.total.toLocaleString('en-IN')} medicines. Export the CSV for the rest.`, { icon: 'ℹ️' });
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const columns = [
    {
      // Numbering continues across pages: row 11 is the eleventh medicine to order, not the first of page two.
      key: 'index',
      header: '#',
      align: 'right',
      className: 'w-12',
      render: (_r, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span>,
    },
    {
      key: 'medicine',
      header: 'Product details',
      sortable: true,
      render: (r) => (
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning" aria-hidden="true">
            <Package className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-semibold text-warning">{r.medicineName}</div>
            {(r.salt || r.strength) && <div className="truncate text-[12px] text-ink/80">{[r.salt, r.strength].filter(Boolean).join(' · ')}</div>}
            <div className="truncate text-[11px] text-muted">
              {r.manufacturer || 'No manufacturer'}
              {r.category ? ` · ${r.category}` : ''}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'threshold',
      header: 'Min threshold',
      sortable: true,
      align: 'right',
      render: (r) =>
        r.thresholdSet ? (
          <span className="font-semibold tabular-nums">
            {r.threshold.toLocaleString('en-IN')} <span className="text-[11px] font-normal text-muted">{r.unit || 'units'}</span>
          </span>
        ) : (
          <span className="text-[12px] italic text-muted">not set</span>
        ),
    },
    {
      key: 'available',
      header: 'Available stock',
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className={cx('font-semibold tabular-nums', r.available === 0 ? 'text-danger' : 'text-ink')}>
          {r.available.toLocaleString('en-IN')} <span className="text-[11px] font-normal text-muted">{r.unit || 'units'}</span>
        </span>
      ),
    },
    {
      key: 'shortfall',
      header: 'Suggested order',
      sortable: true,
      align: 'right',
      render: (r) =>
        r.shortfall === null ? (
          <span className="text-[12px] italic text-muted" title="No reorder level is set for this medicine, so there is no minimum to return to.">
            no level set
          </span>
        ) : (
          <span className="font-bold tabular-nums">{r.shortfall.toLocaleString('en-IN')}</span>
        ),
    },
    {
      key: 'cost',
      header: 'Est. cost (₹)',
      sortable: true,
      align: 'right',
      render: (r) =>
        r.estimatedCost === null ? (
          <span className="text-[12px] italic text-muted" title="Nothing was ever purchased for this medicine, so there is no price to value an order at.">
            no price on record
          </span>
        ) : (
          <div className="text-right">
            <div className="tabular-nums">{inr(r.estimatedCost)}</div>
            <div className="text-[11px] text-muted">at {inr(r.lastCost)} each</div>
          </div>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'center',
      render: (r) => (
        <Badge tone={STATUS_TONE[r.status]} dot>
          {r.statusLabel}
        </Badge>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Low Stock Report</h1>
          <p className="mt-1 text-sm text-muted">Live inventory running at or below its reorder level. What to buy, now.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics/inventory"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            Inventory
          </Link>
          <Button variant="secondary" onClick={exportCsv} loading={busy === 'export'} disabled={!data?.total}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
          <Button onClick={print} loading={busy === 'print'} disabled={!data?.total}>
            <Printer className="h-4 w-4" aria-hidden="true" /> Print report
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

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Low stock figures" className="grid gap-3 sm:grid-cols-3">
            {(data?.cards || Array.from({ length: 3 })).map((c, i) => {
              if (!c) return <Skeleton key={i} className="h-28 w-full rounded-2xl" />;
              const tone = CARD_TONE[c.tone] || CARD_TONE.warning;
              const Icon = CARD_ICON[c.key] || AlertTriangle;
              return (
                <Card key={c.key} className={cx('relative overflow-hidden p-5', tone.ring)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-3xl font-bold tabular-nums tracking-tight">{c.value.toLocaleString('en-IN')}</p>
                      <p className="mt-1 text-sm font-semibold">{c.label}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted">{c.hint}</p>
                    </div>
                    <span className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-xl', tone.wash, tone.text)} aria-hidden="true">
                      <Icon className="h-5 w-5" />
                    </span>
                  </div>
                </Card>
              );
            })}
          </section>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-bold">Low stock inventory register</h2>
              <p className="text-xs text-muted">
                Stock on the shelves{' '}
                {data?.asOf ? (
                  <>
                    as at <strong className="text-ink">{new Date(data.asOf).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
                  </>
                ) : (
                  'right now'
                )}
                . This report has no date range — it is a position, not a period.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
              <div className="min-w-[16rem] flex-1">
                <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
                <SearchInput value={search} onChange={narrow(setSearch)} label="Search low stock" placeholder="Medicine, salt or manufacturer…" />
              </div>
              <Select label="Show" className="w-44" value={status} onChange={(e) => narrow(setStatus)(e.target.value)}>
                {(data?.options?.statuses || [{ value: '', label: 'All items' }]).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select label="Store" className="w-48" value={branchId} onChange={(e) => narrow(setBranchId)(e.target.value)} disabled={branches.loading}>
                <option value="">All stores</option>
                {stores.map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>

            {data && !data.total ? (
              <EmptyState
                icon={Package}
                title={status || search ? 'Nothing matches this question' : 'Nothing needs ordering'}
                hint={
                  status || search
                    ? 'Clear the search or show all items.'
                    : 'Every medicine in these stores is above its reorder level. This is the answer you want.'
                }
              />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1060} />
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

          {Boolean(data?.total) && (
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">To return every medicine to its reorder level</p>
                <p className="mt-1 text-sm">
                  <strong className="text-lg tabular-nums">{(data.summary.suggestedUnits || 0).toLocaleString('en-IN')}</strong> units
                  {data.summary.costKnown ? (
                    <>
                      , costing about <strong className="text-lg tabular-nums">{inr(data.summary.estimatedCost)}</strong>
                      {data.summary.costIsPartial && (
                        <span className="text-muted"> (excluding {data.summary.noCost} with no price on record)</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted"> — the cost is not known, because nothing on this list has a purchase price on record</span>
                  )}
                </p>
              </div>
              <p className="max-w-xl text-[11px] leading-relaxed text-muted">
                {data.notes.suggestion} {data.notes.cost}
              </p>
            </Card>
          )}

          <Card className="space-y-1.5 p-4 text-xs text-muted">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink">How this list is worked out</p>
            {[data?.notes?.noPeriod, data?.notes?.definition, data?.notes?.sellable, data?.notes?.noThreshold, data?.notes?.noCost]
              .filter(Boolean)
              .map((note) => (
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
