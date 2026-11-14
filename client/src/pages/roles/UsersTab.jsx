import { useState } from 'react';
import { Pencil, Plus, UserMinus, Users } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Pagination, SearchInput, Select, Skeleton } from '../../components/common/ui';
import UserDialog from '../../components/roles/UserDialog';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { api } from '../../services/api';

/**
 * The users list.
 *
 * There is no delete. Deactivating keeps the record and everything that points at it — invoices, stock movements,
 * audit entries — and ends their sessions, which is what "this person has left" actually means for a pharmacy that
 * has to produce its records years later. The server has no delete route either, so the absence is not cosmetic.
 */
export default function UsersTab() {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const debounced = useDebounced(search, 300);

  const { data, loading, error, reload } = useFetch('/users', { search: debounced || undefined, role: role || undefined, active, page, limit });

  const [editing, setEditing] = useState(null);
  const [deactivating, setDeactivating] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const save = async (body) => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === 'new') await api.post('/users', body);
      else await api.patch(`/users/${editing.id}`, body);
      setEditing(null);
      reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      await api.post(`/users/${deactivating.id}/deactivate`);
      setDeactivating(null);
      reload();
    } catch (e) {
      setFormError(e.message);
      setDeactivating(null);
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.items || [];
  const reset = () => setPage(1);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); reset(); }} placeholder="Search by name or email…" className="w-full sm:max-w-xs" />
        <Select label="" aria-label="Filter by role" value={role} onChange={(e) => { setRole(e.target.value); reset(); }} className="w-full sm:w-44">
          <option value="">All roles</option>
          {(data?.roles || []).map((r) => (
            <option key={r.key} value={r.key}>{r.name}</option>
          ))}
        </Select>
        <Select label="" aria-label="Filter by status" value={active} onChange={(e) => { setActive(e.target.value); reset(); }} className="w-full sm:w-40">
          <option value="all">All</option>
          <option value="active">Active only</option>
          <option value="inactive">Inactive only</option>
        </Select>
        {data?.canCreate && (
          <Button className="sm:ml-auto" onClick={() => { setFormError(null); setEditing('new'); }}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add user
          </Button>
        )}
      </div>

      {formError && !editing && (
        <div role="alert" className="mb-4 rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {formError}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && !data ? (
          <div className="space-y-2 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No users found" hint={search || role || active !== 'all' ? 'Nobody matches those filters.' : 'Add somebody to get started.'} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-subtle/40 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Name</th>
                    <th className="px-4 py-2.5 font-semibold">Role</th>
                    <th className="px-4 py-2.5 font-semibold">Stores</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="border-b border-line last:border-0 hover:bg-subtle/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{u.name}</span>
                          {u.isSelf && <Badge tone="info">You</Badge>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted">{u.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        {u.roleName}
                        {u.roleMissing && <Badge tone="warning">Unknown role</Badge>}
                      </td>
                      <td className="px-4 py-3 text-muted">{u.branchNames.length ? u.branchNames.join(', ') : 'All stores'}</td>
                      <td className="px-4 py-3">
                        <Badge tone={u.isActive ? 'success' : 'neutral'} dot>
                          {u.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                        {u.mustChangePassword && u.isActive && <p className="mt-0.5 text-xs text-muted">Must change password</p>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {u.canEdit && (
                            <IconButton label={`Edit ${u.name}`} onClick={() => { setFormError(null); setEditing(u); }}>
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </IconButton>
                          )}
                          {u.canDeactivate ? (
                            <IconButton label={`Deactivate ${u.name}`} onClick={() => setDeactivating(u)}>
                              <UserMinus className="h-4 w-4 text-danger" aria-hidden="true" />
                            </IconButton>
                          ) : (
                            u.cannotDeactivateReason && <span className="text-xs text-muted" title={u.cannotDeactivateReason}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} onLimit={(l) => { setLimit(l); reset(); }} pageSummary />
          </>
        )}
      </Card>

      {editing && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          roles={data?.roles || []}
          branches={data?.branches || []}
          saving={busy}
          error={formError}
          onSave={save}
          onClose={() => { setEditing(null); setFormError(null); }}
        />
      )}

      {deactivating && (
        <ConfirmDialog
          title={`Deactivate ${deactivating.name}?`}
          message="They will be signed out and will not be able to sign in again. Nothing they have done is removed: their invoices, stock movements and activity entries all stay exactly as they are, and you can make the account active again at any time."
          confirmLabel="Deactivate"
          danger
          loading={busy}
          onConfirm={deactivate}
          onClose={() => setDeactivating(null)}
        />
      )}
    </>
  );
}
