import { useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { compoundService } from '../../services/catalogService';
import { LIMITS, apiFieldErrors, compoundPayload, validateCompound } from '../../utils/catalogValidation';
import { BUD_UNITS, DOSAGE_FORMS, ROLES, TOTAL_UNITS, UNITS, blankIngredient, previewBatch } from '../../utils/compoundForm';
import { Button, ConfirmDialog, FormField, Input, Modal, Select, cx, inputCls } from '../common/ui';

/** A numbered step, so a long form reads as a sequence rather than a wall. */
function Section({ n, title, action, children }) {
  return (
    <fieldset className="rounded-2xl border border-line bg-card p-4">
      <legend className="flex items-center gap-2 px-1.5">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/10 text-[12px] font-bold tabular-nums text-accent">{n}</span>
        <span className="text-[13px] font-bold">{title}</span>
      </legend>
      {action && <div className="-mt-7 flex justify-end">{action}</div>}
      <div className="mt-1">{children}</div>
    </fieldset>
  );
}

/**
 * Add or edit a compound. A compound is either a formulation label several medicines share ("Paracetamol 650 mg"), or
 * a preparation the pharmacy makes itself — a cream, a suspension, a capsule. The second half of this form only appears
 * once "we prepare this ourselves" is ticked, so the common case stays a short dialog.
 *
 * While ingredients are typed the batch is worked out — what to weigh for each one and what the base makes up — with
 * the same arithmetic the server applies before saving, so the bench and the record can never disagree.
 */
export default function CompoundForm({ initial, onDone, onClose }) {
  const editing = Boolean(initial?._id);
  const [start] = useState(() => ({
    compoundName: initial?.compoundName || '',
    composition: initial?.composition || '',
    description: initial?.description || '',
    status: initial?.status || 'active',
    isPreparation: Boolean(initial?.ingredients?.length),
    dosageForm: initial?.dosageForm || 'Cream',
    totalQuantity: initial?.totalQuantity ? String(initial.totalQuantity) : '100',
    totalUnit: initial?.totalUnit || 'g',
    ingredients: initial?.ingredients?.length
      ? initial.ingredients.map((i) => ({ name: i.name || '', role: i.role || 'active', quantity: i.quantity ?? '', unit: i.unit || '%', medicineId: i.medicineId ? String(i.medicineId) : '', notes: i.notes || '' }))
      : [blankIngredient(), { ...blankIngredient(), role: 'base', unit: 'qs' }],
    instructions: initial?.instructions || '',
    requiresHomogenizer: Boolean(initial?.requiresHomogenizer),
    requiresUnguator: Boolean(initial?.requiresUnguator),
    lightSensitive: Boolean(initial?.lightSensitive),
    sig: initial?.sig || '',
    budValue: initial?.budValue ?? '',
    budUnit: initial?.budUnit || 'days',
  }));
  const [v, setV] = useState(start);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const batch = useMemo(() => (v.isPreparation ? previewBatch(v) : null), [v]);

  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const errors = validateCompound(v);
  const err = (k) => serverErrors[k] || (submitted || touched[k] ? errors[k] : undefined);
  const set = (k) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setV((s) => ({ ...s, [k]: value }));
    setServerErrors((s) => (s[k] ? { ...s, [k]: undefined } : s));
  };
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }));
  const setRow = (n, patch) => setV((s) => ({ ...s, ingredients: s.ingredients.map((row, i) => (i === n ? { ...row, ...patch } : row)) }));
  const addRow = () => setV((s) => ({ ...s, ingredients: [...s.ingredients, blankIngredient()] }));
  const removeRow = (n) => setV((s) => ({ ...s, ingredients: s.ingredients.filter((_, i) => i !== n) }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    if (batch?.problems.length) {
      toast.error(batch.problems[0]);
      return;
    }
    setBusy(true);
    try {
      const body = compoundPayload(v);
      const saved = editing ? await compoundService.update(initial._id, body) : await compoundService.create(body);
      toast.success(`Compound "${saved.compoundName}" ${editing ? 'updated' : 'added'}`);
      onDone(saved);
    } catch (ex) {
      const { fields, general } = apiFieldErrors(ex);
      setServerErrors(fields);
      if (general) toast.error(general);
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy || confirming) return;
    if (dirty) setConfirming(true);
    else onClose();
  };

  const unitOf = v.totalUnit || 'g';
  return (
    <>
      <Modal
        wide={v.isPreparation ? 'xl' : undefined}
        title={editing ? 'Edit compound' : 'Add compound'}
        description="A formulation several medicines share, or a preparation you make yourself."
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="compound-form" variant="accent" loading={busy} disabled={editing && !dirty}>
              {editing ? 'Save changes' : 'Add compound'}
            </Button>
          </>
        }
      >
        <form id="compound-form" onSubmit={submit} noValidate className={cx('gap-4', v.isPreparation ? 'grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'block')}>
          <div className="space-y-4">
            <Section n="01" title="What it is">
              <div className="space-y-3">
                <Input label="Compound name" required autoFocus maxLength={LIMITS.compoundName} placeholder="e.g. Paracetamol 650 mg" value={v.compoundName} onChange={set('compoundName')} onBlur={blur('compoundName')} error={err('compoundName')} />
                <Input label="Composition" maxLength={LIMITS.composition} placeholder="e.g. Paracetamol IP 650 mg" value={v.composition} onChange={set('composition')} onBlur={blur('composition')} error={err('composition')} />
                <FormField label="Description" error={err('description')} hint={`${v.description.length}/${LIMITS.description}`}>
                  {(a) => <textarea {...a} rows={2} maxLength={LIMITS.description} value={v.description} onChange={set('description')} onBlur={blur('description')} placeholder="Optional notes" className={cx(inputCls, 'h-auto py-2', err('description') && 'border-danger')} />}
                </FormField>
                {editing && (
                  <Select label="Status" value={v.status} onChange={set('status')} hint="An archived compound is hidden from new medicines; medicines already linked keep it.">
                    <option value="active">Active</option>
                    <option value="inactive">Archived</option>
                  </Select>
                )}
                <label className="flex items-start gap-2 rounded-xl bg-subtle p-3 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={v.isPreparation} onChange={set('isPreparation')} />
                  <span>
                    <span className="font-semibold">We prepare this ourselves</span>
                    <span className="block text-xs text-muted">Write the recipe: what goes in, how it is made, how long it keeps.</span>
                  </span>
                </label>
              </div>
            </Section>

            {v.isPreparation && (
              <>
                <Section
                  n="02"
                  title="Ingredients & base"
                  action={
                    <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                      <Plus className="h-4 w-4" /> Add ingredient
                    </Button>
                  }
                >
                  <div className="space-y-2">
                    <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 px-1 text-[11px] font-bold uppercase tracking-wide text-muted sm:grid">
                      <span>Ingredient</span>
                      <span>Type</span>
                      <span>Quantity</span>
                      <span>Unit</span>
                      <span className="sr-only">Remove</span>
                    </div>
                    {v.ingredients.map((row, n) => (
                      <div key={n} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                        <Input aria-label={`Ingredient ${n + 1}`} placeholder="e.g. Ketamine HCl" maxLength={150} value={row.name} onChange={(e) => setRow(n, { name: e.target.value })} error={err(`ingredients.${n}.name`)} />
                        <Select aria-label={`Type of ingredient ${n + 1}`} value={row.role} onChange={(e) => setRow(n, { role: e.target.value })}>
                          {ROLES.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </Select>
                        <Input
                          aria-label={`Quantity of ingredient ${n + 1}`}
                          inputMode="decimal"
                          placeholder={row.unit === 'qs' ? 'QS' : '10'}
                          disabled={row.unit === 'qs'}
                          value={row.unit === 'qs' ? '' : row.quantity}
                          onChange={(e) => setRow(n, { quantity: e.target.value })}
                          error={err(`ingredients.${n}.quantity`)}
                        />
                        <Select aria-label={`Unit of ingredient ${n + 1}`} value={row.unit} onChange={(e) => setRow(n, { unit: e.target.value, ...(e.target.value === 'qs' ? { quantity: '' } : {}) })}>
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u === 'qs' ? 'qs (to make up)' : u}
                            </option>
                          ))}
                        </Select>
                        <button
                          type="button"
                          aria-label={`Remove ingredient ${n + 1}`}
                          onClick={() => removeRow(n)}
                          disabled={v.ingredients.length === 1}
                          className="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded-xl bg-subtle p-3 text-sm" aria-label="What this batch weighs out">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">
                        This batch makes {Number(v.totalQuantity) || 0} {unitOf}
                      </span>
                      <span className="text-xs text-muted">
                        Measured {batch.measured} {unitOf}
                        {batch.qsAmount !== null ? ` · base makes up ${batch.qsAmount} ${unitOf}` : batch.shortfall > 0 ? ` · ${batch.shortfall} ${unitOf} unaccounted for` : ''}
                      </span>
                    </div>
                    <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                      {batch.lines.map((l, i) => (
                        <li key={i} className="flex justify-between gap-2 tabular-nums">
                          <span className="truncate text-muted">{l.name || `Ingredient ${i + 1}`}</span>
                          <span className="font-semibold">{l.amount !== null ? `${l.amount} ${unitOf}` : String(l.unit).toLowerCase() === 'qs' ? `${batch.qsAmount ?? '—'} ${unitOf}` : 'weigh by hand'}</span>
                        </li>
                      ))}
                    </ul>
                    {batch.problems.map((p) => (
                      <p key={p} role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-danger">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {p}
                      </p>
                    ))}
                  </div>
                </Section>

                <Section n="03" title="Preparation instructions">
                  <FormField label="How it is made" error={err('instructions')}>
                    {(a) => <textarea {...a} rows={4} maxLength={4000} value={v.instructions} onChange={set('instructions')} placeholder="Step by step: mixing, equipment, anything the bench must know." className={cx(inputCls, 'h-auto py-2')} />}
                  </FormField>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={v.requiresHomogenizer} onChange={set('requiresHomogenizer')} /> Requires homogenizer
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={v.requiresUnguator} onChange={set('requiresUnguator')} /> Requires unguator
                    </label>
                    <label className="flex items-center gap-2 text-sm sm:col-span-2">
                      <input type="checkbox" checked={v.lightSensitive} onChange={set('lightSensitive')} /> Light sensitive — dispense in an amber container
                    </label>
                  </div>
                </Section>
              </>
            )}
          </div>

          {v.isPreparation && (
            <div className="space-y-4">
              <Section n="04" title="Batch & shelf life">
                <div className="grid gap-3">
                  <Select label="Dosage form" value={v.dosageForm} onChange={set('dosageForm')}>
                    <option value="">Not stated</option>
                    {DOSAGE_FORMS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Makes" required inputMode="decimal" value={v.totalQuantity} onChange={set('totalQuantity')} error={err('totalQuantity')} />
                    <Select label="Unit" value={v.totalUnit} onChange={set('totalUnit')}>
                      {TOTAL_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Beyond-use" inputMode="numeric" placeholder="180" value={v.budValue} onChange={set('budValue')} error={err('budValue')} hint="How long it keeps once made." />
                    <Select label="Counted in" value={v.budUnit} onChange={set('budUnit')}>
                      {BUD_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </Section>

              <Section n="05" title="Directions (sig)">
                <FormField label="What goes on the label" error={err('sig')} hint="The directions this preparation normally carries.">
                  {(a) => <textarea {...a} rows={4} maxLength={500} value={v.sig} onChange={set('sig')} placeholder="e.g. Apply 1–2 pumps to the affected area up to four times daily as needed." className={cx(inputCls, 'h-auto py-2')} />}
                </FormField>
              </Section>
            </div>
          )}
        </form>
      </Modal>
      {confirming && <ConfirmDialog danger title="Discard changes?" message="You have unsaved changes. If you close now they will be lost." confirmLabel="Discard changes" onConfirm={onClose} onClose={() => setConfirming(false)} />}
    </>
  );
}
