import { useState } from 'react';
import { AlertTriangle, ArrowLeftRight, Check, PackageX, Percent, Trash2, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../../services/analyticsService';
import { useFetch } from '../../../hooks/useFetch';
import { inr } from '../../../utils/format';
import { Button, FormField, Modal, Spinner, cx, inputCls } from '../../common/ui';

/**
 * The dialogs behind the register's actions.
 *
 * Each one has to make the same thing obvious before it is confirmed: WHETHER THIS MOVES STOCK. Writing a lot off and
 * flagging it for clearance look similar on screen and are nothing alike in consequence — one destroys inventory and
 * the other leaves a note for whoever sets prices. So each dialog states its own consequence in plain words, and the
 * destructive one asks for a reason and wears the danger colour.
 */

/** Runs a server call from a dialog: a toast and close on success, the server's own words in the dialog on failure. */
function useAction(run, success, onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setFields({});
    try {
      const r = await run();
      toast.success(typeof success === 'function' ? success(r) : success);
      onDone(r);
    } catch (e) {
      const f = {};
      for (const d of e.details || []) if (d.path && !f[d.path]) f[d.path] = d.message;
      setFields(f);
      setError(Object.keys(f).length ? '' : e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, go };
}

const ErrorLine = ({ error }) =>
  error ? (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
    </p>
  ) : null;

/** What the selection amounts to, so nobody confirms a bulk action without seeing its size. */
function Selection({ rows, children }) {
  const units = rows.reduce((n, r) => n + r.quantity, 0);
  const value = rows.reduce((n, r) => n + r.costValue, 0);
  return (
    <div className="rounded-lg bg-subtle px-3 py-2 text-sm">
      <p className="font-semibold">
        {rows.length} lot{rows.length === 1 ? '' : 's'} · {units.toLocaleString('en-IN')} units · {inr(value)} at cost
      </p>
      {rows.length === 1 && (
        <p className="mt-0.5 text-xs text-muted">
          {rows[0].medicineName} · batch {rows[0].batchNumber}
          {rows[0].branchName ? ` · ${rows[0].branchName}` : ''}
        </p>
      )}
      {rows.length > 1 && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{rows.map((r) => r.batchNumber).join(', ')}</p>}
      {children}
    </div>
  );
}

/** A consequence, said once, in the place the person is about to act. */
const Consequence = ({ moves, children }) => (
  <p className={cx('rounded-lg border px-3 py-2 text-sm', moves ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-card text-muted')}>{children}</p>
);

const DISPOSAL_REASONS = ['Expired on the shelf', 'Damaged in storage', 'Broken or leaking packaging', 'Recalled by the manufacturer', 'Failed a quality check'];

/**
 * Writing stock off. The one action here that destroys inventory, so it asks why, offers the usual answers rather than
 * inviting a one-word note, and says in as many words that it cannot be undone.
 */
export function DisposeDialog({ rows, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [custom, setCustom] = useState('');
  const text = reason === 'Other' ? custom.trim() : reason;
  const units = rows.reduce((n, r) => n + r.quantity, 0);
  const value = rows.reduce((n, r) => n + r.costValue, 0);
  const a = useAction(
    () => analyticsService.expiryAction({ action: 'dispose', batchIds: rows.map((r) => r.id), reason: text }),
    (r) => `Wrote off ${r.units.toLocaleString('en-IN')} units worth ${inr(r.value)}`,
    onDone,
  );

  return (
    <Modal
      title={rows.length === 1 ? 'Write off this lot' : `Write off ${rows.length} lots`}
      description="The stock is removed and the loss is recorded against this reason."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={a.go} loading={a.busy} disabled={text.length < 3}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Write off {units.toLocaleString('en-IN')} units
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Selection rows={rows} />
        <Consequence moves>
          This removes {units.toLocaleString('en-IN')} units worth {inr(value)} from stock and cannot be undone. The write-off is posted to the stock ledger under your name.
        </Consequence>
        <FormField label="Why is it being written off?" required error={a.fields.reason}>
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} disabled={a.busy}>
            <option value="">Choose a reason…</option>
            {DISPOSAL_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
            <option value="Other">Something else…</option>
          </select>
        </FormField>
        {reason === 'Other' && (
          <FormField label="Say what happened" required>
            <input className={inputCls} value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={300} disabled={a.busy} placeholder="In a few words…" />
          </FormField>
        )}
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/**
 * Marking for clearance. It records a SUGGESTED discount and changes no price — which the dialog says outright,
 * because a pharmacist who thinks this repriced the stock will be unpleasantly surprised at the till.
 */
export function ClearanceDialog({ rows, maxDiscount = 50, onClose, onDone }) {
  // The server already worked out what it would suggest for each lot; the highest is the sensible starting point.
  const suggested = Math.min(maxDiscount, Math.max(0, ...rows.map((r) => r.suggestedDiscount || 0)) || 10);
  const [discount, setDiscount] = useState(suggested);
  const [note, setNote] = useState('');
  const a = useAction(
    () => analyticsService.expiryAction({ action: 'clearance', batchIds: rows.map((r) => r.id), discountPercent: Number(discount), note: note.trim() || undefined }),
    `Marked for clearance at ${discount}%`,
    onDone,
  );

  const worstMrp = rows.reduce((n, r) => n + r.mrpValue, 0);
  return (
    <Modal
      title={rows.length === 1 ? 'Mark this lot for clearance' : `Mark ${rows.length} lots for clearance`}
      description="Records a suggested discount for whoever sets prices."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy}>
            <Percent className="h-4 w-4" aria-hidden="true" /> Mark at {discount}%
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Selection rows={rows} />
        <Consequence>
          <strong className="font-semibold text-ink">No price is changed and no stock moves.</strong> The lot is flagged with this discount so the people who set prices can act on it.
        </Consequence>
        <FormField label="Suggested discount" hint={`At ${discount}% these lots would retail for about ${inr((worstMrp * (100 - discount)) / 100)} instead of ${inr(worstMrp)}.`} error={a.fields.discountPercent}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={maxDiscount}
              step={5}
              value={discount}
              onChange={(e) => setDiscount(Number(e.target.value))}
              disabled={a.busy}
              className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-subtle accent-[var(--primary)]"
              aria-label="Suggested discount percentage"
            />
            <span className="w-14 shrink-0 text-right text-lg font-bold tabular-nums">{discount}%</span>
          </div>
        </FormField>
        {suggested > 0 && discount !== suggested && (
          <button type="button" className="text-xs font-semibold text-accent hover:underline" onClick={() => setDiscount(suggested)}>
            Use the suggested {suggested}%
          </button>
        )}
        <FormField label="Note (optional)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} disabled={a.busy} placeholder="e.g. push it at the counter" />
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/** Taking a lot back off clearance. Nothing to decide, so it is a plain confirmation. */
export function ClearanceClearDialog({ rows, onClose, onDone }) {
  const a = useAction(() => analyticsService.expiryAction({ action: 'clearanceClear', batchIds: rows.map((r) => r.id) }), 'Taken off clearance', onDone);
  return (
    <Modal
      title={rows.length === 1 ? 'Take this lot off clearance' : `Take ${rows.length} lots off clearance`}
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy}>
            <Undo2 className="h-4 w-4" aria-hidden="true" /> Take off clearance
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Selection rows={rows} />
        <Consequence>The suggested discount is withdrawn. No price and no stock changes.</Consequence>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/**
 * Asking the supplier to take a lot back. This quarantines the stock — it cannot be sold while the supplier decides —
 * but the units remain ours and on the books until they are actually collected, which the dialog says plainly.
 */
export function ReturnRequestDialog({ rows, onClose, onDone }) {
  const [note, setNote] = useState('');
  const a = useAction(
    () => analyticsService.expiryAction({ action: 'returnRequest', batchIds: rows.map((r) => r.id), note: note.trim() || undefined }),
    (r) => `Return requested for ${r.batches} lot${r.batches === 1 ? '' : 's'} worth ${inr(r.value)}`,
    onDone,
  );
  const suppliers = [...new Set(rows.map((r) => r.supplierName).filter(Boolean))];

  return (
    <Modal
      title={rows.length === 1 ? 'Request a supplier return' : `Request a supplier return for ${rows.length} lots`}
      description="Sets the stock aside and records that you have asked for it back."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy}>
            <PackageX className="h-4 w-4" aria-hidden="true" /> Request return
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Selection rows={rows}>{suppliers.length > 0 && <p className="mt-1 text-xs font-semibold">To: {suppliers.join(', ')}</p>}</Selection>
        <Consequence>
          The stock is <strong className="font-semibold text-ink">quarantined</strong> so it cannot be sold, but it stays ours and stays on the books until the supplier actually takes it. No debit note is
          raised. You can cancel this at any time.
        </Consequence>
        <FormField label="Note for your own records (optional)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} disabled={a.busy} placeholder="e.g. short dated on arrival" />
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

const OUTCOMES = [
  { value: 'returned', label: 'The supplier took it back', help: 'Removes the stock. This is the only outcome that does.', danger: true },
  { value: 'rejected', label: 'The supplier refused', help: 'The stock is ours. It comes out of quarantine and goes back on sale.' },
  { value: 'cancelled', label: 'Cancel the request', help: 'We changed our minds. The stock comes out of quarantine and goes back on sale.' },
];

/**
 * Closing a supplier return, one of three ways — and the dialog's job is to make the one that moves stock stand out
 * from the two that do not. Cancelling is here as a first-class option because quarantining a lot must never be a
 * one-way door: setting aside the wrong lot has to be fixable without an administrator.
 */
export function ReturnSettleDialog({ rows, onClose, onDone }) {
  const [outcome, setOutcome] = useState('returned');
  const [note, setNote] = useState('');
  const a = useAction(
    () => analyticsService.expiryAction({ action: 'returnSettle', batchIds: rows.map((r) => r.id), outcome, note: note.trim() || undefined }),
    (r) => (r.outcome === 'returned' ? `Recorded as returned — ${r.units.toLocaleString('en-IN')} units removed` : r.outcome === 'rejected' ? 'Recorded as refused — the stock is back on sale' : 'Request cancelled — the stock is back on sale'),
    onDone,
  );
  const chosen = OUTCOMES.find((o) => o.value === outcome);

  return (
    <Modal
      title={rows.length === 1 ? 'Close this supplier return' : `Close ${rows.length} supplier returns`}
      description="What happened with the supplier?"
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button variant={chosen?.danger ? 'danger' : 'primary'} onClick={a.go} loading={a.busy}>
            <Check className="h-4 w-4" aria-hidden="true" /> {chosen?.label}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Selection rows={rows} />
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-[13px] font-semibold">What happened?</legend>
          {OUTCOMES.map((o) => (
            <label
              key={o.value}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                outcome === o.value ? 'border-primary bg-primary/5' : 'border-line hover:bg-subtle',
              )}
            >
              <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} disabled={a.busy} className="mt-0.5 accent-[var(--primary)]" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{o.label}</span>
                <span className={cx('block text-xs', o.danger ? 'font-semibold text-danger' : 'text-muted')}>{o.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <FormField label="Note (optional)">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} disabled={a.busy} placeholder="e.g. collected by the rep" />
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/**
 * Where this lot would be likeliest to sell. It is advice and says so: moving stock between stores goes through the
 * transfer module, with its approvals and its dispatch and receipt steps, and short-circuiting that from a report
 * would be a way to lose stock.
 */
export function TransferSuggestionDialog({ row, onClose }) {
  const { data, loading, error } = useFetch(`/analytics/expiry/batches/${row.id}/transfer-suggestion`);
  return (
    <Modal
      title="Where would this sell?"
      description={`${row.medicineName} · batch ${row.batchNumber}`}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading && <Spinner label="Looking at what each store sells…" />}
      {error && <ErrorLine error={error} />}
      {data && (
        <div className="space-y-3">
          {data.candidates.length === 0 ? (
            <p className="rounded-lg bg-subtle px-3 py-3 text-sm text-muted">{data.note}</p>
          ) : (
            <>
              <p className="text-xs text-muted">Measured over the last {data.velocityWindowDays} days. {row.quantity.toLocaleString('en-IN')} units to move.</p>
              <ul className="space-y-2">
                {data.candidates.map((c, i) => (
                  <li key={c.branchId} className={cx('flex items-center justify-between gap-3 rounded-lg border p-3', i === 0 ? 'border-primary bg-primary/5' : 'border-line')}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {c.branchName}
                        {i === 0 && <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-accent">Best match</span>}
                      </p>
                      <p className="text-xs text-muted">{c.avgDailySales} a day</p>
                    </div>
                    <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                      {c.daysToClear === null ? '—' : `~${c.daysToClear}d to clear`}
                      {c.daysToClear !== null && row.daysToExpiry !== null && (
                        <span className={cx('block text-[11px] font-semibold', c.daysToClear <= row.daysToExpiry ? 'text-success' : 'text-danger')}>
                          {c.daysToClear <= row.daysToExpiry ? 'in time' : 'still too slow'}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs text-muted">
                <ArrowLeftRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {data.note}
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Picks the right dialog for an action. Keeps the page from knowing about any of them individually. */
export function ExpiryActionDialog({ action, rows, maxDiscount, onClose, onDone }) {
  if (!action || !rows?.length) return null;
  const props = { rows, onClose, onDone };
  if (action === 'dispose') return <DisposeDialog {...props} />;
  if (action === 'clearance') return <ClearanceDialog {...props} maxDiscount={maxDiscount} />;
  if (action === 'clearanceClear') return <ClearanceClearDialog {...props} />;
  if (action === 'returnRequest') return <ReturnRequestDialog {...props} />;
  if (action === 'returnSettle') return <ReturnSettleDialog {...props} />;
  if (action === 'transfer') return <TransferSuggestionDialog row={rows[0]} onClose={onClose} />;
  return null;
}
