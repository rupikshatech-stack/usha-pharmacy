import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { authService } from '../../services/authService';
import { passwordRules, passwordValid } from '../../utils/password';
import { Button, FormField, cx, inputCls } from '../../components/common/ui';
import AuthShell from './AuthShell';

function PasswordInput({ label, value, onChange, autoComplete, error, autoFocus, onBlur }) {
  const [show, setShow] = useState(false);
  return (
    <FormField label={label} required error={error}>
      {(a) => (
        <div className="relative">
          <input
            {...a}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            className={cx(inputCls, 'pr-10', error && 'border-danger')}
          />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-muted hover:text-ink">
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      )}
    </FormField>
  );
}

export default function ChangePassword() {
  const { user, passwordChanged, logout } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');

  const errors = {};
  if (!f.current) errors.current = 'Enter your current password';
  if (!passwordValid(f.next)) errors.next = 'Your new password does not meet all the requirements below';
  else if (f.next === f.current) errors.next = 'Choose a password different from your current one';
  if (f.confirm !== f.next) errors.confirm = 'Passwords do not match';
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
      await authService.changePassword(f.current, f.next);
      passwordChanged();
      toast.success('Password updated');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setServerError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title={user.mustChangePassword ? 'Set a new password' : 'Change password'}
      description={user.mustChangePassword ? 'For your security, choose a new password before continuing.' : 'Choose a strong password you don\'t use elsewhere.'}
      footer={
        <button type="button" onClick={logout} className="font-semibold text-primary hover:underline">
          Sign out
        </button>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        {serverError && (
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            {serverError}
          </div>
        )}
        <PasswordInput label="Current password" value={f.current} onChange={set('current')} onBlur={blur('current')} error={show('current')} autoComplete="current-password" autoFocus />
        <PasswordInput label="New password" value={f.next} onChange={set('next')} onBlur={blur('next')} error={show('next')} autoComplete="new-password" />
        <ul className="grid grid-cols-1 gap-1 rounded-lg bg-subtle p-3 text-xs sm:grid-cols-2" aria-label="Password requirements">
          {passwordRules.map((r) => {
            const ok = r.test(f.next);
            return (
              <li key={r.id} className={cx('flex items-center gap-1.5', ok ? 'text-success' : 'text-muted')}>
                {ok ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5" aria-hidden="true" />}
                {r.label}
                <span className="sr-only">{ok ? ' (met)' : ' (not met)'}</span>
              </li>
            );
          })}
        </ul>
        <PasswordInput label="Confirm new password" value={f.confirm} onChange={set('confirm')} onBlur={blur('confirm')} error={show('confirm')} autoComplete="new-password" />
        <p className="text-xs text-muted">You'll stay signed in here, and be signed out on your other devices.</p>
        <Button type="submit" loading={busy} className="w-full">
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
