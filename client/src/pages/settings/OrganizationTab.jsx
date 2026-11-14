import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Building2, CreditCard, History, Info, Landmark, Lock, MapPin, ShieldCheck, TriangleAlert, UserRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { settingsService } from '../../services/settingsService';
import { useAuth } from '../../context/AuthContext';
import { getPath, useDirtyForm, scrollToFirstError } from '../../hooks/useDirtyForm';
import { draftKey, useSettingsDraft } from '../../hooks/useSettingsDraft';
import { isValidGstin, panFromGstin, stateCodeOfGstin } from '../../utils/gstin';
import { Button, Card, Input, Select, cx } from '../../components/common/ui';
import SaveBar from '../../components/settings/SaveBar';
import LogoUpload from '../../components/settings/LogoUpload';
import LicenseList from '../../components/settings/LicenseList';

/** A field's own rule. Each one answers "can this value possibly be right?", never "is this value true?". */
const RULES = {
  name: (v) => (!String(v || '').trim() ? 'The organization name is required' : ''),
  'owner.firstName': (v) => (!String(v || '').trim() ? 'The owner’s first name is required' : ''),
  'owner.lastName': (v) => (!String(v || '').trim() ? 'The owner’s last name is required' : ''),
  'owner.email': (v) => (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'Enter a valid email address' : !v ? 'The owner’s email is required' : ''),
  'owner.phone': (v) => {
    const digits = String(v || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!digits) return 'The owner’s phone number is required';
    return /^[6-9]\d{9}$/.test(digits) ? '' : 'An Indian mobile number is 10 digits starting 6, 7, 8 or 9';
  },
  'owner.altPhone': (v) => {
    if (!v) return '';
    const digits = String(v).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    return /^[6-9]\d{9}$/.test(digits) ? '' : 'An Indian mobile number is 10 digits starting 6, 7, 8 or 9';
  },
  gstin: (v) => {
    if (!v) return '';
    const s = String(v).toUpperCase().trim();
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return 'A GSTIN is 15 characters: 22AAAAA0000A1Z5';
    return isValidGstin(s) ? '' : 'That GSTIN’s check character does not match the rest of it — one character is mistyped';
  },
  'address.pincode': (v) => (!v ? '' : /^[1-9]\d{5}$/.test(v) ? '' : 'A PIN code is 6 digits and cannot start with 0'),
  'billingAddress.pincode': (v) => (!v ? '' : /^[1-9]\d{5}$/.test(v) ? '' : 'A PIN code is 6 digits and cannot start with 0'),
  'tax.fssai': (v) => (!v ? '' : /^\d{14}$/.test(v) ? '' : 'An FSSAI licence number is 14 digits'),
  'tax.cin': (v) => (!v ? '' : /^[LUu]\d{5}[A-Za-z]{2}\d{4}[A-Za-z]{3}\d{6}$/.test(v) ? '' : 'A CIN is 21 characters, for example U24239MH2010PTC123456'),
  'bank.ifsc': (v) => (!v ? '' : /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v).toUpperCase()) ? '' : 'An IFSC is 11 characters, for example HDFC0001234'),
  'bank.accountNumber': (v) => (!v ? '' : /^\d{5,20}$/.test(v) ? '' : 'An account number is 5 to 20 digits'),
  'bank.upiId': (v) => (!v ? '' : /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(v) ? '' : 'A UPI ID looks like name@bank'),
  establishedYear: (v) => {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1800) return 'Enter a year like 1998';
    return n > new Date().getFullYear() ? 'A business cannot be established in the future' : '';
  },
};

/** The fields a complete profile has. Missing ones are reported, never used to block an unrelated save. */
const REQUIRED = ['name', 'owner.firstName', 'owner.lastName', 'owner.email', 'owner.phone'];
const REQUIRED_LABEL = {
  name: 'organization name',
  'owner.firstName': 'owner’s first name',
  'owner.lastName': 'owner’s last name',
  'owner.email': 'owner’s email',
  'owner.phone': 'owner’s phone',
};

/** The form's shape, built from what the server returned. */
const toForm = (o) => ({
  name: o.name || '',
  legalName: o.legalName || '',
  businessCategory: o.businessCategory || 'retail',
  description: o.description || '',
  establishedYear: o.establishedYear ?? '',
  email: o.email || '',
  phone: o.phone || '',
  gstin: o.gstin || '',
  address: {
    line1: o.address?.line1 || '',
    line2: o.address?.line2 || '',
    landmark: o.address?.landmark || '',
    city: o.address?.city || '',
    state: o.address?.state || '',
    pincode: o.address?.pincode || '',
    country: o.address?.country || 'India',
  },
  billingSameAsRegistered: o.billingSameAsRegistered !== false,
  billingAddress: {
    line1: o.billingAddress?.line1 || '',
    line2: o.billingAddress?.line2 || '',
    landmark: o.billingAddress?.landmark || '',
    city: o.billingAddress?.city || '',
    state: o.billingAddress?.state || '',
    pincode: o.billingAddress?.pincode || '',
    country: o.billingAddress?.country || 'India',
  },
  tax: { registrationType: o.tax?.registrationType || 'regular', fssai: o.tax?.fssai || '', cin: o.tax?.cin || '' },
  owner: {
    firstName: o.owner?.firstName || '',
    lastName: o.owner?.lastName || '',
    email: o.owner?.email || '',
    phone: o.owner?.phone || '',
    altPhone: o.owner?.altPhone || '',
  },
  bank: {
    accountHolder: o.bank?.accountHolder || '',
    bankName: o.bank?.bankName || '',
    accountNumber: o.bank?.accountNumberMasked ? '' : o.bank?.accountNumber || '',
    ifsc: o.bank?.ifsc || '',
    branchName: o.bank?.branchName || '',
    upiId: o.bank?.upiId || '',
  },
  licenses: (o.licenses || []).map((l) => ({ ...l })),
});

/** A card with a heading, so the long form reads as sections rather than one wall of inputs. */
const Section = ({ icon: Icon, title, hint, children, className }) => (
  <Card className={cx('p-5', className)}>
    <div className="mb-4">
      <h2 className="flex items-center gap-2 text-[15px] font-bold">
        <Icon className="h-4 w-4 text-muted" aria-hidden="true" /> {title}
      </h2>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
    {children}
  </Card>
);

/**
 * Tab 1: the organization's own profile — who the business is, where it is, what it is licensed to sell, and where
 * customers pay. Everything here is printed on documents or asked for by an inspector, which is why it is business
 * data and not account settings.
 */
export default function OrganizationTab({ data, canManage, onSaved, onDirtyChange, discardSignal, reload }) {
  const { user, refreshUser } = useAuth();
  const initial = useMemo(() => toForm(data.organization), [data.organization]);
  const form = useDirtyForm(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [accountConfirm, setAccountConfirm] = useState('');
  const firstDiscard = useRef(discardSignal);

  /**
   * The safety net for the ways out that cannot be intercepted — the browser's Back button, signing out, and any
   * button that navigates by calling `navigate()` rather than rendering a link. The edits are kept in this tab's
   * session so they can be offered back, and the account number is never among them.
   */
  const NEVER_PERSIST = useMemo(() => ['bank.accountNumber'], []);
  const key = draftKey({ orgId: user?.organization?.id || user?.organizationId, userId: user?.id || user?._id, tab: 'organization' });

  const { values, set, errors, setErrors, dirty, changedCount } = form;

  // Declared before the draft that fills it in: the discard effect below reads it, and a ref used before its own
  // declaration is a temporal-dead-zone crash, not a warning.
  const clearDraftRef = useRef(() => {});
  const draft = useSettingsDraft({ key, values, server: initial, dirty, exclude: NEVER_PERSIST, enabled: canManage });
  const { clear: clearDraft } = draft;
  useEffect(() => {
    clearDraftRef.current = clearDraft;
  }, [clearDraft]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // The shell asks for a discard when the person leaves a tab with unsaved work. `reset` is stable, so this
  // watches the signal alone rather than re-running on every keystroke.
  const { reset } = form;
  useEffect(() => {
    if (discardSignal !== firstDiscard.current) {
      firstDiscard.current = discardSignal;
      reset();
      clearDraftRef.current(); // leaving a tab by discarding means the draft is not wanted either
    }
  }, [discardSignal, reset]);

  const field = (path, label, extra = {}) => ({
    label,
    value: String(path.split('.').reduce((o, k) => o?.[k], values) ?? ''),
    onChange: (e) => set(path, e.target.value),
    onBlur: () => setErrors((prev) => ({ ...prev, [path]: RULES[path]?.(path.split('.').reduce((o, k) => o?.[k], values), values) || undefined })),
    error: errors[path],
    disabled: !canManage,
    'data-field': path,
    ...extra,
  });

  /** The GSTIN tells us the PAN and the state it was issued in; neither is ever typed. */
  const gstinState = useMemo(() => {
    const code = stateCodeOfGstin(values.gstin);
    if (!code) return null;
    return data.options.states.find((s) => s.code === code) || null;
  }, [values.gstin, data.options.states]);
  const stateMismatch = gstinState && values.address.state && gstinState.name !== values.address.state;

  /**
   * What is still blank that ought not to be. These do NOT block a save: this is a PATCH form, and refusing to fix
   * a legal name because somebody never filled in the owner's phone number would be punishing the wrong person for
   * the wrong thing. They are listed instead, so the gap is visible and gets filled in on purpose.
   */
  const missing = useMemo(
    () =>
      REQUIRED.filter((path) => !String(getPath(values, path) ?? '').trim() && !form.changed.includes(path)).map(
        (path) => REQUIRED_LABEL[path],
      ),
    [values, form.changed],
  );

  const save = async () => {
    /**
     * Everything being SENT is checked once more here, because a field nobody focused was never blurred. A field
     * that is not being sent is only checked when it already holds a value — so a bad value can never be saved and
     * a required field can never be CLEARED, but a blank that was already there does not block an unrelated edit.
     */
    const found = {};
    for (const [path, rule] of Object.entries(RULES)) {
      const value = getPath(values, path);
      const beingSent = form.changed.includes(path);
      const hasValue = String(value ?? '').trim() !== '';
      if (!beingSent && !hasValue) continue;
      const message = rule(value, values);
      if (message) found[path] = message;
    }
    values.licenses.forEach((l, i) => {
      if (!String(l.number || '').trim()) found[`licenses.${i}.number`] = 'Enter the licence number';
      if (l.validFrom && l.validUntil && l.validUntil < l.validFrom) found[`licenses.${i}.validUntil`] = 'A licence cannot expire before it starts';
    });
    if (values.bank.accountNumber && accountConfirm && values.bank.accountNumber !== accountConfirm) {
      found['bank.accountNumberConfirm'] = 'The two account numbers do not match';
    }
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
      // The confirmation field is a safety check for the person, not a field the server keeps.
      const saved = await settingsService.saveOrganization({ version: data.version, ...patch });
      form.commit(toForm(saved.settings.organization));
      setSavedAt(Date.now());
      setAccountConfirm('');
      draft.clear(); // saved work is not unsaved work
      onSaved(saved.settings);
      toast.success(saved.unchanged ? 'Nothing had changed.' : `Saved ${saved.changes.length} ${saved.changes.length === 1 ? 'change' : 'changes'}.`);
    } catch (e) {
      if (e.code === 'SETTINGS_CONFLICT') {
        setConflict(e.message);
      } else if (Array.isArray(e.details) && e.details.length) {
        // Server-side field errors land on their own fields.
        const mapped = Object.fromEntries(e.details.map((d) => [d.path, d.message]));
        setErrors(mapped);
        scrollToFirstError(mapped);
        setSaveError(e.message);
      } else {
        setSaveError(e.message);
      }
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  /** Puts a kept draft back on the form, field by field, so nothing it did not mention is disturbed. */
  const restoreDraft = () => {
    for (const path of draft.changedFields) set(path, getPath(draft.draft.values, path));
    draft.accept();
    toast.success(`Restored ${draft.changedFields.length} unsaved ${draft.changedFields.length === 1 ? 'change' : 'changes'}.`);
  };

  return (
    <>
      {draft.draft && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-accent/40 bg-accent/5 p-4">
          <p className="flex items-start gap-2 text-sm">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span>
              You have <strong>{draft.changedFields.length} unsaved {draft.changedFields.length === 1 ? 'change' : 'changes'}</strong> from earlier
              {draft.savedAt ? ` (${new Date(draft.savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})` : ''}. They were kept in
              this browser tab, not saved.
            </span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={draft.discard}>
              Discard
            </Button>
            <Button onClick={restoreDraft}>Restore</Button>
          </div>
        </Card>
      )}

      {conflict && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-warning/40 bg-warning/10 p-4">
          <p className="flex items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{conflict}</span>
          </p>
          <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-card px-3 py-1.5 text-sm font-semibold hover:bg-subtle">
            Reload the page
          </button>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------------- left column */}
        <div className="space-y-4">
          <Section icon={Building2} title="General information" hint="How the business is named on screen and on documents.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input {...field('name', 'Organization name')} required placeholder="SWS Wholesale" />
              <Input {...field('legalName', 'Legal / trade name')} hint="If the registration name differs from the name over the door" />
              <Select {...field('businessCategory', 'Business category')}>
                {data.options.businessCategories.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Input {...field('establishedYear', 'Established year')} type="number" inputMode="numeric" placeholder="1998" />
              <Input {...field('email', 'Business email')} type="email" />
              <Input {...field('phone', 'Business phone')} />
              <div className="sm:col-span-2">
                <span className="mb-1.5 block text-[13px] font-semibold">Description</span>
                <textarea
                  value={values.description}
                  onChange={(e) => set('description', e.target.value)}
                  disabled={!canManage}
                  data-field="description"
                  rows={3}
                  maxLength={1000}
                  className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-primary disabled:opacity-60"
                  placeholder="What this business does, in a line or two."
                />
                <p className="mt-1 text-right text-[11px] text-muted">{values.description.length}/1000</p>
              </div>
            </div>
          </Section>

          <Section icon={MapPin} title="Registered address" hint="The address on your GST registration.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input {...field('address.line1', 'Street address')} className="sm:col-span-2" />
              <Input {...field('address.line2', 'Address line 2')} />
              <Input {...field('address.landmark', 'Area / landmark')} />
              <Input {...field('address.city', 'City')} />
              <Select {...field('address.state', 'State / union territory')}>
                <option value="">Choose a state</option>
                {data.options.states.map((s) => (
                  <option key={s.code} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Input {...field('address.pincode', 'PIN code')} inputMode="numeric" maxLength={6} />
              <Input {...field('address.country', 'Country')} />
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values.billingSameAsRegistered}
                onChange={(e) => set('billingSameAsRegistered', e.target.checked)}
                disabled={!canManage}
                className="h-4 w-4 rounded border-line accent-[var(--primary)]"
              />
              Billing address is the same as the registered address
            </label>

            {!values.billingSameAsRegistered && (
              <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                <Input {...field('billingAddress.line1', 'Billing street address')} className="sm:col-span-2" />
                <Input {...field('billingAddress.city', 'Billing city')} />
                <Select {...field('billingAddress.state', 'Billing state')}>
                  <option value="">Choose a state</option>
                  {data.options.states.map((s) => (
                    <option key={s.code} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Input {...field('billingAddress.pincode', 'Billing PIN code')} inputMode="numeric" maxLength={6} />
                <Input {...field('billingAddress.country', 'Billing country')} />
              </div>
            )}
          </Section>

          <Section icon={ShieldCheck} title="Tax & licences" hint="What this business is registered and licensed to do.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                {...field('gstin', 'GSTIN')}
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                maxLength={15}
                placeholder="27AAPFU0939F1ZV"
                hint="Checked against its own check digit as you type"
              />
              <Input
                label="PAN"
                value={panFromGstin(values.gstin)}
                readOnly
                disabled
                hint="Read from the GSTIN — characters 3 to 12 — so the two can never disagree"
              />
              <Select {...field('tax.registrationType', 'GST registration type')}>
                {data.options.gstRegistrationTypes.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div />
              <Input {...field('tax.fssai', 'FSSAI number')} inputMode="numeric" maxLength={14} hint="Optional — 14 digits" />
              <Input {...field('tax.cin', 'CIN / registration number')} hint="Optional — for a company" />
            </div>

            {values.gstin && !errors.gstin && (
              <p className={cx('mt-3 flex items-start gap-2 rounded-xl p-3 text-xs', stateMismatch ? 'bg-warning/10' : 'bg-success/10')}>
                {stateMismatch ? (
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                ) : (
                  <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                )}
                <span>
                  {stateMismatch ? (
                    <>
                      This GSTIN was issued in <strong>{gstinState.name}</strong>, but the address says <strong>{values.address.state}</strong>. That is
                      allowed — check it is the registration you mean to invoice under.
                    </>
                  ) : (
                    <>
                      The check character matches{gstinState ? <> and it was issued in <strong>{gstinState.name}</strong></> : ''}. This only proves the
                      number is well formed — not that it is registered to you.
                    </>
                  )}
                </span>
              </p>
            )}

            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-1 text-[13px] font-bold">Drug licences</h3>
              <p className="mb-3 text-xs text-muted">Each licence you hold, with its own number and expiry date.</p>
              <LicenseList
                licenses={values.licenses}
                options={data.options.licenseTypes}
                onChange={(next) => set('licenses', next)}
                errors={errors}
                disabled={!canManage}
              />
            </div>
          </Section>
        </div>

        {/* ---------------------------------------------------------------- right column */}
        <div className="space-y-4">
          <Section icon={Building2} title="Store logo">
            {/* The logo has its own endpoint and saves the moment it is chosen, so it is not part of the unsaved
                count. Re-reading the settings keeps this screen and the sidebar showing the same picture. */}
            <LogoUpload
              value={data.organization.logo}
              onChange={async () => {
                await reload();
                refreshUser?.();
              }}
              disabled={!canManage}
            />
          </Section>

          <Section icon={UserRound} title="Owner details" hint="Printed on documents. Not the sign-in account.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input {...field('owner.firstName', 'First name')} required />
              <Input {...field('owner.lastName', 'Last name')} required />
              <Input {...field('owner.email', 'Email')} type="email" required className="sm:col-span-2" />
              <Input {...field('owner.phone', 'Phone')} required inputMode="tel" placeholder="98765 43210" />
              <Input {...field('owner.altPhone', 'Alternate phone')} inputMode="tel" />
            </div>

            <div className="mt-4 rounded-xl border border-line bg-subtle/50 p-3">
              <div className="flex items-start gap-2">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">Login email</p>
                  <p className="truncate text-sm text-muted">{user?.email}</p>
                  {/* TODO (email/OTP): once the project can send mail, add "Change login email" here — verify the
                      current password, send a confirmation link to the new address, and only switch on confirmation. */}
                  <p className="mt-1 text-[11px] text-muted">
                    This is the address you sign in with, and it identifies your organization at sign-in — so it cannot be edited as an
                    ordinary field. Changing it needs email confirmation, which this system cannot send yet.
                  </p>
                </div>
              </div>
            </div>
          </Section>

          <Section icon={Landmark} title="Bank & payment" hint="Printed on invoices when you turn that on.">
            <div className="grid gap-3">
              <Input {...field('bank.accountHolder', 'Account holder name')} />
              <Input {...field('bank.bankName', 'Bank name')} />
              {data.organization.bank.accountNumberMasked ? (
                <Input label="Account number" value={data.organization.bank.accountNumber} readOnly disabled hint="Hidden — you need settings:manage to see or change it" />
              ) : (
                <>
                  <Input {...field('bank.accountNumber', 'Account number')} inputMode="numeric" autoComplete="off" />
                  {values.bank.accountNumber !== initial.bank.accountNumber && values.bank.accountNumber && (
                    <Input
                      label="Re-enter account number"
                      value={accountConfirm}
                      onChange={(e) => setAccountConfirm(e.target.value)}
                      error={errors['bank.accountNumberConfirm']}
                      data-field="bank.accountNumberConfirm"
                      inputMode="numeric"
                      autoComplete="off"
                      hint="Typed twice because a wrong digit here sends money to a stranger"
                    />
                  )}
                </>
              )}
              <Input {...field('bank.ifsc', 'IFSC')} onChange={(e) => set('bank.ifsc', e.target.value.toUpperCase())} maxLength={11} placeholder="HDFC0001234" />
              <Input {...field('bank.branchName', 'Branch')} />
              <Input {...field('bank.upiId', 'UPI ID')} placeholder="business@okhdfcbank" hint="A QR for this ID can be printed on invoices" />
            </div>
            <p className="mt-3 flex items-start gap-2 text-[11px] text-muted">
              <CreditCard className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              These details appear on printed invoices only if you switch that on under Invoice Customization.
            </p>
          </Section>

          <Card className="p-4 text-xs text-muted">
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Every save records who changed what, old value and new, in the activity log. Nothing here is checked against a
                government service — these rules only catch numbers that cannot be right.
              </span>
            </p>
          </Card>
        </div>
      </div>

      {missing.length > 0 && (
        <Card className="mt-4 flex items-start gap-2 border-line bg-subtle/50 p-3 text-xs text-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Still to fill in: <strong className="text-ink">{missing.join(', ')}</strong>. These are printed on documents, so they are
            worth completing — but they do not stop you saving other changes.
          </span>
        </Card>
      )}

      <SaveBar
        count={changedCount}
        saving={saving}
        onSave={save}
        onDiscard={() => {
          form.reset();
          setAccountConfirm('');
          setSaveError('');
          draft.clear();
        }}
        error={saveError}
        savedAt={savedAt}
      />
    </>
  );
}
