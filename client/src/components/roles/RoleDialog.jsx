import { useMemo, useState } from 'react';
import { Info, Lock } from 'lucide-react';
import { Input, Modal, Select } from '../common/ui';
import SaveBar from '../settings/SaveBar';
import PermissionPicker from './PermissionPicker';
import { useDirtyForm } from '../../hooks/useDirtyForm';

const BLANK = { name: '', description: '', scope: 'organization', permissions: [] };

/**
 * Add or edit a role.
 *
 * It is the SAME form either way, and it uses the same `useDirtyForm` as the settings tabs, for the same reason:
 * the save sends only what changed. That matters most on the edit path, where two administrators may have the
 * screen open at once — renaming a role cannot silently rewrite a permission list somebody else just changed,
 * because the permission list is not in the request unless this person touched it.
 *
 * What it will not let you do, it does not offer: a built-in role's name field is read-only, with the reason next
 * to it, rather than a field that accepts typing and then fails on save.
 */
export default function RoleDialog({ role, catalogue, scopeNote, saving, error, onSave, onClose }) {
  const editing = Boolean(role);
  const initial = useMemo(
    () => (role ? { name: role.name, description: role.description || '', scope: role.scope, permissions: role.permissions || [] } : BLANK),
    [role],
  );
  const form = useDirtyForm(initial);
  const [touched, setTouched] = useState(false);

  const nameProblem = touched && form.values.name.trim().length < 2 ? 'Give the role a name of at least 2 characters' : null;
  const locked = Boolean(role?.isSystem);

  const submit = () => {
    setTouched(true);
    if (form.values.name.trim().length < 2) return;
    // On create everything is sent; on edit, only what changed.
    onSave(editing ? form.patch() : { ...form.values, name: form.values.name.trim(), description: form.values.description.trim() });
  };

  return (
    <Modal
      title={editing ? `Edit ${role.name}` : 'Add new role'}
      description={editing ? 'Change what this role may do.' : 'Create a new role for your organization.'}
      onClose={onClose}
      wide
      footer={
        <SaveBar
          inline
          count={editing ? form.changedCount : form.values.permissions.length || (form.values.name ? 1 : 0)}
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
            label="Role name"
            required
            data-field="name"
            value={form.values.name}
            disabled={locked}
            readOnly={locked}
            onChange={(e) => form.set('name', e.target.value)}
            onBlur={() => setTouched(true)}
            error={nameProblem}
            hint={locked ? 'Built-in roles cannot be renamed — users refer to them by name.' : 'e.g. Night Pharmacist'}
            placeholder="e.g. Finance"
            // Browsers offer to fill a field called "name" with the person's own name, which in the product we were
            // shown drops an autofill menu straight over the field below it.
            autoComplete="off"
            name="role-name"
          />

          <Select label="Scope" value={form.values.scope} onChange={(e) => form.set('scope', e.target.value)}>
            <option value="organization">Organization</option>
            <option value="branch">Branch</option>
          </Select>
        </div>

        <Input
          label="Role description"
          value={form.values.description}
          onChange={(e) => form.set('description', e.target.value)}
          placeholder="e.g. Covers the counter overnight"
          autoComplete="off"
          name="role-description"
          maxLength={240}
        />

        {/* Said plainly, because a control that looks like it restricts access and does not is worse than none. */}
        <p className="flex items-start gap-2 rounded-xl border border-line bg-subtle/40 px-3 py-2 text-xs text-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {scopeNote || 'Branch scope is informational for now and does not yet restrict data access.'}
        </p>

        {locked && (
          <p className="flex items-start gap-2 rounded-xl border border-line bg-subtle/40 px-3 py-2 text-xs text-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            This is a built-in role. You can change what it may do, but it cannot be renamed or deleted.
          </p>
        )}

        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Permissions</h3>
            <span className="text-xs text-muted">Select what this role may do</span>
          </div>
          <PermissionPicker catalogue={catalogue} value={form.values.permissions} onChange={(next) => form.set('permissions', next)} />
        </div>
      </div>
    </Modal>
  );
}
