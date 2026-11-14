import { useState } from 'react';
import { AlertCircle, Banknote, Check, Circle, Pencil, X } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, dateTimeFmt, inr } from '../../utils/format';
import { CONDITION_LABEL } from '../../utils/salesReturnValidation';
import { Button, ErrorState, Modal, Skeleton, StatusBadge, cx } from '../common/ui';
import { ApproveReturnDialog, EditReturnDialog, NEXT_REFUND_STATUS, RefundDialog, RejectReturnDialog } from './ReturnActionDialogs';

const OPEN = ['pending', 'approved', 'refund_pending'];
const ACTION_LABEL = { CREATED: 'Recorded', APPROVED: 'Approved', REJECTED: 'Rejected', REFUND: 'Refund', EDITED: 'Edited' };

/** What this user may do with a return right now: the same rules the server enforces (it checks them again). */
export const returnActions = (r, permissions = []) => {
  const has = (p) => permissions.includes(p);
  const restocked = r.items ? r.items.some((i) => i.restockedQuantity > 0) : r.restockedUnits > 0; // the list sends totals, the details send the lines
  const refundOpen = (NEXT_REFUND_STATUS[r.refund?.status || 'pending'] || []).length > 0;
  return {
    approve: has('returns:approve') && r.status === 'pending',
    reject: has('returns:approve') && OPEN.includes(r.status) && !restocked && r.refund?.status !== 'completed',
    refund: has('returns:refund') && ['approved', 'refund_pending'].includes(r.status) && refundOpen,
    edit: has('billing:create') && OPEN.includes(r.status) && r.refund?.status !== 'completed',
  };
};

/** One return: who and why, the products with what happened to their stock, the refund, the history — and the steps this user may take. */
export default function ReturnDetails({ id, permissions, initialAction, onChanged, onClose }) {
  const { data: r, loading, error, reload } = useFetch(`/sales-returns/${id}`);
  const [action, setAction] = useState(initialAction || null);
  const can = r ? returnActions(r, permissions) : {};
  const done = () => {
    setAction(null);
    reload();
    onChanged();
  };

  return (
    <>
      <Modal
        wide
        title={r ? `Return ${r.returnNo}` : 'Return'}
        description={r ? `Against invoice ${r.invoiceNo} · ${dateFmt(r.returnDate)}` : undefined}
        onClose={() => !action && onClose()}
        footer={
          r && (can.approve || can.reject || can.refund || can.edit) ? (
            <>
              {can.edit && (
                <Button variant="secondary" onClick={() => setAction('edit')}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              )}
              {can.reject && (
                <Button variant="secondary" onClick={() => setAction('reject')}>
                  <X className="h-4 w-4" /> Reject
                </Button>
              )}
              {can.approve && (
                <Button onClick={() => setAction('approve')}>
                  <Check className="h-4 w-4" /> Approve
                </Button>
              )}
              {can.refund && (
                <Button variant="accent" onClick={() => setAction('refund')}>
                  <Banknote className="h-4 w-4" /> Process refund
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !r ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-subtle px-4 py-3 text-sm">
              <StatusBadge status={r.status} />
              <span className="font-semibold">{r.customer?.name}</span>
              {r.customer?.phone && <span className="text-muted">{r.customer.phone}</span>}
              <span className="text-muted">Reason: {r.reasonLabel}</span>
              <span className="text-muted">Refund: {r.refund?.method ? `${r.refund.method} · ${r.refund.status}` : '—'}</span>
            </div>
            {r.status === 'rejected' && r.rejectReason && (
              <p role="status" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                Rejected: {r.rejectReason}
              </p>
            )}
            {r.notes && (
              <p className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm text-muted">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {r.notes}
              </p>
            )}
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    {['Item', 'Batch', 'Qty', 'Rate', 'Refund', 'Stock'].map((h, i) => (
                      <th key={h} className={cx('px-4 py-2 font-semibold', i >= 2 && i <= 4 && 'text-right')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((i, n) => (
                    <tr key={n} className="border-t border-line">
                      <td className="px-4 py-2 font-medium">{i.name}</td>
                      <td className="px-4 py-2 font-mono text-[13px]">{i.batchNo}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{i.quantity}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{inr(i.price)}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{inr(i.amount)}</td>
                      <td className="px-4 py-2 text-muted">
                        {i.restockedQuantity > 0
                          ? `Restocked (${i.restockedQuantity})`
                          : i.restock && r.status === 'pending'
                            ? 'To be restocked on approval'
                            : `Not restocked — ${(CONDITION_LABEL[i.condition] || i.condition || 'not restocked').toLowerCase()}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.refund && (
              <p className="text-sm text-muted">
                Refund {r.refund.status}
                {r.refund.reference ? ` · ref ${r.refund.reference}` : ''}
                {r.refund.remarks ? ` · ${r.refund.remarks}` : ''}
                {r.originalPaymentMethod ? ` · originally paid by ${r.originalPaymentMethod}` : ''}
              </p>
            )}
            <div className="text-right text-lg font-extrabold">Refund {inr(r.refundAmount)}</div>

            {r.history?.length > 0 && (
              <section aria-label="History">
                <h3 className="mb-2 text-sm font-bold">History</h3>
                <ol className="space-y-2.5">
                  {r.history.map((h, n) => (
                    <li key={n} className="flex items-start gap-3 text-sm">
                      <Circle className="mt-1 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                      <div>
                        <div className="font-medium">
                          {ACTION_LABEL[h.action] || h.action}
                          {h.note ? <span className="font-normal text-muted"> — {h.note}</span> : null}
                        </div>
                        <div className="text-xs text-muted">
                          {dateTimeFmt(h.at)}
                          {h.byName ? ` · ${h.byName}` : ''}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}
      </Modal>
      {r && action === 'approve' && <ApproveReturnDialog ret={r} onClose={() => setAction(null)} onDone={done} />}
      {r && action === 'reject' && <RejectReturnDialog ret={r} onClose={() => setAction(null)} onDone={done} />}
      {r && action === 'refund' && <RefundDialog ret={r} onClose={() => setAction(null)} onDone={done} />}
      {r && action === 'edit' && <EditReturnDialog ret={r} onClose={() => setAction(null)} onDone={done} />}
    </>
  );
}
