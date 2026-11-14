import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Download, Eye, Filter, Receipt, RefreshCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateTimeFmt, inr } from '../../utils/format';
import { QUICK_RANGES, compactMoney } from '../../utils/analytics';
import { TYPE_TONE, activeChips, columnPlan, directionOf, originOf, summaryLines } from '../../utils/transactions';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, Skeleton, StatusBadge, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import TransactionDetails from '../../components/analytics/TransactionDetails';

const DIRECTION = { in: 'text-success', out: 'text-danger', none: 'text-muted' };

/**
 * The Daily Transaction Report: every business document of a period in one list — sales, purchases, returns of both
 * kinds and stock transfers — read straight from the collections that own them.
 *
 * Two things are deliberate. The filtering, sorting, counting and paging all happen in the database, so the page
 * holds one page and the figures still describe the whole matching set. And a document that is not trade (a cancelled
 * invoice, a transfer between our own stores) is still listed, because it happened — but it is marked, and it adds
 * nothing to a total.
 */
export default function Transactions() {
  const [params, setParams] = useSearchParams();
  // The Overview links here with the period, the store and the kind of document it was showing, so clicking through
  // asks the same question rather than quietly changing it. Read once, when the page opens.
  const [period, setPeriod] = useState(() => {
    const range = params.get('range');
    const base = initialPeriod(QUICK_RANGES.some(([v]) => v === range) ? range : 'last30', params.get('branchId') || '');
    const from = params.get('from');
    const to = params.get('to');
    return from || to ? { ...base, from: from || base.from, to: to || base.to } : base;
  });
  const [type, setType] = useState(() => params.get('type') || '');
  const [status, setStatus] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [open, setOpen] = useState(null);
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
      type: type || undefined,
      status: status || undefined,
      paymentMode: paymentMode || undefined,
      search: q || undefined,
      sortBy: sort.by,
      sortDir: sort.dir,
    }),
    [period, type, status, paymentMode, q, sort],
  );

  const { data, loading, error, reload } = useFetch('/analytics/transactions', { ...query, page, limit, k: refresh });
  const options = data?.options;

  /**
   * Narrowing the question always starts again at page one: page 4 of one question is meaningless as an answer to
   * another. The reset happens here, with the change that caused it, rather than afterwards in an effect.
   */
  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const changeLimit = (n) => {
    setLimit(n);
    setPage(1);
  };

  // Keep the address in step with the question, so this exact report can be shared, bookmarked or reloaded.
  useEffect(() => {
    const next = new URLSearchParams();
    if (type) next.set('type', type);
    next.set('range', period.range);
    if (period.from) next.set('from', period.from);
    if (period.to) next.set('to', period.to);
    if (period.branchId) next.set('branchId', period.branchId);
    setParams(next, { replace: true });
  }, [type, period.range, period.from, period.to, period.branchId, setParams]);

  const clear = (key) => {
    if (key === 'type') narrow(setType)('');
    if (key === 'status') narrow(setStatus)('');
    if (key === 'paymentMode') narrow(setPaymentMode)('');
    if (key === 'search') narrow(setSearch)('');
    if (key === 'branchId') narrow(setPeriod)((prev) => ({ ...prev, branchId: '' }));
  };
  // the chip follows what is TYPED, not the debounced copy: clearing the box should drop the chip at once, even though
  // the question itself waits for the typing to settle
  const chips = activeChips(
    { type, status, paymentMode, search, branchId: period.branchId },
    { options, branchName: stores.find((b) => b._id === period.branchId)?.name },
  );

  const onSort = (by) => narrow(setSort)((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  /** The export asks the server the same question, which answers with every matching row — not the page on screen. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportTransactions(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} transaction${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  // A column that could only ever be empty reads as missing data, so the table follows the kind being looked at.
  const plan = columnPlan(type);
  const columns = [
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      render: (r) => (
        <Badge tone={TYPE_TONE[r.type] || 'neutral'}>{r.typeLabel}</Badge>
      ),
    },
    {
      key: 'reference',
      header: 'Reference',
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold">{r.reference}</div>
          {r.secondary && <div className="truncate text-[11px] text-muted">against {r.secondary}</div>}
        </div>
      ),
    },
    { key: 'date', header: 'Date', sortable: true, hideBelow: 'sm', render: (r) => <span className="whitespace-nowrap text-muted">{dateTimeFmt(r.date)}</span> },
    {
      key: 'party',
      header: plan.partyHeader,
      render: (r) => (
        <div className="min-w-0 max-w-[14rem]">
          <div className="truncate font-medium">{r.partyName}</div>
          {r.partyPhone && <div className="truncate text-[11px] text-muted">{r.partyPhone}</div>}
        </div>
      ),
    },
    {
      key: 'branch',
      header: plan.storeHeader,
      hideBelow: 'lg',
      render: (r) => <span className="text-muted">{r.toBranchName ? `${r.branchName || '—'} → ${r.toBranchName}` : r.branchName || '—'}</span>,
    },
    { key: 'units', header: 'Units', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{Number(r.units || 0).toLocaleString('en-IN')}</span> },
    { key: 'tax', header: 'GST', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{r.tax === null ? '—' : inr(r.tax)}</span> },
    {
      key: 'amount',
      header: plan.amountHeader,
      align: 'right',
      sortable: true,
      render: (r) => (
        <div>
          <div className={cx('font-semibold tabular-nums', r.countsAsTrade ? DIRECTION[directionOf(r.type)] : 'text-muted line-through decoration-1')}>{inr(r.amount)}</div>
          {!r.countsAsTrade && <div className="text-[11px] font-medium text-muted">not counted</div>}
          {r.due > 0 && <div className="text-[11px] font-medium text-warning">{inr(r.due)} due</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (r) => {
        const origin = originOf(r);
        return (
          <div className="flex items-center justify-end gap-0.5">
            <button
              type="button"
              aria-label={`View ${r.typeLabel} ${r.reference}`}
              onClick={() => setOpen(r)}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-ink"
            >
              <Eye className="h-4 w-4" />
            </button>
            {origin && (
              <Link
                to={origin.path}
                aria-label={`${origin.label}: ${r.reference}`}
                title={origin.label}
                className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-ink"
              >
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        );
      },
    },
  ];

  const shown = columns.filter(
    (c) => !((c.key === 'type' && !plan.showType) || (c.key === 'party' && !plan.showParty) || (c.key === 'tax' && !plan.showTax)),
  );

  const lines = summaryLines(data);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Daily Transaction Report</h1>
          <p className="mt-1 text-sm text-muted">Every sale, purchase, return and stock movement of the period, in one list.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/analytics" className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle">
            Overview
          </Link>
          <Button variant="secondary" onClick={() => { setRefresh((n) => n + 1); reload(); }} loading={loading && Boolean(data)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
          <Button onClick={exportCsv} loading={exporting} disabled={!data || data.total === 0}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
        </div>
      </header>

      <Card className="space-y-3 p-3 sm:p-4">
        <PeriodFilters value={period} onChange={narrow(setPeriod)} stores={stores} storesLoading={branches.loading} />
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <Select label="Transaction type" className="w-44" value={type} onChange={(e) => narrow(setType)(e.target.value)} disabled={!options}>
            <option value="">All types</option>
            {(options?.types || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select label="Status" className="w-44" value={status} onChange={(e) => narrow(setStatus)(e.target.value)} disabled={!options}>
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
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search transactions" placeholder="Reference, customer, supplier or phone…" />
          </div>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Filter className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => clear(c.key)}
                className="inline-flex items-center gap-1.5 rounded-full bg-sage px-2.5 py-1 text-xs font-semibold text-sage-ink transition-opacity hover:opacity-80"
              >
                <span className="font-normal opacity-70">{c.label}:</span>
                {c.value}
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => chips.forEach((c) => clear(c.key))}
              className="text-xs font-semibold text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="What these filters add up to" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(lines.length ? lines : Array.from({ length: 4 })).map((l, i) =>
              l ? (
                <Card key={l.key} className="p-4">
                  <dl>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">{l.label}</dt>
                    <dd
                      className="mt-1 text-2xl font-bold tabular-nums tracking-tight"
                      aria-label={`${l.label}: ${l.format === 'number' ? Number(l.value).toLocaleString('en-IN') : inr(l.value)}`}
                      title={l.format === 'number' ? undefined : inr(l.value)}
                    >
                      {l.format === 'number' ? Number(l.value).toLocaleString('en-IN') : compactMoney(l.value)}
                    </dd>
                    <dd className="mt-1 text-xs text-muted">{l.hint}</dd>
                  </dl>
                </Card>
              ) : (
                <Skeleton key={i} className="h-28 w-full rounded-2xl" />
              ),
            )}
          </section>

          <Card>
            <DataTable
              columns={shown}
              rows={data?.items || []}
              rowKey={(r) => `${r.type}-${r.id}`}
              loading={loading && !data}
              skeletonRows={8}
              sort={sort}
              onSort={onSort}
              minWidth={1100 - (columns.length - shown.length) * 120}
              empty={
                <EmptyState
                  icon={Receipt}
                  title={chips.length ? 'No transaction matches these filters' : 'Nothing happened in this period'}
                  hint={chips.length ? 'Try a wider period, or clear a filter.' : 'Choose a longer period, or a different store.'}
                  action={
                    chips.length ? (
                      <Button variant="secondary" onClick={() => chips.forEach((c) => clear(c.key))}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
            {data && data.total > 0 && (
              <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} onLimit={changeLimit} limits={[25, 50, 100]} />
            )}
          </Card>

          <p className="px-1 text-[11px] text-muted">
            Filtering, sorting and counting all happen in the database, so these figures describe every matching transaction, not the page on screen. A draft is
            never listed — nothing was issued. A cancelled or rejected document is listed but counts towards nothing. Stock moved between your own stores is
            never a sale or a purchase. Times are shown in {data?.period?.timezone || 'Asia/Kolkata'}.
          </p>
        </>
      )}

      {open && <TransactionDetails row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
