import { useState } from 'react';
import { Eye, Pencil, Plus, Power, PowerOff, Star, StarOff, Trash2, Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt } from '../../utils/format';
import { supplierService } from '../../services/supplierService';
import { SUPPLIER_TYPES } from '../../utils/supplierForm';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterDropdown, IconButton, Pagination, SearchInput } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import SupplierDetails from '../../components/suppliers/SupplierDetails';
import SupplierFormDialog from '../../components/suppliers/SupplierFormDialog';

/**
 * Suppliers: the companies stock is bought from. Search by company, code, GST, contact person, phone or email; filter by status and type; page through them;
 * and — for people who may change inventory — add, edit, mark preferred and activate or deactivate. Deleting needs the settings permission and is refused once
 * a supplier has any purchasing history: deactivating keeps the history and takes them out of new orders.
 */
export default function Suppliers() {
  const { user } = useAuth();
  const permissions = user?.permissions || [];
  const canWrite = permissions.includes('inventory:write');
  const canDelete = permissions.includes('settings:manage');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [preferred, setPreferred] = useState('');
  const [sort, setSort] = useState({ by: '', dir: 'asc' }); // no sort = preferred first, then A to Z (what the server does by default)
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [form, setForm] = useState(null); // { supplier? }
  const [viewing, setViewing] = useState(null); // supplier id
  const [confirm, setConfirm] = useState(null); // { kind, supplier }
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search);
  const { data, loading, error, reload } = useFetch('/suppliers', {
    search: q, active: status || 'all', type: type || undefined, preferred: preferred || undefined, sort: sort.by || undefined, dir: sort.by ? sort.dir : undefined, page, limit,
  });
  /** Clicking a column sorts by it, and clicking it again turns the order around. The database does the sorting, so it covers every page, not just this one. */
  const onSort = (by) => {
    setSort((s0) => ({ by, dir: s0.by === by && s0.dir === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  };
  const reset = (fn) => (v) => {
    fn(v);
    setPage(1);
  };

  const run = async () => {
    const { kind, supplier: s } = confirm;
    setBusy(true);
    try {
      if (kind === 'delete') {
        await supplierService.remove(s._id);
        toast.success(`Supplier “${s.name}” deleted`);
      } else if (kind === 'status') {
        const next = s.isActive === false ? 'active' : 'inactive';
        await supplierService.setStatus(s._id, next);
        toast.success(`“${s.name}” ${next === 'active' ? 'activated' : 'deactivated'}`);
      } else {
        await supplierService.setPreferred(s._id, !s.isPreferred);
        toast.success(s.isPreferred ? `“${s.name}” is no longer preferred` : `“${s.name}” marked as preferred`);
      }
      setConfirm(null);
      reload();
    } catch (e) {
      toast.error(e.message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'n', header: '#', render: (s, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span> },
    {
      key: 'name',
      header: 'Company Name',
      sortable: true,
      sortKey: 'name',
      render: (s) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            {s.name}
            {s.isActive === false && <Badge tone="neutral">Inactive</Badge>}
          </div>
          <div className="text-xs text-muted">
            {s.code || '—'}
            {s.typeLabel ? ` · ${s.typeLabel}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'supplierType', header: 'Type', hideBelow: 'lg', sortable: true, sortKey: 'supplierType', render: (s) => s.typeLabel || '—' },
    { key: 'created', header: 'Added', hideBelow: 'lg', sortable: true, sortKey: 'createdAt', render: (s) => <span className="text-muted">{s.createdAt ? dateFmt(s.createdAt) : '—'}</span> },
    { key: 'updated', header: 'Last Updated', hideBelow: 'lg', sortable: true, sortKey: 'updatedAt', render: (s) => <span className="text-muted">{s.updatedAt ? dateFmt(s.updatedAt) : '—'}</span> },
    { key: 'gstin', header: 'GST Number', hideBelow: 'md', render: (s) => <span className="font-mono text-xs">{s.gstin || '—'}</span> },
    { key: 'contact', header: 'Contact Person', hideBelow: 'sm', render: (s) => s.contactPerson || '—' },
    {
      key: 'phone',
      header: 'Phone',
      hideBelow: 'sm',
      render: (s) =>
        s.phone ? (
          <a href={`tel:${s.phone}`} className="hover:text-accent">
            {s.phone}
          </a>
        ) : (
          '—'
        ),
    },
    {
      key: 'preferred',
      header: 'Preferred',
      render: (s) =>
        s.isPreferred ? (
          <Badge tone="warning">
            <Star className="mr-1 inline h-3 w-3" aria-hidden="true" />
            Preferred
          </Badge>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <div className="flex items-center gap-1">
          <IconButton label={`View supplier ${s.name}`} onClick={() => setViewing(s._id)}>
            <Eye className="h-4 w-4" />
          </IconButton>
          {canWrite && (
            <>
              <IconButton label={`Edit supplier ${s.name}`} onClick={() => setForm({ supplier: s })}>
                <Pencil className="h-4 w-4" />
              </IconButton>
              <IconButton label={s.isPreferred ? `Remove preferred from ${s.name}` : `Mark ${s.name} as preferred`} onClick={() => setConfirm({ kind: 'preferred', supplier: s })}>
                {s.isPreferred ? <StarOff className="h-4 w-4" /> : <Star className="h-4 w-4" />}
              </IconButton>
              <IconButton label={s.isActive === false ? `Activate ${s.name}` : `Deactivate ${s.name}`} onClick={() => setConfirm({ kind: 'status', supplier: s })}>
                {s.isActive === false ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
              </IconButton>
            </>
          )}
          {canDelete && (
            <IconButton label={`Delete supplier ${s.name}`} onClick={() => setConfirm({ kind: 'delete', supplier: s })} className="text-danger">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      ),
    },
  ];

  const ask = confirm && {
    delete: {
      title: 'Delete this supplier?',
      message: `“${confirm.supplier.name}” will be removed. A supplier with purchase orders, goods receipts or invoices cannot be deleted — deactivate it instead and its history is kept.`,
      confirmLabel: 'Delete supplier',
      danger: true,
    },
    status: {
      title: confirm.supplier.isActive === false ? 'Activate this supplier?' : 'Deactivate this supplier?',
      message:
        confirm.supplier.isActive === false
          ? `“${confirm.supplier.name}” will be offered again on new purchase orders.`
          : `“${confirm.supplier.name}” will stop being offered on new purchase orders. Everything already recorded stays exactly as it is, and you can activate them again at any time.`,
      confirmLabel: confirm.supplier.isActive === false ? 'Activate' : 'Deactivate',
      danger: confirm.supplier.isActive !== false,
    },
    preferred: {
      title: confirm.supplier.isPreferred ? 'Remove the preferred mark?' : 'Mark as preferred?',
      message: confirm.supplier.isPreferred
        ? `“${confirm.supplier.name}” will no longer be listed first.`
        : `“${confirm.supplier.name}” will be marked and listed first when buying.`,
      confirmLabel: confirm.supplier.isPreferred ? 'Remove preferred' : 'Mark as preferred',
      danger: false,
    },
  }[confirm.kind];

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Suppliers</h1>
            <p className="mt-0.5 text-sm text-muted">Manage your product suppliers, contact details, and procurement preferences.</p>
          </div>
          {canWrite && (
            <Button variant="accent" className="rounded-full px-5" onClick={() => setForm({})}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Add Supplier
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-5">
          <SearchInput className="w-full sm:w-80" value={search} onChange={reset(setSearch)} label="Search suppliers" placeholder="Search by company, GST, or contact..." />
          <FilterDropdown
            label="Status"
            value={status}
            allLabel="All"
            onChange={reset(setStatus)}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
          <FilterDropdown label="Type" value={type} allLabel="All" onChange={reset(setType)} options={SUPPLIER_TYPES} />
          <FilterDropdown
            label="Preferred"
            value={preferred}
            allLabel="All"
            onChange={reset(setPreferred)}
            options={[
              { value: 'true', label: 'Preferred only' },
              { value: 'false', label: 'Not preferred' },
            ]}
          />
        </div>

        <div className="border-t border-line">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={data?.items || []}
                rowKey={(s) => s._id}
                loading={loading && !data}
                sort={sort.by ? sort : undefined}
                onSort={onSort}
                minWidth={760}
                empty={<EmptyState icon={Truck} title="No suppliers found" hint="Add a new supplier or adjust the filters to see matching records." />}
              />
              <Pagination pageSummary limits={[10, 25, 50, 100]} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
            </>
          )}
        </div>
      </Card>

      {form && (
        <SupplierFormDialog
          supplier={form.supplier}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            reload();
          }}
        />
      )}
      {viewing && (
        <SupplierDetails
          supplierId={viewing}
          onClose={() => setViewing(null)}
          onEdit={(s) => {
            setViewing(null);
            setForm({ supplier: s });
          }}
        />
      )}
      {confirm && ask && <ConfirmDialog title={ask.title} message={ask.message} confirmLabel={ask.confirmLabel} danger={ask.danger} loading={busy} onConfirm={run} onClose={() => !busy && setConfirm(null)} />}
    </div>
  );
}
