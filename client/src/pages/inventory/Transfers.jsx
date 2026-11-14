import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, Ban, PackageCheck, CheckCircle2, Clock, Eye, FilterX, Pencil, Plus, Printer, Store, Trash2, Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { transferService } from '../../services/transferService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { STATUS_LABEL, allowed, removeAction } from '../../utils/transferValidation';
import { dateFmt } from '../../utils/format';
import { Button, Card, EmptyState, ErrorState, FilterDropdown, IconButton, PageHeader, Pagination, SearchInput, Skeleton, StatusBadge, cx, inputCls } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import TransferForm from '../../components/inventory/TransferForm';
import TransferDetails from '../../components/inventory/TransferDetails';
import TransferActionDialog from '../../components/inventory/TransferActionDialog';
import TransferDocument from '../../components/inventory/TransferDocument';
import TransferDispatchDialog from '../../components/inventory/TransferDispatchDialog';
import TransferReceiveDialog from '../../components/inventory/TransferReceiveDialog';
import StoresManager from '../../components/inventory/StoresManager';
import { useAuth } from '../../context/AuthContext';
import { userCan } from '../../components/layout/nav';

const LIMITS = [10, 25, 50];
const statusOptions = ['draft', 'submitted', 'approved', 'partially_dispatched', 'in_transit', 'partially_received', 'completed', 'rejected', 'cancelled'].map((value) => ({ value, label: STATUS_LABEL[value] }));

/** A summary card that also filters the list (click it again to remove the filter). */
function SummaryCard({ icon: Icon, label, value, hint, tone, active, onClick }) {
  const toneCls = { neutral: 'bg-subtle text-muted', warning: 'bg-warning/10 text-warning', info: 'bg-sage text-sage-ink', success: 'bg-success/10 text-success' }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx('flex items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', active ? 'border-primary ring-1 ring-primary/30' : 'border-line')}
    >
      <span className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-lg', toneCls)}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-muted">{label}</span>
        <span className="block text-xl font-bold tabular-nums leading-tight">{value ?? <Skeleton className="mt-1 h-6 w-10" />}</span>
        <span className="block truncate text-[11px] text-muted">{hint}</span>
      </span>
    </button>
  );
}

/**
 * Inter Store Transfer. Search, filters, paging and the summary cards come from the server; the filters are kept in the URL.
 * A transfer is a draft, then submitted (for approval when required), approved, dispatched (stock leaves the source store, in
 * transit) and received (stock enters the destination store).
 */
export default function Transfers() {
  const { user } = useAuth();
  const permissions = user?.permissions || [];
  const canManage = userCan(user, 'transfer:create') || userCan(user, 'transfer:manage');
  const canStores = userCan(user, 'settings:manage');
  const [params, setParams] = useSearchParams();
  const get = (k, d = '') => params.get(k) || d;
  const patch = (changes) =>
    setParams(
      () => {
        // Start from the URL as it is right now: a fast click after another change must not revive a filter that was just cleared.
        const n = new URLSearchParams(window.location.search);
        Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k)));
        return n;
      },
      { replace: true },
    );

  const urlSearch = get('search');
  const [text, setText] = useState(urlSearch);
  const debounced = useDebounced(text);
  useEffect(() => setText(urlSearch), [urlSearch]);
  useEffect(() => {
    if (debounced !== urlSearch) patch({ search: debounced, page: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const page = Number(get('page', '1')) || 1;
  const limit = LIMITS.includes(Number(get('limit'))) ? Number(get('limit')) : 10;
  const dateFrom = get('dateFrom');
  const dateTo = get('dateTo');
  const rangeError = dateFrom && dateTo && dateFrom > dateTo ? 'The end date must not be before the start date.' : '';
  const query = { search: urlSearch, status: get('status'), fromBranchId: get('from'), toBranchId: get('to'), dateFrom: rangeError ? '' : dateFrom, dateTo: rangeError ? '' : dateTo, page, limit };
  const { data, loading, error, reload } = useFetch('/transfers', query);
  const summary = useFetch('/transfers/summary');
  const stores = useFetch('/branches');
  const settings = useFetch('/transfers/settings');
  const filtersActive = Boolean(urlSearch || query.status || query.fromBranchId || query.toBranchId || dateFrom || dateTo);
  const clearFilters = () => {
    setText('');
    setParams(limit === 10 ? {} : { limit: String(limit) }, { replace: true });
  };
  const refresh = () => {
    reload();
    summary.reload();
    stores.reload();
    settings.reload();
  };

  const [form, setForm] = useState(null); // {} (new) | transfer (edit a draft)
  const [viewing, setViewing] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [managing, setManaging] = useState(false);
  const [acting, setActing] = useState(null); // { transfer, action } for the row actions (delete / cancel)
  const [dispatching, setDispatching] = useState(null); // transfer id: the dispatch screen
  const [receiving, setReceiving] = useState(null); // transfer id: the receiving screen

  const storeOptions = (stores.data || []).map((s) => ({ value: s._id, label: s.name }));
  const s = summary.data;
  const cardFilter = (status) => patch({ status: query.status === status ? '' : status, page: '' });

  const edit = async (row) => {
    try {
      setForm(await transferService.get(row._id)); // the list carries no lines, so load the full draft
    } catch (e) {
      toast.error(e.message);
    }
  };

  const columns = [
    { key: 'n', header: 'Serial Number', className: 'w-24 text-muted', render: (_t, i) => (page - 1) * limit + i + 1 },
    { key: 'reference', header: 'Reference Number', render: (t) => <span className="font-semibold">{t.reference}</span> },
    { key: 'from', header: 'From Store', render: (t) => t.fromBranch.name },
    { key: 'to', header: 'To Store', render: (t) => t.toBranch.name },
    { key: 'items', header: 'Number of Items', align: 'right', render: (t) => <span className="tabular-nums">{t.itemCount}</span> },
    { key: 'date', header: 'Transfer Date', render: (t) => <span className="whitespace-nowrap">{dateFmt(t.transferDate)}</span> },
    { key: 'by', header: 'Created By', hideBelow: 'md', render: (t) => t.createdByName },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={t.status} />
          {t.hasDiscrepancy && (
            <span title={`${t.discrepancyUnits} unit(s) reported damaged or missing`} className="text-warning">
              <AlertTriangle className="h-4 w-4" aria-label="Discrepancy reported" />
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (t) => {
        const removal = removeAction(t.status);
        return (
          <div className="flex gap-0.5">
            <IconButton label={`View transfer ${t.reference}`} onClick={() => setViewing(t._id)}>
              <Eye className="h-4 w-4" />
            </IconButton>
            {allowed(permissions, t.status, 'dispatch') && (
              <IconButton label={`Dispatch transfer ${t.reference}`} onClick={() => setDispatching(t._id)}>
                <Truck className="h-4 w-4" />
              </IconButton>
            )}
            {allowed(permissions, t.status, 'receive') && (
              <IconButton label={`Receive transfer ${t.reference}`} onClick={() => setReceiving(t._id)}>
                <PackageCheck className="h-4 w-4" />
              </IconButton>
            )}
            {allowed(permissions, t.status, 'edit') && (
              <IconButton label={`Edit transfer ${t.reference}`} onClick={() => edit(t)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
            {removal && allowed(permissions, t.status, removal) && (
              <IconButton label={`${removal === 'delete' ? 'Delete' : 'Cancel'} transfer ${t.reference}`} onClick={() => setActing({ transfer: t, action: removal })}>
                {removal === 'delete' ? <Trash2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
              </IconButton>
            )}
            <IconButton label={`Print transfer ${t.reference}`} onClick={() => setPrinting(t._id)}>
              <Printer className="h-4 w-4" />
            </IconButton>
          </div>
        );
      },
    },
  ];

  const empty = (
    <EmptyState
      icon={ArrowLeftRight}
      title={filtersActive ? 'No transfers match your filters' : 'No transfers yet'}
      hint={filtersActive ? 'Try a different search, or clear the filters.' : 'Create a transfer to move stock from one store to another.'}
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        ) : (
          canManage && (
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> New Transfer
            </Button>
          )
        )
      }
    />
  );

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title="Inter Store Transfer"
        description="Manage medicine stock transfers between your branches."
        actions={
          <>
            <Button variant="secondary" onClick={() => setManaging(true)}>
              <Store className="h-4 w-4" /> {canStores ? 'Manage stores' : 'Stores'}
            </Button>
            {canManage && (
              <Button onClick={() => setForm({})}>
                <Plus className="h-4 w-4" /> New Transfer
              </Button>
            )}
          </>
        }
      />

      <section aria-label="Transfer summary" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={ArrowLeftRight} tone="neutral" label="Total Transfers" value={s?.total} hint="all transfers" active={!query.status} onClick={() => patch({ status: '', page: '' })} />
        <SummaryCard icon={Clock} tone="warning" label="Pending Transfers" value={s?.pending} hint={settings.data?.approvalRequired ? 'awaiting approval or dispatch' : 'approved, awaiting dispatch'} active={query.status === 'pending'} onClick={() => cardFilter('pending')} />
        <SummaryCard icon={Truck} tone="info" label="In Transit" value={s?.inTransit} hint="dispatched, not yet received" active={query.status === 'transit'} onClick={() => cardFilter('transit')} />
        <SummaryCard icon={CheckCircle2} tone="success" label="Completed Transfers" value={s?.completed} hint="received at the destination" active={query.status === 'completed'} onClick={() => cardFilter('completed')} />
      </section>

      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3 sm:p-4">
          <SearchInput className="w-full sm:w-72" value={text} onChange={setText} label="Search transfers" placeholder="Search reference number…" />
          <FilterDropdown label="From store" allLabel="Any" value={query.fromBranchId} options={storeOptions} onChange={(v) => patch({ from: v, page: '' })} />
          <FilterDropdown label="To store" allLabel="Any" value={query.toBranchId} options={storeOptions} onChange={(v) => patch({ to: v, page: '' })} />
          <FilterDropdown label="Status" allLabel="Any" value={['pending', 'transit'].includes(get('status')) ? '' : query.status} options={statusOptions} onChange={(v) => patch({ status: v, page: '' })} />
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            <span className="hidden sm:inline">From date</span>
            <input type="date" aria-label="From date" value={dateFrom} max={dateTo || undefined} onChange={(e) => patch({ dateFrom: e.target.value, page: '' })} className={cx(inputCls, 'h-9 w-auto text-[13px] text-ink', rangeError && 'border-danger')} />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            <span className="hidden sm:inline">To date</span>
            <input type="date" aria-label="To date" value={dateTo} min={dateFrom || undefined} onChange={(e) => patch({ dateTo: e.target.value, page: '' })} className={cx(inputCls, 'h-9 w-auto text-[13px] text-ink', rangeError && 'border-danger')} />
          </label>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <FilterX className="h-3.5 w-3.5" /> Clear filters
            </Button>
          )}
          {get('status') === 'pending' && <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning">Showing pending transfers</span>}
          {get('status') === 'transit' && <span className="rounded-full bg-warning/10 px-2.5 py-0.5 text-xs font-semibold text-warning">Showing transfers in transit</span>}
          {rangeError && <p role="alert" className="w-full text-xs text-danger">{rangeError}</p>}
        </div>

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable columns={columns} rows={data?.items || []} rowKey={(t) => t._id} loading={loading && !data} empty={empty} minWidth={860} />
            {data && data.total > 0 && (
              <Pagination
                page={data.page}
                pages={data.pages}
                total={data.total}
                limit={limit}
                limits={LIMITS}
                onPage={(p) => patch({ page: p === 1 ? '' : String(p) })}
                onLimit={(n) => patch({ limit: n === 10 ? '' : String(n), page: '' })}
              />
            )}
          </>
        )}
      </Card>

      {form && stores.data && (
        <TransferForm
          initial={form._id ? form : null}
          stores={stores.data}
          onClose={() => setForm(null)}
          onDone={(saved) => {
            setForm(null);
            refresh();
            setViewing(saved._id);
          }}
        />
      )}
      {viewing && (
        <TransferDetails
          id={viewing}
          permissions={permissions}
          onChanged={refresh}
          onEdit={(t) => {
            setViewing(null);
            setForm(t);
          }}
          onPrint={(t) => setPrinting(t._id)}
          onClose={() => setViewing(null)}
        />
      )}
      {printing && <TransferDocument id={printing} onClose={() => setPrinting(null)} />}
      {receiving && (
        <TransferReceiveDialog
          id={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            refresh();
          }}
        />
      )}
      {dispatching && (
        <TransferDispatchDialog
          id={dispatching}
          onClose={() => setDispatching(null)}
          onDone={() => {
            setDispatching(null);
            refresh();
          }}
        />
      )}
      {managing && stores.data && <StoresManager stores={stores.data} canManage={canStores} onChanged={refresh} onClose={() => setManaging(false)} />}
      {acting && (
        <TransferActionDialog
          transfer={acting.transfer}
          action={acting.action}
          settings={settings.data || {}}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
