import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CalendarClock, ChevronDown, Globe2, History, IndianRupee, Info, Lock, Package, ReceiptText, RotateCcw, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsService } from '../../services/settingsService';
import { useAuth } from '../../context/AuthContext';
import { getPath, scrollToFirstError, useDirtyForm } from '../../hooks/useDirtyForm';
import { draftKey, useSettingsDraft } from '../../hooks/useSettingsDraft';
import { formatDateAs } from '../../utils/format';
import { Button, Card, ConfirmDialog, Input, Select, cx } from '../../components/common/ui';
import SaveBar from '../../components/settings/SaveBar';
import { Section, Toggle } from '../../components/settings/SettingsParts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const NOTIFICATIONS = [
  { key: 'lowStock', label: 'Low stock', hint: 'A medicine at or below its reorder level' },
  { key: 'nearExpiry', label: 'Near expiry', hint: 'A batch expiring within your longest expiry threshold' },
  { key: 'licenseExpiry', label: 'Licence expiry', hint: 'A drug licence lapsing within the warning window' },
  { key: 'dailySummary', label: 'Daily sales summary', hint: 'Yesterday’s invoices and sales, in your own day' },
];

/** The IANA zones the browser knows, with the organization's own always present so the select can show it. */
const timezoneOptions = (current) => {
  let all = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];
  }
  return [...new Set([current, 'Asia/Kolkata', ...all])].filter(Boolean);
};

const toForm = (g) => ({
  timezone: g.timezone,
  dateFormat: g.dateFormat,
  fiscalYearStartMonth: g.fiscalYearStartMonth,
  posRoundOff: Boolean(g.posRoundOff),
  expiry: {
    thresholds: [...g.expiry.thresholds],
    velocityWindowDays: g.expiry.velocityWindowDays,
    supplierReturnWindowDays: g.expiry.supplierReturnWindowDays,
    clearanceMaxDiscount: g.expiry.clearanceMaxDiscount,
  },
  inventory: { defaultLowStockThreshold: g.inventory.defaultLowStockThreshold },
  billing: { requireCustomerPhoneOnCredit: Boolean(g.billing.requireCustomerPhoneOnCredit), defaultCreditDays: g.billing.defaultCreditDays },
  licenseExpiryWarningDays: g.licenseExpiryWarningDays,
  notifications: Object.fromEntries(NOTIFICATIONS.map(({ key }) => [key, { enabled: Boolean(g.notifications?.[key]?.enabled), channel: g.notifications?.[key]?.channel || 'in_app' }])),
});

/** A whole number within bounds, or the sentence that says why not. */
const whole = (label, min, max) => (v) => {
  if (v === '' || v === null || v === undefined) return `Enter ${label}`;
  const n = Number(v);
  if (!Number.isInteger(n)) return `${label} must be a whole number`;
  if (n < min) return `${label} cannot be below ${min}`;
  if (n > max) return `${label} cannot be above ${max}`;
  return '';
};

const RULES = {
  'inventory.defaultLowStockThreshold': whole('the default reorder level', 0, 100000),
  'billing.defaultCreditDays': whole('the credit period', 0, 365),
  licenseExpiryWarningDays: whole('the licence warning period', 1, 365),
  'expiry.velocityWindowDays': whole('the days of sales to read', 7, 365),
  'expiry.supplierReturnWindowDays': whole('the supplier-return window', 0, 365),
  'expiry.clearanceMaxDiscount': (v) => {
    const n = Number(v);
    if (v === '' || Number.isNaN(n)) return 'Enter a discount';
    return n < 0 || n > 90 ? 'A clearance discount is 0 to 90 percent — beyond that it is a giveaway' : '';
  },
};

/**
 * Tab 3: Common Settings — the rules this system bills and stocks by, and how it speaks.
 *
 * TWO KINDS OF THING LIVE HERE, and the screen keeps them apart. The first are real choices: they are saved, the
 * server reads them, and billing or stock behaves differently afterwards. The second are rules this system ENFORCES
 * and no setting can switch off — oldest stock sold first, expired batches never sold, stock never negative. Those are
 * shown as locked, with the reason, because a safety rule nobody can see is one people assume is not there.
 *
 * TIMEZONE AND DATE FORMAT ARE DISPLAY ONLY. Every date is stored as a UTC instant and stays one; these change the
 * characters on the screen, and nothing in the database.
 */
export default function GeneralTab({ data, canManage, onSaved, onDirtyChange, discardSignal }) {
  const { user } = useAuth();
  const initial = useMemo(() => toForm(data.general), [data.general]);
  const form = useDirtyForm(initial);
  const { values, set, errors, setErrors, dirty, changedCount, reset } = form;

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [resetting, setResetting] = useState(false);
  const firstDiscard = useRef(discardSignal);

  const key = draftKey({ orgId: user?.organization?.id || user?.organizationId, userId: user?.id || user?._id, tab: 'general' });
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

  const lock = data.general.fiscalYear;
  const tzLock = data.general.timezoneLock;
  const zones = useMemo(() => timezoneOptions(data.general.timezone), [data.general.timezone]);
  const sample = useMemo(() => new Date('2026-11-06T09:30:00Z'), []);
  const num = (path) => (e) => set(path, e.target.value === '' ? '' : Number(e.target.value));
  const blur = (path) => () => setErrors((prev) => ({ ...prev, [path]: RULES[path]?.(getPath(values, path)) || undefined }));
  const field = (path, label, extra = {}) => ({
    label,
    value: getPath(values, path) ?? '',
    onChange: num(path),
    onBlur: blur(path),
    error: errors[path],
    disabled: !canManage,
    'data-field': path,
    type: 'number',
    ...extra,
  });

  const save = async () => {
    const found = {};
    for (const [path, rule] of Object.entries(RULES)) {
      const message = rule(getPath(values, path));
      if (message) found[path] = message;
    }
    const t = values.expiry.thresholds.map(Number);
    if (t.some((x) => !Number.isInteger(x) || x < 1 || x > 730)) found['expiry.thresholds'] = 'Each threshold is a whole number of days, 1 to 730';
    else if (!(t[0] < t[1] && t[1] < t[2])) found['expiry.thresholds'] = 'Each threshold must be larger than the one before it';
    if (Object.keys(found).length) {
      setErrors(found);
      setSaveError('Some fields need attention.');
      scrollToFirstError(found);
      return;
    }

    setSaving(true);
    setSaveError('');
    try {
      const patch = form.patch();
      // The thresholds travel as numbers, whatever the inputs held.
      if (patch.expiry?.thresholds) patch.expiry.thresholds = patch.expiry.thresholds.map(Number);
      const saved = await settingsService.saveGeneral({ version: data.version, ...patch });
      form.commit(toForm(saved.settings.general));
      setSavedAt(Date.now());
      draft.clear();
      onSaved(saved.settings);
      toast.success(saved.unchanged ? 'Nothing had changed.' : `Saved ${saved.changes.length} ${saved.changes.length === 1 ? 'change' : 'changes'}.`);
    } catch (e) {
      if (e.code === 'SETTINGS_CONFLICT') setConflict(e.message);
      else if (e.code === 'FISCAL_YEAR_LOCKED' || e.code === 'TIMEZONE_LOCKED') {
        const field = e.code === 'TIMEZONE_LOCKED' ? 'timezone' : 'fiscalYearStartMonth';
        const mapped = { [field]: e.message };
        setErrors(mapped);
        setSaveError(e.code === 'TIMEZONE_LOCKED' ? 'The timezone is locked.' : 'The financial year is locked.');
        scrollToFirstError(mapped);
      } else if (Array.isArray(e.details) && e.details.length) {
        const mapped = Object.fromEntries(e.details.map((d) => [d.path, d.message]));
        setErrors(mapped);
        scrollToFirstError(mapped);
        setSaveError(e.message);
      } else setSaveError(e.message);
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const doReset = async () => {
    setSaving(true);
    try {
      const saved = await settingsService.resetInvoice(data.version);
      onSaved(saved.settings);
      toast.success('Invoice layout is back to the defaults. Numbering, terms and counters were not touched.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
      setResetting(false);
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------------------------------------------------------------- left */}
        <div className="space-y-4">
          <Section icon={Globe2} title="Regional" hint="How dates are written and when the financial year starts.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Timezone"
                value={values.timezone}
                onChange={(e) => set('timezone', e.target.value)}
                disabled={!canManage || tzLock.locked}
                error={errors.timezone}
                data-field="timezone"
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
              <Select label="Date format" value={values.dateFormat} onChange={(e) => set('dateFormat', e.target.value)} disabled={!canManage} data-field="dateFormat">
                {data.options.dateFormats.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} — {formatDateAs(sample, o.value, values.timezone)}
                  </option>
                ))}
              </Select>
              <div>
                <Select
                  label="Financial year starts in"
                  value={String(values.fiscalYearStartMonth)}
                  onChange={(e) => set('fiscalYearStartMonth', Number(e.target.value))}
                  disabled={!canManage || lock.locked}
                  error={errors.fiscalYearStartMonth}
                  data-field="fiscalYearStartMonth"
                  hint={lock.locked ? undefined : `Currently ${lock.label}`}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <span className="mb-1.5 block text-[13px] font-semibold">Currency</span>
                <p className="flex h-10 items-center gap-2 rounded-lg border border-line bg-subtle/50 px-3 text-sm text-muted">
                  <IndianRupee className="h-4 w-4" aria-hidden="true" /> ₹ 1,23,456.78
                </p>
              </div>
            </div>

            {lock.locked && (
              <p className="mt-3 flex items-start gap-2 rounded-xl border border-line bg-subtle/50 p-3 text-xs text-muted">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <strong className="text-ink">Financial year start — locked for {lock.label}.</strong> {lock.reason}
                </span>
              </p>
            )}
            {tzLock.locked && (
              <p className="mt-3 flex items-start gap-2 rounded-xl border border-line bg-subtle/50 p-3 text-xs text-muted">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <strong className="text-ink">Timezone — locked for {tzLock.label}.</strong> {tzLock.reason}
                </span>
              </p>
            )}
            <p className="mt-3 flex items-start gap-2 text-[11px] text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              The timezone and date format change how dates are SHOWN. Every date is stored as an exact moment in UTC and is never rewritten, so
              changing either one cannot alter an invoice, a batch or a report’s figures — only how their dates read.
            </p>
          </Section>

          <Section icon={Package} title="Inventory" hint="Defaults for new stock, and when an expiry becomes worth acting on.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input {...field('inventory.defaultLowStockThreshold', 'Default reorder level')} min={0} hint="A new medicine starts here. Each medicine keeps its own after that." />
            </div>

            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[13px] font-bold">Expiry thresholds</p>
              <p className="mb-3 text-xs text-muted">
                Shared with Expiry Intelligence and the notification bell — there is one set of these, not a copy. The largest is how far ahead the
                bell looks.
              </p>
              <div className="grid grid-cols-3 gap-3" data-field="expiry.thresholds">
                {[0, 1, 2].map((i) => (
                  <Input
                    key={i}
                    label={`Bucket ${i + 1} (days)`}
                    type="number"
                    min={1}
                    max={730}
                    value={values.expiry.thresholds[i]}
                    onChange={(e) => set('expiry.thresholds', values.expiry.thresholds.map((v, j) => (j === i ? (e.target.value === '' ? '' : Number(e.target.value)) : v)))}
                    disabled={!canManage}
                  />
                ))}
              </div>
              {errors['expiry.thresholds'] && <p className="mt-1.5 text-xs text-danger">{errors['expiry.thresholds']}</p>}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input {...field('expiry.velocityWindowDays', 'Days of sales to read')} min={7} max={365} hint="How far back sales are read to see how fast a medicine sells" />
                <Input {...field('expiry.supplierReturnWindowDays', 'Supplier-return window (days)')} min={0} max={365} hint="How close to expiry a lot can be and still go back" />
                <Input {...field('expiry.clearanceMaxDiscount', 'Largest clearance discount (%)')} min={0} max={90} hint="The most the report will ever suggest" />
              </div>
            </div>

            <div className="mt-4 space-y-2 border-t border-line pt-4">
              <p className="text-[13px] font-bold">Always enforced</p>
              {data.enforced.map((rule) => (
                <div key={rule.key} className="flex items-start gap-2 rounded-xl border border-line bg-subtle/50 p-3">
                  <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  <div>
                    <p className="text-[13px] font-semibold">{rule.label}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{rule.detail}</p>
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-muted">These are not switches. The server enforces them in the same atomic step that takes the stock, so no screen — and no setting — can bypass them.</p>
            </div>
          </Section>
        </div>

        {/* ---------------------------------------------------------------- right */}
        <div className="space-y-4">
          <Section icon={ReceiptText} title="Billing & compliance">
            <div className="space-y-1">
              <Toggle
                label="Round bills off"
                hint="Off keeps every total exact. When on, to the nearest ₹1 or ₹0.50 — choose which under Invoice Customization."
                checked={values.posRoundOff}
                onChange={(v) => set('posRoundOff', v)}
                disabled={!canManage}
              />
              <Toggle
                label="Require the customer’s phone number on credit sales"
                hint="Enforced by the server, so it holds however the sale is rung up. Off, as it has always been, unless you turn it on."
                checked={values.billing.requireCustomerPhoneOnCredit}
                onChange={(v) => set('billing.requireCustomerPhoneOnCredit', v)}
                disabled={!canManage}
              />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input
                {...field('billing.defaultCreditDays', 'Default credit period (days)')}
                min={0}
                max={365}
                hint="0 means no due date. Above 0, a credit sale with a balance is stamped with a due date this many days on."
              />
            </div>
            {/* TODO (prescription capture module): require prescription details for Schedule H / H1 / X, and the doctor's
                name and registration number for Schedule X. Deliberately NOT here yet - an invoice has nowhere to store a
                prescription, so a toggle for it would do nothing. It arrives with that module. */}
          </Section>

          <Section icon={Bell} title="Notifications" hint="What the bell tells you. Switching one off quietens the bell, never the figures.">
            <div className="space-y-2">
              {NOTIFICATIONS.map(({ key: k, label, hint }) => (
                <div key={k} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
                  <Toggle
                    label={label}
                    hint={hint}
                    checked={values.notifications[k].enabled}
                    onChange={(v) => set(`notifications.${k}.enabled`, v)}
                    disabled={!canManage}
                  />
                  <span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-semibold text-muted">In-app bell</span>
                </div>
              ))}
            </div>
            {/* TODO (email / WhatsApp): add a channel select here once those channels exist. The `channel` field is already
                stored per notification, and the server already accepts only `in_app`; sending by another channel would be
                a scheduled job reading these same flags, so nothing on this screen has to change shape for it. */}
            <p className="mt-3 flex items-start gap-2 text-[11px] text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Notifications are shown in the app only for now. Email and WhatsApp will appear here when they exist.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input {...field('licenseExpiryWarningDays', 'Warn about a licence this many days before it lapses')} min={1} max={365} />
            </div>
          </Section>

          {canManage && (
            <details className="group rounded-2xl border border-danger/30 bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-[13px] font-bold">
                <span className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-danger" aria-hidden="true" /> Danger zone
                </span>
                <ChevronDown className={cx('h-4 w-4 text-muted transition-transform group-open:rotate-180')} aria-hidden="true" />
              </summary>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
                <div className="max-w-md">
                  <p className="text-[13px] font-bold">Reset invoice layout</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Puts the paper size, template, colour and print toggles back to the defaults.{' '}
                    <strong className="text-ink">It never touches numbering, terms, counters or an invoice that exists.</strong>
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setResetting(true)} disabled={saving}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset layout
                </Button>
              </div>
            </details>
          )}
        </div>
      </div>

      {resetting && (
        <ConfirmDialog
          title="Reset the invoice layout?"
          message="The paper size, template, accent colour and print toggles go back to the defaults. Numbering formats, terms, the counters behind your invoice numbers, and every invoice already issued are not touched."
          confirmLabel="Reset layout"
          danger
          loading={saving}
          onConfirm={doReset}
          onClose={() => setResetting(false)}
        />
      )}

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
