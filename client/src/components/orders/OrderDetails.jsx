import { useState } from 'react';
import { Ban, Check, Circle, Download, PackageCheck, Pencil, Printer, Send, Truck, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { orderService } from '../../services/orderService';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, dateTimeFmt, expiryFmt, inr } from '../../utils/format';
import { Button, ErrorState, Modal, Skeleton, StatusBadge, cx } from '../common/ui';
import { CancelOrderDialog, RejectOrderDialog } from './OrderActionDialogs';
import OrderDocument from './OrderDocument';
import ReceiveGoodsDialog from './ReceiveGoodsDialog';

const PAYMENT_TERMS_LABEL = { cod: 'Cash on Delivery', advance: 'Advance Payment', credit: 'Credit', partial: 'Partial Payment' };
const ACTION_LABEL = {
  CREATED: 'Created',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Sent back',
  ORDERED: 'Marked as ordered',
  RECEIVED: 'Goods received',
  CANCELLED: 'Cancelled',
};

/** What this user may do with an order right now: the same rules the server enforces (it checks them again). */
export const orderActions = (o, permissions = []) => {
  const write = permissions.includes('inventory:write');
  const approve = permissions.includes('orders:approve');
  return {
    edit: write && o.status === 'draft', // a submitted order is sent back to draft before it can be edited
    submit: write && o.status === 'draft',
    approve: approve && o.status === 'pending',
    reject: approve && o.status === 'pending',
    markOrdered: write && o.status === 'approved',
    receive: write && ['ordered', 'partially_received'].includes(o.status),
    cancel: write && ['draft', 'pending', 'approved', 'ordered'].includes(o.status),
  };
};

/** One order: supplier and delivery details, products with ordered / received figures, totals, payment, goods received history, the order's history — and the steps this user may take. */
export default function OrderDetails({ id, permissions, initialAction, onChanged, onEdit, onClose }) {
  const { data: o, loading, error, reload } = useFetch(`/orders/${id}`);
  const [dialog, setDialog] = useState(initialAction || null);
  const [busy, setBusy] = useState('');
  const can = o ? orderActions(o, permissions) : {};
  const direct = Boolean(initialAction); // opened straight from a row button: finishing (or cancelling) the dialog returns to the list
  const closeDialog = () => (direct ? onClose() : setDialog(null));
  const done = () => {
    onChanged();
    if (direct) onClose();
    else {
      setDialog(null);
      reload();
    }
  };
  const run = async (name, call, success) => {
    if (busy) return;
    setBusy(name);
    try {
      await call();
      toast.success(success);
      done();
    } catch (e) {
      toast.error(e.message);
      reload();
    } finally {
      setBusy('');
    }
  };
  const [document, setDocument] = useState(null); // the printable order: { download }

  return (
    <>
      {!(direct && dialog) && (
        <Modal
          wide="xl"
          title={o ? `Order ${o.orderNo}` : 'Order'}
          description={o ? `${o.supplier?.name} · ${dateFmt(o.orderDate)}` : undefined}
          onClose={() => !dialog && !busy && onClose()}
          footer={
            o ? (
              <>
                <Button variant="secondary" onClick={() => setDocument({ download: false })} disabled={Boolean(busy)}>
                  <Printer className="h-4 w-4" /> Print Order
                </Button>
                <Button variant="secondary" onClick={() => setDocument({ download: true })} disabled={Boolean(busy)}>
                  <Download className="h-4 w-4" /> Download PDF
                </Button>
                {can.edit && (
                  <Button variant="secondary" onClick={() => onEdit?.(o)} disabled={Boolean(busy)}>
                    <Pencil className="h-4 w-4" /> Edit
                  </Button>
                )}
                {can.cancel && (
                  <Button variant="secondary" onClick={() => setDialog('cancel')} disabled={Boolean(busy)}>
                    <Ban className="h-4 w-4" /> Cancel order
                  </Button>
                )}
                {can.reject && (
                  <Button variant="secondary" onClick={() => setDialog('reject')} disabled={Boolean(busy)}>
                    <X className="h-4 w-4" /> Send back
                  </Button>
                )}
                {can.submit && (
                  <Button loading={busy === 'submit'} onClick={() => run('submit', () => orderService.submit(o._id), `Order ${o.orderNo} submitted`)}>
                    <Send className="h-4 w-4" /> Submit
                  </Button>
                )}
                {can.approve && (
                  <Button loading={busy === 'approve'} onClick={() => run('approve', () => orderService.approve(o._id), `Order ${o.orderNo} approved`)}>
                    <Check className="h-4 w-4" /> Approve
                  </Button>
                )}
                {can.markOrdered && (
                  <Button loading={busy === 'order'} onClick={() => run('order', () => orderService.markOrdered(o._id), `Order ${o.orderNo} marked as ordered`)}>
                    <Truck className="h-4 w-4" /> Mark as ordered
                  </Button>
                )}
                {can.receive && (
                  <Button variant="accent" onClick={() => setDialog('receive')} disabled={Boolean(busy)}>
                    <PackageCheck className="h-4 w-4" /> {o.status === 'partially_received' ? 'Receive the rest' : 'Receive items'}
                  </Button>
                )}
              </>
            ) : undefined
          }
        >
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading && !o ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-28 w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-subtle px-4 py-3 text-sm">
                <StatusBadge status={o.status} />
                <span className="font-semibold">{o.supplier?.name}</span>
                {o.supplier?.phone && <span className="text-muted">{o.supplier.phone}</span>}
                {o.expectedDate && <span className="text-muted">Expected {dateFmt(o.expectedDate)}</span>}
                {o.branchName && <span className="text-muted">Deliver to {o.branchName}</span>}
                {o.referenceNo && <span className="text-muted">Ref {o.referenceNo}</span>}
                {o.createdByName && <span className="text-muted">Created by {o.createdByName}</span>}
                {o.approvedByName && <span className="text-muted">Approved by {o.approvedByName}</span>}
                <span className="text-muted">
                  {o.itemCount} item{o.itemCount === 1 ? '' : 's'} · {o.receivedUnits} of {o.units} units arrived
                </span>
              </div>
              {o.status === 'draft' && o.rejectReason && (
                <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                  Sent back: {o.rejectReason}
                </p>
              )}
              {o.status === 'cancelled' && o.cancelReason && <p className="rounded-lg border border-line px-3 py-2 text-sm text-muted">Cancelled: {o.cancelReason}</p>}
              {o.notes && <p className="rounded-lg border border-line px-3 py-2 text-sm text-muted">{o.notes}</p>}
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Product', 'Unit', 'Ordered', 'Free', 'Received', 'Accepted', 'Rejected / damaged', 'Pending', 'Rate', 'Discount', 'GST', 'Total'].map((h, i) => (
                        <th key={h} className={cx('px-3 py-2 font-semibold', i >= 2 && 'text-right')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {o.items.map((i, n) => (
                      <tr key={n} className="border-t border-line">
                        <td className="px-3 py-2 font-medium">{i.name}</td>
                        <td className="px-3 py-2 text-muted">{i.unit || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.freeQuantity || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.receivedQuantity || 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.acceptedQuantity ?? i.receivedQuantity ?? 0}</td>
                        <td className={cx('px-3 py-2 text-right tabular-nums', (i.rejectedQuantity || 0) + (i.damagedQuantity || 0) > 0 && 'font-semibold text-danger')}>
                          {(i.rejectedQuantity || 0) + (i.damagedQuantity || 0)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{Math.max(0, i.quantity + (i.freeQuantity || 0) - (i.receivedQuantity || 0))}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.rate > 0 ? inr(i.rate) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.discountPercent > 0 ? `${i.discountPercent}% · ${inr(i.discountAmount)}` : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.gstPercent > 0 ? `${i.gstPercent}% · ${inr(i.gstAmount)}` : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.total > 0 ? inr(i.total) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {o.grandTotal > 0 && (
                <div className="grid gap-4 md:grid-cols-2">
                  <dl className="rounded-xl bg-subtle p-4 text-sm" aria-label="Order totals">
                    {[
                      ['Subtotal', inr(o.subtotal)],
                      ['Discount', `− ${inr(o.discountTotal)}`],
                      ['Tax (GST)', inr(o.gstTotal)],
                      ['Additional charges', inr((o.charges?.shipping || 0) + (o.charges?.packaging || 0) + (o.charges?.other || 0) + (o.charges?.gstAmount || 0))],
                      ...(o.charges?.additionalDiscount > 0 ? [['Additional discount', `− ${inr(o.charges.additionalDiscount)}`]] : []),
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between py-0.5 text-muted">
                        <dt>{k}</dt>
                        <dd className="tabular-nums">{v}</dd>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-extrabold">
                      <dt>Grand total</dt>
                      <dd className="tabular-nums">{inr(o.grandTotal)}</dd>
                    </div>
                  </dl>
                  {o.payment?.terms && (
                    <dl className="rounded-xl border border-line p-4 text-sm" aria-label="Payment">
                      {[
                        ['Payment terms', PAYMENT_TERMS_LABEL[o.payment.terms] || o.payment.terms],
                        ['Payment method', o.payment.method || '—'],
                        ['Advance payment', inr(o.payment.advance)],
                        ['Remaining amount', inr(o.payment.remaining)],
                        ['Payment status', o.paymentStatusLabel || '—'],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between py-0.5">
                          <dt className="text-muted">{k}</dt>
                          <dd className="font-medium">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}

              {o.receipts?.length > 0 && (
                <section aria-label="Goods received history">
                  <h3 className="mb-2 text-sm font-bold">Goods received history</h3>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
                    {o.receipts.map((g) => (
                      <li key={g._id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            <span className="font-mono font-semibold">{g.receiptNo}</span>
                            <span className="ml-2 text-muted">
                              {g.totalAccepted} added to stock
                              {g.totalRejected + g.totalDamaged > 0 ? ` · ${g.totalRejected} rejected · ${g.totalDamaged} damaged` : ''} · {dateTimeFmt(g.receivedAt)} ·{' '}
                              {g.receivedByName}
                            </span>
                          </span>
                          {g.remarks && <span className="text-xs text-muted">{g.remarks}</span>}
                        </div>
                        <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                          {g.items.map((l, n) => (
                            <li key={n}>
                              {l.name}: {l.acceptedQuantity} accepted
                              {l.batchNumber ? ` · batch ${l.batchNumber}` : ''}
                              {l.expiryDate ? ` · exp ${expiryFmt(l.expiryDate)}` : ''}
                              {l.rejectedQuantity + l.damagedQuantity > 0
                                ? ` · ${l.rejectedQuantity} rejected, ${l.damagedQuantity} damaged${l.remarks ? ` (${l.remarks})` : ''}`
                                : ''}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {o.history?.length > 0 && (
                <section aria-label="Order history">
                  <h3 className="mb-2 text-sm font-bold">History</h3>
                  <ol className="space-y-2.5">
                    {o.history.map((h, n) => (
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
      )}
      {o && document && <OrderDocument id={o._id} download={document.download} onClose={() => setDocument(null)} />}
      {o && dialog === 'receive' && <ReceiveGoodsDialog id={o._id} onClose={closeDialog} onDone={done} />}
      {o && dialog === 'reject' && <RejectOrderDialog order={o} onClose={closeDialog} onDone={done} />}
      {o && dialog === 'cancel' && <CancelOrderDialog order={o} onClose={closeDialog} onDone={done} />}
    </>
  );
}
