import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FilterX, Pencil, Plus, Power, Tag, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { attributeService } from '../../services/catalogService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { ATTRIBUTE_TYPES, hasValues, typeLabel } from '../../utils/catalogValidation';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, FilterDropdown, IconButton, PageHeader, Pagination, SearchInput, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import AttributeForm from '../../components/inventory/AttributeForm';
import { useAuth } from '../../context/AuthContext';
import { userCan } from '../../components/layout/nav';

const LIMIT = 10;
const SHOWN_VALUES = 6;

/**
 * Attributes: the organization's own lists (categories, dosage forms, strengths, units) and the extra fields
 * ("custom attributes") a medicine can carry. Each can be enabled or disabled, with its own allowed values.
 */
export default function Attributes() {
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
  const type = get('type');
  const status = get('status');
  const { data, loading, error, reload } = useFetch('/attributes', { type, search: urlSearch, status, page, limit: LIMIT });
  const filtersActive = Boolean(urlSearch || type || status);
  const clearFilters = () => {
    setText('');
    setParams({}, { replace: true });
  };

  const [form, setForm] = useState(null); // {} | attribute
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'toggle', attribute }
  const [working, setWorking] = useState(false);

  const runConfirmed = async () => {
    const { kind, attribute: a } = confirm;
    setWorking(true);
    try {
      if (kind === 'delete') {
        await attributeService.remove(a._id);
        toast.success(`“${a.attributeName}” deleted`);
      } else {
        const next = a.status === 'active' ? 'inactive' : 'active';
        await attributeService.update(a._id, { status: next });
        toast.success(`“${a.attributeName}” ${next === 'active' ? 'enabled' : 'disabled'}`);
      }
      setConfirm(null);
      reload();
    } catch (e) {
      toast.error(e.message);
      setConfirm(null);
    } finally {
      setWorking(false);
    }
  };

  const dash = <span className="text-muted">—</span>;
  const columns = [
    { key: 'attributeName', header: 'Name', render: (a) => <span className="font-semibold">{a.attributeName}</span> },
    { key: 'attributeType', header: 'Type', render: (a) => <Badge tone="neutral">{typeLabel(a.attributeType)}</Badge> },
    {
      key: 'values',
      header: 'Allowed Values',
      hideBelow: 'md',
      render: (a) =>
        !hasValues(a.attributeType) ? (
          <span className="text-xs text-muted">One category record</span>
        ) : a.values.length === 0 ? (
          <span className="text-xs text-muted">{a.attributeType === 'custom' ? 'Any text' : dash}</span>
        ) : (
          <div className="flex max-w-md flex-wrap gap-1">
            {a.values.slice(0, SHOWN_VALUES).map((v) => (
              <span key={v} className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium">
                {v}
              </span>
            ))}
            {a.values.length > SHOWN_VALUES && <span className="px-1 text-xs text-muted">+{a.values.length - SHOWN_VALUES} more</span>}
          </div>
        ),
    },
    { key: 'medicineCount', header: 'Used By', align: 'right', render: (a) => <span className="tabular-nums" title="Medicines using this attribute">{a.medicineCount} {a.medicineCount === 1 ? 'medicine' : 'medicines'}</span> },
    { key: 'status', header: 'Status', render: (a) => <Badge tone={a.status === 'active' ? 'success' : 'neutral'} dot>{a.status === 'active' ? 'Enabled' : 'Disabled'}</Badge> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (a) =>
        canWrite && (
          <div className="flex justify-end gap-0.5">
            <IconButton label={`Edit ${a.attributeName}`} onClick={() => setForm(a)}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton label={`${a.status === 'active' ? 'Disable' : 'Enable'} ${a.attributeName}`} onClick={() => setConfirm({ kind: 'toggle', attribute: a })}>
              <Power className={cx('h-4 w-4', a.status === 'active' ? 'text-success' : 'text-muted')} />
            </IconButton>
            {canDelete && (
              <IconButton label={`Delete ${a.attributeName}`} onClick={() => setConfirm({ kind: 'delete', attribute: a })}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        ),
    },
  ];

  const empty = (
    <EmptyState
      icon={Tag}
      title={filtersActive ? 'No attributes match your filters' : 'No attributes yet'}
      hint={filtersActive ? 'Try a different search, or clear the filters.' : 'Define dosage forms, strengths, units or your own medicine fields.'}
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={clearFilters}>
            <FilterX className="h-4 w-4" /> Clear filters
          </Button>
        ) : (
          canWrite && (
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> Add Attribute
            </Button>
          )
        )
      }
    />
  );

  const target = confirm?.attribute;
  const toggling = target?.status === 'active' ? 'disable' : 'enable';
  const used = target?.medicineCount > 0;

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        title="Attributes"
        description="Your own lists and extra fields for medicine records."
        actions={
          canWrite && (
            <Button onClick={() => setForm({})}>
              <Plus className="h-4 w-4" /> Add Attribute
            </Button>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3 sm:p-4">
          <SearchInput className="w-full sm:w-80" value={text} onChange={setText} label="Search attributes" placeholder="Search name or value…" />
          <FilterDropdown label="Type" allLabel="Any" value={type} options={ATTRIBUTE_TYPES.map((t) => ({ value: t.value, label: t.plural }))} onChange={(v) => patch({ type: v, page: '' })} />
          <FilterDropdown label="Status" allLabel="Any" value={status} options={[{ value: 'active', label: 'Enabled' }, { value: 'inactive', label: 'Disabled' }]} onChange={(v) => patch({ status: v, page: '' })} />
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
            <DataTable columns={columns} rows={data?.items || []} rowKey={(a) => a._id} loading={loading && !data} empty={empty} minWidth={640} />
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={(p) => patch({ page: p === 1 ? '' : String(p) })} />}
          </>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        Custom attributes appear in the medicine form under “Additional information”. Dosage forms, strengths and units become the choices offered there. Everything here belongs to your organization only.
      </p>

      {form && (
        <AttributeForm
          initial={form._id ? form : null}
          defaultType={type || 'dosage_form'}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            reload();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          danger={confirm.kind === 'delete'}
          title={confirm.kind === 'delete' ? 'Delete attribute?' : `${toggling[0].toUpperCase()}${toggling.slice(1)} attribute?`}
          confirmLabel={confirm.kind === 'delete' ? 'Delete' : toggling[0].toUpperCase() + toggling.slice(1)}
          loading={working}
          onConfirm={runConfirmed}
          onClose={() => setConfirm(null)}
          message={
            confirm.kind === 'delete'
              ? used && (target.attributeType === 'category' || target.attributeType === 'custom')
                ? `“${target.attributeName}” is used by ${target.medicineCount} medicine(s) and can’t be deleted. Disable it instead.`
                : `“${target.attributeName}” will be permanently deleted. Medicines keep any values they already have.`
              : toggling === 'disable'
                ? `“${target.attributeName}” will no longer be offered in the medicine form. Medicines that already use it keep their values.`
                : `“${target.attributeName}” will be offered in the medicine form again.`
          }
        />
      )}
    </div>
  );
}
