import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Card, Input } from '../../components/common/ui';
import { platformService } from '../../services/platformService';

/**
 * The only thing a newly created platform account can do. The script that creates it sets a forced password
 * change, and the server refuses every other platform route until it is done — so this screen is not a suggestion.
 */
export default function PlatformPasswordChange({ onDone }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await platformService.changePassword(form.currentPassword, form.newPassword);
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Card className="mx-auto max-w-md p-6">
      <h2 className="text-lg font-bold">Choose your own password</h2>
      <p className="mt-1 text-sm text-muted">This account was created with a temporary password. Nothing else opens until you change it.</p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <Input label="Temporary password" type="password" required autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
        <Input label="New password" type="password" required autoComplete="new-password" hint="At least 8 characters, with a capital, a number and a symbol." value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
        <Input label="Confirm new password" type="password" required autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        {error && <p role="alert" className="rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} className="w-full">
          <KeyRound className="h-4 w-4" aria-hidden="true" /> Change password
        </Button>
      </form>
    </Card>
  );
}
