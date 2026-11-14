import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, PackageCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { transferService } from '../../services/transferService';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, newIdempotencyKey } from '../../utils/format';
import { awaitsReceipt, countedOn, hasLineDiscrepancy, leavesExpected, receiveLines, stillExpected, toReceivePayload, validateReceipt } from '../../utils/transferValidation';
import { Button, ErrorState, FormField, Modal, Skeleton, StatusBadge, cx, inputCls } from '../common/ui';

const numCls = 'h-9 w-[4.5rem] px-1.5 text-right tabular-nums';

/**
 * The receiving screen for the destination branch. Each line shows what was dispatched, what earlier receipts already took in, what is
 * still expected, and lets the receiver record this receipt: units received in good condition (the only ones credited to stock),
 * damaged units, and missing/short units — the last two need remarks. A partial receipt leaves the rest expected; "nothing more is
 * coming" closes the receipt and writes the rest off as missing.
 *
 * The idempotency key is made once when the screen opens and reused for every attempt, so a double click or a retry after a timeout
 * cannot credit the stock twice: the server answers a repeat with the original receipt.
 */
export default function TransferReceiveDialog({ id, onDone, onClose }) {
  const { data: t, loading, error, reload } = useFetch(`/transfers/${id}`);
  const [key] = useState(() => newIdempotencyKey());
  const [typed, setTyped] = useState({}); // edits by batch id and field; everything else shows the default
  const [closeReceipt, setCloseReceipt] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const base = useMemo(() => (t ? receiveLines(t) : null), [t]);
  const lines = useMemo(() => base?.map((l) => ({ ...l, ...(typed[l.batchId] || {}) })) ?? null, [base, typed]);
  const errors = lines ? validateReceipt(lines, { closeReceipt, remarks }) : {};
  const shown = (k) => serverErrors[k] || (submitted ? errors[k] : undefined);
  const receivable = t && awaitsReceipt(t.status);

  const edit = (i, field, value) => {
    setTyped((x) => ({ ...x, [lines[i].batchId]: { ...(x[lines[i].batchId] || {}), [field]: value } }));
    setServerErrors({});
  };
  const receiveAll = () => {
    setTyped({});
    setCloseReceipt(false);
    setServerErrors({});
  };

  const totals = (lines || []).reduce((s, l) => ({ r: s.r + (Number(l.quantity) || 0), d: s.d + (Number(l.damaged) || 0), m: s.m + (Number(l.missing) || 0) }), { r: 0, d: 0, m: 0 });
  const discrepancy = totals.d + totals.m > 0;

  const confirm = async () => {
    setSubmitted(true);
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const result = await transferService.receive(id, toReceivePayload(lines, { closeReceipt, remarks, idempotencyKey: key }));
      const r = result.receipt;
      toast.success(result.duplicate ? `Already received as ${r.reference} — nothing was credited twice` : `Receipt ${r.reference} recorded — ${r.totalReceived} unit${r.totalReceived === 1 ? '' : 's'} added to ${t.toBranch.name}${r.totalDamaged + r.totalMissing ? ` (${r.totalDamaged} damaged, ${r.totalMissing} missing)` : ''}`);
      onDone(result);
    } catch (e) {
      // map "items.N.field" (N counts only the lines that were sent) back to the screen's lines
      const sent = lines.filter((l) => countedOn(l) > 0);
      const next = {};
      for (const d of e.details || []) {
        const m = /^items\.(\d+)\.(\w+)$/.exec(d.path || '');
        if (m) {
          const line = sent[Number(m[1])];
          const idx = line ? lines.findIndex((l) => l.batchId === line.batchId) : -1;
          const k = idx >= 0 ? (m[2] === 'remarks' ? `line.${idx}.remarks` : `line.${idx}`) : null;
          if (k && !next[k]) next[k] = d.message;
        } else if (d.path === 'remarks' && !next.remarks) next.remarks = d.message;
        else if (d.path === 'items' && !next.lines) next.lines = d.message;
      }
      setServerErrors(next);
      toast.error(e.message);
      if (!Object.keys(next).length) reload(); // the transfer may have changed (someone else received or cancelled it)
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide="xl"
      title={t ? `Receive transfer ${t.reference}` : 'Receive transfer'}
      description={t ? `Record what actually arrived at ${t.toBranch.name}. Stock is credited to it only when you confirm.` : undefined}
      onClose={() => !busy && onClose()}
      footer={
        receivable && lines ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirm} loading={busy} disabled={lines.length === 0}>
              <PackageCheck className="h-4 w-4" /> Confirm receipt
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
      ) : !receivable ? (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t.reference} is {t.status.replace('_', ' ')}, so it can’t be received. Only a transfer that is in transit or partially received can.
        </p>
      ) : !lines ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-x-8 gap-y-3 rounded-xl bg-subtle px-4 py-3 text-sm sm:grid-cols-[auto_1fr_auto_1fr_auto_auto]">
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
              <dt className="text-xs text-muted">Dispatch date</dt>
              <dd className="font-semibold">{dateFmt(t.lastDispatchedAt || t.dispatchedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd>
                <StatusBadge status={t.status} />
              </dd>
            </div>
          </dl>

          {lines.length === 0 ? (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-muted">Every dispatched unit of this transfer has already been accounted for.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold">What arrived</h3>
                <Button size="sm" variant="ghost" onClick={receiveAll}>
                  Everything arrived in good condition
                </Button>
              </div>
              {submitted && errors.lines && (
                <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {errors.lines}
                </p>
              )}
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Medicine', 'Batch Number', 'Dispatched Quantity', 'Previously Received', 'Remaining Quantity', 'Current Received Quantity', 'Damaged', 'Missing / Short', 'Remarks', 'Still Expected'].map((h, i) => (
                        <th key={h} className={cx('px-2.5 py-2.5 font-semibold', i >= 2 && i !== 8 && 'text-right')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const problem = shown(`line.${i}`);
                      const needsRemarks = hasLineDiscrepancy(l);
                      const remarksProblem = shown(`line.${i}.remarks`);
                      const label = `${l.medicineName} batch ${l.batchNumber}`;
                      return (
                        <tr key={l.batchId} className="border-t border-line align-top">
                          <td className="px-2.5 py-3 font-semibold">
                            {l.medicineName}
                            {l.unit && <div className="text-xs font-normal text-muted">{l.unit}</div>}
                          </td>
                          <td className="px-2.5 py-3">
                            <span className="rounded-md bg-subtle px-2 py-1 font-mono text-[12px]">{l.batchNumber}</span>
                          </td>
                          <td className="px-2.5 py-3 text-right tabular-nums">{l.dispatched}</td>
                          <td className="px-2.5 py-3 text-right tabular-nums text-muted">{l.previouslyReceived}</td>
                          <td className="px-2.5 py-3 text-right font-semibold tabular-nums">{l.remaining}</td>
                          <td className="px-2.5 py-3 text-right">
                            <input aria-label={`Received quantity of ${label}`} aria-invalid={Boolean(problem)} type="number" min="0" step="1" value={l.quantity} onChange={(e) => edit(i, 'quantity', e.target.value)} className={cx(inputCls, numCls, 'ml-auto', problem && 'border-danger')} />
                          </td>
                          <td className="px-2.5 py-3 text-right">
                            <input aria-label={`Damaged quantity of ${label}`} aria-invalid={Boolean(problem)} type="number" min="0" step="1" value={l.damaged} onChange={(e) => edit(i, 'damaged', e.target.value)} className={cx(inputCls, numCls, 'ml-auto', problem && 'border-danger')} />
                          </td>
                          <td className="px-2.5 py-3 text-right">
                            <input aria-label={`Missing quantity of ${label}`} aria-invalid={Boolean(problem)} type="number" min="0" step="1" value={l.missing} onChange={(e) => edit(i, 'missing', e.target.value)} className={cx(inputCls, numCls, 'ml-auto', problem && 'border-danger')} />
                          </td>
                          <td className="px-2.5 py-3">
                            <input
                              aria-label={`Remarks for ${label}`}
                              aria-invalid={Boolean(remarksProblem)}
                              value={l.remarks}
                              maxLength={300}
                              placeholder={needsRemarks ? 'Required: what happened?' : 'Optional'}
                              onChange={(e) => edit(i, 'remarks', e.target.value)}
                              className={cx(inputCls, 'h-9 min-w-44', needsRemarks && !remarksProblem && 'border-warning', remarksProblem && 'border-danger')}
                            />
                          </td>
                          <td className={cx('px-2.5 py-3 text-right font-semibold tabular-nums', stillExpected(l) > 0 ? 'text-warning' : 'text-success')}>{stillExpected(l)}</td>
                        </tr>
                      );
                    }).flatMap((row, i) => {
                      const k = `line.${i}`;
                      const msgs = [shown(k), shown(`${k}.remarks`)].filter(Boolean);
                      return msgs.length
                        ? [row, <tr key={`${lines[i].batchId}-err`}><td colSpan={10} className="bg-danger/5 px-2.5 py-1.5"><p role="alert" className="text-xs text-danger">{msgs.join(' ')}</p></td></tr>]
                        : [row];
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line bg-subtle/60 text-sm font-semibold">
                      <td colSpan={5} className="px-2.5 py-2">
                        This receipt
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{totals.r}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{totals.d}</td>
                      <td className="px-2.5 py-2 text-right tabular-nums">{totals.m}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {discrepancy && (
                <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {totals.d > 0 && `${totals.d} damaged`}
                    {totals.d > 0 && totals.m > 0 && ' and '}
                    {totals.m > 0 && `${totals.m} missing or short`}. These units are recorded as a discrepancy, not added to {t.toBranch.name}’s stock. Remarks are required for each affected line.
                  </span>
                </p>
              )}

              {leavesExpected(lines) && (
                <div className="rounded-xl border border-line px-4 py-3 text-sm">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" checked={closeReceipt} onChange={(e) => setCloseReceipt(e.target.checked)} />
                    <span>
                      <span className="block font-semibold">Nothing more is coming — close this receipt</span>
                      <span className="block text-xs text-muted">The units still expected will be recorded as missing and the transfer completed. Leave unticked to receive the rest later.</span>
                    </span>
                  </label>
                  {closeReceipt && (
                    <div className="mt-3">
                      <FormField label="Why is the rest not coming?" required error={shown('remarks')}>
                        {(a) => <input {...a} value={remarks} maxLength={500} onChange={(e) => {
                          setRemarks(e.target.value);
                          setServerErrors({});
                        }} placeholder="e.g. Supplier confirmed the last cartons were not loaded" className={cx(inputCls, shown('remarks') && 'border-danger')} />}
                      </FormField>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
