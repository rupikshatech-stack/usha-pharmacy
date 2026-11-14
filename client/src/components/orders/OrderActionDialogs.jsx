import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { orderService } from '../../services/orderService';
import { useFetch } from '../../hooks/useFetch';
import { Button, ErrorState, FormField, Modal, cx, inputCls } from '../common/ui';

/** Runs a server call from a dialog: success toast and close, or the server's message in the dialog. */
function useAction(run, success, onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await run();
      toast.success(success);
      onDone(r);
    } catch (e) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}
const ErrorLine = ({ error }) =>
  error ? (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
    </p>
  ) : null;

/** Send a pending order back to draft, with the reason. */
export function RejectOrderDialog({ order, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = reason.trim().length < 3;
  const a = useAction(() => orderService.reject(order._id, reason.trim()), `Order ${order.orderNo} sent back to draft`, onDone);
  return (
    <Modal
      title={`Send back order ${order.orderNo}`}
      description="The order returns to draft so it can be corrected and submitted again."
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
            <X className="h-4 w-4" /> Send back
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Reason" required error={touched && short ? 'Give a reason (at least 3 characters).' : undefined}>
          {(p) => <textarea {...p} rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className={cx(inputCls, 'h-auto py-2')} />}
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/** Cancel an order before anything has arrived. */
export function CancelOrderDialog({ order, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const a = useAction(() => orderService.cancel(order._id, reason.trim()), `Order ${order.orderNo} cancelled`, onDone);
  return (
    <Modal
      title={`Cancel order ${order.orderNo}?`}
      description="An order can only be cancelled before any goods have arrived."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Keep order
          </Button>
          <Button variant="danger" onClick={a.go} loading={a.busy}>
            Cancel order
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Reason" hint="Optional.">
          {(p) => <input {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />}
        </FormField>
        <ErrorLine error={a.error} />
      </div>
    </Modal>
  );
}

/** Whether submitted orders need approval before they can be marked as ordered. */
export function OrderSettingsDialog({ onClose }) {
  const { data, loading, error, reload } = useFetch('/orders/settings');
  const [value, setValue] = useState(null);
  const current = value ?? data?.approvalRequired ?? false;
  const a = useAction(() => orderService.saveSettings(current), 'Order settings saved', onClose);
  return (
    <Modal
      title="Order settings"
      description="How supplier orders move from draft to ordered."
      onClose={() => !a.busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={a.busy}>
            Cancel
          </Button>
          <Button onClick={a.go} loading={a.busy} disabled={!data}>
            Save
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" disabled={loading && !data} checked={current} onChange={(e) => setValue(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--primary)]" />
            <span>
              <span className="font-semibold">Orders must be approved before they can be placed</span>
              <span className="block text-muted">When on, a submitted order waits for someone with approval rights. When off, it is approved as soon as it is submitted.</span>
            </span>
          </label>
          <ErrorLine error={a.error} />
        </div>
      )}
    </Modal>
  );
}
