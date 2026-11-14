import { useState } from 'react';
import { Building2, Eye, Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { branchService } from '../../services/branchService';
import { addressText, branchActions } from '../../utils/branchForm';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterDropdown, IconButton, Pagination, SearchInput } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import BranchDetails from '../../components/branches/BranchDetails';
import BranchFormDialog from '../../components/branches/BranchFormDialog';

/**
 * Branches: the organization's stores. Search by name, filter by status, page through them, and — for people who may manage settings — add, edit,
 * activate / deactivate and delete. The default branch can't be deactivated or deleted, and a branch that has stock or transfer history can only be deactivated.
 */
export default function Branches() {
  const { user } = useAuth();
  const canManage = (user?.permissions || []).includes('settings:manage');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [form, setForm] = useState(null); // { branch? }
  const [viewing, setViewing] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'toggle' | 'delete', branch }
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search);
  const { data, loading, error, reload } = useFetch('/branches', { search: q, status, page, limit });

  const run = async () => {
    const { kind, branch } = confirm;
    setBusy(true);
    try {
      if (kind === 'delete') {
        await branchService.remove(branch._id);
        toast.success(`Branch “${branch.name}” deleted`);
      } else {
        const next = branch.status === 'active' ? 'inactive' : 'active';
        await branchService.update(branch._id, { status: next });
        toast.success(`“${branch.name}” ${next === 'active' ? 'activated' : 'deactivated'}`);
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
    { key: 'n', header: '#', render: (b, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span> },
    {
      key: 'name',
      header: 'Branch Name',
      render: (b) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            {b.name} {b.isDefault && <Badge tone="info">Default</Badge>}
          </div>
          <div className="font-mono text-xs text-muted">{b.code}</div>
        </div>
      ),
    },
    { key: 'address', header: 'Address', hideBelow: 'sm', render: (b) => <span className="line-clamp-2 max-w-md text-muted">{addressText(b) || '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (b) => (
        <Badge tone={b.status === 'active' ? 'success' : 'neutral'} dot>
          {b.status === 'active' ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (b) => {
        const a = branchActions(b, canManage);
        return (
          <div className="flex items-center gap-0.5">
            <IconButton label={`View branch ${b.name}`} onClick={() => setViewing(b)}>
              <Eye className="h-4 w-4" />
            </IconButton>
            {a.edit && (
              <IconButton label={`Edit branch ${b.name}`} onClick={() => setForm({ branch: b })}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
            {a.toggle && (
              <IconButton label={`${a.toggleLabel} branch ${b.name}`} onClick={() => setConfirm({ kind: 'toggle', branch: b })}>
                {b.status === 'active' ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
              </IconButton>
            )}
            {a.remove && (
              <IconButton label={`Delete branch ${b.name}`} onClick={() => setConfirm({ kind: 'delete', branch: b })} className="text-danger">
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight">Branches</h1>
            <p className="mt-0.5 text-sm text-muted">Manage your store branches.</p>
          </div>
          {canManage && (
            <Button variant="accent" className="rounded-full px-5" onClick={() => setForm({})}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Add Branch
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
            label="Search branches"
            placeholder="Search by branch name..."
          />
          <FilterDropdown
            label="Status"
            value={status}
            allLabel="All"
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
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
                rowKey={(b) => b._id}
                loading={loading && !data}
                minWidth={560}
                empty={<EmptyState icon={Building2} title="No Branches found" hint="Add a new Branch or adjust the filters to see matching records." />}
              />
              <Pagination
                pageSummary
                limits={[10, 25, 50, 100]}
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

      {form && (
        <BranchFormDialog
          branch={form.branch}
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            if (viewing) setViewing(saved && { ...viewing, ...saved });
            reload();
          }}
        />
      )}
      {viewing && !form && (
        <BranchDetails
          branch={viewing}
          canEdit={canManage}
          onClose={() => setViewing(null)}
          onEdit={(b) => {
            setViewing(null);
            setForm({ branch: b });
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          danger={confirm.kind === 'delete'}
          loading={busy}
          title={confirm.kind === 'delete' ? 'Delete branch?' : `${confirm.branch.status === 'active' ? 'Deactivate' : 'Activate'} branch?`}
          confirmLabel={confirm.kind === 'delete' ? 'Delete' : confirm.branch.status === 'active' ? 'Deactivate' : 'Activate'}
          message={
            confirm.kind === 'delete'
              ? `“${confirm.branch.name}” will be permanently deleted. A branch that holds stock or has transfer history can’t be deleted — deactivate it instead.`
              : confirm.branch.status === 'active'
                ? `“${confirm.branch.name}” will no longer be offered for transfers, orders or stock. Its history is kept.`
                : `“${confirm.branch.name}” will be available again.`
          }
          onConfirm={run}
          onClose={() => !busy && setConfirm(null)}
        />
      )}
    </div>
  );
}
