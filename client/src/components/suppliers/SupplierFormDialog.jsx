import { useState } from 'react';
import toast from 'react-hot-toast';
import { supplierService } from '../../services/supplierService';
import { useFetch } from '../../hooks/useFetch';
import { PAYMENT_TERMS, SUPPLIER_TYPES, emptySupplier, serverErrors, supplierPayload, supplierProblems, supplierToForm } from '../../utils/supplierForm';
import { Button, FormField, Input, Modal, Select, cx, inputCls } from '../common/ui';

function Section({ title, hint, children }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-bold">{title}</legend>
      {hint && <p className="-mt-1 text-xs text-muted">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/**
 * Add or edit a supplier, in the four sections the module is organised by: company, contact, address and procurement. Everything typed here is checked again by
 * the server; a duplicate code or name, or a store that is not ours, comes back as a message under the field. Saving is disabled while it is in flight, so a
 * double click cannot create two suppliers.
 */
export default function SupplierFormDialog({ supplier, onClose, onSaved }) {
  const editing = Boolean(supplier);
  const [f, setF] = useState(() => (supplier ? supplierToForm(supplier) : emptySupplier()));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const branches = useFetch('/branches');
  const stores = (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive');

  const set = (k) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF((x) => ({ ...x, [k]: value }));
    if (errors[k]) setErrors((x) => ({ ...x, [k]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const found = supplierProblems(f);
    setErrors(found);
    if (Object.keys(found).length) {
      toast.error('Please fix the highlighted fields.');
      document.querySelector('[aria-invalid="true"]')?.focus?.();
      return;
    }
    setBusy(true);
    try {
      const body = supplierPayload(f);
      const saved = editing ? await supplierService.update(supplier._id, body) : await supplierService.create(body);
      toast.success(`Supplier “${saved.name}” ${editing ? 'updated' : 'added'}`);
      if (saved.gstinWarning) toast(`${saved.gstinWarning.name} has the same GST number.`, { icon: '⚠️' }); // allowed: a group can trade under one registration
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
      title={editing ? 'Edit Supplier' : 'Add Supplier'}
      description={editing ? `Update the details of ${supplier.name}.` : 'Add a company you buy stock from.'}
      onClose={() => !busy && onClose()}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="supplier-form" variant="accent" loading={busy} disabled={busy}>
            Save Supplier
          </Button>
        </>
      }
    >
      <form id="supplier-form" onSubmit={submit} noValidate className="space-y-5">
        <Section title="Company Information">
          <Input label="Company Name" required autoFocus maxLength={150} value={f.name} onChange={set('name')} error={errors.name} />
          <Input label="Supplier Code" maxLength={20} value={f.code} onChange={set('code')} error={errors.code} placeholder="SUP-0001" hint={editing ? 'Must be unique.' : 'Leave empty and one is given automatically.'} />
          <Input label="GST Number" maxLength={20} value={f.gstin} onChange={set('gstin')} error={errors.gstin} placeholder="27ABCDE1234F1Z5" />
          <Input label="PAN Number" maxLength={10} value={f.pan} onChange={set('pan')} error={errors.pan} placeholder="ABCDE1234F" />
          <Select label="Supplier Type" value={f.supplierType} onChange={set('supplierType')} error={errors.supplierType}>
            {SUPPLIER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input label="Company Website" maxLength={200} value={f.website} onChange={set('website')} error={errors.website} placeholder="https://" />
          <Select label="Status" value={f.status} onChange={set('status')} error={errors.status}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-semibold">
            <input type="checkbox" checked={f.isPreferred} onChange={set('isPreferred')} />
            Preferred supplier
          </label>
        </Section>

        <Section title="Contact Information">
          <Input label="Contact Person" required maxLength={100} value={f.contactPerson} onChange={set('contactPerson')} error={errors.contactPerson} />
          <Input label="Phone Number" required type="tel" maxLength={20} value={f.phone} onChange={set('phone')} error={errors.phone} />
          <Input label="Alternate Phone Number" type="tel" maxLength={20} value={f.altPhone} onChange={set('altPhone')} error={errors.altPhone} />
          <Input label="Email Address" type="email" maxLength={150} value={f.email} onChange={set('email')} error={errors.email} />
          <Input label="Alternate Email" type="email" maxLength={150} value={f.altEmail} onChange={set('altEmail')} error={errors.altEmail} />
        </Section>

        <Section title="Address Information">
          <Input label="Address Line 1" required className="sm:col-span-2" maxLength={150} value={f.line1} onChange={set('line1')} error={errors.line1} />
          <Input label="Address Line 2" className="sm:col-span-2" maxLength={150} value={f.line2} onChange={set('line2')} error={errors.line2} />
          <Input label="Country" maxLength={80} value={f.country} onChange={set('country')} error={errors.country} />
          <Input label="State" maxLength={80} value={f.state} onChange={set('state')} error={errors.state} />
          <Input label="City" maxLength={80} value={f.city} onChange={set('city')} error={errors.city} />
          <Input label="PIN Code" maxLength={6} inputMode="numeric" value={f.pincode} onChange={set('pincode')} error={errors.pincode} />
          <Input label="Landmark" className="sm:col-span-2" maxLength={150} value={f.landmark} onChange={set('landmark')} error={errors.landmark} />
        </Section>

        <Section title="Procurement Information" hint="How buying from them usually works. None of this moves money; the order screens start from it.">
          <Select label="Payment Terms" value={f.paymentTerms} onChange={set('paymentTerms')} error={errors.paymentTerms}>
            {PAYMENT_TERMS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input
            label="Credit Period (days)"
            inputMode="numeric"
            maxLength={3}
            value={f.creditPeriodDays}
            onChange={set('creditPeriodDays')}
            error={errors.creditPeriodDays}
            required={f.paymentTerms === 'custom'}
            disabled={f.paymentTerms !== 'custom'}
            hint={f.paymentTerms === 'custom' ? 'How many days they allow.' : 'Set by the payment terms.'}
          />
          <Input label="Minimum Order Value (₹)" inputMode="decimal" value={f.minimumOrderValue} onChange={set('minimumOrderValue')} error={errors.minimumOrderValue} />
          <Input label="Preferred Delivery Time" maxLength={100} value={f.preferredDeliveryTime} onChange={set('preferredDeliveryTime')} error={errors.preferredDeliveryTime} placeholder="e.g. 2–3 days, mornings" />
          <Select label="Default Branch" value={f.defaultBranchId} onChange={set('defaultBranchId')} error={errors.defaultBranchId} hint="Where their deliveries usually go.">
            <option value="">No default</option>
            {stores.map((b) => (
              <option key={b._id} value={b._id}>
                {b.name}
              </option>
            ))}
          </Select>
          <FormField label="Notes" className="sm:col-span-2" error={errors.notes}>
            {(a) => <textarea {...a} rows={3} maxLength={1000} value={f.notes} onChange={set('notes')} className={cx(inputCls, 'h-auto', errors.notes && 'border-danger')} />}
          </FormField>
        </Section>
      </form>
    </Modal>
  );
}
