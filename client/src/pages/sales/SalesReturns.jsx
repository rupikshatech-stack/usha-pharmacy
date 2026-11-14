import { useState } from 'react';
import { Banknote, Clock3, Eye, FilterX, Package, Pencil, Plus, RotateCcw, Wallet } from 'lucide-react';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, inr } from '../../utils/format';
import { Button, Card, EmptyState, ErrorState, FilterDropdown, IconButton, Pagination, SearchInput, Skeleton, StatusBadge, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import ProcessReturnDialog from '../../components/sales/ProcessReturnDialog';
import ReturnDetails from '../../components/sales/ReturnDetails';
import { returnActions } from '../../components/sales/ReturnDetails';
import { useAuth } from '../../context/AuthContext';

const TONE = {
  purple: { tile: 'bg-purple-soft text-purple', blob: 'bg-purple-soft' },
  orange: { tile: 'bg-orange-soft text-orange', blob: 'bg-orange-soft' },
  info: { tile: 'bg-info-soft text-info', blob: 'bg-info-soft' },
};

/** A summary card: the number first, then what it is, with the icon and a soft colour glow on the right. */
function ReturnStat({ label, value, hint, icon: Icon, tone, loading }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-card px-5 py-4 shadow-sm">
      <span aria-hidden="true" className={cx('pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full blur-xl', TONE[tone].blob)} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          {loading ? <Skeleton className="h-8 w-24" /> : <div className="truncate text-2xl font-extrabold leading-tight tracking-tight tabular-nums">{value}</div>}
          <div className="mt-1 text-sm font-medium text-muted">{label}</div>
          {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
        </div>
        <span className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-xl', TONE[tone].tile)}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

/** Sales Returns: summary cards, then every return with search, reason and status filters, a table and paging. */
export default function SalesReturns() {
  const { user } = useAuth();
  const permissions = user?.permissions || [];
  const canProcess = permissions.includes('billing:create');
  // The Daily Transaction Report links here with ?search=<reference>, so a row opens its own document. Read once.
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') || '');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(null); // { id, action }
  const [starting, setStarting] = useState(false);
  const q = useDebounced(search);

  const meta = useFetch('/sales-returns/meta');
  const summary = useFetch('/sales-returns/summary');
  const { data, loading, error, reload } = useFetch('/sales-returns', {
    search: q,
    reason,
    status,
    page,
    limit,
  });
  const filtersActive = Boolean(q || reason || status);
  const clear = () => {
    setSearch('');
    setReason('');
    setStatus('');
    setPage(1);
  };
  const s = summary.data;

  const columns = [
    {
      key: 'n',
      header: '#',
      render: (r, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span>,
    },
    {
      key: 'returnNo',
      header: 'Return ID',
      render: (r) => <span className="font-mono font-semibold">{r.returnNo}</span>,
    },
    {
      key: 'invoice',
      header: 'Original Invoice',
      hideBelow: 'md',
      render: (r) => <span className="font-mono text-[13px]">{r.invoiceNo}</span>,
    },
    {
      key: 'customer',
      header: 'Customer Info',
      render: (r) => (
        <div>
          <div className="font-medium">{r.customer?.name}</div>
          <div className="text-xs text-muted">{r.customer?.phone || 'No phone number'}</div>
        </div>
      ),
    },
    {
      key: 'value',
      header: 'Return Value',
      align: 'right',
      render: (r) => (
        <div>
          <div className="font-semibold tabular-nums">{inr(r.refundAmount)}</div>
          <div className="text-xs text-muted">
            {r.units} unit{r.units === 1 ? '' : 's'}
          </div>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      hideBelow: 'sm',
      render: (r) => r.reasonLabel,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => {
        const can = returnActions(r, permissions);
        return (
          <div className="flex items-center gap-0.5">
            <IconButton label={`View return ${r.returnNo}`} onClick={() => setOpen({ id: r._id })}>
              <Eye className="h-4 w-4" />
            </IconButton>
            {can.edit && (
              <IconButton label={`Edit return ${r.returnNo}`} onClick={() => setOpen({ id: r._id, action: 'edit' })}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
            {can.refund && (
              <IconButton label={`Process refund for ${r.returnNo}`} onClick={() => setOpen({ id: r._id, action: 'refund' })}>
                <Banknote className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      {summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : (
        <section aria-label="Returns summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <ReturnStat label="Total Refunded" icon={Wallet} tone="purple" loading={!s} value={s && inr(s.totalRefunded)} />
          <ReturnStat
            label="Returns Processed"
            icon={RotateCcw}
            tone="orange"
            loading={!s}
            value={s && s.returnsProcessed.toLocaleString('en-IN')}
            hint={s && `${s.totalReturns.toLocaleString('en-IN')} return${s.totalReturns === 1 ? '' : 's'} in total`}
          />
          <ReturnStat label="Items Restocked" icon={Package} tone="purple" loading={!s} value={s && s.itemsRestocked.toLocaleString('en-IN')} />
          <ReturnStat label="Pending Refunds" icon={Clock3} tone="info" loading={!s} value={s && inr(s.pendingRefunds)} hint={s && `${s.pendingCount} awaiting processing`} />
        </section>
      )}

      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Sales Returns</h1>
            <p className="mt-0.5 text-sm text-muted">Manage customer returns, restock inventory, and process refunds.</p>
          </div>
          {canProcess && (
            <Button variant="accent" size="lg" className="rounded-full px-5" onClick={() => setStarting(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Process New Return
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-5">
          <SearchInput
            className="w-full sm:w-80"
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            label="Search returns"
            placeholder="Search Return ID, Invoice # or Customer…"
          />
          <FilterDropdown
            label="Reason"
            allLabel="All"
            value={reason}
            options={meta.data?.reasons || []}
            onChange={(v) => {
              setReason(v);
              setPage(1);
            }}
          />
          <FilterDropdown
            label="Status"
            allLabel="All"
            value={status}
            options={meta.data?.statuses || []}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
          />
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clear}>
              <FilterX className="h-3.5 w-3.5" /> Clear filters
            </Button>
          )}
        </div>

        <div className="border-t border-line">
          {error ? (
            <ErrorState
              message={error}
              onRetry={() => {
                reload();
                summary.reload();
              }}
            />
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={data?.items || []}
                rowKey={(r) => r._id}
                loading={loading && !data}
                minWidth={760}
                empty={<EmptyState icon={RotateCcw} title="No sales returns found" hint="Process a new return or adjust your filters." />}
              />
              <Pagination
                pageSummary
                page={data?.page || 1}
                pages={data?.pages || 1}
                total={data?.total || 0}
                limit={limit}
                onPage={setPage}
                onLimit={(n) => {
                  setLimit(n);
                  setPage(1);
                }}
              />
            </>
          )}
        </div>
      </Card>

      {open && (
        <ReturnDetails
          id={open.id}
          initialAction={open.action}
          permissions={permissions}
          onChanged={() => {
            reload();
            summary.reload();
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {starting && (
        <ProcessReturnDialog
          onClose={() => setStarting(false)}
          onDone={() => {
            setStarting(false);
            setPage(1);
            reload();
            summary.reload();
          }}
        />
      )}
    </div>
  );
}
