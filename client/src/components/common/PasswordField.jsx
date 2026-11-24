import { useState } from 'react';
import { Check, Circle, Eye, EyeOff } from 'lucide-react';
import { passwordRules } from '../../utils/password';
import { FormField, cx, inputCls } from './ui';

/**
 * A password box with a reveal toggle, and the live policy checklist that belongs beside it.
 *
 * Both were written for the pharmacy's own change-password screen and are shared from here, because the platform
 * operator types a password under exactly the same rules. Two copies would have drifted the first time the policy
 * moved, and the one that drifted would be the screen nobody looks at — the one used once, by an operator, on a
 * brand-new account.
 */
export function PasswordInput({ label, value, onChange, autoComplete, error, hint, autoFocus, onBlur, id, name }) {
  const [show, setShow] = useState(false);
  return (
    <FormField id={id} label={label} required error={error} hint={hint}>
      {(a) => (
        <div className="relative">
          <input
            {...a}
            name={name}
            type={show ? 'text' : 'password'}
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            className={cx(inputCls, 'pr-10', error && 'border-danger')}
          />
          {/* Labelled by what it will do next, not by what it is, so it is useful read out on its own. */}
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            className="absolute right-0 top-0 grid h-10 w-10 place-items-center rounded-r-lg text-muted transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      )}
    </FormField>
  );
}

/** Which rules the password typed so far already meets. The server checks the same list again. */
export function PasswordRules({ value, className }) {
  return (
    <ul className={cx('grid grid-cols-1 gap-1 rounded-lg bg-subtle p-3 text-xs sm:grid-cols-2', className)} aria-label="Password requirements">
      {passwordRules.map((r) => {
        const ok = r.test(value);
        return (
          <li key={r.id} className={cx('flex items-center gap-1.5', ok ? 'text-success' : 'text-muted')}>
            {ok ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Circle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            {r.label}
            <span className="sr-only">{ok ? ' (met)' : ' (not met)'}</span>
          </li>
        );
      })}
    </ul>
  );
}
