import { Fragment, useState } from 'react';
import { ArrowRight, Ban, Building2, Check, CheckCircle2, Circle, ClipboardCheck, PackageCheck, Pencil, Printer, Send, Trash2, Truck, X, XCircle } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { STATUS_HELP, allowed, hasPermission } from '../../utils/transferValidation';
import { dateFmt, dateTimeFmt, expiryFmt } from '../../utils/format';
import { Button, ErrorState, Modal, Skeleton, StatusBadge, cx } from '../common/ui';
import TransferActionDialog from './TransferActionDialog';
import TransferDispatchDialog from './TransferDispatchDialog';
import TransferReceiveDialog from './TransferReceiveDialog';
import TransferAuditTrail from './TransferAuditTrail';

const EVENT_ICON = {
  created: Circle,
  submitted: ClipboardCheck,
  approved: Check,
  rejected: XCircle,
  dispatched: Truck,
  received: CheckCircle2,
  cancelled: Ban,
};
const EVENT_TONE = {
  rejected: 'text-danger',
  cancelled: 'text-danger',
  received: 'text-success',
  approved: 'text-success',
};

/** One transfer: its lines, its history, and the steps that are possible now (and allowed for this user). */
export default function TransferDetails({ id, permissions, onEdit, onPrint, onChanged, onClose }) {
  const { data: t, loading, error, reload } = useFetch(`/transfers/${id}`);
  const settings = useFetch('/transfers/settings');
  const [action, setAction] = useState(null);
  const [dispatching, setDispatching] = useState(false);
  const [receiving, setReceiving] = useState(false);

  const can = (a) => t && allowed(permissions, t.status, a) && t.access?.[a === 'delete' ? 'edit' : a] !== false; // the server also says what is possible for this user at these stores
  const started = Boolean((t && !['draft', 'submitted', 'approved', 'rejected'].includes(t.status)) || (t && t.dispatches?.length));
  const receiving_ = Boolean(t && (t.receipts?.length || ['partially_received', 'completed'].includes(t.status)));
  const step = (a, label, Icon, variant = 'primary') =>
    can(a) && (
      <Button variant={variant === 'primary' ? undefined : variant} onClick={() => setAction(a)}>
        <Icon className="h-4 w-4" /> {label}
      </Button>
    );

  return (
    <>
      <Modal
        wide="xl"
        title={t ? `Transfer ${t.reference}` : 'Transfer'}
        description={t ? STATUS_HELP[t.status] : undefined}
        onClose={() => !action && !dispatching && !receiving && onClose()}
      >
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !t ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <section aria-label="Transfer overview" className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-mono text-lg font-bold">{t.reference}</h3>
                  <StatusBadge status={t.status} />
                </div>
                <span className="text-sm text-muted">
                  {t.itemCount} item{t.itemCount === 1 ? '' : 's'} · {t.totalUnits} unit{t.totalUnits === 1 ? '' : 's'}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
                {[
                  ['Transfer date', dateFmt(t.transferDate)],
                  t.expectedArrivalDate && ['Expected arrival', dateFmt(t.expectedArrivalDate)],
                  ['Created by', t.createdByName || '—'],
                  t.submittedAt && ['Submitted', `${dateTimeFmt(t.submittedAt)}${t.submittedByName ? ` · ${t.submittedByName}` : ''}`],
                  t.approvedAt && ['Approved on', `${dateTimeFmt(t.approvedAt)}${t.approvedByName ? ` · ${t.approvedByName}` : ' · automatic'}`],
                  t.rejectedAt && ['Rejected on', `${dateTimeFmt(t.rejectedAt)}${t.rejectedByName ? ` · ${t.rejectedByName}` : ''}`],
                  t.dispatchedAt && ['Dispatched on', `${dateTimeFmt(t.dispatchedAt)}${t.dispatchedByName ? ` · ${t.dispatchedByName}` : ''}`],
                  t.receivedAt && ['Last received', `${dateTimeFmt(t.receivedAt)}${t.receivedByName ? ` · ${t.receivedByName}` : ''}`],
                  t.cancelledAt && ['Cancelled on', `${dateTimeFmt(t.cancelledAt)}${t.cancelledByName ? ` · ${t.cancelledByName}` : ''}`],
                ]
                  .filter(Boolean)
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{k}</dt>
                      <dd className="mt-0.5 font-medium">{v}</dd>
                    </div>
                  ))}
              </dl>
              <div className="mt-4 grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
                {[
                  ['Source store', t.fromBranch],
                  ['Destination store', t.toBranch],
                ].map(([label, b], n) => (
                  <Fragment key={label}>
                    {n === 1 && <ArrowRight className="hidden h-5 w-5 self-center text-muted md:block" aria-hidden="true" />}
                    <div className="flex items-start gap-3 rounded-xl bg-sage/50 px-4 py-3">
                      <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                      <div className="text-sm">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
                        <div className="font-semibold">{b?.name}</div>
                        {(b?.code || b?.address) && <div className="text-xs text-muted">{[b.code, b.address].filter(Boolean).join(' · ')}</div>}
                      </div>
                    </div>
                  </Fragment>
                ))}
              </div>
            </section>
            {t.internalRemarks && <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">Internal remarks: {t.internalRemarks}</p>}
            {t.notes && <p className="rounded-lg border border-line px-3 py-2 text-sm text-muted">{t.notes}</p>}
            {t.status === 'rejected' && t.rejectReason && (
              <p role="status" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                Rejected: {t.rejectReason}
              </p>
            )}

            <h3 className="-mb-2 text-sm font-bold">Medicines and batches</h3>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    {(receiving_
                      ? ['Medicine', 'Batch', 'Dispatched', 'Received', 'Damaged', 'Missing', 'Still expected']
                      : started
                        ? ['Medicine', 'Batch', 'Expiry', 'Approved', 'Dispatched', 'Remaining']
                        : ['Medicine', 'Batch', 'Expiry', 'Quantity']
                    ).map((h, i) => (
                      <th key={h} className={cx('px-4 py-2 font-semibold', i >= 3 && 'text-right')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.items.map((i) => (
                    <tr key={String(i.batchId)} className="border-t border-line">
                      <td className="px-4 py-2 font-medium">{i.medicineName}</td>
                      <td className="px-4 py-2 font-mono text-[13px]">{i.batchNumber}</td>
                      {receiving_ ? (
                        <>
                          <td className="px-4 py-2 text-right tabular-nums">{i.dispatchedQuantity}</td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">{i.receivedQuantity}</td>
                          <td className={cx('px-4 py-2 text-right tabular-nums', i.damagedQuantity > 0 && 'font-semibold text-danger')}>{i.damagedQuantity}</td>
                          <td className={cx('px-4 py-2 text-right tabular-nums', i.missingQuantity > 0 && 'font-semibold text-danger')}>{i.missingQuantity}</td>
                          <td className={cx('px-4 py-2 text-right tabular-nums', i.remainingToReceive > 0 && 'font-semibold text-warning')}>{i.remainingToReceive}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-2 text-muted">{expiryFmt(i.expiryDate)}</td>
                          <td className="px-4 py-2 text-right font-semibold tabular-nums">{i.quantity}</td>
                          {started && <td className="px-4 py-2 text-right tabular-nums">{i.dispatchedQuantity}</td>}
                          {started && <td className={cx('px-4 py-2 text-right tabular-nums', i.remainingQuantity > 0 && 'font-semibold text-warning')}>{i.remainingQuantity}</td>}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {t.hasDiscrepancy && (
              <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                <p className="font-semibold">
                  Discrepancy reported: {t.damagedUnits > 0 && `${t.damagedUnits} damaged`}
                  {t.damagedUnits > 0 && t.missingUnits > 0 && ', '}
                  {t.missingUnits > 0 && `${t.missingUnits} missing or short`}
                </p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {t.items
                    .filter((i) => i.remarks)
                    .map((i) => (
                      <li key={String(i.batchId)}>
                        {i.medicineName} ({i.batchNumber}): {i.remarks}
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {t.receipts?.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold">Receiving details</h3>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
                  {t.receipts.map((r) => (
                    <li key={r._id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <span>
                        <span className="font-mono font-semibold">{r.reference}</span>
                        <span className="ml-2 text-muted">
                          {r.totalReceived} received
                          {r.totalDamaged ? ` · ${r.totalDamaged} damaged` : ''}
                          {r.totalMissing ? ` · ${r.totalMissing} missing` : ''} · {dateTimeFmt(r.receivedAt)} · {r.receivedByName || ''}
                          {r.closed ? ' · closed' : ''}
                        </span>
                      </span>
                      {r.remarks && <span className="text-xs text-muted">{r.remarks}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {t.dispatches?.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold">Dispatch details</h3>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
                  {t.dispatches.map((d) => (
                    <li key={d._id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <span>
                        <span className="font-mono font-semibold">{d.reference}</span>
                        <span className="ml-2 text-muted">
                          {d.totalUnits} unit{d.totalUnits === 1 ? '' : 's'} · {dateTimeFmt(d.dispatchedAt)}
                          {d.closedShort ? ' · closed short' : ''}
                        </span>
                      </span>
                      {d.notes && <span className="text-xs text-muted">{d.notes}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-bold">Status timeline</h3>
              <ol className="space-y-3">
                {t.timeline.map((e) => {
                  const Icon = EVENT_ICON[e.event] || Circle;
                  return (
                    <li key={`${e.event}-${e.ref || e.at}`} className="flex items-start gap-3 text-sm">
                      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', EVENT_TONE[e.event] || 'text-muted')} aria-hidden="true" />
                      <div>
                        <div className="font-medium">{e.label}</div>
                        <div className="text-xs text-muted">
                          {dateTimeFmt(e.at)}
                          {e.by ? ` · ${e.by}` : ''}
                          {e.note ? ` · “${e.note}”` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            <TransferAuditTrail id={t._id} refreshKey={`${t.status}-${t.receipts?.length || 0}-${t.dispatches?.length || 0}`} />

            <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              {hasPermission(permissions, 'transfer:print') && (
                <Button variant="secondary" onClick={() => onPrint(t)}>
                  <Printer className="h-4 w-4" /> Print
                </Button>
              )}
              {can('delete') && (
                <Button variant="secondary" onClick={() => setAction('delete')}>
                  <Trash2 className="h-4 w-4" /> Delete draft
                </Button>
              )}
              {can('edit') && (
                <Button variant="secondary" onClick={() => onEdit(t)}>
                  <Pencil className="h-4 w-4" /> Edit
                </Button>
              )}
              {can('cancel') && (
                <Button variant="secondary" onClick={() => setAction('cancel')}>
                  <XCircle className="h-4 w-4" /> Cancel transfer
                </Button>
              )}
              {can('reject') && (
                <Button variant="secondary" onClick={() => setAction('reject')}>
                  <X className="h-4 w-4" /> Reject
                </Button>
              )}
              {step('submit', 'Submit transfer', Send)}
              {step('approve', 'Approve', Check)}
              {can('dispatch') && (
                <Button onClick={() => setDispatching(true)}>
                  <Truck className="h-4 w-4" /> {t.status === 'partially_dispatched' ? 'Dispatch the rest' : 'Dispatch stock'}
                </Button>
              )}
              {can('receive') && (
                <Button onClick={() => setReceiving(true)}>
                  <PackageCheck className="h-4 w-4" /> {t.status === 'partially_received' ? 'Receive the rest' : 'Receive stock'}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {receiving && (
        <TransferReceiveDialog
          id={id}
          onClose={() => setReceiving(false)}
          onDone={() => {
            setReceiving(false);
            onChanged();
            reload();
          }}
        />
      )}

      {dispatching && (
        <TransferDispatchDialog
          id={id}
          onClose={() => setDispatching(false)}
          onDone={() => {
            setDispatching(false);
            onChanged();
            reload();
          }}
        />
      )}

      {t && action && (
        <TransferActionDialog
          transfer={t}
          action={action}
          settings={settings.data || {}}
          onClose={() => setAction(null)}
          onDone={(_result, failure) => {
            const gone = action === 'delete' && !failure;
            setAction(null);
            onChanged();
            if (gone) onClose();
            else reload(); // also after a failed attempt: someone else may have acted on it first
          }}
        />
      )}
    </>
  );
}
