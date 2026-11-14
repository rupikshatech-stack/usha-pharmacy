import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Ban, ClipboardList, Eye, PackageCheck, Plus, Settings, Sparkles } from 'lucide-react';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt } from '../../utils/format';
import { Button, Card, EmptyState, ErrorState, IconButton, Pagination, SearchInput, StatusBadge } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import { useAuth } from '../../context/AuthContext';
import AddOrderDialog from '../../components/orders/AddOrderDialog';
import OrderDetails, { orderActions } from '../../components/orders/OrderDetails';
import { OrderSettingsDialog } from '../../components/orders/OrderActionDialogs';

/** Orders placed with suppliers for stock that is expected to arrive: search, a table, paging and a read-only details view. */
export default function Orders() {
  const { user } = useAuth();
  const permissions = user?.permissions || [];
  const canWrite = permissions.includes('inventory:write');
  const navigate = useNavigate();
  const location = useLocation();
  // the Suppliers screens link here: ?search= shows one supplier's purchase history, ?new=1&supplierId= starts an order for them. Read once, when the page opens.
  const [initial] = useState(() => new URLSearchParams(location.search));
  const [search, setSearch] = useState(() => initial.get('search') || '');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(null); // { id, action }
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(() => initial.get('new') === '1');
  const [forSupplier] = useState(() => initial.get('supplierId') || '');
  const [editing, setEditing] = useState(null); // a draft being edited
  const q = useDebounced(search);
  const goTo = location.state?.openOrder;
  useEffect(() => {
    if (goTo) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open the order the previous page sent us to, once
      setOpen({ id: goTo });
      navigate('/orders', { replace: true, state: null });
    }
  }, [goTo, navigate]);
  const { data, loading, error, reload } = useFetch('/orders', { search: q, page, limit });

  const columns = [
    { key: 'n', header: '#', render: (o, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span> },
    { key: 'orderNo', header: 'Order ID', render: (o) => <span className="font-mono font-semibold">{o.orderNo}</span> },
    { key: 'supplier', header: 'Supplier', render: (o) => <span className="font-medium">{o.supplier?.name}</span> },
    { key: 'date', header: 'Date', hideBelow: 'sm', render: (o) => <span className="text-muted">{dateFmt(o.orderDate)}</span> },
    {
      key: 'items',
      header: 'Items',
      hideBelow: 'md',
      render: (o) => (
        <div className="max-w-[16rem]">
          <div className="font-semibold tabular-nums">{o.itemCount}</div>
          <div className="truncate text-xs text-muted">
            {o.preview.join(', ')}
            {o.itemCount > o.preview.length ? ` +${o.itemCount - o.preview.length} more` : ''}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (o) => {
        const can = orderActions(o, permissions);
        return (
          <div className="flex items-center gap-0.5">
            <IconButton label={`View order ${o.orderNo}`} onClick={() => setOpen({ id: o._id })}>
              <Eye className="h-4 w-4" />
            </IconButton>
            {can.receive && (
              <IconButton label={`Receive items for ${o.orderNo}`} onClick={() => setOpen({ id: o._id, action: 'receive' })}>
                <PackageCheck className="h-4 w-4" />
              </IconButton>
            )}
            {can.cancel && (
              <IconButton label={`Cancel order ${o.orderNo}`} onClick={() => setOpen({ id: o._id, action: 'cancel' })}>
                <Ban className="h-4 w-4" />
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
            <h1 className="text-xl font-bold tracking-tight">Orders</h1>
            <p className="mt-0.5 text-sm text-muted">Manage received items</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {permissions.includes('settings:manage') && (
              <Button variant="secondary" className="rounded-full px-3" onClick={() => setSettings(true)} aria-label="Order settings">
                <Settings className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
            <Button variant="secondary" className="rounded-full bg-info-soft px-4 text-info hover:bg-info-soft" onClick={() => navigate('/orders/ai-billing')}>
              <Sparkles className="h-4 w-4" aria-hidden="true" /> AI Billing
            </Button>
            {canWrite && (
              <Button variant="accent" className="rounded-full px-5" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" /> Add Order
              </Button>
            )}
          </div>
        </div>

        <div className="px-4 pb-4 sm:px-5">
          <SearchInput
            className="w-full sm:w-80"
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            label="Search orders"
            placeholder="Search orders..."
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
                rowKey={(o) => o._id}
                loading={loading && !data}
                minWidth={640}
                empty={<EmptyState icon={ClipboardList} title="No data found" hint="There is nothing to display right now." />}
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
        <OrderDetails
          id={open.id}
          initialAction={open.action}
          permissions={permissions}
          onChanged={() => reload()}
          onEdit={(o) => {
            setOpen(null);
            setEditing(o);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {settings && <OrderSettingsDialog onClose={() => setSettings(false)} />}
      {(adding || editing) && (
        <AddOrderDialog
          order={editing || undefined}
          supplierId={!editing ? forSupplier : undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onDone={(o) => {
            const wasEditing = Boolean(editing);
            setAdding(false);
            setEditing(null);
            if (!wasEditing) {
              setPage(1);
              setSearch('');
            }
            reload();
            if (wasEditing) setOpen({ id: o._id }); // back to the order's details
          }}
        />
      )}
    </div>
  );
}
