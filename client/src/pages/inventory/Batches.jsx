import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarX2, FilterX, History, Layers, Pencil, Plus } from 'lucide-react';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { expiryFmt, inr } from '../../utils/format';
import { expiryNote, expiryUrgency } from '../../utils/batchValidation';
import { Button, Card, EmptyState, ErrorState, FilterDropdown, IconButton, PageHeader, Pagination, SearchInput, StatusBadge, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import BatchForm from '../../components/inventory/BatchForm';
import BatchEditForm from '../../components/inventory/BatchEditForm';
import BatchHistory from '../../components/inventory/BatchHistory';
import { useAuth } from '../../context/AuthContext';
import { userCan } from '../../components/layout/nav';

const LIMIT = 10;

const stockOptions = [
  { value: 'in_stock', label: 'In Stock' },
  { value: 'low_stock', label: 'Low Stock' },
  { value: 'out_of_stock', label: 'Out of Stock' },
  { value: 'expired', label: 'Expired' },
  { value: 'quarantined', label: 'Quarantined' },
  { value: 'recalled', label: 'Recalled' },
  { value: 'archived', label: 'Archived' },
];

const expiryOptions = [
  { value: '30', label: 'Within 30 days' },
  { value: '60', label: 'Within 60 days' },
  { value: '90', label: 'Within 90 days' },
  { value: 'expired', label: 'Expired' },
  { value: 'valid', label: 'Not expired' },
];

const urgencyText = { expired: 'text-danger', critical: 'text-danger', soon: 'text-warning', watch: 'text-warning', ok: '', none: 'text-muted' };

/** A clickable expiry-alert counter that applies (or clears) its filter. */
function AlertCard({ icon: Icon, label, hint, batches, units, tone, active, onClick }) {
  const toneCls = { danger: 'bg-danger/10 text-danger', warning: 'bg-warning/10 text-warning', info: 'bg-subtle text-muted' }[tone];
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
        <span className="block text-xl font-bold tabular-nums leading-tight">{batches ?? '—'}</span>
        <span className="block truncate text-[11px] text-muted">{batches === undefined ? hint : `${units} unit${units === 1 ? '' : 's'} · ${hint}`}</span>
      </span>
    </button>
  );
}

/**
 * Inventory Batches. Every batch of every medicine, with server-side search / filters / sorting / paging kept in the URL.
 * Status and expiry are calculated by the server; expired stock is never sellable.
 */
export default function Batches() {
  const { user } = useAuth();
  const canWrite = userCan(user, 'inventory:write');
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
  const sort = { by: get('sortBy', 'expiryDate'), dir: get('sortDir', 'asc') };
  const query = {
    search: urlSearch,
    medicineId: get('medicine'),
    manufacturer: get('manufacturer'),
    branchId: get('store'),
    expiry: get('expiry'),
    stock: get('stock'),
    archived: get('archived', 'exclude'),
    sortBy: sort.by,
    sortDir: sort.dir,
    page,
    limit: LIMIT,
  };
  const { data, loading, error, reload } = useFetch('/batches', query);
  const summary = useFetch('/batches/summary');
  const stores = useFetch('/branches');
  const filtersActive = Boolean(urlSearch || query.medicineId || query.manufacturer || query.branchId || query.expiry || query.stock || query.archived !== 'exclude');
  const clearFilters = () => {
    setText('');
    setParams({}, { replace: true });
  };
  const onSort = (by) => patch({ sortBy: by, sortDir: sort.by === by && sort.dir === 'asc' ? 'desc' : 'asc', page: '' });
  const refresh = () => {
    reload();
    summary.reload();
  };

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);

  const s = summary.data;
  const toggleExpiry = (v) => patch({ expiry: query.expiry === v ? '' : v, page: '' });

  const dash = <span className="text-muted">—</span>;
  const columns = [
    {
      key: 'medicineName',
      header: 'Medicine',
      sortable: true,
      render: (b) => (
        <div className="min-w-0">
          <div className="font-semibold">{b.medicineName || dash}</div>
          {(b.strength || b.dosageForm) && <div className="text-xs text-muted">{[b.strength, b.dosageForm].filter(Boolean).join(' · ')}</div>}
        </div>
      ),
    },
    { key: 'batchNumber', header: 'Batch Number', sortable: true, render: (b) => <span className="font-mono text-[13px] font-medium">{b.batchNumber}</span> },
    { key: 'manufacturer', header: 'Manufacturer', sortable: true, hideBelow: 'lg', render: (b) => b.manufacturer || dash },
    ...((stores.data?.length || 0) > 1 ? [{ key: 'branchName', header: 'Store', hideBelow: 'lg', render: (b) => b.branchName || dash }] : []),
    { key: 'manufacturingDate', header: 'Mfg. Date', sortable: true, hideBelow: 'lg', render: (b) => (b.manufacturingDate ? expiryFmt(b.manufacturingDate) : dash) },
    {
      key: 'expiryDate',
      header: 'Expiry Date',
      sortable: true,
      render: (b) => {
        const u = expiryUrgency(b);
        return (
          <div className="whitespace-nowrap">
            <div className={cx('font-medium', urgencyText[u])}>{expiryFmt(b.expiryDate)}</div>
            {u !== 'none' && u !== 'ok' && <div className={cx('text-[11px] font-semibold', urgencyText[u])}>{expiryNote(b)}</div>}
          </div>
        );
      },
    },
    { key: 'purchasePrice', header: 'Purchase', sortable: true, align: 'right', hideBelow: 'lg', render: (b) => <span className="tabular-nums">{inr(b.purchasePrice)}</span> },
    { key: 'sellingPrice', header: 'Selling', sortable: true, align: 'right', render: (b) => <span className="tabular-nums">{inr(b.sellingPrice)}</span> },
    { key: 'mrp', header: 'MRP', sortable: true, align: 'right', hideBelow: 'md', render: (b) => <span className="tabular-nums">{inr(b.mrp)}</span> },
    {
      key: 'availableQuantity',
      header: 'Available Qty',
      sortable: true,
      align: 'right',
      render: (b) => (
        <div>
          <span className="font-semibold tabular-nums">{b.availableQuantity}</span>
          {b.sellableQuantity !== b.availableQuantity && b.availableQuantity > 0 && <div className="text-[11px] text-muted">{b.sellableQuantity} sellable</div>}
        </div>
      ),
    },
    { key: 'stockStatus', header: 'Status', sortable: true, render: (b) => <StatusBadge status={b.stockStatus} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (b) => (
        <div className="flex justify-end gap-0.5">
          <IconButton label={`View history of batch ${b.batchNumber}`} onClick={() => setHistory(b)}>
            <History className="h-4 w-4" />
          </IconButton>
          {canWrite && (
            <IconButton label={`Edit batch ${b.batchNumber}`} onClick={() => setEditing(b)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      ),
    },
  ];

  const empty = (
    <EmptyState
      icon={Layers}
      title={filtersActive ? 'No batches match your filters' : 'No batches yet'}
      hint={filtersActive ? 'Try a different search, or clear the filters.' : 'Receive stock for a medicine to create its first batch.'}
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        ) : (
          canWrite && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add Batch
            </Button>
          )
        )
      }
    />
  );

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title="Inventory Batch"
        description="Track every received batch, its expiry and its stock history."
        actions={
          canWrite && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add Batch
            </Button>
          )
        }
      />

      {/* Expiry alerts: click one to filter the table to it */}
      <section aria-label="Expiry alerts" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AlertCard icon={CalendarX2} tone="danger" label="Expired" hint="remove from stock" {...s?.expired} active={query.expiry === 'expired'} onClick={() => toggleExpiry('expired')} />
        <AlertCard icon={AlertTriangle} tone="danger" label="Expiring within 30 days" hint="act now" {...s?.within30} active={query.expiry === '30'} onClick={() => toggleExpiry('30')} />
        <AlertCard icon={CalendarClock} tone="warning" label="Expiring within 60 days" hint="plan ahead" {...s?.within60} active={query.expiry === '60'} onClick={() => toggleExpiry('60')} />
        <AlertCard icon={CalendarClock} tone="info" label="Expiring within 90 days" hint="keep watch" {...s?.within90} active={query.expiry === '90'} onClick={() => toggleExpiry('90')} />
      </section>
      <p className="-mt-2 mb-4 text-xs text-muted">Counts include only batches that still have stock. Expired batches are never sold — the Selling Point skips them automatically.</p>

      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3 sm:p-4">
          <SearchInput className="w-full sm:w-80" value={text} onChange={setText} label="Search batches" placeholder="Search medicine or batch number…" />
          <FilterDropdown label="Expiry" allLabel="Any" value={query.expiry} options={expiryOptions} onChange={(v) => patch({ expiry: v, page: '' })} />
          <FilterDropdown label="Manufacturer" value={query.manufacturer} options={s?.manufacturers || []} onChange={(v) => patch({ manufacturer: v, page: '' })} />
          {(stores.data?.length || 0) > 1 && <FilterDropdown label="Store" value={query.branchId} options={stores.data.map((x) => ({ value: x._id, label: x.name }))} onChange={(v) => patch({ store: v, page: '' })} />}
          <FilterDropdown label="Stock status" allLabel="Any" value={query.stock} options={stockOptions} onChange={(v) => patch({ stock: v, page: '' })} />
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            <input type="checkbox" checked={query.archived !== 'exclude'} onChange={(e) => patch({ archived: e.target.checked ? 'include' : '', page: '' })} className="h-4 w-4 accent-[var(--primary)]" />
            Show archived
          </label>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <FilterX className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable columns={columns} rows={data?.items || []} rowKey={(b) => b._id} loading={loading && !data} sort={sort} onSort={onSort} empty={empty} minWidth={880} />
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={(p) => patch({ page: p === 1 ? '' : String(p) })} />}
          </>
        )}
      </Card>

      {adding && (
        <BatchForm
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <BatchEditForm
          batch={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {history && <BatchHistory batch={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
