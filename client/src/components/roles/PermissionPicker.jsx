import { useMemo } from 'react';
import { Check, Minus } from 'lucide-react';
import { cx } from '../common/ui';

/**
 * The permission chooser.
 *
 * The product we were shown lists every permission in one flat alphabetical column, so "Delete Branches" sits next
 * to "Edit Branches" and a person scanning for billing has to read forty boxes to be sure they have not missed one.
 * This groups them the way the system is actually divided — Inventory, Billing, Transfers, and so on — with a
 * select-all per group and a count, so the question "can this role do anything with money?" is answered by looking
 * at one line rather than reading the list.
 *
 * THE GROUPS COME FROM THE SERVER. Nothing here knows what a permission is called or what it means; it renders
 * whatever `GET /roles` sent in `catalogue`. Adding a permission on the server makes it appear here with no change
 * to this file, and — more importantly — a permission that the server does NOT recognise cannot be invented here
 * and then silently dropped on save.
 */

function Tri({ state, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cx(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
        disabled && 'cursor-not-allowed opacity-50',
        state === 'none' ? 'border-line bg-card' : 'border-primary bg-primary text-white',
      )}
    >
      {state === 'all' && <Check className="h-3 w-3" aria-hidden="true" strokeWidth={3} />}
      {state === 'some' && <Minus className="h-3 w-3" aria-hidden="true" strokeWidth={3} />}
    </button>
  );
}

export default function PermissionPicker({ catalogue = [], value = [], onChange, disabled }) {
  const held = useMemo(() => new Set(value), [value]);

  const toggle = (key) => {
    const next = new Set(held);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };

  const toggleGroup = (group) => {
    const keys = group.permissions.map((p) => p.key);
    const allOn = keys.every((k) => held.has(k));
    const next = new Set(held);
    for (const k of keys) {
      if (allOn) next.delete(k);
      else next.add(k);
    }
    onChange([...next]);
  };

  const total = catalogue.reduce((n, g) => n + g.permissions.length, 0);
  const allOn = total > 0 && catalogue.every((g) => g.permissions.every((p) => held.has(p.key)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-line bg-subtle/40 px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
          <Tri
            state={allOn ? 'all' : held.size ? 'some' : 'none'}
            disabled={disabled}
            label="Select every permission"
            onChange={() => onChange(allOn ? [] : catalogue.flatMap((g) => g.permissions.map((p) => p.key)))}
          />
          Select all permissions
        </label>
        <span className="text-xs text-muted" aria-live="polite">
          {held.size} of {total} selected
        </span>
      </div>

      {catalogue.map((group) => {
        const keys = group.permissions.map((p) => p.key);
        const on = keys.filter((k) => held.has(k)).length;
        return (
          <fieldset key={group.key} className="rounded-xl border border-line">
            <legend className="sr-only">{group.label}</legend>
            <div className="flex items-center justify-between border-b border-line bg-subtle/30 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
                <Tri
                  state={on === keys.length ? 'all' : on ? 'some' : 'none'}
                  disabled={disabled}
                  label={`Select every ${group.label} permission`}
                  onChange={() => toggleGroup(group)}
                />
                {group.label}
              </label>
              <span className={cx('text-xs', on ? 'text-primary' : 'text-muted')}>
                {on}/{keys.length}
              </span>
            </div>

            <div className="grid gap-px bg-line sm:grid-cols-2">
              {group.permissions.map((p) => (
                <label
                  key={p.key}
                  className={cx('flex cursor-pointer items-start gap-2.5 bg-card p-3 transition hover:bg-subtle/50', disabled && 'cursor-not-allowed')}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
                    checked={held.has(p.key)}
                    disabled={disabled}
                    onChange={() => toggle(p.key)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-tight">{p.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted">{p.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
