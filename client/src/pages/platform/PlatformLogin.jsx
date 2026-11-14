import { useState } from 'react';
import { LogIn } from 'lucide-react';
import { Button, Card, Input } from '../../components/common/ui';
import { platformService } from '../../services/platformService';
import { setCsrfToken } from '../../services/api';

/** Platform sign-in. The server answers a wrong password and a non-platform account identically, so this screen
 *  shows whatever it is told and never tries to be more helpful than that. */
export default function PlatformLogin({ onSignedIn }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
    <Card className="mx-auto max-w-md p-6">
      <h2 className="text-lg font-bold">Platform sign-in</h2>
      <p className="mt-1 text-sm text-muted">For the operator who onboards new pharmacies. This is not a pharmacy sign-in.</p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <Input label="Email" type="email" required autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Input label="Password" type="password" required autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">
          <LogIn className="h-4 w-4" aria-hidden="true" /> Sign in
        </Button>
      </form>
    </Card>
  );
}
