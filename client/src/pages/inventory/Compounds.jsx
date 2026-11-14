import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, FilterX, FlaskConical, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { compoundService } from '../../services/catalogService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterDropdown, IconButton, PageHeader, Pagination, SearchInput } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import CompoundForm from '../../components/inventory/CompoundForm';
import CompoundMedicines from '../../components/inventory/CompoundMedicines';
import { useAuth } from '../../context/AuthContext';
import { userCan } from '../../components/layout/nav';

const LIMIT = 10;

/** All Compounds: search, add, edit, link to medicines, and delete (if unused) or archive. State lives in the URL. */
export default function Compounds() {
  const { user } = useAuth();
  const canWrite = userCan(user, 'inventory:write');
  const canDelete = userCan(user, 'inventory:delete');
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
  const status = get('status');
  const { data, loading, error, reload } = useFetch('/compounds', { search: urlSearch, status, page, limit: LIMIT });
  const filtersActive = Boolean(urlSearch || status);
  const clearFilters = () => {
    setText('');
    setParams({}, { replace: true });
  };

  const [form, setForm] = useState(null); // {} (new) | compound (edit)
  const [linking, setLinking] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'archive' | 'restore', compound }
  const [working, setWorking] = useState(false);

  const runConfirmed = async () => {
    const { kind, compound } = confirm;
    setWorking(true);
    try {
      if (kind === 'delete') {
        await compoundService.remove(compound._id);
        toast.success(`"${compound.compoundName}" deleted`);
      } else {
        await compoundService.update(compound._id, { status: kind === 'archive' ? 'inactive' : 'active' });
        toast.success(`"${compound.compoundName}" ${kind === 'archive' ? 'archived' : 'restored'}`);
      }
      setConfirm(null);
      reload();
    } catch (e) {
      toast.error(e.message);
      setConfirm(null);
      if (e.code === 'IN_USE') reload();
    } finally {
      setWorking(false);
    }
  };

  const dash = <span className="text-muted">—</span>;
  const columns = [
    {
      key: 'compoundName',
      header: 'Compound',
      render: (c) => (
        <div className="min-w-0">
          <div className="font-semibold">{c.compoundName}</div>
          {c.description && <div className="max-w-md truncate text-xs text-muted">{c.description}</div>}
        </div>
      ),
    },
    { key: 'composition', header: 'Composition', hideBelow: 'md', render: (c) => c.composition || dash },
    {
      key: 'medicineCount',
      header: 'Linked Medicines',
      align: 'right',
      render: (c) => (
        <button type="button" onClick={() => setLinking(c)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold tabular-nums hover:bg-subtle" aria-label={`View the ${c.medicineCount} medicines linked to ${c.compoundName}`}>
          <Link2 className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> {c.medicineCount}
        </button>
      ),
    },
    { key: 'status', header: 'Status', render: (c) => <Badge tone={c.status === 'active' ? 'success' : 'neutral'} dot>{c.status === 'active' ? 'Active' : 'Archived'}</Badge> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (c) => (
        <div className="flex justify-end gap-0.5">
          <IconButton label={`Medicines of ${c.compoundName}`} onClick={() => setLinking(c)}>
            <Link2 className="h-4 w-4" />
          </IconButton>
          {canWrite && (
            <>
              <IconButton label={`Edit ${c.compoundName}`} onClick={() => setForm(c)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
              {c.status === 'active' ? (
                <IconButton label={`Archive ${c.compoundName}`} onClick={() => setConfirm({ kind: 'archive', compound: c })}>
                  <Archive className="h-4 w-4" />
                </IconButton>
              ) : (
                <IconButton label={`Restore ${c.compoundName}`} onClick={() => setConfirm({ kind: 'restore', compound: c })}>
                  <ArchiveRestore className="h-4 w-4" />
                </IconButton>
              )}
            </>
          )}
          {canDelete && c.medicineCount === 0 && (
            <IconButton label={`Delete ${c.compoundName}`} onClick={() => setConfirm({ kind: 'delete', compound: c })}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      ),
    },
  ];

  const empty = (
    <EmptyState
      icon={FlaskConical}
      title={filtersActive ? 'No compounds match your filters' : 'No compounds yet'}
      hint={filtersActive ? 'Try a different search, or clear the filters.' : 'Add a compound, then link the medicines that contain it.'}
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        ) : (
          canWrite && (
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> Add Compound
            </Button>
          )
        )
      }
    />
  );

  const target = confirm?.compound;
  const copy = {
    delete: { title: 'Delete compound?', label: 'Delete', danger: true, message: `"${target?.compoundName}" is not linked to any medicine and will be permanently deleted. This can't be undone.` },
    archive: { title: 'Archive compound?', label: 'Archive', danger: false, message: `"${target?.compoundName}" will be hidden from new medicines${target?.medicineCount ? `. The ${target.medicineCount} medicine(s) already linked keep it` : ''}. You can restore it at any time.` },
    restore: { title: 'Restore compound?', label: 'Restore', danger: false, message: `"${target?.compoundName}" will be available for medicines again.` },
  }[confirm?.kind || 'delete'];

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title="All Compound"
        description="Formulations your medicines are made of."
        actions={
          canWrite && (
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> Add Compound
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3 sm:p-4">
          <SearchInput className="w-full sm:w-80" value={text} onChange={setText} label="Search compounds" placeholder="Search name or composition…" />
          <FilterDropdown label="Status" allLabel="Any" value={status} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Archived' }]} onChange={(v) => patch({ status: v, page: '' })} />
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
            <DataTable columns={columns} rows={data?.items || []} rowKey={(c) => c._id} loading={loading && !data} empty={empty} minWidth={640} />
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={(p) => patch({ page: p === 1 ? '' : String(p) })} />}
          </>
        )}
      </Card>

      {form && (
        <CompoundForm
          initial={form._id ? form : null}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            reload();
          }}
        />
      )}
      {linking && <CompoundMedicines compound={linking} canWrite={canWrite} onChanged={reload} onClose={() => setLinking(null)} />}
      {confirm && <ConfirmDialog danger={copy.danger} title={copy.title} confirmLabel={copy.label} message={copy.message} loading={working} onConfirm={runConfirmed} onClose={() => setConfirm(null)} />}
    </div>
  );
}
