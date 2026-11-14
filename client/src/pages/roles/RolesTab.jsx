import { useState } from 'react';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, Pagination, SearchInput, Skeleton } from '../../components/common/ui';
import RoleDialog from '../../components/roles/RoleDialog';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { api } from '../../services/api';

/**
 * The roles table.
 *
 * Every action it offers comes from the server's own answer: `canEdit`, `canDelete` and `cannotDeleteReason` are
 * computed where the rules live, and this file renders them. That is the whole reason the reference product's
 * stacked "Not authorized" toasts cannot happen here — a button that would be refused is not drawn, and where
 * something is deliberately unavailable the reason is on the row rather than in a toast after the click.
 */
export default function RolesTab() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const debounced = useDebounced(search, 300);

  const { data, loading, error, reload } = useFetch('/roles', { search: debounced || undefined, page, limit });

  const [editing, setEditing] = useState(null); // a role, or 'new'
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const save = async (body) => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === 'new') await api.post('/roles', body);
      else await api.patch(`/roles/${editing.id}`, body);
      setEditing(null);
      reload();
    } catch (e) {
      // The server's refusal is shown exactly as written: it names the role, the count, or the permission at fault.
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/roles/${removing.id}`);
      setRemoving(null);
      reload();
    } catch (e) {
      setFormError(e.message);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.items || [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by role name…" className="w-full sm:max-w-sm" />
        {data?.canCreate && (
          <Button onClick={() => { setFormError(null); setEditing('new'); }}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Add role
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
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No roles found" hint={search ? 'No role matches that search.' : 'Add a role to get started.'} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-subtle/40 text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Role name</th>
                    <th className="px-4 py-2.5 font-semibold">Scope</th>
                    <th className="px-4 py-2.5 font-semibold">Permissions</th>
                    <th className="px-4 py-2.5 font-semibold">Users</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-subtle/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{r.name}</span>
                          {r.isSystem && <Badge tone="neutral">Built-in</Badge>}
                        </div>
                        {r.description && <p className="mt-0.5 max-w-md text-xs text-muted">{r.description}</p>}
                      </td>
                      <td className="px-4 py-3 capitalize text-muted">{r.scope}</td>
                      <td className="px-4 py-3">
                        <Badge tone={r.permissionCount ? 'info' : 'neutral'}>{r.permissionCount}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted">{r.userCount}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {r.canEdit && (
                            <IconButton label={`Edit ${r.name}`} onClick={() => { setFormError(null); setEditing(r); }}>
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </IconButton>
                          )}
                          {r.canDelete ? (
                            <IconButton label={`Delete ${r.name}`} onClick={() => setRemoving(r)}>
                              <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                            </IconButton>
                          ) : (
                            // Not a disabled button that says nothing: the reason is the thing worth showing.
                            <span className="text-xs text-muted" title={r.cannotDeleteReason || ''}>
                              {r.isSystem ? 'Built-in' : `${r.userCount} in use`}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pages={data.pages} total={data.total} limit={data.limit} onPage={setPage} onLimit={(l) => { setLimit(l); setPage(1); }} pageSummary />
          </>
        )}
      </Card>

      {editing && (
        <RoleDialog
          role={editing === 'new' ? null : editing}
          catalogue={data?.catalogue || []}
          scopeNote={data?.scopeNote}
          saving={busy}
          error={formError}
          onSave={save}
          onClose={() => { setEditing(null); setFormError(null); }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          message="This role will be removed. Nobody holds it, so no one loses access."
          confirmLabel="Delete role"
          danger
          loading={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}
