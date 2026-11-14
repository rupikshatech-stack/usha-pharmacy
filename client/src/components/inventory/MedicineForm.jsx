import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { medicineService } from '../../services/medicineService';
import { Button, ConfirmDialog, FormField, Input, Modal, cx, inputCls } from '../common/ui';
import { Combobox } from '../common/Combobox';
import ImageDropzone from '../common/ImageDropzone';
import { FIELD_LABELS, LIMITS, codeProblem, gstSplit, initialValues, isDirty, packingSummary, serverFieldErrors, toPayload, unitsPerOuter, validateMedicine } from '../../utils/medicineValidation';

const DOSAGE_FORMS = ['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Ointment', 'Cream', 'Gel', 'Drops', 'Inhaler', 'Powder', 'Sachet', 'Other'];

const PACK_UNITS = ['Box', 'Carton', 'Case', 'Pack', 'Strip', 'Bottle', 'Tube', 'Vial', 'Sachet', 'Jar'];
const TAXABILITY = [
  { value: 'taxable', label: 'Taxable' },
  { value: 'exempt', label: 'Exempt' },
  { value: 'nil', label: 'Nil rated' },
];

/** A numbered step of the form. The number makes a long form read as a sequence rather than a wall. */
function Section({ n, title, description, children, cols = 2 }) {
  return (
    <fieldset className="rounded-2xl border border-line bg-card p-4">
      <legend className="flex items-center gap-2 px-1.5">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/10 text-[12px] font-bold tabular-nums text-accent">{n}</span>
        <span className="text-[13px] font-bold">{title}</span>
      </legend>
      {description && <p className="mb-3 mt-1 text-xs text-muted">{description}</p>}
      <div className={`grid gap-3 ${cols === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2'}`}>{children}</div>
    </fieldset>
  );
}

/** "will be created" hint for searchable fields that accept new values. */
const newHint = (value, options) => {
  const v = value.trim().toLowerCase();
  return v && !options.some((o) => o.toLowerCase() === v) ? `"${value.trim()}" will be added as a new option.` : undefined;
};

/**
 * Add / Edit medicine. A medicine is the product only: prices, expiry and quantities belong to batches
 * and are deliberately not on this form.
 */
export default function MedicineForm({ initial, facets, onDone, onClose }) {
  const editing = Boolean(initial?._id);
  const start = useMemo(() => initialValues(initial), [initial]);
  const [m, setM] = useState(start);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({}); // from the API; cleared per field when that field is edited
  const [dupes, setDupes] = useState({}); // live duplicate warnings for sku / barcode
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef(null);

  const dirty = isDirty(start, m);
  const clientErrors = validateMedicine(m);
  const errorFor = (k) => {
    if (serverErrors[k]) return serverErrors[k];
    if (dupes[k]) return dupes[k];
    return submitted || touched[k] ? clientErrors[k] : undefined;
  };

  const change = (k, v) => {
    setM((s) => ({ ...s, [k]: v }));
    setServerErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
    if (k === 'sku' || k === 'barcode') setDupes((d) => (d[k] ? { ...d, [k]: undefined } : d));
  };
  const set = (k) => (e) => change(k, e.target.value);
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }));
  const field = (k) => ({ value: m[k], onChange: set(k), onBlur: blur(k), error: errorFor(k) });

  // Ask the server whether a SKU / barcode is already taken, as soon as the person leaves the field.
  const checkDuplicate = (k) => async () => {
    setTouched((t) => ({ ...t, [k]: true }));
    const value = m[k].trim();
    if (!value || codeProblem(value, FIELD_LABELS[k])) return;
    try {
      const r = await medicineService.duplicates({ [k]: value, excludeId: editing ? initial._id : undefined });
      const hit = r?.[k];
      setDupes((d) => ({
        ...d,
        [k]: hit ? `${FIELD_LABELS[k]} is already used by "${hit.name}"${hit.archived ? ' (archived)' : ''}.` : undefined,
      }));
    } catch {
      /* the save will check again; a failed lookup must not block typing */
    }
  };

  const setAttr = (i, patch) => {
    setM((s) => ({ ...s, attributes: s.attributes.map((a, n) => (n === i ? { ...a, ...patch } : a)) }));
    setServerErrors((e) => (e.attributes ? { ...e, attributes: undefined } : e));
  };

  const focusFirstError = () =>
    requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setGeneral('');
    const blocking = Object.keys(clientErrors).length || Object.values(dupes).some(Boolean);
    if (blocking) {
      focusFirstError();
      return;
    }
    setBusy(true);
    try {
      const body = toPayload(m);
      const saved = editing ? await medicineService.update(initial._id, body) : await medicineService.create(body);
      toast.success(editing ? `"${saved.medicineName}" updated` : `"${saved.medicineName}" added to inventory`);
      onDone(saved, !editing);
    } catch (err) {
      const { fields, general: g } = serverFieldErrors(err);
      setServerErrors(fields);
      setGeneral(g);
      if (Object.keys(fields).length) focusFirstError();
      else toast.error(g);
    } finally {
      setBusy(false);
    }
  };

  // Closing with unsaved changes asks first.
  const requestClose = () => {
    if (busy || confirming) return;
    if (dirty) setConfirming(true);
    else onClose();
  };

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const errorList = Object.keys(FIELD_LABELS).filter((k) => submitted && errorFor(k));
  const options = (list) => (list || []).map((c) => (typeof c === 'string' ? c : c.name));
  const compounds = options(facets?.compounds);
  const manufacturers = options(facets?.manufacturers);
  const categories = options(facets?.categories);
  const dosageForms = facets?.dosageForms?.length ? facets.dosageForms : DOSAGE_FORMS;
  const attributeDefs = facets?.attributeDefs || []; // this organization's custom attributes (Attributes page)
  const strengths = facets?.strengths || [];
  // the companies already in use, so the same name is not typed three ways; a manufacturer is usually the company too
  const companies = [...new Set([...options(facets?.companies), ...manufacturers])].sort((a, b) => a.localeCompare(b));
  const packLine = packingSummary(m); // "Box of 10 × 15 tablets", as it reads on a label
  const perOuter = unitsPerOuter(m);
  const split = gstSplit(m.taxability === 'taxable' ? m.gstPercentage : 0); // one rate, shown the way a bill charges it

  return (
    <>
      <Modal
        wide
        title={editing ? 'Edit medicine' : 'Add medicine'}
        description={editing ? 'Update the product details. Prices, expiry and quantities belong to batches.' : 'Create the product record. You can add its first batch right after.'}
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="medicine-form" loading={busy} disabled={editing && !dirty}>
              {editing ? 'Save changes' : 'Add medicine'}
            </Button>
          </>
        }
      >
        <form id="medicine-form" ref={formRef} onSubmit={submit} noValidate className="space-y-4">
          <datalist id="attribute-names">
            {attributeDefs.map((d) => (
              <option key={d.id} value={d.name} />
            ))}
          </datalist>
          {(general || errorList.length > 0) && (
            <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {general || `Please fix ${errorList.length} ${errorList.length === 1 ? 'field' : 'fields'}: ${errorList.map((k) => FIELD_LABELS[k]).join(', ')}.`}
            </div>
          )}

          <Section n="01" title="Product identification" description="What the product is and how it is recognised on the shelf and at the counter.">
            <Input label="Medicine name" required placeholder="e.g. Dolo 650" autoFocus maxLength={LIMITS.medicineName} className="sm:col-span-2" {...field('medicineName')} />
            <Input label="Generic name" placeholder="e.g. Paracetamol" maxLength={LIMITS.genericName} {...field('genericName')} />
            <Combobox label="Salt / compound" placeholder="Search or type a new one" options={compounds} value={m.salt} onChange={(v) => change('salt', v)} error={errorFor('salt')} hint={newHint(m.salt, compounds)} />
            <Combobox label="Manufacturer" placeholder="Search or type a new one" options={manufacturers} value={m.manufacturer} onChange={(v) => change('manufacturer', v)} error={errorFor('manufacturer')} hint={newHint(m.manufacturer, manufacturers)} />
            <Combobox label="Company" placeholder="Whose name is on the pack" options={companies} value={m.company} onChange={(v) => change('company', v)} error={errorFor('company')} hint="Leave empty when it is the same as the manufacturer." />
            <Combobox label="Category" placeholder="Search or type a new one" options={categories} value={m.categoryName} onChange={(v) => change('categoryName', v)} error={errorFor('categoryName')} hint={newHint(m.categoryName, categories)} />
            <Combobox label="Dosage form" placeholder="Select or type" options={dosageForms} value={m.dosageForm} onChange={(v) => change('dosageForm', v)} error={errorFor('dosageForm')} />
            <Combobox label="Strength" placeholder="e.g. 650 mg" options={strengths} value={m.strength} onChange={(v) => change('strength', v)} error={errorFor('strength')} />
            <Input label="SKU" placeholder="Internal stock code" hint="Must be unique in your organization." maxLength={LIMITS.sku} {...field('sku')} onBlur={checkDuplicate('sku')} />
            <Input label="Barcode / EAN" placeholder="Scan or type" hint="Must be unique in your organization." maxLength={LIMITS.barcode} {...field('barcode')} onBlur={checkDuplicate('barcode')} />
          </Section>

          <Section n="02" title="Packing & classification" description="How it arrives from the supplier and how it is classified for tax. Stock is always counted in the sellable unit." cols={3}>
            <Combobox label="Outer pack" placeholder="Box, Carton…" options={PACK_UNITS} value={m.outerUnit} onChange={(v) => change('outerUnit', v)} error={errorFor('packing.outerUnit')} />
            <Input label="Outer quantity" type="number" min="1" step="1" placeholder="1" hint="Inner packs per outer." {...field('outerQty')} />
            <Combobox label="Inner pack (sellable)" placeholder="Strip, Bottle…" options={PACK_UNITS} value={m.innerUnit} onChange={(v) => change('innerUnit', v)} error={errorFor('packing.innerUnit')} />
            <Input label="Units per inner pack" type="number" min="1" step="1" placeholder="10" {...field('innerQty')} />
            <Input label="HSN / SAC" placeholder="e.g. 30049099" inputMode="numeric" maxLength={8} {...field('hsnCode')} />
            <Input label="Reorder level" required type="number" min="0" step="1" hint="You'll be alerted when available stock falls below this." {...field('reorderLevel')} />
            {packLine && (
              <p className="rounded-lg bg-subtle px-3 py-2 text-xs sm:col-span-2 lg:col-span-3">
                <span className="font-semibold">{packLine}</span>
                {perOuter ? <span className="text-muted"> — {perOuter} sellable units in one {m.outerUnit.toLowerCase()}.</span> : null}
              </p>
            )}
          </Section>

          <Section n="03" title="Pricing & taxation" description="Tax applies to every sale of this product. Prices here are only defaults for a new batch — a sale is always priced from the batch it comes out of." cols={3}>
            <FormField label="Tax applicability" error={errorFor('taxability')}>
              {(a) => (
                <select {...a} value={m.taxability} onChange={set('taxability')} className={cx(inputCls, 'pr-8')}>
                  {TAXABILITY.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <Input
              label="GST percentage"
              required={m.taxability === 'taxable'}
              type="number"
              min="0"
              max="100"
              step="0.01"
              disabled={m.taxability !== 'taxable'}
              hint={m.taxability === 'taxable' ? undefined : 'Exempt and nil-rated products carry no GST.'}
              {...field('gstPercentage')}
            />
            <div className="rounded-lg bg-subtle px-3 py-2 text-xs" aria-label="How this rate is charged">
              <div className="font-semibold">How it is charged</div>
              <div className="mt-0.5 tabular-nums text-muted">
                Within the state: CGST {split.cgst}% + SGST {split.sgst}%
                <br />
                Across states: IGST {split.igst}%
              </div>
            </div>
            <Input label="M.R.P. (₹)" type="number" min="0" step="0.01" placeholder="Printed on the pack" hint="Prefills a new batch." {...field('defaultMrp')} />
            <Input label="Purchase rate (₹)" type="number" min="0" step="0.01" placeholder="What you pay" hint="Prefills a new batch." {...field('defaultPurchasePrice')} />
            <FormField label="Available stock">
              {(a) => <input {...a} readOnly value={editing ? `${initial.availableStock ?? 0} ${initial.unit || 'units'}` : 'Added with the first batch'} className={cx(inputCls, 'bg-subtle text-muted')} />}
            </FormField>
          </Section>

          <Section n="04" title="Additional information">
            <FormField label="Description" className="sm:col-span-2" error={errorFor('description')} hint={`${m.description.length}/${LIMITS.description}`}>
              {(a) => (
                <textarea {...a} rows={3} maxLength={LIMITS.description} value={m.description} onChange={set('description')} onBlur={blur('description')} placeholder="Optional notes about this medicine" className={cx(inputCls, 'h-auto py-2', errorFor('description') && 'border-danger')} />
              )}
            </FormField>

            <div className="sm:col-span-2">
              <ImageDropzone
                label="Product image"
                value={m.image.trim()}
                onChange={(url) => change('image', url)}
                upload={(file) => medicineService.uploadImage(file)}
                error={errorFor('image')}
                hint="Shown on the product and at the counter. It is stored with your organization and only your team can see it."
              />
            </div>

            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-semibold">Custom attributes</span>
                {m.attributes.length < LIMITS.attributes && (
                  <Button size="sm" variant="secondary" onClick={() => setM((s) => ({ ...s, attributes: [...s.attributes, { key: '', value: '' }] }))}>
                    <Plus className="h-3.5 w-3.5" /> Add attribute
                  </Button>
                )}
              </div>
              {m.attributes.length === 0 ? (
                <p className="text-xs text-muted">
                  Optional extra details such as storage conditions or schedule type.
                  {attributeDefs.length > 0 && ` Your organization defines: ${attributeDefs.map((d) => d.name).join(', ')}.`}
                </p>
              ) : (
                <div className="space-y-2">
                  {m.attributes.map((a, i) => {
                    const def = attributeDefs.find((d) => d.name.toLowerCase() === a.key.trim().toLowerCase());
                    return (
                    <div key={i} className="flex items-center gap-2">
                      <input aria-label={`Attribute ${i + 1} name`} aria-invalid={Boolean(errorFor('attributes'))} list="attribute-names" placeholder="Name" maxLength={LIMITS.attributeKey} value={a.key} onChange={(e) => setAttr(i, { key: e.target.value })} className={inputCls} />
                      {def?.values.length ? (
                        <select aria-label={`Attribute ${i + 1} value`} value={a.value} onChange={(e) => setAttr(i, { value: e.target.value })} className={cx(inputCls, 'pr-8')}>
                          <option value="">Select a value…</option>
                          {[...new Set([...def.values, ...(a.value ? [a.value] : [])])].map((v) => (
                            <option key={v} value={v}>
                              {v}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input aria-label={`Attribute ${i + 1} value`} placeholder="Value" maxLength={LIMITS.attributeValue} value={a.value} onChange={(e) => setAttr(i, { value: e.target.value })} className={inputCls} />
                      )}
                      <button type="button" aria-label={`Remove attribute ${i + 1}`} onClick={() => setM((s) => ({ ...s, attributes: s.attributes.filter((_, n) => n !== i) }))} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted hover:bg-subtle hover:text-danger">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    );
                  })}
                  {errorFor('attributes') && <p role="alert" className="text-xs text-danger">{errorFor('attributes')}</p>}
                </div>
              )}
            </div>
          </Section>
        </form>
      </Modal>

      {confirming && (
        <ConfirmDialog
          danger
          title="Discard unsaved changes?"
          message="You have changes that haven't been saved. If you close now they will be lost."
          confirmLabel="Discard changes"
          onConfirm={onClose}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
