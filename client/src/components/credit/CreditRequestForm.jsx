import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { creditService } from '../../services/creditService';
import { ACCEPT, amountProblem, conversionNote, estimate, fileProblem, fileSize, rupees, serverErrors, toAmountText } from '../../utils/credit';
import { newIdempotencyKey } from '../../utils/format';
import { Button, Card, FormField, cx, inputCls } from '../common/ui';

/**
 * Submit Credit Request: the amount paid and a screenshot of the payment. Both are checked here and again by the server; the request is created as Pending for
 * the signed-in person. The form is cleared only after the server accepted it, and the send button is disabled while sending, so it cannot be sent twice.
 */
export default function CreditRequestForm({ settings, onSubmitted }) {
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [key, setKey] = useState(() => newIdempotencyKey()); // one key per request being filled in: a repeated send is the same request
  const input = useRef(null);
  const rate = settings?.rupeesPerCredit ?? 5;
  const limits = { maxMB: settings?.maxFileMB ?? 5, max: settings?.maxAmount ?? 1000000 };

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a preview address is made (and released) with each chosen file
    setPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setPreview('');
    };
  }, [file]);

  const choose = (f) => {
    if (!f) return;
    const problem = fileProblem(f, limits);
    setErrors((e) => ({ ...e, screenshot: problem || undefined }));
    if (problem) return;
    setFile(f);
  };
  const remove = () => {
    setFile(null);
    if (input.current) input.current.value = '';
    setErrors((e) => ({ ...e, screenshot: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const found = { amount: amountProblem(amount, limits) || undefined, screenshot: fileProblem(file, limits) || undefined };
    setErrors(found);
    if (found.amount || found.screenshot) {
      toast.error('Please fix the highlighted fields.');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const r = await creditService.submit(file, toAmountText(amount), key, setProgress);
      toast.success(`Credit request ${r.requestNo} submitted. It is pending review.`);
      setAmount('');
      remove();
      setKey(newIdempotencyKey()); // the next request is a new one
      onSubmitted?.(r);
    } catch (ex) {
      const fields = serverErrors(ex.details);
      if (Object.keys(fields).length) setErrors(fields);
      toast.error(ex.message); // the form keeps what was typed
    } finally {
      setBusy(false);
    }
  };

  const est = estimate(amount, rate);
  return (
    <Card className="mx-auto w-full max-w-xl rounded-2xl p-5 shadow-sm sm:p-8">
      <h2 className="text-lg font-bold tracking-tight">Submit Credit Request</h2>
      <p className="mt-1 text-sm text-muted">Provide your requested limit and a screenshot of the payment.</p>

      <form onSubmit={submit} noValidate className="mt-6 space-y-5">
        <FormField
          label="Payment Amount (₹)"
          required
          error={errors.amount}
          hint={est ? `About ${est} credit${est === 1 ? '' : 's'} (whole credits) at ${rupees(rate)} per credit — the administrator decides the final credits.` : undefined}
        >
          {(a) => (
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true">
                ₹
              </span>
              <input
                {...a}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amount}
                disabled={busy}
                onChange={(e) => {
                  setAmount(e.target.value);
                  if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
                }}
                className={cx(inputCls, 'pl-7 tabular-nums', errors.amount && 'border-danger')}
              />
            </div>
          )}
        </FormField>

        <FormField label="Payment Screenshot" required error={errors.screenshot} hint={`JPG, JPEG, PNG or WEBP, up to ${limits.maxMB} MB.`}>
          {(a) => (
            <div>
              <input
                ref={input}
                id={a.id}
                aria-describedby={a['aria-describedby']}
                aria-invalid={a['aria-invalid']}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                disabled={busy}
                onChange={(e) => choose(e.target.files?.[0])}
              />
              {!file ? (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    choose(e.dataTransfer.files?.[0]);
                  }}
                  className={cx('rounded-xl border-2 border-dashed p-6 text-center', errors.screenshot ? 'border-danger' : 'border-line')}
                >
                  <Upload className="mx-auto h-7 w-7 text-muted" aria-hidden="true" />
                  <p className="mt-2 text-sm font-semibold">Drag and drop the payment screenshot here</p>
                  <Button type="button" variant="secondary" className="mt-3" onClick={() => input.current?.click()}>
                    Choose File
                  </Button>
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-line p-3">
                  <div className="flex items-center gap-3 text-sm">
                    <ImageIcon className="h-6 w-6 shrink-0 text-muted" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold" data-testid="credit-file-name">
                        {file.name}
                      </div>
                      <div className="text-xs text-muted">{fileSize(file.size)}</div>
                    </div>
                    <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} disabled={busy}>
                      Replace
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={busy} aria-label="Remove file">
                      <X className="h-4 w-4" /> <span className="hidden sm:inline">Remove</span>
                    </Button>
                  </div>
                  {preview && <img src={preview} alt={`Preview of ${file.name}`} className="max-h-72 w-full rounded-lg bg-subtle object-contain" />}
                </div>
              )}
            </div>
          )}
        </FormField>

        {busy && (
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1.5 overflow-hidden rounded-full bg-subtle"
          >
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        <Button type="submit" variant="accent" className="w-full" loading={busy} disabled={busy}>
          Submit Request
        </Button>
        <p className="text-xs text-muted">{conversionNote(rate)}</p>
      </form>
    </Card>
  );
}
