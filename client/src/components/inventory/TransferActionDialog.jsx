import { useState } from 'react';
import toast from 'react-hot-toast';
import { transferService } from '../../services/transferService';
import { ACTION_COPY } from '../../utils/transferValidation';
import { ConfirmDialog, FormField, inputCls } from '../common/ui';

const DONE = {
  submit: (t) => `${t.reference} submitted${t.status === 'submitted' ? ' for approval' : ''}`,
  approve: (t) => `${t.reference} approved`,
  reject: (t) => `${t.reference} rejected`,
  dispatch: (t) => `${t.reference} dispatched — stock is in transit`,
  receive: (t) => `${t.reference} received at ${t.toBranch.name}`,
  cancel: (t) => `${t.reference} cancelled`,
  delete: (t) => `Draft ${t.reference} deleted`,
};

/**
 * One confirmation for every workflow step. It says what the step does to stock, asks for a reason where one is needed
 * (required to reject, optional to cancel), runs the API call and reports the outcome. `transfer` needs reference,
 * status, totalUnits, fromBranch, toBranch.
 */
export default function TransferActionDialog({ transfer, action, settings, onDone, onClose }) {
  const copy = ACTION_COPY[action](transfer, settings);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reasonMissing = copy.reason === 'required' && reason.trim().length < 3;

  const run = async () => {
    setBusy(true);
    try {
      const id = transfer._id;
      let result;
      if (action === 'delete') await transferService.remove(id);
      else if (action === 'reject') result = await transferService.reject(id, reason.trim());
      else if (action === 'cancel') result = await transferService.cancel(id, reason.trim());
      else result = await transferService[action](id);
      toast.success(DONE[action](result || transfer));
      onDone(result || null);
    } catch (e) {
      toast.error(e.message);
      onDone(null, e); // the transfer may have changed under us (someone else acted on it): the caller reloads
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      danger={copy.danger}
      title={copy.title}
      confirmLabel={copy.label}
      loading={busy}
      onConfirm={() => !reasonMissing && run()}
      onClose={() => !busy && onClose()}
      message={
        <>
          {copy.message}
          {copy.reason && (
            <span className="mt-3 block">
              <FormField label={copy.reason === 'required' ? 'Reason' : 'Reason (optional)'} required={copy.reason === 'required'} hint={reasonMissing && reason ? 'Give a short reason (at least 3 characters).' : undefined}>
                {(a) => <input {...a} autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={action === 'reject' ? 'e.g. Not needed at the destination' : 'e.g. Sent to the wrong store'} className={inputCls} />}
              </FormField>
            </span>
          )}
        </>
      }
    />
  );
}
