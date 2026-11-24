import { useState } from 'react';
import { KeyRound, TriangleAlert } from 'lucide-react';
import { Button, Card } from '../../components/common/ui';
import { PasswordInput, PasswordRules } from '../../components/common/PasswordField';
import { passwordValid } from '../../utils/password';
import { platformService } from '../../services/platformService';

/**
 * The only thing a newly created platform account can do.
 *
 * The script that creates the account sets a forced password change, and the server refuses every other platform
 * route until it is done — so this screen is not a suggestion, and it says so rather than letting the operator
 * hunt for the part of the console that still works.
 *
 * The rules are checked as the password is typed, against the same list the server holds. Finding out on submit
 * that a symbol was wanted, with a temporary password that was read down a telephone, is a poor way to learn it.
 */
export default function PlatformPasswordChange({ onDone }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);

  const errors = {};
  if (!f.current) errors.current = 'Enter the temporary password you were given';
  if (!passwordValid(f.next)) errors.next = 'Your new password does not meet all the requirements below';
  else if (f.next === f.current) errors.next = 'Choose a password different from the temporary one';
  if (f.confirm !== f.next) errors.confirm = 'The two new passwords do not match';

  const show = (k) => (submitted || touched[k] ? errors[k] : undefined);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const blur = (k) => () => setTouched((t) => ({ ...t, [k]: true }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setServerError('');
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      await platformService.changePassword(f.current, f.next);
      await onDone();
    } catch (err) {
      setServerError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Card className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight">Choose your own password</h2>
            <p className="mt-1 text-sm text-muted">This account was created with a temporary password. Nothing else in the console opens until you change it.</p>
          </div>
        </div>

        <form onSubmit={submit} noValidate className="mt-6 space-y-4">
          {serverError && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {serverError}
            </p>
          )}
          <PasswordInput label="Temporary password" value={f.current} onChange={set('current')} onBlur={blur('current')} error={show('current')} autoComplete="current-password" autoFocus />
          <PasswordInput label="New password" value={f.next} onChange={set('next')} onBlur={blur('next')} error={show('next')} autoComplete="new-password" />
          <PasswordRules value={f.next} />
          <PasswordInput label="Confirm new password" value={f.confirm} onChange={set('confirm')} onBlur={blur('confirm')} error={show('confirm')} autoComplete="new-password" />
          <Button type="submit" loading={busy} className="w-full">
            <KeyRound className="h-4 w-4" aria-hidden="true" /> Change password and continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
