import { useState } from 'react';
import { AlertTriangle, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../../services/analyticsService';
import { Button, FormField, Modal, cx, inputCls } from '../../common/ui';

/**
 * The organization's own definitions of "soon" and "selling well".
 *
 * These are per-organization on purpose, and the dialog says so: a retail chemist turning stock over in a fortnight
 * and a wholesaler holding a quarter's supply do not mean the same thing by "expiring soon". One hard-coded set of
 * thresholds would make the whole screen quietly wrong for one of them.
 *
 * Changing them changes every figure on the screen, so the dialog is explicit about that rather than presenting
 * itself as a harmless preference.
 */
export default function ExpirySettingsDialog({ settings, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    near: settings.thresholds[0],
    soon: settings.thresholds[1],
    later: settings.thresholds[2],
    velocityWindowDays: settings.velocityWindowDays,
    supplierReturnWindowDays: settings.supplierReturnWindowDays,
    clearanceMaxDiscount: settings.clearanceMaxDiscount,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState({});

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value === '' ? '' : Number(e.target.value) }));
  const ordered = Number(form.near) < Number(form.soon) && Number(form.soon) < Number(form.later);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setFields({});
    try {
      const saved = await analyticsService.updateExpirySettings({
        thresholds: [Number(form.near), Number(form.soon), Number(form.later)],
        velocityWindowDays: Number(form.velocityWindowDays),
        supplierReturnWindowDays: Number(form.supplierReturnWindowDays),
        clearanceMaxDiscount: Number(form.clearanceMaxDiscount),
      });
      toast.success('Expiry settings saved. Every figure on this screen now uses them.');
      onSaved(saved);
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

  return (
    <Modal
      title="Expiry settings"
      description="What this organization means by “expiring soon” and “selling well”."
      onClose={() => !busy && onClose()}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!ordered}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Save settings
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg border border-line bg-subtle px-3 py-2 text-sm text-muted">
          These change <strong className="text-ink">every figure on this screen</strong> — the cards, the risk scores and the projected loss — for everyone in the organization. They do not
          change any stock.
        </p>

        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">The three expiry buckets</legend>
          <p className="mb-3 text-xs text-muted">The cards above the register count stock expiring within each of these. They nest: everything in the first is also in the second.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Urgent" hint="days" error={fields['thresholds.0']}>
              <input type="number" className={inputCls} value={form.near} min={1} max={730} onChange={set('near')} disabled={busy} />
            </FormField>
            <FormField label="Soon" hint="days" error={fields['thresholds.1']}>
              <input type="number" className={inputCls} value={form.soon} min={1} max={730} onChange={set('soon')} disabled={busy} />
            </FormField>
            <FormField label="Watch" hint="days" error={fields['thresholds.2']}>
              <input type="number" className={inputCls} value={form.later} min={1} max={730} onChange={set('later')} disabled={busy} />
            </FormField>
          </div>
          {!ordered && (
            <p className={cx('mt-2 flex items-start gap-2 text-sm text-danger')} role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Each bucket must be longer than the one before it.
            </p>
          )}
        </fieldset>

        <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          <FormField
            label="Velocity window"
            hint="Days of sales used to work out how fast a medicine moves. Shorter reacts quickly; longer is steadier."
            error={fields.velocityWindowDays}
          >
            <input type="number" className={inputCls} value={form.velocityWindowDays} min={7} max={365} onChange={set('velocityWindowDays')} disabled={busy} />
          </FormField>
          <FormField label="Supplier return window" hint="How close to expiry, either side, a distributor will still take stock back." error={fields.supplierReturnWindowDays}>
            <input type="number" className={inputCls} value={form.supplierReturnWindowDays} min={0} max={365} onChange={set('supplierReturnWindowDays')} disabled={busy} />
          </FormField>
          <FormField label="Largest clearance discount" hint="The most this report will ever suggest. It never changes a price." error={fields.clearanceMaxDiscount}>
            <input type="number" className={inputCls} value={form.clearanceMaxDiscount} min={0} max={90} onChange={set('clearanceMaxDiscount')} disabled={busy} />
          </FormField>
        </div>

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
