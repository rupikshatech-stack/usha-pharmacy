import { useState } from 'react';
import { Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { batchService } from '../../services/batchService';
import { batchEditPayload, validateBatchEdit } from '../../utils/batchValidation';
import { expiryFmt } from '../../utils/format';
import { Button, ConfirmDialog, Input, Modal, Select } from '../common/ui';

const STATUS_OPTIONS = [
  ['active', 'Active'],
  ['quarantined', 'Quarantined (hold, not sellable)'],
  ['recalled', 'Recalled (not sellable)'],
  ['archived', 'Archived (only when empty)'],
];

/** Edit the permitted parts of a batch: prices, manufacturer, status and reserved quantity. Identity is shown read-only. */
export default function BatchEditForm({ batch, onDone, onClose }) {
  const [start] = useState(() => ({
    purchasePrice: String(batch.purchasePrice ?? 0),
    sellingPrice: String(batch.sellingPrice),
    mrp: String(batch.mrp),
    manufacturer: batch.manufacturer || '',
    reservedQuantity: String(batch.reservedQuantity ?? 0),
    status: batch.status,
  }));
  const [v, setV] = useState(start);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const errors = validateBatchEdit(v, batch);
  const err = (k) => serverErrors[k] || (submitted ? errors[k] : undefined);
  const set = (k) => (e) => {
    setV((s) => ({ ...s, [k]: e.target.value }));
    setServerErrors((s) => (s[k] ? { ...s, [k]: undefined } : s));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    const body = batchEditPayload(v, batch);
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const saved = await batchService.update(batch._id, body);
      toast.success(`Batch ${batch.batchNumber} updated`);
      onDone(saved);
    } catch (ex) {
      const fieldErrors = Object.fromEntries((ex.details || []).map((d) => [String(d.path).split('.')[0], d.message]));
      if (ex.code === 'BATCH_NOT_EMPTY') fieldErrors.status = ex.message;
      if (Object.keys(fieldErrors).length) setServerErrors(fieldErrors);
      else toast.error(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy || confirming) return;
    if (dirty) setConfirming(true);
    else onClose();
  };

  return (
    <>
      <Modal
        wide
        title={`Edit batch ${batch.batchNumber}`}
        description={batch.medicineName}
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="batch-edit-form" loading={busy} disabled={!dirty}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-subtle p-3 text-sm sm:grid-cols-4">
          {[
            ['Batch number', batch.batchNumber],
            ['Expiry date', expiryFmt(batch.expiryDate)],
            ['Quantity received', batch.initialQuantity],
            ['On hand', batch.availableQuantity],
          ].map(([k, val]) => (
            <div key={k}>
              <div className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted">
                <Lock className="h-3 w-3" aria-hidden="true" /> {k}
              </div>
              <div className="font-semibold tabular-nums">{val}</div>
            </div>
          ))}
          <p className="col-span-full text-xs text-muted">These are fixed. To change the quantity, record a stock adjustment — it is kept in the batch history.</p>
        </div>

        <form id="batch-edit-form" onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
          <Input label="Manufacturer" value={v.manufacturer} onChange={set('manufacturer')} error={err('manufacturer')} maxLength={120} />
          <Select label="Status" value={v.status} onChange={set('status')} error={err('status')}>
            {STATUS_OPTIONS.map(([val, label]) => (
              <option key={val} value={val}>
                {label}
              </option>
            ))}
          </Select>
          <Input label="Purchase price" type="number" min="0" step="0.01" value={v.purchasePrice} onChange={set('purchasePrice')} error={err('purchasePrice')} />
          <Input label="MRP" type="number" min="0" step="0.01" value={v.mrp} onChange={set('mrp')} error={err('mrp')} />
          <Input label="Selling price" type="number" min="0" step="0.01" value={v.sellingPrice} onChange={set('sellingPrice')} error={err('sellingPrice')} hint="Cannot be higher than the MRP." />
          <Input label="Reserved quantity" type="number" min="0" step="1" value={v.reservedQuantity} onChange={set('reservedQuantity')} error={err('reservedQuantity')} hint="Units set aside; they can't be sold." />
        </form>
      </Modal>
      {confirming && (
        <ConfirmDialog danger title="Discard changes?" message="You have unsaved changes to this batch. If you close now they will be lost." confirmLabel="Discard changes" onConfirm={onClose} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}
