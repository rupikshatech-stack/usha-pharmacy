import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, LogIn, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, Card, Input } from '../../components/common/ui';
import { PasswordInput } from '../../components/common/PasswordField';
import { platformService } from '../../services/platformService';
import { setCsrfToken } from '../../services/api';

/**
 * Platform sign-in.
 *
 * The server answers a wrong password and a perfectly good pharmacy account identically — both are "those
 * details did not work" — so this screen shows what it is told and never tries to be more helpful than that.
 * Guessing on its behalf ("no such operator") would turn the form into a way to ask which addresses exist.
 *
 * What it can do is spare the person who arrived here by mistake: most people typing this address want their
 * pharmacy's workspace, so the way back is on the screen rather than something to work out.
 */
export default function PlatformLogin({ onSignedIn }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await platformService.login(form.email.trim(), form.password);
      setCsrfToken(data.csrfToken);
      onSignedIn(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <Card className="p-6 sm:p-7">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sage px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-sage-ink">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Operator only
        </span>
        <h2 className="mt-3 text-xl font-bold tracking-tight">Platform sign-in</h2>
        <p className="mt-1 text-sm text-muted">For the operator who onboards new pharmacies.</p>

        <form onSubmit={submit} noValidate className="mt-6 space-y-4">
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}
          <Input
            id="platform-email"
            label="Email"
            type="email"
            required
            autoComplete="username"
            autoFocus
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <PasswordInput
            id="platform-password"
            label="Password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Button type="submit" loading={busy} className="w-full">
            <LogIn className="h-4 w-4" aria-hidden="true" /> Sign in
          </Button>
        </form>
      </Card>

      <p className="mt-4 text-center text-sm text-muted">
        Work at a pharmacy?{' '}
        <Link to="/login" className="inline-flex items-center gap-1 font-semibold text-primary underline-offset-2 hover:underline">
          Sign in to your workspace <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </p>
    </div>
  );
}
