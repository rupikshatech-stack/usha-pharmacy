import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, PackageCheck, Plus, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { goodsReceiptService } from '../../services/goodsReceiptService';
import { canConfirm, differences, extraBatch, isDirty, lineFigures, lineProblems, toForm, toPayload, totals } from '../../utils/goodsReceipt';
import { Badge, Button, ErrorState, Modal, Skeleton, cx, inputCls } from '../common/ui';

const cell = 'h-9 text-sm';

/** A small input for one cell of a line, outlined when that value has a problem. */
function In({ value, onChange, label, error, numeric, type = 'text', className }) {
  return (
    <input
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error || undefined}
      type={type}
      value={value}
      inputMode={numeric ? 'numeric' : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={cx(inputCls, cell, numeric && 'text-right tabular-nums', error && 'border-danger ring-1 ring-danger/30', className)}
    />
  );
}

/**
 * GOODS RECEIPT: what the supplier's invoice listed beside what ACTUALLY arrived. The quantities that arrived start empty and are entered by the person
 * counting the delivery; accepted units are worked out (arrived - rejected - damaged) and are the only ones that enter stock. Expired medicine, missing batch
 * information and over-delivery are refused. Confirming is the single step that updates stock, once, on the server.
 */
export default function GoodsReceiptForm({ upload, onBack, onDone }) {
  const [draft, setDraft] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState('');

  const adopt = useCallback((d) => {
    const f = toForm(d);
    setDraft(d);
    setForm(f);
    setSaved(f);
  }, []);

  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return; // one request at a time (React runs effects twice in development)
    loading.current = true;
    try {
      setError('');
      adopt(await goodsReceiptService.createDraft({ uploadId: upload.uploadId }));
    } catch (e) {
      setError(e.message);
    } finally {
      loading.current = false;
    }
  }, [upload.uploadId, adopt]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft is prepared (or the open one reopened) when the screen opens
    load();
  }, [load]);

  const order = useMemo(() => new Map((draft?.receivable?.lines || []).map((l) => [String(l.medicineId), l])), [draft]);
  const dirty = form && saved ? isDirty(form, saved) : false;
  const set = (i, k, v) => setForm((f) => ({ ...f, items: f.items.map((l, n) => (n === i ? { ...l, [k]: v } : l)) }));

  const save = async () => {
    setBusy(true);
    setFailure('');
    try {
      adopt(await goodsReceiptService.update(draft._id, toPayload(form)));
      toast.success('Draft saved. Stock has not changed.');
      return true;
    } catch (e) {
      setFailure(e.message);
      toast.error(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    setShow(true);
    if (!canConfirm(form)) {
      toast.error('Fix the highlighted quantities and batch details first.');
      return;
    }
    if (dirty && !(await save())) return;
    setAsking(true);
  };

  const confirm = async () => {
    setBusy(true);
    setFailure('');
    try {
      const r = await goodsReceiptService.confirm(draft._id);
      setResult(r);
      setAsking(false);
      toast.success(`Goods receipt ${r.receipt.receiptNo} confirmed — stock updated.`);
    } catch (e) {
      setAsking(false);
      setFailure(e.message);
      toast.error(e.message);
      if (e.details?.length) setShow(true);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="border-t border-line p-4 sm:p-5">
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  if (!draft || !form) {
    return (
      <div className="space-y-3 border-t border-line p-4 sm:p-5">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Preparing the goods receipt…
        </p>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (result) {
    const g = result.receipt;
    return (
      <div className="space-y-4 border-t border-line p-4 sm:p-5" aria-live="polite">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
          Goods receipt confirmed <Badge tone="success">{g.receiptNo}</Badge>
        </h2>
        <div className="flex items-start gap-3 rounded-xl border border-success/40 bg-success/5 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="font-semibold">
              {g.totalAccepted} unit{g.totalAccepted === 1 ? '' : 's'} added to stock · {g.totalRejected + g.totalDamaged} rejected or damaged (not added)
            </p>
            <p className="text-muted">
              Order {result.order.orderNo} is now {result.order.statusLabel.toLowerCase()}.{' '}
              {result.replayed ? 'This receipt had already been confirmed; nothing was added twice.' : 'Each batch was updated and every change is in the stock history.'}
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[40rem] text-left text-xs" aria-label="Received lines">
            <thead className="bg-subtle">
              <tr>
                {['Product', 'Batch', 'Arrived', 'Accepted', 'Rejected', 'Damaged', 'Batch stock now'].map((h) => (
                  <th key={h} className="px-2 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.items.map((l, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-2 py-1.5">{l.name}</td>
                  <td className="px-2 py-1.5">{l.batchNumber || '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.quantity + l.freeQuantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.acceptedQuantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.rejectedQuantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.damagedQuantity}</td>
                  <td className="px-2 py-1.5 tabular-nums">{l.balanceAfter ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="accent" onClick={() => onDone(result)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const t = totals(form);
  const diffs = differences(form);
  const serverProblems = (draft.problems || []).filter((p) => !p.field);
  const canGo = form.items.length > 0;

  return (
    <div className="space-y-4 border-t border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
            Goods receipt <Badge tone="info">{draft.draftNo}</Badge>
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            Order {draft.orderNo} · {draft.supplier?.name} · supplier invoice {draft.supplierInvoiceNumber || '—'}
          </p>
        </div>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back to purchase order
        </Button>
      </div>

      <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <p>
          Count the delivery and enter what <b>actually arrived</b>. The invoice quantity is shown for comparison only and is never assumed to be what was delivered. Only{' '}
          <b>accepted</b> units (arrived − rejected − damaged) are added to stock. Expired medicine cannot be added: record those units as rejected.
        </p>
      </div>
      {draft.receivable && !draft.receivable.receivable && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" /> Order {draft.orderNo} is {draft.receivable.status.replace('_', ' ')}. Goods can only
          be received once it has been approved and marked as ordered (in Orders).
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-max min-w-full border-collapse text-left text-xs" aria-label="Goods receipt lines">
          <thead className="bg-subtle">
            <tr>
              {[
                'Product',
                'Ordered',
                'Previously received',
                'Invoice qty',
                'Actually received',
                'Free received',
                'Rejected',
                'Damaged',
                'Accepted',
                'Batch',
                'Mfg date',
                'Expiry',
                'MRP',
                'Selling price',
                'Remarks',
                '',
              ].map((h, i) => (
                <th key={i} scope="col" className="px-1.5 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {form.items.map((l, i) => {
              const o = order.get(l.medicineId);
              const p = show ? lineProblems(l) : {};
              const f = lineFigures(l);
              const n = i + 1;
              return (
                <tr key={l._id || `new-${i}`} className="border-t border-line align-top">
                  <td className="min-w-[10rem] px-1.5 py-1.5">
                    <div className="font-medium">{l.name}</div>
                    {!l._id && <div className="text-muted">Another batch</div>}
                  </td>
                  <td className="px-1.5 py-1.5 tabular-nums">{o ? o.orderedQuantity : '—'}</td>
                  <td className="px-1.5 py-1.5 tabular-nums">{o ? o.previouslyReceived : '—'}</td>
                  <td className="px-1.5 py-1.5 tabular-nums" title="What the invoice says. Not what arrived.">
                    {l.invoice?.quantity != null ? `${l.invoice.quantity}${l.invoice.freeQuantity ? ` + ${l.invoice.freeQuantity} free` : ''}` : '—'}
                  </td>
                  <td className="px-1 py-1">
                    <In
                      value={l.receivedQuantity}
                      onChange={(v) => set(i, 'receivedQuantity', v)}
                      label={`Actually received quantity of line ${n}`}
                      error={p.receivedQuantity}
                      numeric
                      className="w-24"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <In
                      value={l.receivedFree}
                      onChange={(v) => set(i, 'receivedFree', v)}
                      label={`Free quantity received of line ${n}`}
                      error={p.receivedFree}
                      numeric
                      className="w-20"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <In
                      value={l.rejectedQuantity}
                      onChange={(v) => set(i, 'rejectedQuantity', v)}
                      label={`Rejected quantity of line ${n}`}
                      error={p.rejectedQuantity}
                      numeric
                      className="w-20"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.damagedQuantity} onChange={(v) => set(i, 'damagedQuantity', v)} label={`Damaged quantity of line ${n}`} numeric className="w-20" />
                  </td>
                  <td className="px-1.5 py-1.5 font-semibold tabular-nums" aria-label={`Accepted quantity of line ${n}`}>
                    {f.accepted}
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.batchNumber} onChange={(v) => set(i, 'batchNumber', v)} label={`Batch number of line ${n}`} error={p.batchNumber} className="w-28" />
                  </td>
                  <td className="px-1 py-1">
                    <In
                      value={l.manufacturingDate}
                      onChange={(v) => set(i, 'manufacturingDate', v)}
                      label={`Manufacturing date of line ${n}`}
                      error={p.manufacturingDate}
                      type="date"
                      className="w-36"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.expiryDate} onChange={(v) => set(i, 'expiryDate', v)} label={`Expiry date of line ${n}`} error={p.expiryDate} type="date" className="w-36" />
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.mrp} onChange={(v) => set(i, 'mrp', v)} label={`MRP of line ${n}`} error={p.mrp} numeric className="w-24" />
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.sellingPrice} onChange={(v) => set(i, 'sellingPrice', v)} label={`Selling price of line ${n}`} error={p.sellingPrice} numeric className="w-24" />
                  </td>
                  <td className="px-1 py-1">
                    <In value={l.remarks} onChange={(v) => set(i, 'remarks', v)} label={`Remarks of line ${n}`} error={p.remarks} className="w-40" />
                  </td>
                  <td className="px-1 py-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Add another batch of ${l.name}`}
                      onClick={() => setForm((x) => ({ ...x, items: [...x.items.slice(0, i + 1), extraBatch(l), ...x.items.slice(i + 1)] }))}
                    >
                      <Plus className="h-3.5 w-3.5" /> Batch
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {show && (
        <ul aria-label="Problems" className="space-y-1 text-sm text-danger">
          {form.items.flatMap((l, i) =>
            Object.values(lineProblems(l)).map((m, k) => (
              <li key={`${i}-${k}`} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Line {i + 1} ({l.name}): {m}
              </li>
            )),
          )}
          {serverProblems.map((p, i) => (
            <li key={`s${i}`} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {p.message}
            </li>
          ))}
        </ul>
      )}
      {failure && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {failure}
        </p>
      )}

      <label className="block text-xs font-semibold text-muted">
        Receiving remarks
        <textarea
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          rows={2}
          maxLength={500}
          className={cx(inputCls, 'mt-1 h-auto font-normal text-ink')}
          aria-label="Receiving remarks"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
        <p className="text-sm text-muted" role="status">
          Invoice {t.invoice} · arrived {t.arrived} · <b className="text-ink">accepted {t.accepted}</b> · rejected {t.rejected} · damaged {t.damaged}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={save} disabled={busy || !dirty}>
            <Save className="h-4 w-4" /> Save draft
          </Button>
          <Button variant="accent" onClick={review} loading={busy} disabled={busy || !canGo}>
            <PackageCheck className="h-4 w-4" /> Confirm Goods Receipt &amp; Update Stock
          </Button>
        </div>
      </div>

      {asking && (
        <Modal
          title="Confirm goods receipt"
          description="This updates your stock. Check what will be added."
          onClose={() => !busy && setAsking(false)}
          wide
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="accent" onClick={confirm} loading={busy}>
                Confirm and update stock
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>
              <b>{t.accepted}</b> unit{t.accepted === 1 ? '' : 's'} will be added to sellable stock. <b>{t.rejected + t.damaged}</b> rejected or damaged unit
              {t.rejected + t.damaged === 1 ? '' : 's'} will be recorded but not added.
            </p>
            <table className="w-full text-left text-xs" aria-label="Receipt summary">
              <thead className="text-muted">
                <tr>
                  {['Product', 'Batch', 'Expiry', 'Arrived', 'Accepted'].map((h) => (
                    <th key={h} className="px-2 py-1 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {form.items
                  .filter((l) => lineFigures(l).arrived > 0)
                  .map((l, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-2 py-1">{l.name}</td>
                      <td className="px-2 py-1">{l.batchNumber || '—'}</td>
                      <td className="px-2 py-1">{l.expiryDate || '—'}</td>
                      <td className="px-2 py-1 tabular-nums">{lineFigures(l).arrived}</td>
                      <td className="px-2 py-1 font-semibold tabular-nums">{lineFigures(l).accepted}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {diffs.length > 0 && (
              <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs">
                Differs from the invoice: {diffs.map((d) => `${d.name} (invoice ${d.invoice}, arrived ${d.arrived})`).join('; ')}.
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
