import { useState } from 'react';
import { Lock, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { attributeService } from '../../services/catalogService';
import { ATTRIBUTE_TYPES, LIMITS, apiFieldErrors, attributePayload, hasValues, parseValues, typeLabel, validateAttribute } from '../../utils/catalogValidation';
import { Button, ConfirmDialog, FormField, Input, Modal, Select, cx } from '../common/ui';

/** Chips editor for the allowed values: type and press Enter or comma (pasting a list works too). */
function ValuesEditor({ values, onChange, error, examples, optionalHint }) {
  const [draft, setDraft] = useState('');
  const add = (text) => {
    const more = parseValues(text, values);
    if (more.length) onChange([...values, ...more]);
    setDraft('');
  };
  const unused = examples.filter((x) => !values.some((v) => v.toLowerCase() === x.toLowerCase()));

  return (
    <FormField label="Allowed values" error={error} hint={optionalHint}>
      {(a) => (
        <div>
          <div className={cx('flex flex-wrap gap-1.5 rounded-lg border bg-card p-2', error ? 'border-danger' : 'border-line')}>
            {values.map((v) => (
              <span key={v} className="inline-flex items-center gap-1 rounded-full bg-subtle py-0.5 pl-2.5 pr-1 text-xs font-semibold">
                {v}
                <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="grid h-4 w-4 place-items-center rounded-full text-muted hover:bg-line hover:text-danger">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              {...a}
              value={draft}
              maxLength={LIMITS.value * 5}
              placeholder={values.length ? 'Add another…' : 'Type a value and press Enter'}
              onChange={(e) => (/[,;\n]/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add(draft);
                } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
              }}
              onBlur={() => draft && add(draft)}
              className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-muted/70"
            />
          </div>
          {unused.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Suggestions:
              {unused.map((x) => (
                <button key={x} type="button" onClick={() => onChange([...values, x])} className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-line px-2 py-0.5 font-semibold hover:border-primary hover:text-primary">
                  <Plus className="h-3 w-3" /> {x}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </FormField>
  );
}

/** Add or edit an attribute. The type is chosen when adding and is fixed afterwards. */
export default function AttributeForm({ initial, defaultType = 'dosage_form', onDone, onClose }) {
  const editing = Boolean(initial?._id);
  const [start] = useState(() => ({
    attributeName: initial?.attributeName || '',
    attributeType: initial?.attributeType || defaultType,
    values: initial?.values || [],
    status: initial?.status || 'active',
  }));
  const [v, setV] = useState(start);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const type = ATTRIBUTE_TYPES.find((t) => t.value === v.attributeType);
  const dirty = JSON.stringify(v) !== JSON.stringify(start);
  const errors = validateAttribute(v);
  const err = (k) => serverErrors[k] || (submitted || touched[k] ? errors[k] : undefined);
  const clearServer = (k) => setServerErrors((s) => (s[k] ? { ...s, [k]: undefined } : s));
  const set = (k) => (e) => {
    setV((s) => ({ ...s, [k]: e.target.value }));
    clearServer(k);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    const body = attributePayload(v, editing ? initial : null);
    if (editing && !Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      const saved = editing ? await attributeService.update(initial._id, body) : await attributeService.create(body);
      toast.success(`${typeLabel(saved.attributeType)} “${saved.attributeName}” ${editing ? 'updated' : 'added'}`);
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

  return (
    <>
      <Modal
        wide
        title={editing ? `Edit ${typeLabel(v.attributeType).toLowerCase()}` : 'Add attribute'}
        description={type?.help}
        onClose={requestClose}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form="attribute-form" loading={busy} disabled={editing && !dirty}>
              {editing ? 'Save changes' : 'Add attribute'}
            </Button>
          </>
        }
      >
        <form id="attribute-form" onSubmit={submit} noValidate className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" required autoFocus maxLength={LIMITS.attributeName} placeholder={v.attributeType === 'custom' ? 'e.g. Storage condition' : v.attributeType === 'category' ? 'e.g. Tablets' : 'e.g. Dosage forms'} value={v.attributeName} onChange={set('attributeName')} onBlur={() => setTouched((t) => ({ ...t, attributeName: true }))} error={err('attributeName')} />
            {editing ? (
              <div>
                <div className="mb-1.5 flex items-center gap-1 text-[13px] font-semibold">
                  Type <Lock className="h-3 w-3 text-muted" aria-hidden="true" />
                </div>
                <div className="flex h-10 items-center rounded-lg border border-line bg-subtle px-3 text-sm text-muted">{typeLabel(v.attributeType)} (can’t be changed)</div>
              </div>
            ) : (
              <Select label="Type" required value={v.attributeType} onChange={(e) => setV((s) => ({ ...s, attributeType: e.target.value, values: [] }))} error={err('attributeType')}>
                {ATTRIBUTE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {hasValues(v.attributeType) && (
            <ValuesEditor
              values={v.values}
              examples={type?.examples || []}
              error={err('values')}
              optionalHint={v.attributeType === 'custom' ? 'Leave empty to accept any text. With values, a medicine can only use these.' : 'Offered as choices in the medicine form.'}
              onChange={(values) => {
                setV((s) => ({ ...s, values }));
                clearServer('values');
              }}
            />
          )}

          <Select label="Status" value={v.status} onChange={set('status')} hint="A disabled attribute is not offered in the medicine form. Existing medicines keep their values.">
            <option value="active">Enabled</option>
            <option value="inactive">Disabled</option>
          </Select>
        </form>
      </Modal>
      {confirming && <ConfirmDialog danger title="Discard changes?" message="You have unsaved changes. If you close now they will be lost." confirmLabel="Discard changes" onConfirm={onClose} onClose={() => setConfirming(false)} />}
    </>
  );
}
