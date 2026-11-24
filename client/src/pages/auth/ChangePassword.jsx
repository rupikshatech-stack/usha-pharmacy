import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { authService } from '../../services/authService';
import { passwordValid } from '../../utils/password';
import { Button } from '../../components/common/ui';
import { PasswordInput, PasswordRules } from '../../components/common/PasswordField';
import AuthShell from './AuthShell';

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
        <PasswordRules value={f.next} />
        <PasswordInput label="Confirm new password" value={f.confirm} onChange={set('confirm')} onBlur={blur('confirm')} error={show('confirm')} autoComplete="new-password" />
        <p className="text-xs text-muted">You'll stay signed in here, and be signed out on your other devices.</p>
        <Button type="submit" loading={busy} className="w-full">
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
