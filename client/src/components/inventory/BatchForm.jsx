import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { batchService } from '../../services/batchService';
import { blankBatch, newBatchPayload, validateNewBatch } from '../../utils/batchValidation';
import { serverFieldErrors } from '../../utils/medicineValidation';
import { Button, ConfirmDialog, Input, Modal } from '../common/ui';
import MedicinePicker from './MedicinePicker';

/**
 * Receive a new batch. The medicine is chosen here (or passed in). Expired batches can't be received, and the
 * batch number, expiry date and quantity are fixed once saved, so they are worth double-checking.
 */
export default function BatchForm({ medicine: preset, onDone, onClose }) {
  const [initial] = useState(() => ({ ...blankBatch, medicineId: preset?._id || '', manufacturer: preset?.manufacturer || '' }));
  const [v, setV] = useState(initial);
  const [today] = useState(() => new Date().toISOString().slice(0, 10)); // yyyy-mm-dd, fixed while the form is open
  const [tomorrow] = useState(() => new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  const [medicine, setMedicine] = useState(preset || null);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef(null);

  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const errors = validateNewBatch(v);
  const err = (k) => serverErrors[k] || (submitted || touched[k] ? errors[k] : undefined);
  const set = (k) => (e) => {
    setV((s) => ({ ...s, [k]: e.target.value }));
    setServerErrors((s) => (s[k] ? { ...s, [k]: undefined } : s));
  };
  const f = (k, label, extra) => (
    <Input label={label} value={v[k]} onChange={set(k)} onBlur={() => setTouched((t) => ({ ...t, [k]: true }))} error={err(k)} {...extra} />
  );
  const focusFirst = () => requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());

  const chooseMedicine = (m) => {
    setMedicine(m);
    setV((s) => ({ ...s, medicineId: m?._id || '', manufacturer: s.manufacturer || m?.manufacturer || '' }));
    setServerErrors((s) => ({ ...s, medicineId: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return focusFirst();
    setBusy(true);
    try {
      const saved = await batchService.create(newBatchPayload(v));
      toast.success(`Batch ${saved.batchNumber} received for ${medicine?.medicineName || 'the medicine'} (+${saved.availableQuantity})`);
      onDone(saved);
    } catch (ex) {
      const { fields, general } = serverFieldErrors({ ...ex, details: ex.details });
      // the server reports batch-level problems on named fields; a duplicate batch number has no path, so place it
      if (ex.code === 'DUPLICATE_BATCH') setServerErrors({ batchNumber: ex.message });
      else if (Object.keys(fields).length || (ex.details || []).length) setServerErrors(Object.fromEntries((ex.details || []).map((d) => [String(d.path).split('.')[0], d.message])));
      else toast.error(general);
      focusFirst();
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
        title="Add batch"
        description="Receive stock for a medicine. Batch number, expiry date and quantity can't be changed afterwards."
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="batch-form" loading={busy}>
              Add batch
            </Button>
          </>
        }
      >
        <form id="batch-form" ref={formRef} onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
          <MedicinePicker required value={medicine} onChange={chooseMedicine} error={err('medicineId')} autoFocus={!preset} />
          {f('batchNumber', 'Batch number', { required: true, maxLength: 50, placeholder: 'e.g. BT2407A', autoFocus: Boolean(preset) })}
          {f('manufacturer', 'Manufacturer', { maxLength: 120, placeholder: 'Defaults to the medicine’s manufacturer' })}
          {f('manufacturingDate', 'Manufacturing date', { type: 'date', max: today })}
          {f('expiryDate', 'Expiry date', { type: 'date', required: true, min: tomorrow })}
          {f('initialQuantity', 'Quantity received', { type: 'number', min: '1', step: '1', required: true })}
          {f('purchasePrice', 'Purchase price', { type: 'number', min: '0', step: '0.01', placeholder: '0.00' })}
          {f('mrp', 'MRP', { type: 'number', min: '0', step: '0.01', required: true })}
          {f('sellingPrice', 'Selling price', { type: 'number', min: '0', step: '0.01', required: true, hint: 'Cannot be higher than the MRP.' })}
        </form>
      </Modal>
      {confirming && (
        <ConfirmDialog danger title="Discard this batch?" message="The batch hasn't been saved. If you close now, what you entered will be lost." confirmLabel="Discard" onConfirm={onClose} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}
