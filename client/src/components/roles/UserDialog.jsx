import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { Input, Modal, Select } from '../common/ui';
import SaveBar from '../settings/SaveBar';
import { useDirtyForm } from '../../hooks/useDirtyForm';

/**
 * Add or edit a user.
 *
 * On EDIT the email address and the password are not here at all. An email identifies the account at sign-in, and
 * changing somebody's password behind their back is a different act from administering their role — both are
 * refused by the server, so neither is offered.
 *
 * On ADD the administrator types an initial password and the person is forced to choose their own the first time
 * they sign in. There is no invite email: sending mail is separate work, and a half-built invite flow that silently
 * fails to deliver is worse than asking an administrator to pass the password on.
 */
export default function UserDialog({ user, roles = [], branches = [], saving, error, onSave, onClose }) {
  const editing = Boolean(user);
  const initial = useMemo(
    () =>
      user
        ? { name: user.name, role: user.role, branchIds: user.branchIds || [], isActive: user.isActive }
        : { name: '', email: '', password: '', role: roles.find((r) => r.key === 'STAFF')?.key || roles[0]?.key || 'STAFF', branchIds: [], isActive: true },
    [user, roles],
  );
  const form = useDirtyForm(initial);
  const [touched, setTouched] = useState(false);

  const problems = {
    name: form.values.name.trim().length < 2 ? 'Give the person a name of at least 2 characters' : null,
    email: editing ? null : !/^\S+@\S+\.\S+$/.test(form.values.email || '') ? 'Enter a valid email address' : null,
    password: editing ? null : (form.values.password || '').length < 8 ? 'At least 8 characters, with a capital, a number and a symbol' : null,
  };
  const blocked = Object.values(problems).some(Boolean);

  const submit = () => {
    setTouched(true);
    if (blocked) return;
    onSave(editing ? form.patch() : { ...form.values, name: form.values.name.trim(), email: form.values.email.trim().toLowerCase() });
  };

  const toggleBranch = (id) => {
    const held = new Set((form.values.branchIds || []).map(String));
    if (held.has(id)) held.delete(id);
    else held.add(id);
    form.set('branchIds', [...held]);
  };

  return (
    <Modal
      title={editing ? `Edit ${user.name}` : 'Add new user'}
      onClose={onClose}
      wide
      footer={
        <SaveBar
          inline
          count={editing ? form.changedCount : form.values.name || form.values.email ? 1 : 0}
          saving={saving}
          error={error}
          onSave={submit}
          onDiscard={editing ? form.reset : onClose}
        />
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Full name"
            required
            data-field="name"
            value={form.values.name}
            onChange={(e) => form.set('name', e.target.value)}
            onBlur={() => setTouched(true)}
            error={touched ? problems.name : null}
            autoComplete="off"
            name="person-name"
          />

          {editing ? (
            <Input label="Email" value={user.email} readOnly disabled hint="An email address identifies the account at sign-in and cannot be changed here." />
          ) : (
            <Input
              label="Email"
              required
              type="email"
              data-field="email"
              value={form.values.email}
              onChange={(e) => form.set('email', e.target.value)}
              onBlur={() => setTouched(true)}
              error={touched ? problems.email : null}
              autoComplete="off"
              name="person-email"
            />
          )}
        </div>

        {!editing && (
          <Input
            label="Initial password"
            required
            type="password"
            data-field="password"
            value={form.values.password}
            onChange={(e) => form.set('password', e.target.value)}
            onBlur={() => setTouched(true)}
            error={touched ? problems.password : null}
            hint="They will have to choose their own password the first time they sign in."
            autoComplete="new-password"
            name="initial-password"
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Role" value={form.values.role} onChange={(e) => form.set('role', e.target.value)}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>

          {editing && (
            <Select label="Status" value={String(form.values.isActive)} onChange={(e) => form.set('isActive', e.target.value === 'true')} disabled={user.isSelf}>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </Select>
          )}
        </div>

        <fieldset className="rounded-xl border border-line">
          <legend className="sr-only">Stores</legend>
          <div className="border-b border-line bg-subtle/30 px-3 py-2 text-sm font-semibold">Stores</div>
          {branches.length === 0 ? (
            <p className="p-3 text-xs text-muted">This organization has no stores yet.</p>
          ) : (
            <div className="grid gap-px bg-line sm:grid-cols-2">
              {branches.map((b) => (
                <label key={b.id} className="flex cursor-pointer items-center gap-2.5 bg-card p-3 text-sm hover:bg-subtle/50">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--primary)]"
                    checked={(form.values.branchIds || []).map(String).includes(String(b.id))}
                    onChange={() => toggleBranch(String(b.id))}
                  />
                  {b.name}
                </label>
              ))}
            </div>
          )}
          <p className="flex items-start gap-2 border-t border-line px-3 py-2 text-xs text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Leave every store unticked for someone who works across all of them.
          </p>
        </fieldset>

        {user?.isSelf && <p className="rounded-xl border border-line bg-subtle/40 px-3 py-2 text-xs text-muted">This is your own account, so it cannot be deactivated here.</p>}
      </div>
    </Modal>
  );
}
