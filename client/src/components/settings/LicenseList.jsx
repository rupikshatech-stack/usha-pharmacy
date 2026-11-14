import { useRef, useState } from 'react';
import { CalendarClock, FileText, Loader2, Paperclip, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsService } from '../../services/settingsService';
import { Badge, Button, Input, Select, cx } from '../common/ui';

/**
 * Drug licences, as a list.
 *
 * A pharmacy holds several at once — Form 20 and 21 for retail, 20B and 21B for wholesale, 20C/21C for Schedule X —
 * each with its own number and its own expiry date. A single "licence number" field can hold one of them, which is
 * why it cannot answer the question an inspector actually asks. Each row carries its own dates and its own scan.
 *
 * The expiry status comes from the SERVER (`status`, `daysToExpiry`) for rows that have been saved, so the warning
 * on screen is the same one the bell and any report would use. A row being typed now has no status yet, and does
 * not pretend to.
 */
const STATUS = {
  expired: { tone: 'danger', label: 'Expired' },
  expiring: { tone: 'warning', label: 'Expiring soon' },
  valid: { tone: 'success', label: 'Valid' },
  no_expiry: { tone: 'neutral', label: 'No expiry recorded' },
};

const blankLicense = () => ({ type: '20', number: '', issuedBy: '', validFrom: '', validUntil: '', notes: '', document: null });

/** A date as the input wants it (yyyy-mm-dd), from whatever the server sent. */
const asDateInput = (v) => (v ? String(v).slice(0, 10) : '');

export default function LicenseList({ licenses, options, onChange, errors = {}, disabled }) {
  const [uploading, setUploading] = useState(null);
  const fileRefs = useRef({});

  const update = (index, field, value) => onChange(licenses.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  const add = () => onChange([...licenses, blankLicense()]);
  const remove = (index) => onChange(licenses.filter((_, i) => i !== index));

  const attach = async (index, file) => {
    if (!file) return;
    if (file.size > 5 * 1048576) {
      toast.error('Use a file up to 5 MB.');
      return;
    }
    setUploading(index);
    try {
      const saved = await settingsService.uploadDocument(file);
      update(index, 'document', { storageKey: saved.storageKey, fileName: saved.fileName, mimeType: saved.mimeType, size: saved.size, url: saved.url });
      toast.success('Document attached. Save to keep it.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="space-y-3" data-field="licenses">
      {licenses.length === 0 && (
        <p className="rounded-xl border border-dashed border-line bg-subtle/40 p-4 text-center text-sm text-muted">
          No drug licences recorded yet. Add each one you hold — they expire on different dates.
        </p>
      )}

      {licenses.map((l, i) => {
        const status = l.status ? STATUS[l.status] : null;
        return (
          <div key={l._id || l.key || i} className={cx('rounded-2xl border p-4', l.status === 'expired' ? 'border-danger/40 bg-danger/5' : 'border-line bg-card')}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Licence {i + 1}</span>
                {status && (
                  <Badge tone={status.tone} dot>
                    {status.label}
                    {typeof l.daysToExpiry === 'number' && l.status === 'expiring' ? ` · ${l.daysToExpiry} days` : ''}
                  </Badge>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={`Remove licence ${i + 1}`}
                className="rounded-lg p-1.5 text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Select label="Type" required value={l.type} onChange={(e) => update(i, 'type', e.target.value)} disabled={disabled}>
                {(options || []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Input
                label="Licence number"
                required
                value={l.number || ''}
                onChange={(e) => update(i, 'number', e.target.value)}
                error={errors[`licenses.${i}.number`]}
                disabled={disabled}
                placeholder="MH-20B-123456"
              />
              <Input label="Valid from" type="date" value={asDateInput(l.validFrom)} onChange={(e) => update(i, 'validFrom', e.target.value)} disabled={disabled} />
              <Input
                label="Valid until"
                type="date"
                value={asDateInput(l.validUntil)}
                onChange={(e) => update(i, 'validUntil', e.target.value)}
                error={errors[`licenses.${i}.validUntil`]}
                disabled={disabled}
                hint={l.validFrom && l.validUntil && l.validUntil < l.validFrom ? undefined : 'Used for the expiry warning'}
              />
              <Input
                label="Issued by"
                className="sm:col-span-2"
                value={l.issuedBy || ''}
                onChange={(e) => update(i, 'issuedBy', e.target.value)}
                disabled={disabled}
                placeholder="FDA Maharashtra"
              />
              <Input label="Note" className="sm:col-span-2" value={l.notes || ''} onChange={(e) => update(i, 'notes', e.target.value)} disabled={disabled} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {l.document ? (
                <>
                  <a
                    href={l.document.url || `/api/settings/documents/${String(l.document.storageKey || '').split('/').pop()}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-line"
                  >
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    {l.document.fileName || 'Scanned licence'}
                  </a>
                  <button
                    type="button"
                    onClick={() => update(i, 'document', null)}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-danger"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" /> Detach
                  </button>
                </>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => fileRefs.current[i]?.click()} disabled={disabled || uploading === i}>
                  {uploading === i ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />}
                  {uploading === i ? 'Uploading…' : 'Attach scan'}
                </Button>
              )}
              <span className="text-[11px] text-muted">PDF, PNG, JPG or WebP · up to 5 MB</span>
              <input
                ref={(el) => {
                  fileRefs.current[i] = el;
                }}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  attach(i, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        );
      })}

      <Button variant="secondary" onClick={add} disabled={disabled}>
        <Plus className="h-4 w-4" aria-hidden="true" /> Add a licence
      </Button>

      {licenses.some((l) => l.status === 'expired' || l.status === 'expiring') && (
        <p className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs text-ink">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>
            A licence that has lapsed is not a paperwork problem — trading on it is an offence. Renew it and update the dates here;
            the warning follows the date you enter.
          </span>
        </p>
      )}
      {licenses.length > 0 && !licenses.some((l) => l.validUntil) && (
        <p className="flex items-start gap-2 text-[11px] text-muted">
          <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Add the expiry dates and this page will warn you before they lapse.
        </p>
      )}
    </div>
  );
}
