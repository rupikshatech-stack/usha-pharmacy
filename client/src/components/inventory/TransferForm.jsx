import { useRef, useState } from 'react';
import { ArrowRight, Minus, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { transferService } from '../../services/transferService';
import { blankTransfer, expiryTone, fromTransfer, isDirty, newLine, serverErrors, stepQuantity, toPayload, validateTransfer } from '../../utils/transferValidation';
import { expiryFmt } from '../../utils/format';
import { Button, ConfirmDialog, FormField, Input, Modal, Select, cx, inputCls } from '../common/ui';
import TransferBatchPicker from './TransferBatchPicker';

const TONE = { expired: 'font-semibold text-danger', soon: 'font-semibold text-danger', watch: 'font-medium text-warning', ok: 'text-muted' };

/** A numbered group of the form, like the steps of a paper transfer note. */
function Section({ step, title, aside, children }) {
  return (
    <section className="rounded-2xl border border-line p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-3 text-[15px] font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-sage text-xs font-bold text-sage-ink" aria-hidden="true">
            {step}
          </span>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Create a transfer draft, or edit one. Saving a draft never moves stock — that happens when it is sent. */
export default function TransferForm({ initial, stores, onDone, onClose }) {
  const editing = Boolean(initial?._id);
  const active = stores.filter((s) => s.status === 'active');
  const [start] = useState(() => (initial ? fromTransfer(initial) : blankTransfer(active.find((s) => s.isDefault)?._id || active[0]?._id || '')));
  const [t, setT] = useState(start);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrs, setServerErrs] = useState({});
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [now] = useState(() => new Date());
  const formRef = useRef(null);

  const dirty = isDirty(start, t);
  const errors = validateTransfer(t);
  const err = (k) => serverErrs[k] || (submitted || touched[k] ? errors[k] : undefined);
  const clear = (k) => setServerErrs((s) => (s[k] ? { ...s, [k]: undefined } : s));
  const set = (k) => (e) => {
    setT((s) => ({ ...s, [k]: e.target.value }));
    clear(k);
  };
  const touch = (k) => () => setTouched((x) => ({ ...x, [k]: true }));

  const changeFrom = (e) => {
    const value = e.target.value;
    // The lines are batches of the OLD source store, so they no longer apply.
    setT((s) => ({ ...s, fromBranchId: value, lines: value === s.fromBranchId ? s.lines : [], toBranchId: s.toBranchId === value ? '' : s.toBranchId }));
    setServerErrs({});
  };
  const setQty = (i, quantity) => {
    setT((s) => ({ ...s, lines: s.lines.map((l, n) => (n === i ? { ...l, quantity } : l)) }));
    clear(`line.${i}`);
  };
  const step = (i, delta) => setQty(i, stepQuantity(t.lines[i].quantity, delta, t.lines[i].available));
  const addLine = (batch) => {
    setT((s) => ({ ...s, lines: [...s.lines, newLine(batch, 1)] }));
    clear('lines');
  };
  const removeLine = (i) => {
    setT((s) => ({ ...s, lines: s.lines.filter((_, n) => n !== i) }));
    setServerErrs({});
  };

  const focusFirst = () => requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setGeneral('');
    if (Object.keys(errors).length) return focusFirst();
    setBusy(true);
    try {
      const saved = editing ? await transferService.update(initial._id, toPayload(t)) : await transferService.create(toPayload(t));
      toast.success(`Draft ${saved.reference} ${editing ? 'updated' : 'saved'}`);
      onDone(saved);
    } catch (ex) {
      const { fields, general: g } = serverErrors(ex);
      setServerErrs(fields);
      setGeneral(g);
      if (Object.keys(fields).length) focusFirst();
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy || confirming) return;
    if (dirty) setConfirming(true);
    else onClose();
  };

  const toStores = active.filter((s) => s._id !== t.fromBranchId);
  const lineProblems = Object.keys(errors).filter((k) => k.startsWith('line.')).length;
  const totalUnits = t.lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);

  return (
    <>
      <Modal
        wide
        title={editing ? `Edit transfer ${initial.reference}` : 'Create stock transfer'}
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="transfer-form" loading={busy} disabled={editing && !dirty}>
              {editing ? 'Save changes' : 'Save draft'}
            </Button>
          </>
        }
      >
        <form id="transfer-form" ref={formRef} onSubmit={submit} noValidate className="space-y-4">
          {general && (
            <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {general}
            </div>
          )}
          {submitted && lineProblems > 0 && (
            <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              Fix the quantity on {lineProblems} line{lineProblems === 1 ? '' : 's'} below.
            </div>
          )}
          <p className="text-sm text-muted">Saving creates a draft. Stock only moves when you send the transfer.</p>

          <div className="space-y-4 rounded-2xl border border-line p-4 sm:p-5">
            <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr_11rem]">
              <Select label="From store" required value={t.fromBranchId} onChange={changeFrom} onBlur={touch('fromBranchId')} error={err('fromBranchId')}>
                <option value="">Choose a store…</option>
                {active.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <ArrowRight className="mb-2.5 hidden h-5 w-5 text-muted sm:block" aria-hidden="true" />
              <Select label="To store" required value={t.toBranchId} onChange={set('toBranchId')} onBlur={touch('toBranchId')} error={err('toBranchId')}>
                <option value="">Choose a store…</option>
                {toStores.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Input label="Transfer date" required type="date" value={t.transferDate} onChange={set('transferDate')} onBlur={touch('transferDate')} error={err('transferDate')} />
            </div>
            {active.length < 2 && (
              <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                You need at least two active stores to transfer stock. Use “Manage stores” to add another.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Reference No." hint={editing ? undefined : 'Numbered automatically when you save.'}>
                {(a) => <input {...a} readOnly value={editing ? initial.reference : 'Assigned on save'} className={cx(inputCls, 'bg-subtle font-mono text-[13px] text-muted')} />}
              </FormField>
              <Input label="Expected arrival date" type="date" min={t.transferDate || undefined} value={t.expectedArrivalDate} onChange={set('expectedArrivalDate')} onBlur={touch('expectedArrivalDate')} error={err('expectedArrivalDate')} hint="Optional. When the destination should expect the stock." />
            </div>

            <FormField label="Notes / reason (optional)" error={err('notes')} hint={`${t.notes.length}/500 · shown on the printed transfer note`}>
              {(a) => (
                <textarea {...a} rows={3} value={t.notes} maxLength={500} placeholder="Enter any relevant notes for the receiving store…" onChange={set('notes')} onBlur={touch('notes')} className={cx(inputCls, 'h-auto py-2', err('notes') && 'border-danger')} />
              )}
            </FormField>

            <FormField label="Internal remarks (optional)" error={err('internalRemarks')} hint="For your staff only — never printed on the transfer note.">
              {(a) => <input {...a} value={t.internalRemarks} maxLength={500} onChange={set('internalRemarks')} onBlur={touch('internalRemarks')} className={cx(inputCls, err('internalRemarks') && 'border-danger')} />}
            </FormField>
          </div>

          <Section step="01" title="Transfer items" aside={<span className="text-sm text-muted">{t.lines.length > 0 ? `${t.lines.length} line${t.lines.length === 1 ? '' : 's'} · ${totalUnits} unit${totalUnits === 1 ? '' : 's'}` : 'Nothing added yet'}</span>}>
            <TransferBatchPicker branchId={t.fromBranchId} exclude={t.lines.map((l) => l.batchId)} onPick={addLine} error={err('lines')} />
            {t.lines.length > 0 && (
              <div className="mt-4 overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Medicine', 'Batch', 'Expiry', 'Available', 'Transfer qty', ''].map((h, i) => (
                        <th key={i} className={cx('px-3 py-2.5 font-semibold', h === 'Available' && 'text-right')}>
                          {h || <span className="sr-only">Remove</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.lines.map((l, i) => {
                      const tone = expiryTone(l.expiryDate, now);
                      return (
                        <tr key={l.batchId} className="border-t border-line align-top">
                          <td className="px-3 py-3">
                            <div className="font-semibold">{l.medicineName}</div>
                            {l.subtitle && <div className="text-xs text-muted">{l.subtitle}</div>}
                          </td>
                          <td className="px-3 py-3">
                            <span className="rounded-md bg-subtle px-2 py-1 font-mono text-[12px]">{l.batchNumber}</span>
                          </td>
                          <td className={cx('whitespace-nowrap px-3 py-3', TONE[tone])}>
                            {expiryFmt(l.expiryDate)}
                            {tone === 'expired' && <div className="text-[11px]">Expired</div>}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{l.available ?? '—'}</td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <button type="button" aria-label={`Decrease quantity of ${l.medicineName} batch ${l.batchNumber}`} onClick={() => step(i, -1)} className="grid h-8 w-8 place-items-center rounded-full border border-line hover:bg-subtle">
                                <Minus className="h-3.5 w-3.5" />
                              </button>
                              <input
                                aria-label={`Quantity of ${l.medicineName} batch ${l.batchNumber}`}
                                aria-invalid={Boolean(err(`line.${i}`))}
                                type="number"
                                min="1"
                                step="1"
                                max={l.available ?? undefined}
                                value={l.quantity}
                                onChange={(e) => setQty(i, e.target.value)}
                                className={cx(inputCls, 'h-9 w-16 px-1 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none', err(`line.${i}`) && 'border-danger')}
                              />
                              <button type="button" aria-label={`Increase quantity of ${l.medicineName} batch ${l.batchNumber}`} onClick={() => step(i, 1)} disabled={l.available != null && Number(l.quantity) >= l.available} className="grid h-8 w-8 place-items-center rounded-full border border-line hover:bg-subtle disabled:opacity-40">
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {err(`line.${i}`) && <p role="alert" className="mt-1 max-w-[16rem] text-xs text-danger">{err(`line.${i}`)}</p>}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <button type="button" aria-label={`Remove ${l.medicineName} batch ${l.batchNumber}`} onClick={() => removeLine(i)} className="grid h-8 w-8 place-items-center rounded-lg text-danger hover:bg-danger/10">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </form>
      </Modal>
      {confirming && (
        <ConfirmDialog danger title="Discard this transfer?" message="You have unsaved changes. If you close now they will be lost." confirmLabel="Discard changes" onConfirm={onClose} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}
