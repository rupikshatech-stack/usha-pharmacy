import { useState } from 'react';
import { dateTimeFmt, expiryFmt, inr } from '../../utils/format';
import { expiryNote } from '../../utils/batchValidation';
import { useFetch } from '../../hooks/useFetch';
import { Badge, ErrorState, Modal, Pagination, Skeleton, StatusBadge } from '../common/ui';

const LABEL = { PURCHASE: 'Received', SALE: 'Sold', SALE_RETURN: 'Sale return', ADJUSTMENT: 'Adjustment', WRITE_OFF: 'Written off', OPENING: 'Opening', TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out' };
const LIMIT = 10;

/** One batch: its details and the permanent log of every change to its quantity. */
export default function BatchHistory({ batch, onClose }) {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch(`/batches/${batch._id}/movements`, { page, limit: LIMIT });

  const facts = [
    ['Batch number', batch.batchNumber],
    ['Manufacturer', batch.manufacturer || '—'],
    ['Manufactured', expiryFmt(batch.manufacturingDate)],
    ['Expiry', `${expiryFmt(batch.expiryDate)}${expiryNote(batch) ? ` (${expiryNote(batch)})` : ''}`],
    ['Purchase price', inr(batch.purchasePrice)],
    ['Selling price / MRP', `${inr(batch.sellingPrice)} / ${inr(batch.mrp)}`],
    ['Received', batch.initialQuantity],
    ['On hand', batch.availableQuantity],
    ['Reserved', batch.reservedQuantity],
    ['Sellable', batch.sellableQuantity],
  ];

  return (
    <Modal wide title={`Batch history — ${batch.batchNumber}`} description={batch.medicineName} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={batch.stockStatus} />
          {batch.isExpired && <Badge tone="danger">Never sold: expired stock is blocked from sale</Badge>}
        </div>
        <dl className="grid gap-x-8 sm:grid-cols-2">
          {facts.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line py-1.5 text-sm">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right font-medium tabular-nums">{val}</dd>
            </div>
          ))}
        </dl>

        <div>
          <h3 className="mb-2 text-sm font-bold">Stock movements</h3>
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : !data ? (
            <Skeleton className="h-24 w-full" />
          ) : data.items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-sm text-muted">No movements recorded.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['When', 'Type', 'Change', 'Balance', 'Reason / reference', 'By'].map((h) => (
                        <th key={h} className="px-4 py-2 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((e) => (
                      <tr key={e._id} className="border-t border-line">
                        <td className="whitespace-nowrap px-4 py-2 text-muted">{dateTimeFmt(e.createdAt)}</td>
                        <td className="px-4 py-2">{LABEL[e.type] || e.type}</td>
                        <td className={`px-4 py-2 font-semibold tabular-nums ${e.quantity > 0 ? 'text-success' : 'text-danger'}`}>
                          {e.quantity > 0 ? '+' : ''}
                          {e.quantity}
                        </td>
                        <td className="px-4 py-2 tabular-nums">{e.balanceAfter ?? '—'}</td>
                        <td className="px-4 py-2 text-muted">{[e.reason, e.invoiceNo && `Invoice ${e.invoiceNo}`].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-4 py-2 text-muted">{e.createdByName || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={data.page} pages={data.pages} total={data.total} limit={LIMIT} onPage={setPage} />
            </div>
          )}
          <p className="mt-1.5 text-xs text-muted">The history is permanent: entries can't be edited or deleted, only corrected with a new entry.</p>
        </div>
      </div>
    </Modal>
  );
}
