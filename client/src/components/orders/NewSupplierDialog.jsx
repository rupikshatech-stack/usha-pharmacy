import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { supplierService } from '../../services/orderService';
import { Button, FormField, Modal, cx, inputCls } from '../common/ui';

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Adds a supplier from inside the order form, so a new supplier doesn't interrupt the order. The full Suppliers screens build on the same records. */
export default function NewSupplierDialog({ onDone, onClose }) {
  const [v, setV] = useState({ name: '', contactPerson: '', phone: '', email: '', gstin: '', line1: '', city: '', state: '', pincode: '' });
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState({});
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => {
    setV((x) => ({ ...x, ...patch }));
    setServer({});
  };
  const e = {};
  if (!v.name.trim()) e.name = 'Enter the supplier name.';
  if (!v.contactPerson.trim()) e.contactPerson = 'Enter the contact person.';
  if (!v.phone.trim()) e.phone = 'Enter the phone number.';
  if (v.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) e.email = 'Enter a valid email address.';
  if (v.phone.trim() && !/^[0-9+\-\s()]+$/.test(v.phone.trim())) e.phone = 'Use digits, spaces, + and - only.';
  if (v.gstin.trim() && !GSTIN.test(v.gstin.trim().toUpperCase())) e.gstin = 'GST number is not in a valid format.';
  const shown = (k) => server[k] || (submitted ? e[k] : undefined);

  const save = async () => {
    setSubmitted(true);
    setGeneral('');
    if (busy || Object.keys(e).length) return;
    setBusy(true);
    try {
      const s = await supplierService.create({
        name: v.name.trim(),
        contactPerson: v.contactPerson.trim(),
        phone: v.phone.trim(),
        email: v.email.trim(),
        gstin: v.gstin.trim().toUpperCase(),
        address: { line1: v.line1.trim(), city: v.city.trim(), state: v.state.trim(), pincode: v.pincode.trim() },
      });
      toast.success(`Supplier ${s.name} added`);
      onDone(s);
    } catch (err) {
      const f = {};
      for (const d of err.details || []) if (d.path && !f[d.path]) f[d.path] = d.message;
      setServer(f);
      setGeneral(Object.keys(f).length ? '' : err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const text = (k, label, props = {}) => (
    <FormField label={label} required={['name', 'contactPerson', 'phone'].includes(k)} error={shown(k)}>
      {(a) => <input {...a} value={v[k]} onChange={(ev) => set({ [k]: ev.target.value })} className={cx(inputCls, shown(k) && 'border-danger')} {...props} />}
    </FormField>
  );

  return (
    <Modal
      title="Add supplier"
      description="Add a supplier to order from."
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Add supplier
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">{text('name', 'Supplier name', { maxLength: 150, autoFocus: true })}</div>
          {text('contactPerson', 'Contact person', { maxLength: 100 })}
          {text('phone', 'Phone number', { maxLength: 20, inputMode: 'tel' })}
          {text('email', 'Email', { maxLength: 150, type: 'email' })}
          {text('gstin', 'GST number', { maxLength: 15 })}
          <div className="sm:col-span-2">{text('line1', 'Address', { maxLength: 150 })}</div>
          {text('city', 'City', { maxLength: 80 })}
          {text('state', 'State', { maxLength: 80 })}
          {text('pincode', 'PIN code', { maxLength: 10 })}
        </div>
        {general && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {general}
          </p>
        )}
      </div>
    </Modal>
  );
}
