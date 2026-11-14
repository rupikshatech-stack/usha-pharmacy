import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, FileText, Hash, History, Info, Lock, Printer, Scale, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsService } from '../../services/settingsService';
import { useAuth } from '../../context/AuthContext';
import { getPath, scrollToFirstError, useDirtyForm } from '../../hooks/useDirtyForm';
import { draftKey, useSettingsDraft } from '../../hooks/useSettingsDraft';
import { formatDocumentNumber } from '../../utils/documentNumberFormat';
import { SAMPLE_INVOICE, printRenderedInvoice, renderInvoiceHtml } from '../../utils/invoiceTemplate';
import { Badge, Button, Card, Input, Select, cx } from '../../components/common/ui';
import SaveBar from '../../components/settings/SaveBar';

/** Every print toggle, grouped the way somebody thinks about an invoice rather than the way it is stored. */
const TOGGLES = [
  { group: 'Header', items: [['logo', 'Store logo'], ['gstin', 'GSTIN'], ['drugLicenses', 'Drug licence numbers']] },
  { group: 'Item table', items: [['hsn', 'HSN column'], ['batchExpiry', 'Batch & expiry'], ['mrp', 'MRP column'], ['discount', 'Discount column']] },
  { group: 'Totals', items: [['taxBreakup', 'Tax breakup table'], ['amountInWords', 'Amount in words']] },
  { group: 'Footer', items: [['bankDetails', 'Bank details'], ['upiQr', 'UPI QR code'], ['signature', 'Signature block'], ['computerGenerated', '“Computer-generated invoice”']] },
];

const toForm = (invoice) => ({
  perBranch: Boolean(invoice.perBranch),
  series: invoice.series.reduce((acc, s) => {
    acc[s.series] = { organization: { ...s.organization }, branches: Object.fromEntries(s.branches.filter((b) => b.configured).map((b) => [b.branchId, { ...b.config }])) };
    return acc;
  }, {}),
  template: {
    paperSize: invoice.template.paperSize,
    style: invoice.template.style,
    accentColor: invoice.template.accentColor,
    show: { ...invoice.template.show },
  },
  terms: {
    terms: invoice.terms.terms || '',
    footerNote: invoice.terms.footerNote || '',
    returnPolicy: invoice.terms.returnPolicy || '',
    declaration: invoice.terms.declaration || '',
    signatoryName: invoice.terms.signatoryName || '',
  },
  calculation: { ...invoice.calculation },
});

/** What the PATCH body looks like: the stored shape, not the screen's. */
const toPatch = (values) => ({
  perBranch: values.perBranch,
  series: Object.entries(values.series).flatMap(([series, cfg]) => [
    { ...cfg.organization, series, branchId: null },
    ...Object.entries(cfg.branches).map(([branchId, c]) => ({ ...c, series, branchId })),
  ]),
  template: values.template,
  terms: values.terms,
  // itemDiscountBeforeTax is a rule, not a choice: the server refuses `false`, so it is never sent.
  calculation: { roundOffNearest: values.calculation.roundOffNearest },
});

const Section = ({ icon: Icon, title, hint, children, right }) => (
  <Card className="p-5">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon className="h-4 w-4 text-muted" aria-hidden="true" /> {title}
        </h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {right}
    </div>
    {children}
  </Card>
);

const Toggle = ({ label, checked, onChange, disabled, hint }) => (
  <label className={cx('flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors', !disabled && 'hover:bg-subtle')}>
    <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--primary)]" />
    <span className="min-w-0">
      {label}
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
    </span>
  </label>
);

/**
 * Tab 2: how documents are numbered and how an invoice is printed.
 *
 * THE PREVIEW IS THE REAL THING. It renders through `renderInvoiceHtml` — the same function the till prints with —
 * so what is tuned here is literally what comes out of the printer. A preview that merely resembled the invoice
 * would be worse than none: somebody would trust it, print, and find the GSTIN missing.
 *
 * THE NUMBERING IS THE DANGEROUS PART, and the screen treats it that way: it shows the counter's last issued number
 * beside the next one, refuses a start below what has already been issued (the server refuses it too), and says
 * plainly that renaming a series never touches a document that exists.
 */
export default function InvoiceTab({ data, canManage, onSaved, onDirtyChange, discardSignal }) {
  const { user } = useAuth();
  const initial = useMemo(() => toForm(data.invoice), [data.invoice]);
  const form = useDirtyForm(initial);
  const { values, set, errors, setErrors, dirty, changedCount, reset } = form;

  const [series, setSeries] = useState('sales');
  const [scope, setScope] = useState('org');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [counters, setCounters] = useState({});
  const firstDiscard = useRef(discardSignal);

  const key = draftKey({ orgId: user?.organization?.id || user?.organizationId, userId: user?.id || user?._id, tab: 'invoice' });
  const clearDraftRef = useRef(() => {});
  const draft = useSettingsDraft({ key, values, server: initial, dirty, enabled: canManage });
  const { clear: clearDraft } = draft;
  useEffect(() => {
    clearDraftRef.current = clearDraft;
  }, [clearDraft]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (discardSignal !== firstDiscard.current) {
      firstDiscard.current = discardSignal;
      reset();
      clearDraftRef.current();
    }
  }, [discardSignal, reset]);

  /** What the counter has actually issued — read once per series and store, never incremented by looking. */
  useEffect(() => {
    let live = true;
    const branchId = scope === 'org' ? undefined : scope;
    settingsService
      .previewNumber({ series, ...(branchId ? { branchId } : {}) })
      .then((d) => live && setCounters((c) => ({ ...c, [`${series}|${scope}`]: d })))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [series, scope, savedAt]);

  const seriesMeta = data.invoice.series.find((s) => s.series === series);
  const config = scope === 'org' ? values.series[series].organization : values.series[series].branches[scope] || values.series[series].organization;
  const branchConfigured = scope !== 'org' && Boolean(values.series[series].branches[scope]);
  const counter = counters[`${series}|${scope}`];
  /**
   * Today's financial year, as the SERVER works it out (`GET /settings` returns it). Reading the clock in the browser
   * during render would make the output unstable, and would be a second opinion on a question the server already
   * answers - in the organization's own timezone, which the browser does not know.
   */
  const fy = data.general.financialYear;

  /** Editing a store's numbering for the first time starts from what it currently follows: the organization's. */
  const setConfig = (field, value) => {
    if (scope === 'org') set(`series.${series}.organization.${field}`, value);
    else {
      const base = values.series[series].branches[scope] || values.series[series].organization;
      set(`series.${series}.branches.${scope}`, { ...base, [field]: value });
    }
  };

  const nextSequence = Math.max((counter?.nextSequence ?? 1), Number(config.start) || 1);
  const nextNumber = formatDocumentNumber(config, nextSequence, { financialYearLabel: fy });
  const startTooLow = counter?.lastIssued && Number(config.start) > 1 && Number(config.start) <= (counter.nextSequence - 1);

  /* ------------------------------------------------------------------ the preview */
  const previewHtml = useMemo(
    () =>
      renderInvoiceHtml({
        invoice: SAMPLE_INVOICE,
        settings: { template: values.template, terms: values.terms, calculation: values.calculation },
        org: data.organization,
        preview: true,
      }),
    [values.template, values.terms, values.calculation, data.organization],
  );

  const save = async () => {
    const found = {};
    if (startTooLow) found[`series.${series}.start`] = `Number ${counter.nextSequence - 1} has already been issued — start at ${counter.nextSequence} or higher`;
    if (Object.keys(found).length) {
      setErrors(found);
      setSaveError('Some fields need attention.');
      scrollToFirstError(found);
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const saved = await settingsService.saveInvoice({ version: data.version, ...toPatch(values) });
      form.commit(toForm(saved.settings.invoice));
      setSavedAt(Date.now());
      draft.clear();
      onSaved(saved.settings);
      const raised = (saved.counters || []).filter((c) => c.raised);
      toast.success(saved.unchanged ? 'Nothing had changed.' : `Saved ${saved.changes.length} ${saved.changes.length === 1 ? 'change' : 'changes'}.`);
      if (raised.length) {
        toast(`${raised.length} numbering counter(s) were raised so the new settings cannot re-issue an existing number.`, { icon: 'ℹ️', duration: 6000 });
      }
    } catch (e) {
      if (e.code === 'SETTINGS_CONFLICT') setConflict(e.message);
      else if (e.code === 'NUMBER_ALREADY_ISSUED' && Array.isArray(e.details)) {
        const mapped = { [`series.${series}.start`]: e.details[0]?.message || e.message };
        setErrors(mapped);
        setSaveError(e.message);
        scrollToFirstError(mapped);
      } else setSaveError(e.message);
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {draft.draft && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-accent/40 bg-accent/5 p-4">
          <p className="flex items-start gap-2 text-sm">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span>
              You have <strong>{draft.changedFields.length} unsaved {draft.changedFields.length === 1 ? 'change' : 'changes'}</strong> from earlier. They were kept in
              this browser tab, not saved.
            </span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={draft.discard}>
              Discard
            </Button>
            <Button
              onClick={() => {
                for (const path of draft.changedFields) set(path, getPath(draft.draft.values, path));
                draft.accept();
                toast.success('Restored your unsaved changes.');
              }}
            >
              Restore
            </Button>
          </div>
        </Card>
      )}

      {conflict && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-warning/40 bg-warning/10 p-4">
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{conflict}</span>
          </p>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        {/* ---------------------------------------------------------------- settings */}
        <div className="space-y-4">
          <Section
            icon={Hash}
            title="Document numbering"
            hint="What the NEXT document is called. Numbers already issued are never changed."
            right={
              <Toggle
                label="Number each store separately"
                checked={values.perBranch}
                onChange={(v) => set('perBranch', v)}
                disabled={!canManage}
              />
            }
          >
            <div className="mb-4 flex flex-wrap gap-2">
              {data.options.series.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setSeries(s.value)}
                  className={cx(
                    'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
                    series === s.value ? 'bg-sage text-sage-ink' : 'bg-subtle text-muted hover:text-ink',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {values.perBranch && (
              <Select label="Numbering for" className="mb-3 w-64" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="org">All stores (organization default)</option>
                {(seriesMeta?.branches || []).map((b) => (
                  <option key={b.branchId} value={b.branchId}>
                    {b.name}
                    {values.series[series].branches[b.branchId] ? ' — own numbering' : ' — follows the default'}
                  </option>
                ))}
              </Select>
            )}

            {scope !== 'org' && !branchConfigured && (
              <p className="mb-3 rounded-lg bg-subtle p-2.5 text-xs text-muted">
                This store follows the organization default. Change anything below and it gets its own numbering.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input label="Prefix" value={config.prefix || ''} onChange={(e) => setConfig('prefix', e.target.value)} disabled={!canManage} placeholder="INV" maxLength={12} />
              <Input label="Separator" value={config.separator ?? '-'} onChange={(e) => setConfig('separator', e.target.value)} disabled={!canManage} maxLength={3} placeholder="-" />
              <Input label="Suffix" value={config.suffix || ''} onChange={(e) => setConfig('suffix', e.target.value)} disabled={!canManage} maxLength={12} />
              <Input
                label="Padding"
                type="number"
                value={config.padding ?? 4}
                onChange={(e) => setConfig('padding', Number(e.target.value))}
                disabled={!canManage}
                hint="0001 is four"
                min={0}
                max={12}
              />
              <Input
                label="Start at"
                type="number"
                value={config.start ?? 1}
                onChange={(e) => setConfig('start', Number(e.target.value))}
                disabled={!canManage}
                error={errors[`series.${series}.start`]}
                data-field={`series.${series}.start`}
                min={1}
              />
            </div>

            <div className="mt-3 space-y-1">
              <Toggle label="Include the financial year" hint={`Prints as ${fy}`} checked={config.includeFinancialYear} onChange={(v) => setConfig('includeFinancialYear', v)} disabled={!canManage} />
              <Toggle
                label="Start again each financial year"
                hint="On 1 April the sequence returns to the start — and gets its own counter, so last year's numbers are untouched"
                checked={config.resetEveryFinancialYear}
                onChange={(v) => setConfig('resetEveryFinancialYear', v)}
                disabled={!canManage}
              />
            </div>

            <div className="mt-4 rounded-xl border border-line bg-subtle/50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Next number</span>
                <code className="text-lg font-bold tracking-tight">{nextNumber}</code>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {counter?.lastIssued ? (
                  <>
                    Last issued <strong className="text-ink">{counter.lastIssued}</strong> · counter <code>{counter.counterKey}</code>
                  </>
                ) : (
                  <>Nothing issued yet in this series · counter <code>{counter?.counterKey || '…'}</code></>
                )}
              </p>
              {startTooLow && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Number {counter.nextSequence - 1} has already been issued. Numbering cannot start at or below it — those documents exist.
                </p>
              )}
            </div>
          </Section>

          <Section icon={FileText} title="Template & layout" hint="How the invoice is laid out and what it shows.">
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Paper size" value={values.template.paperSize} onChange={(e) => set('template.paperSize', e.target.value)} disabled={!canManage}>
                {data.options.paperSizes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select label="Template style" value={values.template.style} onChange={(e) => set('template.style', e.target.value)} disabled={!canManage}>
                {data.options.templates.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div>
                <span className="mb-1.5 block text-[13px] font-semibold">Accent colour</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={values.template.accentColor || '#0f766e'}
                    onChange={(e) => set('template.accentColor', e.target.value)}
                    disabled={!canManage}
                    className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-card"
                    aria-label="Accent colour"
                  />
                  <code className="text-xs text-muted">{values.template.accentColor}</code>
                </div>
              </div>
            </div>

            {String(values.template.paperSize).startsWith('thermal') && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-subtle p-2.5 text-xs text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Thermal paper prints in black only, on a narrow roll. The accent colour, the wider columns and the side-by-side blocks are
                dropped automatically — on that paper they come out as grey smudges.
              </p>
            )}

            <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
              {TOGGLES.map(({ group, items }) => (
                <div key={group}>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted">{group}</p>
                  {items.map(([k, label]) => (
                    <Toggle key={k} label={label} checked={values.template.show[k]} onChange={(v) => set(`template.show.${k}`, v)} disabled={!canManage} />
                  ))}
                </div>
              ))}
            </div>

            {values.template.show.upiQr && !data.organization.bank.upiId && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 p-2.5 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                No UPI ID is saved, so no QR can be printed. Add one under Organization Profile → Bank &amp; payment.
              </p>
            )}
            {values.template.show.bankDetails && !data.organization.bank.accountNumber && (
              <p className="mt-2 flex items-start gap-2 rounded-lg bg-warning/10 p-2.5 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                No bank account is saved, so the bank block would print empty.
              </p>
            )}
          </Section>

          <Section icon={Scale} title="Terms & notes" hint="Printed at the foot of every invoice.">
            <div className="space-y-3">
              {[
                ['terms.terms', 'Terms and conditions', 2000, 4],
                ['terms.returnPolicy', 'Return policy', 500, 2],
                ['terms.declaration', 'Declaration', 500, 2],
              ].map(([path, label, max, rows]) => (
                <div key={path}>
                  <span className="mb-1.5 block text-[13px] font-semibold">{label}</span>
                  <textarea
                    value={getPath(values, path)}
                    onChange={(e) => set(path, e.target.value)}
                    disabled={!canManage}
                    rows={rows}
                    maxLength={max}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-primary disabled:opacity-60"
                  />
                  <p className="mt-1 text-right text-[11px] text-muted">
                    {String(getPath(values, path) || '').length}/{max}
                  </p>
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Footer note" value={values.terms.footerNote} onChange={(e) => set('terms.footerNote', e.target.value)} disabled={!canManage} maxLength={300} />
                <Input label="Authorised signatory" value={values.terms.signatoryName} onChange={(e) => set('terms.signatoryName', e.target.value)} disabled={!canManage} maxLength={120} />
              </div>
            </div>
          </Section>

          <Section icon={Scale} title="Calculation defaults">
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-xl border border-line bg-subtle/50 p-3">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div>
                  <p className="text-[13px] font-semibold">Prices include GST</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    Always on. Tax is split out of the marked price, never added on top, so the customer pays the price on the shelf. Exclusive
                    pricing would mean changing how every bill is calculated.
                  </p>
                </div>
              </div>
              <Select
                label="Round off to"
                className="w-48"
                value={String(values.calculation.roundOffNearest)}
                onChange={(e) => set('calculation.roundOffNearest', Number(e.target.value))}
                disabled={!canManage}
                hint={data.general.posRoundOff ? 'Rounding is on for this organization' : 'Rounding is currently off — turn it on under Common Settings'}
              >
                <option value="1">Nearest ₹1</option>
                <option value="0.5">Nearest ₹0.50</option>
              </Select>
              <div className="flex items-start gap-2 rounded-xl border border-line bg-subtle/50 p-3">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div>
                  <p className="text-[13px] font-semibold">Item discount comes off before tax</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    Always on. A discount is taken off the inclusive price first, so the tax falls with it — which is how a retail bill works.
                    Applying it after tax would mean changing how every bill is calculated.
                  </p>
                </div>
              </div>
            </div>
          </Section>

        </div>

        {/* ---------------------------------------------------------------- live preview */}
        <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="flex items-center gap-2 text-[15px] font-bold">
                  <Eye className="h-4 w-4 text-muted" aria-hidden="true" /> Live preview
                </h2>
                <p className="text-xs text-muted">The same renderer the till prints with.</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (!printRenderedInvoice(previewHtml)) toast.error('Allow pop-ups to print');
                }}
              >
                <Printer className="h-3.5 w-3.5" aria-hidden="true" /> Test print
              </Button>
            </div>
            <div className="bg-subtle p-3">
              <iframe
                title="Invoice preview"
                srcDoc={previewHtml}
                sandbox="allow-same-origin"
                className="h-[640px] w-full rounded-lg border border-line bg-white"
              />
            </div>
          </Card>
          <Card className="flex items-start gap-2 p-3 text-[11px] text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              A sample bill, marked PREVIEW, with your own header, licences, terms and toggles. The figures are made up; everything an invoice
              prints about a real sale comes from what the server saved for it.
            </span>
          </Card>
          <Card className="flex items-start gap-2 p-3 text-[11px] text-muted">
            <Badge tone="neutral">FY {fy}</Badge>
            <span>
              Changing a prefix renames the next document only. Every invoice already issued keeps the number it was printed with — the sequence
              lives in a counter, not in the text.
            </span>
          </Card>
        </div>
      </div>

      <SaveBar
        count={changedCount}
        saving={saving}
        onSave={save}
        onDiscard={() => {
          reset();
          setSaveError('');
          draft.clear();
        }}
        error={saveError}
        savedAt={savedAt}
      />
    </>
  );
}
