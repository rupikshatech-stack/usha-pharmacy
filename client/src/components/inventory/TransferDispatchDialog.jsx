import { useMemo, useState } from 'react';
import { ArrowRight, Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { transferService } from '../../services/transferService';
import { useFetch } from '../../hooks/useFetch';
import { newIdempotencyKey, expiryFmt } from '../../utils/format';
import { dispatchLines, leavesRemainder, remainingAfter, toDispatchPayload, validateDispatch } from '../../utils/transferValidation';
import { Button, ErrorState, FormField, Modal, Skeleton, StatusBadge, cx, inputCls } from '../common/ui';

/**
 * The dispatch screen for an approved transfer. Each line shows what was approved, what has already gone, what is in stock now, how
 * many to send in THIS dispatch and how many will still remain. Sending less than the remainder is allowed (the rest can be dispatched
 * later, or the transfer can be closed short); sending more than approved is not.
 *
 * The idempotency key is made once when the screen opens and reused for every attempt, so a double click or a retry after a timeout
 * cannot dispatch twice: the server answers a repeat with the original dispatch.
 */
export default function TransferDispatchDialog({ id, onDone, onClose }) {
  const { data: t, loading, error, reload } = useFetch(`/transfers/${id}`);
  const [key] = useState(() => newIdempotencyKey());
  const [typed, setTyped] = useState({}); // what the user has typed, by batch id; everything else shows the default
  const [closeShort, setCloseShort] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const base = useMemo(() => (t ? dispatchLines(t) : null), [t]);
  const lines = useMemo(() => base?.map((l) => (typed[l.batchId] === undefined ? l : { ...l, quantity: typed[l.batchId] })) ?? null, [base, typed]);

  const errors = lines ? validateDispatch(lines) : {};
  const err = (i) => serverErrors[`line.${i}`] || (submitted ? errors[`line.${i}`] : undefined);
  const setQty = (i, quantity) => {
    setTyped((x) => ({ ...x, [lines[i].batchId]: quantity }));
    setServerErrors({});
  };
  const sendAll = () => {
    setTyped(Object.fromEntries(base.map((l) => [l.batchId, String(l.available == null ? l.remaining : Math.min(l.remaining, l.available))])));
    setServerErrors({});
  };

  const dispatchable = t && ['approved', 'partially_dispatched'].includes(t.status);
  const totalNow = (lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  const confirm = async () => {
    setSubmitted(true);
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const payload = toDispatchPayload(lines, { closeShort, idempotencyKey: key, notes });
      const result = await transferService.dispatch(id, payload);
      toast.success(result.duplicate ? `Already dispatched as ${result.dispatch.reference} — nothing was sent twice` : `Dispatch ${result.dispatch.reference} recorded — ${result.dispatch.totalUnits} unit${result.dispatch.totalUnits === 1 ? '' : 's'} sent`);
      onDone(result);
    } catch (e) {
      // map "items.N.quantity" (N counts only the lines that were sent) back to the screen's lines
      const sent = lines.filter((l) => Number(l.quantity) > 0);
      const next = {};
      for (const d of e.details || []) {
        const m = /^items\.(\d+)\./.exec(d.path || '');
        const line = m ? sent[Number(m[1])] : null;
        const idx = line ? lines.findIndex((l) => l.batchId === line.batchId) : -1;
        if (idx >= 0 && !next[`line.${idx}`]) next[`line.${idx}`] = d.message;
      }
      setServerErrors(next);
      toast.error(e.message);
      if (!Object.keys(next).length) reload(); // the transfer may have changed (someone else dispatched or cancelled it)
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={t ? `Dispatch transfer ${t.reference}` : 'Dispatch transfer'}
      description="Confirm what is leaving the source branch. Stock is removed from it now and recorded in the stock ledger."
      onClose={() => !busy && onClose()}
      footer={
        dispatchable && lines ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirm} loading={busy} disabled={lines.length === 0}>
              <Truck className="h-4 w-4" /> Confirm dispatch
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading || !t ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !dispatchable ? (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t.reference} is {t.status.replace('_', ' ')}, so it can’t be dispatched. Only an approved or partially dispatched transfer can.
        </p>
      ) : !lines ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-x-8 gap-y-3 rounded-xl bg-subtle px-4 py-3 text-sm sm:grid-cols-[auto_1fr_auto_1fr_auto]">
            <div>
              <dt className="text-xs text-muted">Transfer reference</dt>
              <dd className="font-semibold">{t.reference}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Source branch</dt>
              <dd className="font-semibold">{t.fromBranch.name}</dd>
            </div>
            <ArrowRight className="mt-4 hidden h-4 w-4 text-muted sm:block" aria-hidden="true" />
            <div>
              <dt className="text-xs text-muted">Destination branch</dt>
              <dd className="font-semibold">{t.toBranch.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd>
                <StatusBadge status={t.status} />
              </dd>
            </div>
          </dl>

          {lines.length === 0 ? (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-muted">Every line of this transfer has already been dispatched.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold">Lines to dispatch</h3>
                <Button size="sm" variant="ghost" onClick={sendAll}>
                  Fill with the most that can be sent
                </Button>
              </div>
              {submitted && errors.lines && (
                <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {errors.lines}
                </p>
              )}
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[600px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Medicine', 'Batch', 'Approved Quantity', 'Already Sent', 'In Stock', 'Dispatch Quantity', 'Remaining Quantity'].map((h) => (
                        <th key={h} className={cx('px-3 py-2.5 font-semibold', !['Medicine', 'Batch'].includes(h) && 'text-right')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.batchId} className="border-t border-line align-top">
                        <td className="px-3 py-3 font-semibold">{l.medicineName}</td>
                        <td className="px-3 py-3">
                          <span className="rounded-md bg-subtle px-2 py-1 font-mono text-[12px]">{l.batchNumber}</span>
                          <div className="mt-0.5 text-[11px] text-muted">exp. {expiryFmt(l.expiryDate)}</div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{l.approved}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{l.dispatched}</td>
                        <td className={cx('px-3 py-3 text-right tabular-nums', l.available != null && l.available < l.remaining && 'font-semibold text-warning')}>{l.available ?? '—'}</td>
                        <td className="px-3 py-3 text-right">
                          <input
                            aria-label={`Dispatch quantity of ${l.medicineName} batch ${l.batchNumber}`}
                            aria-invalid={Boolean(err(i))}
                            type="number"
                            min="0"
                            step="1"
                            max={Math.min(l.remaining, l.available ?? l.remaining)}
                            value={l.quantity}
                            onChange={(e) => setQty(i, e.target.value)}
                            className={cx(inputCls, 'ml-auto h-9 w-20 text-right tabular-nums', err(i) && 'border-danger')}
                          />
                          {err(i) && <p role="alert" className="mt-1 max-w-[14rem] text-xs text-danger">{err(i)}</p>}
                        </td>
                        <td className={cx('px-3 py-3 text-right font-semibold tabular-nums', remainingAfter(l) > 0 ? 'text-warning' : 'text-success')}>{remainingAfter(l)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-subtle/60 text-sm font-semibold">
                      <td colSpan={5} className="px-3 py-2">
                        Sending in this dispatch
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{totalNow}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {leavesRemainder(lines) && (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" checked={closeShort} onChange={(e) => setCloseShort(e.target.checked)} />
                  <span>
                    <span className="block font-semibold">This is everything I can send</span>
                    <span className="block text-xs text-muted">Close the transfer after this dispatch: the remaining quantities will not be sent, and only what was dispatched will be received. Leave unticked to dispatch the rest later.</span>
                  </span>
                </label>
              )}

              <FormField label="Notes (optional)" hint="For example the vehicle or who is carrying it.">
                {(a) => <input {...a} value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} className={inputCls} />}
              </FormField>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
