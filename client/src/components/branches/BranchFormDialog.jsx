import { useState } from 'react';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { branchService } from '../../services/branchService';
import { blankBranch, fromBranch, serverErrors, toBody, validateBranch } from '../../utils/branchForm';
import { Button, FormField, Input, Modal, Select, cx, inputCls } from '../common/ui';

function Section({ title, children }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-bold">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * Add or edit a branch. Every required field is checked here and again by the server; a duplicate code or name comes back as a message under the field. The Save
 * button is disabled while saving, so a double click cannot save twice.
 */
export default function BranchFormDialog({ branch, onClose, onSaved }) {
  const editing = Boolean(branch);
  const [f, setF] = useState(() => (branch ? fromBranch(branch) : blankBranch()));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const found = validateBranch(f);
    setErrors(found);
    if (Object.keys(found).length) {
      toast.error('Please fix the highlighted fields.');
      document.querySelector('[aria-invalid="true"]')?.focus?.();
      return;
    }
    setBusy(true);
    try {
      const body = toBody(f);
      const saved = editing ? await branchService.update(branch._id, body) : await branchService.create(body);
      toast.success(`Branch “${saved.name}” ${editing ? 'updated' : 'added'}`);
      onSaved(saved);
    } catch (ex) {
      const fields = serverErrors(ex.details);
      if (Object.keys(fields).length) setErrors(fields);
      toast.error(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? 'Edit Branch' : 'Add Branch'}
      description={editing ? `Update the details of ${branch.name}.` : 'Add a new store branch.'}
      onClose={() => !busy && onClose()}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="branch-form" variant="accent" loading={busy} disabled={busy}>
            Save Branch
          </Button>
        </>
      }
    >
      <form id="branch-form" onSubmit={submit} noValidate className="space-y-5">
        {f.legacyAddress && (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-subtle p-3 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> This branch only has a one-line address: “{f.legacyAddress}”. Enter its address line 1 and
            PIN code below to complete it.
          </p>
        )}
        <Section title="Basic Information">
          <Input label="Branch Name" required autoFocus maxLength={100} value={f.name} onChange={set('name')} error={errors.name} />
          <Input
            label="Branch Code"
            required
            maxLength={20}
            value={f.code}
            onChange={set('code')}
            error={errors.code}
            placeholder="e.g. NORTH-1"
            hint="Letters, numbers and . _ - only. Must be unique."
          />
          <Input label="Branch Phone Number" type="tel" maxLength={20} value={f.phone} onChange={set('phone')} error={errors.phone} />
          <Input label="Branch Email" type="email" maxLength={120} value={f.email} onChange={set('email')} error={errors.email} />
          <Select label="Branch Status" value={f.status} onChange={set('status')} error={errors.status}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Section>
        <Section title="Address Information">
          <Input label="Address Line 1" required className="sm:col-span-2" maxLength={150} value={f.addressLine1} onChange={set('addressLine1')} error={errors.addressLine1} />
          <Input label="Address Line 2" className="sm:col-span-2" maxLength={150} value={f.addressLine2} onChange={set('addressLine2')} error={errors.addressLine2} />
          <Input label="Country" maxLength={60} value={f.country} onChange={set('country')} error={errors.country} />
          <Input label="State" maxLength={80} value={f.state} onChange={set('state')} error={errors.state} />
          <Input label="City" maxLength={80} value={f.city} onChange={set('city')} error={errors.city} />
          <Input label="PIN Code" required maxLength={12} inputMode="numeric" value={f.pincode} onChange={set('pincode')} error={errors.pincode} />
          <Input label="Landmark" className="sm:col-span-2" maxLength={150} value={f.landmark} onChange={set('landmark')} error={errors.landmark} />
        </Section>
        <Section title="Additional Information">
          <Input label="Branch Manager" maxLength={100} value={f.managerName} onChange={set('managerName')} error={errors.managerName} />
          <Input label="GSTIN" maxLength={20} value={f.gstin} onChange={set('gstin')} error={errors.gstin} placeholder="27ABCDE1234F1Z5" />
          <Input label="Opening Date" type="date" value={f.openingDate} onChange={set('openingDate')} error={errors.openingDate} />
          <FormField label="Notes" className="sm:col-span-2" error={errors.notes}>
            {(a) => <textarea {...a} rows={3} maxLength={500} value={f.notes} onChange={set('notes')} className={cx(inputCls, 'h-auto', errors.notes && 'border-danger')} />}
          </FormField>
        </Section>
      </form>
    </Modal>
  );
}
