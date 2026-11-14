import { useMemo, useState } from 'react';
import { AlertTriangle, PackageCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { orderService } from '../../services/orderService';
import { useFetch } from '../../hooks/useFetch';
import { expiryFmt, newIdempotencyKey } from '../../utils/format';
import {
  accepted,
  arriving,
  delivered,
  existingBatch,
  receiveErrorsFromServer,
  receiveLinesFrom,
  stillExpected,
  toReceivePayload,
  validateReceipt,
} from '../../utils/goodsReceive';
import { Button, ErrorState, FormField, Modal, Skeleton, StatusBadge, cx, inputCls } from '../common/ui';

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * The Goods Received form. Each ordered product shows what was ordered, what already arrived and what is still expected; you enter what
 * arrived now (paid and free units), how many of those are rejected or damaged, and the batch number, dates and prices. Only the verified,
 * accepted units go into stock (in their batch); rejected and damaged units are recorded separately. A partial delivery leaves the rest expected.
 *
 * The idempotency key is made once when the form opens and reused for every attempt, so a double click or a retry after a timeout
 * cannot add the stock twice: the server answers a repeat with the original record.
 */
export default function ReceiveGoodsDialog({ id, onDone, onClose }) {
  const { data: r, loading, error, reload } = useFetch(`/orders/${id}/receivable`);
  const [key] = useState(() => newIdempotencyKey());
  const [typed, setTyped] = useState({}); // edits by product and field; everything else shows the default
  const [remarks, setRemarks] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(false);

  const base = useMemo(() => (r ? receiveLinesFrom(r) : null), [r]);
  const lines = useMemo(
    () =>
      base?.map((l) => {
        const next = { ...l, ...(typed[l.key] || {}) };
        // typing a batch number that is already in stock fills in its expiry (which is then fixed)
        const ex = existingBatch(next);
        return ex && !(typed[l.key] && 'expiryDate' in typed[l.key]) ? { ...next, expiryDate: isoDay(ex.expiryDate) } : next;
      }) ?? null,
    [base, typed],
  );
  const errors = lines ? validateReceipt(lines) : {};
  const shown = (k) => serverErrors[k] || (submitted ? errors[k] : undefined);
  const receivable = r?.receivable;

  const edit = (k, patch) => {
    setTyped((t) => ({ ...t, [k]: { ...(t[k] || {}), ...patch } }));
    setServerErrors({});
    setGeneral('');
  };
  const confirm = async () => {
    setSubmitted(true);
    setGeneral('');
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const out = await orderService.receive(id, toReceivePayload(lines, { remarks, idempotencyKey: key }));
      const g = out.receipt;
      toast.success(
        out.duplicate
          ? `Already recorded as ${g.receiptNo} — nothing was added twice`
          : `${g.receiptNo} recorded — ${g.totalAccepted} unit${g.totalAccepted === 1 ? '' : 's'} added to stock${g.totalRejected + g.totalDamaged ? ` (${g.totalRejected + g.totalDamaged} rejected or damaged)` : ''}`,
      );
      onDone(out);
    } catch (e) {
      const { fields, general: msg } = receiveErrorsFromServer(e, lines);
      setServerErrors(fields);
      setGeneral(msg);
      toast.error(e.message);
      if (e.status === 409) reload(); // someone else received or cancelled it: show the new numbers
    } finally {
      setBusy(false);
    }
  };

  const totals = (lines || []).reduce((s, l) => ({ arrived: s.arrived + arriving(l), accepted: s.accepted + accepted(l) }), { arrived: 0, accepted: 0 });
  const input = (l, field, label, props = {}) => {
    const err = shown(`line.${l.key}.${field}`);
    return (
      <FormField label={label} error={err} className={props.className}>
        {(a) => (
          <input
            {...a}
            aria-label={`${label} of ${l.name}`}
            aria-invalid={Boolean(err)}
            value={l[field]}
            onChange={(e) => edit(l.key, { [field]: e.target.value })}
            className={cx(inputCls, 'h-9', props.num && 'text-right tabular-nums', err && 'border-danger')}
            {...props.input}
          />
        )}
      </FormField>
    );
  };

  return (
    <Modal
      wide="xl"
      title={r ? `Goods received — ${r.orderNo}` : 'Goods received'}
      description={r ? `${r.supplier?.name}${r.branchName ? ` · delivering to ${r.branchName}` : ''}. Only verified, accepted units are added to stock.` : undefined}
      onClose={() => !busy && onClose()}
      footer={
        receivable && lines?.length ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" onClick={confirm} loading={busy}>
              <PackageCheck className="h-4 w-4" /> Confirm receipt
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !r ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !receivable ? (
        <p role="status" className="rounded-lg border border-line px-4 py-6 text-center text-sm text-muted">
          <StatusBadge status={r.status} /> <span className="ml-2">Goods can only be received once the order has been marked as ordered.</span>
        </p>
      ) : !lines.length ? (
        <p role="status" className="rounded-lg border border-line px-4 py-6 text-center text-sm text-muted">
          Everything on this order has already arrived.
        </p>
      ) : (
        <div className="space-y-4">
          {shown('lines') && (
            <p role="alert" className="text-sm text-danger">
              {shown('lines')}
            </p>
          )}
          {lines.map((l) => {
            const ex = existingBatch(l);
            const rej = Number(l.rejectedQuantity) + Number(l.damagedQuantity) > 0;
            return (
              <section key={l.key} aria-label={`Receive ${l.name}`} className="rounded-xl border border-line p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                  <h3 className="text-sm font-bold">
                    {l.name} {l.unit && <span className="font-normal text-muted">· {l.unit}</span>}
                  </h3>
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                    <div>
                      Ordered <b className="text-ink tabular-nums">{l.orderedQuantity}</b>
                    </div>
                    <div>
                      Previously received <b className="text-ink tabular-nums">{l.previouslyReceived}</b>
                    </div>
                    <div>
                      Remaining <b className="text-ink tabular-nums">{l.remainingQuantity}</b>
                    </div>
                  </dl>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {input(l, 'quantity', 'Receiving quantity', { num: true, input: { inputMode: 'numeric' } })}
                  {input(l, 'freeQuantity', 'Free quantity', { num: true, input: { inputMode: 'numeric' } })}
                  {input(l, 'rejectedQuantity', 'Rejected quantity', { num: true, input: { inputMode: 'numeric' } })}
                  {input(l, 'damagedQuantity', 'Damaged quantity', { num: true, input: { inputMode: 'numeric' } })}
                  <FormField label="Batch number" error={shown(`line.${l.key}.batchNumber`)}>
                    {(a) => (
                      <>
                        <input
                          {...a}
                          list={`batches-${l.key}`}
                          aria-label={`Batch number of ${l.name}`}
                          aria-invalid={Boolean(shown(`line.${l.key}.batchNumber`))}
                          maxLength={50}
                          value={l.batchNumber}
                          onChange={(e) => edit(l.key, { batchNumber: e.target.value })}
                          className={cx(inputCls, 'h-9', shown(`line.${l.key}.batchNumber`) && 'border-danger')}
                        />
                        <datalist id={`batches-${l.key}`}>
                          {l.batches.map((b) => (
                            <option key={b.batchNumber} value={b.batchNumber}>{`exp ${expiryFmt(b.expiryDate)} · ${b.quantity} in stock`}</option>
                          ))}
                        </datalist>
                      </>
                    )}
                  </FormField>
                  {input(l, 'manufacturingDate', 'Manufacturing date', { input: { type: 'date' } })}
                  <FormField label="Expiry date" error={shown(`line.${l.key}.expiryDate`)} hint={ex ? 'This batch is already in stock, so its expiry is fixed.' : undefined}>
                    {(a) => (
                      <input
                        {...a}
                        type="date"
                        aria-label={`Expiry date of ${l.name}`}
                        aria-invalid={Boolean(shown(`line.${l.key}.expiryDate`))}
                        readOnly={Boolean(ex)}
                        value={l.expiryDate}
                        onChange={(e) => edit(l.key, { expiryDate: e.target.value })}
                        className={cx(inputCls, 'h-9', ex && 'bg-subtle', shown(`line.${l.key}.expiryDate`) && 'border-danger')}
                      />
                    )}
                  </FormField>
                  {input(l, 'purchasePrice', 'Purchase price', { num: true, input: { inputMode: 'decimal' } })}
                  {!ex && input(l, 'mrp', 'MRP', { num: true, input: { inputMode: 'decimal' } })}
                  {!ex && input(l, 'sellingPrice', 'Selling price', { num: true, input: { inputMode: 'decimal' } })}
                  <FormField label="Actual received quantity" hint="Added to stock: arrived − rejected − damaged.">
                    {(a) => (
                      <input
                        {...a}
                        aria-label={`Actual received quantity of ${l.name}`}
                        readOnly
                        value={accepted(l)}
                        className={cx(inputCls, 'h-9 bg-subtle text-right font-semibold tabular-nums')}
                      />
                    )}
                  </FormField>
                  {rej && <div className="sm:col-span-2 lg:col-span-4">{input(l, 'remarks', 'Remarks on rejected or damaged units', { input: { maxLength: 300 } })}</div>}
                </div>
                {stillExpected(l) > 0 && arriving(l) > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    {stillExpected(l)} more unit{stillExpected(l) === 1 ? '' : 's'} will still be expected after this delivery.
                  </p>
                )}
              </section>
            );
          })}
          <FormField label="Delivery remarks" hint="Optional — anything about this delivery.">
            {(a) => <textarea {...a} rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={cx(inputCls, 'h-auto py-2')} />}
          </FormField>
          <p className="text-sm font-semibold" aria-live="polite">
            {delivered(lines).length} product{delivered(lines).length === 1 ? '' : 's'} · {totals.arrived} unit{totals.arrived === 1 ? '' : 's'} arriving · {totals.accepted} will
            be added to stock
          </p>
          {general && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {general}
            </p>
          )}
          {submitted && Object.keys(errors).length > 0 && !busy && (
            <p role="status" className="text-sm text-danger">
              Please fix the highlighted fields before confirming the receipt.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
