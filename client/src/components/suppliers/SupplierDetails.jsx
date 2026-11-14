import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReceiptText, Star } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { rupees, termsSummary } from '../../utils/supplierForm';
import { dateFmt } from '../../utils/format';
import { Badge, Button, EmptyState, ErrorState, Modal, Pagination, Skeleton } from '../common/ui';
import { DataTable } from '../common/DataTable';

const RECEIPT_TONE = { complete: 'success', partial: 'warning', none: 'neutral' };

/**
 * What has actually been bought from this supplier: one row per purchase order, read from the orders and the goods receipts booked against them — there is no
 * second history kept anywhere. Each row opens the order it came from.
 */
function PurchaseHistory({ supplierId, onOpenOrder }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const { data, loading, error, reload } = useFetch(`/suppliers/${supplierId}/purchases`, { page, limit });

  const columns = [
    { key: 'orderNo', header: 'Purchase Order', render: (r) => <span className="font-mono font-semibold">{r.orderNo}</span> },
    { key: 'orderDate', header: 'Purchase Date', render: (r) => (r.orderDate ? dateFmt(r.orderDate) : '—') },
    { key: 'expected', header: 'Expected', hideBelow: 'md', render: (r) => (r.expectedDate ? dateFmt(r.expectedDate) : '—') },
    { key: 'received', header: 'Received', hideBelow: 'md', render: (r) => (r.receivedDate ? dateFmt(r.receivedDate) : '—') },
    { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="tabular-nums">{rupees(r.totalAmount)}</span> },
    { key: 'paid', header: 'Paid', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums">{rupees(r.paidAmount)}</span> },
    { key: 'due', header: 'Outstanding', align: 'right', render: (r) => <span className={`tabular-nums${r.outstandingAmount > 0 ? ' font-semibold text-danger' : ''}`}>{rupees(r.outstandingAmount)}</span> },
    { key: 'status', header: 'Order Status', render: (r) => <Badge tone="neutral">{r.statusLabel}</Badge> },
    {
      key: 'grn',
      header: 'Goods Receipt',
      render: (r) => (
        <Badge tone={RECEIPT_TONE[r.receiptStatus]}>
          {r.receiptStatusLabel}
          {r.receiptCount > 1 ? ` (${r.receiptCount})` : ''}
        </Badge>
      ),
    },
    {
      key: 'open',
      header: 'Actions',
      render: (r) => (
        <button type="button" className="text-sm font-semibold text-accent hover:underline" onClick={() => onOpenOrder(r)}>
          {r.lastReceiptNo ? 'Open order / receipt' : 'Open order'}
        </button>
      ),
    },
  ];

  return (
    <section aria-label="Purchase history" className="space-y-2">
      <h3 className="text-sm font-bold">Purchase history</h3>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <DataTable
            columns={columns}
            rows={data?.items || []}
            rowKey={(r) => r._id}
            loading={loading && !data}
            minWidth={820}
            empty={<EmptyState icon={ReceiptText} title="Nothing bought yet" hint="Purchase orders placed with this supplier will appear here." />}
          />
          {(data?.total || 0) > 0 && (
            <Pagination pageSummary limits={[10, 25, 50]} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
          )}
        </div>
      )}
    </section>
  );
}

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{children}</dd>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-line bg-subtle p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * One supplier: who they are, how to reach them, where they are, how buying from them works, and what has actually been bought — every figure comes from the
 * organization's own orders and goods receipts (the server works them out; nothing here is invented or stored).
 */
export default function SupplierDetails({ supplierId, onClose, onEdit }) {
  const navigate = useNavigate();
  const { data: s, loading, error, reload } = useFetch(`/suppliers/${supplierId}`);

  return (
    <Modal
      title={s ? s.name : 'Supplier'}
      description={s ? `${s.code || 'No code'}${s.typeLabel ? ` · ${s.typeLabel}` : ''}` : undefined}
      onClose={onClose}
      wide
      footer={
        s && (
          <>
            <Button variant="secondary" onClick={() => navigate(`/orders?search=${encodeURIComponent(s.name)}`)}>
              View Purchase History
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/orders?new=1&supplierId=${s._id}`)} disabled={s.isActive === false}>
              Create Purchase Order
            </Button>
            <Button variant="accent" onClick={() => onEdit(s)}>
              Edit Supplier
            </Button>
          </>
        )
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !s ? (
        <Skeleton className="h-80 w-full" />
      ) : (
        s && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={s.isActive === false ? 'neutral' : 'success'} dot>
                {s.isActive === false ? 'Inactive' : 'Active'}
              </Badge>
              {s.isPreferred && (
                <Badge tone="warning">
                  <Star className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  Preferred supplier
                </Badge>
              )}
            </div>

            <section aria-label="Supplier statistics">
              <h3 className="text-sm font-bold">Purchasing so far</h3>
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <Stat label="Purchase orders" value={s.totalOrders ?? 0} />
                <Stat label="Pending orders" value={s.openOrders ?? 0} />
                <Stat label="Goods receipts" value={s.totalGoodsReceipts ?? 0} />
                <Stat label="Total purchases" value={rupees(s.totalPurchaseAmount ?? 0)} />
                <Stat label="Outstanding payable" value={rupees(s.outstandingAmount ?? 0)} />
                <Stat label="Last purchase" value={s.lastPurchaseDate ? dateFmt(s.lastPurchaseDate) : '—'} />
              </div>
            </section>

            <div className="grid gap-5 lg:grid-cols-2">
              <section aria-label="Company details">
                <h3 className="text-sm font-bold">Company</h3>
                <dl className="divide-y divide-line">
                  <Row label="Company name">{s.name}</Row>
                  <Row label="Supplier code">{dash(s.code)}</Row>
                  <Row label="GST number">{dash(s.gstin)}</Row>
                  <Row label="PAN">{dash(s.pan)}</Row>
                  <Row label="Supplier type">{dash(s.typeLabel)}</Row>
                  <Row label="Website">
                    {s.website ? (
                      <a href={s.website} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                        {s.website}
                      </a>
                    ) : (
                      '—'
                    )}
                  </Row>
                  <Row label="Preferred">{s.isPreferred ? 'Yes' : 'No'}</Row>
                  <Row label="Account status">{s.isActive === false ? 'Inactive' : 'Active'}</Row>
                </dl>
              </section>

              <section aria-label="Contact details">
                <h3 className="text-sm font-bold">Contact</h3>
                <dl className="divide-y divide-line">
                  <Row label="Contact person">{dash(s.contactPerson)}</Row>
                  <Row label="Phone">{dash(s.phone)}</Row>
                  <Row label="Alternate phone">{dash(s.altPhone)}</Row>
                  <Row label="Email">{dash(s.email)}</Row>
                  <Row label="Alternate email">{dash(s.altEmail)}</Row>
                </dl>

                <h3 className="mt-4 text-sm font-bold">Address</h3>
                <dl className="divide-y divide-line">
                  <Row label="Full address">{dash(s.addressLine)}</Row>
                  <Row label="City">{dash(s.address?.city)}</Row>
                  <Row label="State">{dash(s.address?.state)}</Row>
                  <Row label="PIN code">{dash(s.address?.pincode)}</Row>
                  <Row label="Country">{dash(s.address?.country)}</Row>
                </dl>
              </section>
            </div>

            <PurchaseHistory supplierId={s._id} onOpenOrder={(r) => navigate('/orders', { state: { openOrder: r._id } })} />

            <section aria-label="Procurement details">
              <h3 className="text-sm font-bold">Procurement</h3>
              <dl className="divide-y divide-line">
                <Row label="Payment terms">{termsSummary(s.procurement?.paymentTerms, s.procurement?.creditPeriodDays)}</Row>
                <Row label="Credit period">{s.creditDays ? `${s.creditDays} day${s.creditDays === 1 ? '' : 's'}` : 'None'}</Row>
                <Row label="Minimum order value">{rupees(s.procurement?.minimumOrderValue ?? 0)}</Row>
                <Row label="Preferred delivery time">{dash(s.procurement?.preferredDeliveryTime)}</Row>
                <Row label="Default branch">{dash(s.defaultBranchName)}</Row>
                <Row label="Notes">{dash(s.procurement?.notes)}</Row>
              </dl>
            </section>
          </div>
        )
      )}
    </Modal>
  );
}
