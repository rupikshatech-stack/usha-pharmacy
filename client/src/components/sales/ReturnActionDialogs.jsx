import { useState } from 'react';
import { AlertTriangle, Banknote, Check, Pencil, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesReturnService } from '../../services/salesReturnService';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { Button, FormField, Modal, cx, inputCls } from '../common/ui';

const REFERENCE_METHODS = ['UPI', 'Card', 'Bank Transfer'];
// Where a refund may go from its current state (the server enforces the same; a paid refund is final).
export const NEXT_REFUND_STATUS = {
  pending: ['processing', 'completed', 'failed'],
  processing: ['pending', 'completed', 'failed'],
  failed: ['pending', 'processing', 'completed'],
  completed: [],
};
const STATUS_LABEL = { pending: 'Pending', processing: 'Processing', completed: 'Completed', failed: 'Failed' };

/** Runs a server call from a dialog: success toast and close, or the server's message in the dialog. */
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

/** Approve a pending return. If staff marked units for restocking, approving adds exactly those verified units back — unless "don't restock" is chosen. */
export function ApproveReturnDialog({ ret, onClose, onDone }) {
  const planned = ret.items.filter((i) => i.restock && !i.restockedQuantity);
  const units = planned.reduce((n, i) => n + i.quantity, 0);
  const [skip, setSkip] = useState(false);
  const a = useAction(() => salesReturnService.approve(ret._id, { doNotRestock: skip }), `Return ${ret.returnNo} approved`, onDone);
  return (
    <Modal
      title={`Approve return ${ret.returnNo}`}
      description="Approving accepts the return. It never adds stock by itself."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy}>
            <Check className="h-4 w-4" /> Approve
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          {ret.customer?.name} · {inr(ret.returnValue)} · {ret.reasonLabel}
        </p>
        {units > 0 ? (
          <>
            <p className="rounded-lg bg-subtle px-3 py-2">
              The person who recorded this return inspected {units} unit{units === 1 ? '' : 's'} and marked {units === 1 ? 'it' : 'them'} for restocking. They go back into the
              batch they were sold from.
            </p>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              <span>Approve without adding these units back to stock</span>
            </label>
          </>
        ) : (
          <p className="text-muted">No units were marked for restocking, so stock will not change.</p>
        )}
        <ErrorLine error={a.error || a.fields['items.0.restock']} />
      </div>
    </Modal>
  );
}

export function RejectReturnDialog({ ret, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = reason.trim().length < 3;
  const a = useAction(() => salesReturnService.reject(ret._id, reason.trim()), `Return ${ret.returnNo} rejected — its units are returnable again`, onDone);
  return (
    <Modal
      title={`Reject return ${ret.returnNo}`}
      description="The units and the refund go back to the invoice, so they can be returned properly."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={a.busy}
            onClick={() => {
              setTouched(true);
              if (!short) a.go();
            }}
          >
            <X className="h-4 w-4" /> Reject return
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Reason for rejecting" required error={(touched && short && 'Give a reason (at least 3 characters).') || a.fields.reason}>
          {(p) => <textarea {...p} rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className={cx(inputCls, 'h-auto py-2')} />}
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/** Record where the refund stands. Recording only: no payment is made from here. A completed refund is final. */
export function RefundDialog({ ret, onClose, onDone }) {
  const current = ret.refund?.status || 'pending';
  const options = NEXT_REFUND_STATUS[current] || [];
  const [status, setStatus] = useState(options[0] || 'processing');
  const [method, setMethod] = useState(ret.refund?.method || 'Cash');
  const [reference, setReference] = useState(ret.refund?.reference || '');
  const [remarks, setRemarks] = useState('');
  const [touched, setTouched] = useState(false);
  const refMissing = status === 'completed' && REFERENCE_METHODS.includes(method) && !reference.trim();
  const a = useAction(
    () => salesReturnService.refund(ret._id, { status, method, reference: reference.trim(), remarks: remarks.trim() }),
    `Refund for ${ret.returnNo} recorded as ${STATUS_LABEL[status].toLowerCase()}`,
    onDone,
  );
  return (
    <Modal
      title={`Process refund — ${ret.returnNo}`}
      description={`${inr(ret.refundAmount)} to ${ret.customer?.name}. This only records the refund; no payment is made from here.`}
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button
            variant="accent"
            loading={a.busy}
            disabled={options.length === 0}
            onClick={() => {
              setTouched(true);
              if (!refMissing) a.go();
            }}
          >
            <Banknote className="h-4 w-4" /> Record refund
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">Current refund status: {STATUS_LABEL[current]}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="New refund status" required>
            {(p) => (
              <select {...p} value={status} onChange={(e) => setStatus(e.target.value)} className={cx(inputCls, 'pr-8')}>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {STATUS_LABEL[o]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Refund method" required>
            {(p) => (
              <select {...p} value={method} onChange={(e) => setMethod(e.target.value)} className={cx(inputCls, 'pr-8')}>
                {['Cash', 'UPI', 'Card', 'Bank Transfer', 'Store Credit'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            label="Transaction / reference ID"
            error={(touched && refMissing && `Enter the ${method} transaction or reference ID for a completed refund.`) || a.fields.reference}
            hint="Needed for a completed UPI, card or bank transfer refund."
          >
            {(p) => <input {...p} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} className={inputCls} />}
          </FormField>
          <FormField label="Remarks">{(p) => <input {...p} value={remarks} maxLength={300} onChange={(e) => setRemarks(e.target.value)} className={inputCls} />}</FormField>
        </div>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/** Notes and the refund's method and remarks. Products, quantities and amounts stay as recorded: they drive stock and money. */
export function EditReturnDialog({ ret, onClose, onDone }) {
  const [notes, setNotes] = useState(ret.notes || '');
  const [method, setMethod] = useState(ret.refund?.method || 'Cash');
  const [remarks, setRemarks] = useState(ret.refund?.remarks || '');
  const a = useAction(() => salesReturnService.update(ret._id, { notes: notes.trim(), refund: { method, remarks: remarks.trim() } }), `Return ${ret.returnNo} updated`, onDone);
  return (
    <Modal
      title={`Edit return ${ret.returnNo}`}
      description="Products, quantities and amounts can't be changed after a return is recorded."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy}>
            <Pencil className="h-4 w-4" /> Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Additional remarks" error={a.fields.notes}>
          {(p) => <textarea {...p} rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} className={cx(inputCls, 'h-auto py-2')} />}
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Refund method">
            {(p) => (
              <select {...p} value={method} onChange={(e) => setMethod(e.target.value)} className={cx(inputCls, 'pr-8')}>
                {['Cash', 'UPI', 'Card', 'Bank Transfer', 'Store Credit'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label="Refund remarks">{(p) => <input {...p} value={remarks} maxLength={300} onChange={(e) => setRemarks(e.target.value)} className={inputCls} />}</FormField>
        </div>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}
