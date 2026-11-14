import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FilterX, Package, Plus, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { medicineService } from '../../services/medicineService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterDropdown, PageHeader, Pagination, SearchInput, StatusBadge, cx, inputCls } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import MedicineForm from '../../components/inventory/MedicineForm';
import MedicineDetails from '../../components/inventory/MedicineDetails';
import InventoryCards from '../../components/inventory/InventoryCards';
import RowActions from '../../components/inventory/RowActions';

const LIMIT = 10;

const stockOptions = [
  { value: 'in_stock', label: 'In Stock' },
  { value: 'low_stock', label: 'Low Stock' },
  { value: 'out_of_stock', label: 'Out of Stock' },
  { value: 'expired', label: 'Expired' },
];

/**
 * All Inventory. Search, filters, sorting and paging are done by the server (GET /api/inventory) and kept in the
 * URL, so a view can be bookmarked or shared. Stock status is calculated by the server from batch data.
 */
export default function Inventory() {
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

  // Search box: typing is debounced into the URL.
  const urlSearch = get('search');
  const [text, setText] = useState(urlSearch);
  const debounced = useDebounced(text);
  useEffect(() => setText(urlSearch), [urlSearch]);
  useEffect(() => {
    if (debounced !== urlSearch) patch({ search: debounced, page: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const page = Number(get('page', '1')) || 1;
  const sort = { by: get('sortBy', 'medicineName'), dir: get('sortDir', 'asc') };
  const query = {
    search: urlSearch,
    categoryId: get('category'),
    manufacturer: get('manufacturer'),
    stock: get('stock'),
    archived: get('archived', 'exclude'),
    sortBy: sort.by,
    sortDir: sort.dir,
    page,
    limit: LIMIT,
  };

  const { data, loading, error, reload } = useFetch('/inventory', query);
  const facets = useFetch('/inventory/facets');
  const filtersActive = Boolean(urlSearch || query.categoryId || query.manufacturer || query.stock || query.archived !== 'exclude');
  const clearFilters = () => {
    setText('');
    setParams({}, { replace: true });
  };

  const [form, setForm] = useState(null); // null | {} (new) | medicine (edit)
  const [details, setDetails] = useState(null); // { id, addBatch }
  const [confirm, setConfirm] = useState(null); // { kind: 'remove' | 'restore', medicine }
  const [working, setWorking] = useState(false);

  // /inventory?new=1 (e.g. from a shortcut) opens the Add Medicine form.
  useEffect(() => {
    if (params.get('new')) {
      setForm({});
      patch({ new: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const onSort = (by) => patch({ sortBy: by, sortDir: sort.by === by && sort.dir === 'asc' ? 'desc' : 'asc', page: '' });

  const runConfirmed = async () => {
    const { kind, medicine } = confirm;
    setWorking(true);
    try {
      if (kind === 'restore') {
        await medicineService.restore(medicine._id);
        toast.success(`${medicine.medicineName} restored`);
      } else {
        const r = await medicineService.remove(medicine._id);
        toast.success(r.deleted ? `${medicine.medicineName} deleted` : `${medicine.medicineName} archived`);
      }
      setConfirm(null);
      reload();
      facets.reload();
    } catch (err) {
      toast.error(err.message);
      setConfirm(null);
    } finally {
      setWorking(false);
    }
  };

  const actions = {
    onView: (m) => setDetails({ id: m._id }),
    onAddBatch: (m) => setDetails({ id: m._id, addBatch: true }),
    onEdit: (m) => setForm(m),
    onRemove: (m) => setConfirm({ kind: 'remove', medicine: m }),
    onRestore: (m) => setConfirm({ kind: 'restore', medicine: m }),
  };

  const dash = <span className="text-muted">—</span>;
  const columns = [
    {
      key: 'medicineName',
      header: 'Medicine',
      sortable: true,
      render: (m) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-semibold">{m.medicineName}</span>
            {m.isActive === false && <StatusBadge status="archived" />}
          </div>
          {(m.strength || m.dosageForm) && <div className="text-xs text-muted">{[m.strength, m.dosageForm].filter(Boolean).join(' · ')}</div>}
        </div>
      ),
    },
    {
      key: 'genericName',
      header: 'Salt / Generic Name',
      sortable: true,
      hideBelow: 'lg',
      render: (m) =>
        m.genericName || m.salt ? (
          <div className="min-w-0">
            <div>{m.genericName || m.salt}</div>
            {m.genericName && m.salt && m.salt !== m.genericName && <div className="text-xs text-muted">{m.salt}</div>}
          </div>
        ) : (
          dash
        ),
    },
    { key: 'manufacturer', header: 'Manufacturer', sortable: true, hideBelow: 'lg', render: (m) => m.manufacturer || dash },
    { key: 'categoryName', header: 'Category', sortable: true, hideBelow: 'lg', render: (m) => m.categoryName || dash },
    {
      key: 'totalStock',
      header: 'Total Stock',
      sortable: true,
      align: 'right',
      render: (m) => (
        <div>
          <span className="font-semibold tabular-nums">{m.totalStock}</span>
          {m.totalStock !== m.availableStock && <div className="text-[11px] text-muted">{m.availableStock} sellable</div>}
          {m.expiredStock > 0 && <div className="text-[11px] font-semibold text-danger">{m.expiredStock} expired</div>}
        </div>
      ),
    },
    { key: 'reorderLevel', header: 'Reorder Level', sortable: true, align: 'right', render: (m) => <span className="tabular-nums text-muted">{m.reorderLevel}</span> },
    { key: 'stockStatus', header: 'Stock Status', sortable: true, render: (m) => <StatusBadge status={m.stockStatus} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', render: (m) => <RowActions m={m} {...actions} /> },
  ];

  const empty = (
    <EmptyState
      icon={Package}
      title={filtersActive ? 'No medicines match your filters' : 'No medicines yet'}
      hint={filtersActive ? 'Try a different search, or clear the filters.' : 'Add your first medicine to start tracking stock.'}
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        ) : (
          <Button onClick={() => setForm({})}>
            <Plus className="h-4 w-4" /> Add Medicine
          </Button>
        )
      }
    />
  );

  const target = confirm?.medicine;
  const hasHistory = target?.batchCount > 0;

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title="All Inventory"
        description="Manage your medicine inventory."
        actions={
          <>
            <Link to="/inventory/import">
              <Button variant="secondary">
                <Upload className="h-4 w-4" /> Import Inventory
              </Button>
            </Link>
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> Add Medicine
            </Button>
          </>
        }
      />

      <Card>
        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3 sm:p-4">
          <SearchInput className="w-full sm:w-80" value={text} onChange={setText} label="Search inventory" placeholder="Search name, salt, manufacturer, SKU or barcode…" />
          <FilterDropdown label="Category" value={query.categoryId} options={(facets.data?.categories || []).map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => patch({ category: v, page: '' })} />
          <FilterDropdown label="Stock status" allLabel="Any" value={query.stock} options={stockOptions} onChange={(v) => patch({ stock: v, page: '' })} />
          <FilterDropdown label="Manufacturer" value={query.manufacturer} options={facets.data?.manufacturers || []} onChange={(v) => patch({ manufacturer: v, page: '' })} />
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            <span className="hidden sm:inline">Show</span>
            <select
              aria-label="Show archived medicines"
              value={query.archived}
              onChange={(e) => patch({ archived: e.target.value === 'exclude' ? '' : e.target.value, page: '' })}
              className={cx(inputCls, 'h-9 w-auto min-w-32 pr-7 text-[13px] text-ink')}
            >
              <option value="exclude">Active only</option>
              <option value="include">Active + archived</option>
              <option value="only">Archived only</option>
            </select>
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
            {/* Table on tablets and desktops */}
            <div className="hidden md:block">
              <DataTable columns={columns} rows={data?.items || []} rowKey={(m) => m._id} loading={loading && !data} sort={sort} onSort={onSort} empty={empty} minWidth={680} />
            </div>
            {/* Cards on phones */}
            <div className="md:hidden">
              <InventoryCards items={data?.items || []} loading={loading && !data} empty={empty} {...actions} />
            </div>
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={(p) => patch({ page: p === 1 ? '' : String(p) })} />}
          </>
        )}
      </Card>

      {form && (
        <MedicineForm
          initial={form._id ? form : null}
          facets={facets.data}
          onClose={() => setForm(null)}
          onDone={(saved, created) => {
            setForm(null);
            reload();
            facets.reload();
            if (created) setDetails({ id: saved._id, addBatch: true });
          }}
        />
      )}
      {details && <MedicineDetails id={details.id} startWithBatch={details.addBatch} onClose={() => setDetails(null)} onChanged={reload} />}

      {confirm && (
        <ConfirmDialog
          danger={confirm.kind === 'remove'}
          title={confirm.kind === 'restore' ? 'Restore medicine?' : hasHistory ? 'Archive medicine?' : 'Delete medicine?'}
          confirmLabel={confirm.kind === 'restore' ? 'Restore' : hasHistory ? 'Archive' : 'Delete'}
          loading={working}
          onConfirm={runConfirmed}
          onClose={() => setConfirm(null)}
          message={
            confirm.kind === 'restore'
              ? `"${target.medicineName}" will be available for sale again.`
              : hasHistory
                ? `"${target.medicineName}" has stock and sales history, so it will be archived instead of deleted. It disappears from the Selling Point and the default list, but its batches, stock history and invoices are kept, and you can restore it at any time.`
                : `"${target.medicineName}" has no stock or sales history and will be permanently deleted. This can't be undone.`
          }
        />
      )}
    </div>
  );
}
