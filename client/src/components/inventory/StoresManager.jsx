import { useState } from 'react';
import { Pencil, Plus, Store, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { storeService, transferService } from '../../services/transferService';
import { useFetch } from '../../hooks/useFetch';
import { Badge, Button, ConfirmDialog, Input, Modal } from '../common/ui';

const blank = { name: '', code: '', address: '', phone: '' };

/** Add, rename, deactivate and delete stores. The default store can't be deactivated or deleted. */
export default function StoresManager({ stores, canManage, onChanged, onClose }) {
  const [form, setForm] = useState(null); // null | { id?, ...fields }
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'toggle', store }
  const settings = useFetch('/transfers/settings');
  const [savingSetting, setSavingSetting] = useState(false);
  const [approval, setApproval] = useState(null); // what the checkbox shows right away, while the change is being saved

  const toggleApproval = async (on) => {
    setSavingSetting(true);
    setApproval(on);
    try {
      await transferService.saveSettings(on);
      toast.success(on ? 'Transfers now need approval before dispatch' : 'Transfers no longer need approval');
      settings.reload();
    } catch (e) {
      setApproval(null); // saving failed: show the real setting again
      toast.error(e.message);
    } finally {
      setSavingSetting(false);
    }
  };

  const openForm = (values) => {
    setErrors({});
    setForm(values);
  };

  const save = async (e) => {
    e.preventDefault();
    const next = {};
    if (!form.name.trim()) next.name = 'Store name is required';
    if (!form.code.trim()) next.code = 'Store code is required';
    else if (!/^[A-Za-z0-9._-]+$/.test(form.code.trim())) next.code = 'Use letters, numbers and . _ - only';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const body = { name: form.name.trim(), code: form.code.trim(), address: form.address.trim(), phone: form.phone.trim() };
      if (form.id) await storeService.update(form.id, body);
      else await storeService.create(body);
      toast.success(`Store “${body.name}” ${form.id ? 'updated' : 'added'}`);
      setForm(null);
      onChanged();
    } catch (ex) {
      const fields = Object.fromEntries((ex.details || []).map((d) => [d.path, d.message]));
      if (Object.keys(fields).length) setErrors(fields);
      else toast.error(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    const { kind, store } = confirm;
    setBusy(true);
    try {
      if (kind === 'delete') {
        await storeService.remove(store._id);
        toast.success(`Store “${store.name}” deleted`);
      } else {
        const next = store.status === 'active' ? 'inactive' : 'active';
        await storeService.update(store._id, { status: next });
        toast.success(`“${store.name}” ${next === 'active' ? 'activated' : 'deactivated'}`);
      }
      onChanged();
    } catch (ex) {
      toast.error(ex.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <>
      <Modal
        wide
        title="Stores"
        description="Places where your stock is held. Transfers move stock between them."
        onClose={() => !form && !confirm && onClose()}
        footer={
          canManage && !form ? (
            <Button onClick={() => openForm({ ...blank })}>
              <Plus className="h-4 w-4" /> Add store
            </Button>
          ) : undefined
        }
      >
        {form ? (
          <form onSubmit={save} noValidate className="grid gap-3 sm:grid-cols-2">
            <Input label="Store name" required autoFocus maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} placeholder="e.g. North Branch" />
            <Input label="Code" required maxLength={20} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} error={errors.code} placeholder="e.g. NORTH" />
            <Input label="Address" className="sm:col-span-2" maxLength={300} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} error={errors.address} />
            <Input label="Phone" maxLength={20} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} error={errors.phone} />
            <div className="flex items-end justify-end gap-2 sm:col-span-2">
              <Button variant="secondary" onClick={() => setForm(null)}>
                Back
              </Button>
              <Button type="submit" loading={busy}>
                {form.id ? 'Save store' : 'Add store'}
              </Button>
            </div>
          </form>
        ) : (
          <>
          <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
              checked={Boolean(approval ?? settings.data?.approvalRequired)}
              disabled={!canManage || savingSetting || !settings.data}
              onChange={(e) => toggleApproval(e.target.checked)}
            />
            <span>
              <span className="block font-semibold">Require approval for transfers</span>
              <span className="block text-xs text-muted">When on, a submitted transfer must be approved by someone with approval rights before its stock can be dispatched.{canManage ? '' : ' Only a settings manager can change this.'}</span>
            </span>
          </label>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {stores.map((s) => (
              <li key={s._id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sage text-sage-ink">
                    <Store className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{s.name}</span>
                      <span className="text-xs text-muted">{s.code}</span>
                      {s.isDefault && <Badge tone="success">Default</Badge>}
                      {s.status !== 'active' && <Badge tone="neutral">Inactive</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {s.unitsOnHand} unit{s.unitsOnHand === 1 ? '' : 's'} in {s.batchCount} batch{s.batchCount === 1 ? '' : 'es'}
                      {s.openTransfers ? ` · ${s.openTransfers} open transfer${s.openTransfers === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openForm({ id: s._id, name: s.name, code: s.code, address: s.address || '', phone: s.phone || '' })} aria-label={`Edit ${s.name}`}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    {!s.isDefault && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'toggle', store: s })}>
                          {s.status === 'active' ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'delete', store: s })} aria-label={`Delete ${s.name}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          </>
        )}
      </Modal>
      {confirm && (
        <ConfirmDialog
          danger={confirm.kind === 'delete'}
          title={confirm.kind === 'delete' ? 'Delete store?' : `${confirm.store.status === 'active' ? 'Deactivate' : 'Activate'} store?`}
          confirmLabel={confirm.kind === 'delete' ? 'Delete' : confirm.store.status === 'active' ? 'Deactivate' : 'Activate'}
          loading={busy}
          onConfirm={runConfirm}
          onClose={() => !busy && setConfirm(null)}
          message={
            confirm.kind === 'delete'
              ? `“${confirm.store.name}” will be permanently deleted. A store that holds stock or has transfer history can't be deleted — deactivate it instead.`
              : confirm.store.status === 'active'
                ? `“${confirm.store.name}” will no longer be offered for new transfers. Its stock stays where it is.`
                : `“${confirm.store.name}” will be available for transfers again.`
          }
        />
      )}
    </>
  );
}
