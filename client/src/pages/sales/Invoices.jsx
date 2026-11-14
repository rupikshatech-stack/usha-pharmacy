import { useState } from 'react';
import { Eye, FileText, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { invoiceService } from '../../services/invoiceService';
import { dateFmt, inr } from '../../utils/format';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { printInvoice } from '../../utils/printInvoice';
import { useAuth } from '../../context/AuthContext';
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Modal, PageHeader, Pagination, SearchInput } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';

const LIMIT = 10;

export default function Invoices() {
  const { user } = useAuth();
  // The Daily Transaction Report links here with ?search=<reference>, so a row opens its own document. Read once.
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') || '');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const { data, loading, error, reload } = useFetch('/invoices', { search: q, page, limit: LIMIT });
  const [open, setOpen] = useState(null);

  const view = async (id) => {
    try {
      setOpen(await invoiceService.get(id));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const columns = [
    { key: 'invoiceNo', header: 'Invoice', render: (i) => <span className="font-semibold">{i.invoiceNo}</span> },
    { key: 'date', header: 'Date', hideBelow: 'sm', render: (i) => <span className="text-muted">{dateFmt(i.createdAt)}</span> },
    { key: 'customer', header: 'Customer', render: (i) => i.customer?.name },
    { key: 'payment', header: 'Payment', hideBelow: 'md', render: (i) => i.paymentType },
    { key: 'total', header: 'Total', align: 'right', render: (i) => <span className="font-semibold tabular-nums">{inr(i.total)}</span> },
    { key: 'due', header: 'Due', align: 'right', hideBelow: 'md', render: (i) => (i.due > 0 ? <Badge tone="warning">{inr(i.due)}</Badge> : <span className="text-muted">—</span>) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (i) => (
        <IconButton label={`View ${i.invoiceNo}`} onClick={() => view(i._id)}>
          <Eye className="h-4 w-4" />
        </IconButton>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <PageHeader title="Invoices" description="Transaction history." />
      <Card>
        <div className="border-b border-line p-3 sm:p-4">
          <SearchInput
            className="w-full sm:w-80"
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            label="Search invoices"
            placeholder="Search invoice no., customer or phone…"
          />
        </div>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.items || []}
              rowKey={(i) => i._id}
              loading={loading && !data}
              minWidth={560}
              empty={<EmptyState icon={FileText} title={q ? 'No invoices match your search' : 'No invoices yet'} hint={q ? undefined : 'Invoices appear here after your first sale at the Selling Point.'} />}
            />
            {data && data.total > 0 && <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={setPage} />}
          </>
        )}
      </Card>

      {open && (
        <Modal
          wide
          title={`Invoice ${open.invoiceNo}`}
          description={`${dateFmt(open.createdAt)} · ${open.customer?.name} ${open.customer?.phone || ''}`}
          onClose={() => setOpen(null)}
          footer={
            <Button variant="secondary" onClick={async () => {
              if (!(await printInvoice(open, user.organization?.name))) toast.error('Allow pop-ups to print');
            }}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          }
        >
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  {['Item', 'Batch', 'Qty', 'Rate', 'Disc %', 'Amount'].map((h) => (
                    <th key={h} className="px-4 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {open.items.map((it, idx) => (
                  <tr key={idx} className="border-t border-line">
                    <td className="px-4 py-2 font-medium">{it.name}</td>
                    <td className="px-4 py-2">{it.batchNo}</td>
                    <td className="px-4 py-2">{it.quantity}</td>
                    <td className="px-4 py-2 tabular-nums">{inr(it.price)}</td>
                    <td className="px-4 py-2">{it.discountPercent}</td>
                    <td className="px-4 py-2 tabular-nums">{inr(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 space-y-1 text-right text-sm">
            <div className="text-muted">Subtotal {inr(open.subTotal)}</div>
            <div className="text-muted">Discount {inr(open.discount)}</div>
            <div className="text-lg font-extrabold">Total {inr(open.total)}</div>
            {open.returnedAmount > 0 && (
              <div className="text-muted">
                Returned {inr(open.returnedAmount)} · net {inr(open.total - open.returnedAmount)}
              </div>
            )}
            <div className="text-muted">
              {open.paymentType} · Paid {inr(open.paid)}
              {open.due > 0 && ` · Due ${inr(open.due)}`}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
