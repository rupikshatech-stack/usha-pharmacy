import { useRef, useState } from 'react';
import { Building2, Info, Plus, TriangleAlert, UserRound } from 'lucide-react';
import { Button, Card, Input, Select, cx } from '../../components/common/ui';
import { platformService } from '../../services/platformService';
import { BUSINESS_CATEGORIES, at, blankOrganization, put, serverErrors, toBody, validateOrganization } from '../../utils/platformForm';
import { exactEmail, exactName, useSimilarOrganizations } from './useSimilarOrganizations';
import CredentialsHandover from './CredentialsHandover';
import OrganizationDirectory from './OrganizationDirectory';

/** One spelling addresses a field, its error and its summary link: "owner.email" -> "onb-owner-email". */
const fid = (path) => `onb-${path.replace(/\./g, '-')}`;

/**
 * A remark under a field about what is already on the installation.
 *
 * It is not an error and does not use the error colours: nothing here is wrong yet, and the form will still
 * send. "Show it" points the directory at what was found rather than describing it, because the operator's next
 * question is always "which one?".
 */
function Note({ tone, onShow, children }) {
  const warn = tone === 'warning';
  return (
    <p className={cx('mt-1.5 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg px-2.5 py-1.5 text-xs', warn ? 'bg-warning-soft text-warning' : 'bg-subtle text-muted')}>
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        {warn ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0">{children}</span>
      </span>
      <button
        type="button"
        onClick={onShow}
        className="shrink-0 cursor-pointer font-bold underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Show it
      </button>
    </p>
  );
}

/**
 * Onboarding a pharmacy: the form, and the directory of what is already here.
 *
 * The two sit side by side on a wide screen because they are one task, not two. The question the directory
 * answers — "have we already set these people up?" — arrives in the middle of typing, and sending the operator
 * to another screen to answer it would cost them the form.
 *
 * Only three fields are required, which is the server's rule, not a shortcut: a pharmacy fills in its own GSTIN,
 * licences and address on its Settings screens afterwards. Asking for them here would hold up a telephone call
 * for numbers the person on the other end is unlikely to have to hand.
 */
export default function NewOrganization() {
  const [form, setForm] = useState(blankOrganization);
  const [touched, setTouched] = useState({});
  const [edited, setEdited] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [fromServer, setFromServer] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const summaryRef = useRef(null);

  // The directory's own controls live here, so the form can point it at a pharmacy it thinks is a duplicate.
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [highlightId, setHighlightId] = useState(null);

  const typedName = at(form, 'name');
  const typedEmail = at(form, 'owner.email');
  const nameLike = useSimilarOrganizations(typedName);
  const emailLike = useSimilarOrganizations(typedEmail, { enabled: /.+@.+\..+/.test(typedEmail.trim()) });
  const sameName = exactName(nameLike, typedName);
  const sameEmail = exactEmail(emailLike, typedEmail);
  const nearby = nameLike.filter((o) => o.id !== sameName?.id);

  const showInDirectory = (term) => {
    setSearch(term);
    setStatus('');
    setPage(1);
  };

  const onSearch = (v) => {
    setSearch(v);
    setPage(1);
  };
  const onStatus = (v) => {
    setStatus(v);
    setPage(1);
  };

  // What the server said about a field outranks what we worked out ourselves: only it knows the name is taken.
  const errors = { ...validateOrganization(form), ...fromServer };
  const listed = Object.entries(errors).filter(([, message]) => message);
  const showSummary = submitted && (listed.length > 0 || Boolean(formError));

  const set = (path) => (e) => {
    const { value } = e.target;
    setForm((f) => put(f, path, value));
    setEdited((d) => (d[path] ? d : { ...d, [path]: true }));
    // Editing the field answers the server's objection to it; keeping the message would just be stale.
    setFromServer((s) => {
      if (!s[path]) return s;
      const { [path]: _answered, ...rest } = s;
      return rest;
    });
  };
  const blur = (path) => () => setTouched((t) => ({ ...t, [path]: true }));

  /**
   * A field's props. Its error appears once the field has been typed in AND left, or once the form has been sent.
   *
   * Both halves matter. Leaving a field the operator never touched — tabbing past it, or clicking away from the
   * one that is focused on arrival — is not a mistake worth a red line; that is what sending the form is for.
   */
  const field = (path, label, extra = {}) => ({
    id: fid(path),
    label,
    value: at(form, path),
    onChange: set(path),
    onBlur: blur(path),
    error: submitted || (touched[path] && edited[path]) ? errors[path] : undefined,
    autoComplete: 'off',
    ...extra,
  });

  const focusSummary = () => requestAnimationFrame(() => summaryRef.current?.focus());

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setFormError('');
    if (Object.keys(validateOrganization(form)).length) {
      setFromServer({});
      focusSummary();
      return;
    }
    setBusy(true);
    try {
      const data = await platformService.createOrganization(toBody(form));
      setCreated(data);
      setForm(blankOrganization());
      setTouched({});
      setEdited({});
      setSubmitted(false);
      // Clear whatever the directory was narrowed to, so the pharmacy just made is actually among what it shows.
      setSearch('');
      setStatus('');
      setPage(1);
      setHighlightId(data.organization.id);
      setReloadToken((n) => n + 1);
    } catch (err) {
      setFromServer(serverErrors(err.details));
      setFormError(err.message);
      focusSummary();
    } finally {
      setBusy(false);
    }
  };

  const goToField = (path) => (e) => {
    e.preventDefault();
    document.getElementById(fid(path))?.focus();
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">
        {created ? (
          <CredentialsHandover created={created} onDone={() => setCreated(null)} />
        ) : (
          <Card className="p-5 sm:p-6">
            <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <Building2 className="h-5 w-5 text-muted" aria-hidden="true" /> Onboard a pharmacy
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Creates the pharmacy, its five built-in roles and its first administrator in one step, and gives you a temporary password to pass on.
            </p>

            <form onSubmit={submit} noValidate className="mt-6 space-y-6">
              {showSummary && (
                <div
                  ref={summaryRef}
                  tabIndex={-1}
                  role="alert"
                  aria-labelledby="onboard-problem"
                  className="rounded-xl border border-danger/40 bg-danger-soft p-3.5 outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                >
                  <h3 id="onboard-problem" className="flex items-center gap-2 text-sm font-bold text-danger">
                    <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {formError || 'Check the form before sending it'}
                  </h3>
                  {listed.length > 0 && (
                    <ul className="mt-2 space-y-1 pl-6 text-sm text-danger">
                      {listed.map(([path, message]) => (
                        <li key={path} className="list-disc">
                          <a href={`#${fid(path)}`} onClick={goToField(path)} className="underline underline-offset-2 hover:no-underline">
                            {message}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <fieldset className="space-y-3">
                <legend className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
                  <Building2 className="h-3.5 w-3.5" aria-hidden="true" /> The pharmacy
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Input {...field('name', 'Pharmacy name', { required: true, placeholder: 'e.g. Shree Medical Stores', maxLength: 150, autoFocus: true })} />
                    {sameName ? (
                      <Note tone="warning" onShow={() => showInDirectory(sameName.name)}>
                        <strong className="font-bold">{sameName.name}</strong> is already on this installation. This name will be refused.
                      </Note>
                    ) : (
                      nearby.length > 0 && (
                        <Note tone="info" onShow={() => showInDirectory(typedName.trim())}>
                          {nearby.length === 1 ? 'A similar name is already here: ' : `${nearby.length} similar names are already here: `}
                          {nearby.slice(0, 2).map((o) => o.name).join(', ')}
                          {nearby.length > 2 ? '…' : ''}
                        </Note>
                      )
                    )}
                  </div>
                  <Select id={fid('businessCategory')} label="Business category" value={form.businessCategory} onChange={set('businessCategory')}>
                    {BUSINESS_CATEGORIES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input {...field('address.line1', 'Address', { placeholder: 'Street address', maxLength: 200 })} />
                  <Input {...field('phone', 'Phone', { inputMode: 'tel', maxLength: 20 })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input {...field('address.city', 'City', { maxLength: 80 })} />
                  <Input {...field('address.state', 'State', { maxLength: 80 })} />
                  <Input {...field('address.pincode', 'PIN code', { inputMode: 'numeric', maxLength: 6 })} />
                </div>
                <p className="text-xs text-muted">Everything but the name can be left blank — the pharmacy fills the rest in on its own Settings screens.</p>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
                  <UserRound className="h-3.5 w-3.5" aria-hidden="true" /> The owner — becomes the first administrator
                </legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input {...field('owner.firstName', 'First name', { required: true, maxLength: 60 })} />
                  <Input {...field('owner.lastName', 'Last name', { maxLength: 60 })} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Input
                      {...field('owner.email', 'Email', {
                        required: true,
                        type: 'email',
                        maxLength: 150,
                        hint: 'They sign in with this. It must not already have an account here.',
                      })}
                    />
                    {sameEmail && (
                      <Note tone="warning" onShow={() => showInDirectory(sameEmail.name)}>
                        This address already administers <strong className="font-bold">{sameEmail.name}</strong>. One address can belong to one account only.
                      </Note>
                    )}
                  </div>
                  <Input {...field('owner.phone', 'Phone', { inputMode: 'tel', maxLength: 20 })} />
                </div>
              </fieldset>

              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
                <Button type="submit" loading={busy}>
                  <Plus className="h-4 w-4" aria-hidden="true" /> Create pharmacy
                </Button>
                <p className="text-xs text-muted">The password is generated now and shown to you once.</p>
              </div>
            </form>
          </Card>
        )}
      </div>

      {/* Stays in view while the form is filled in, so a duplicate can be spotted without losing what was typed. */}
      <OrganizationDirectory
        search={search}
        onSearch={onSearch}
        status={status}
        onStatus={onStatus}
        page={page}
        onPage={setPage}
        reloadToken={reloadToken}
        highlightId={highlightId}
        className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-8rem)]"
      />
    </div>
  );
}
