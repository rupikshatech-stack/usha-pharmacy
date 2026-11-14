import { Card, cx } from '../common/ui';

/** A titled card, so a long settings page reads as sections rather than one wall of inputs. */
export const Section = ({ icon: Icon, title, hint, children, right, className }) => (
  <Card className={cx('p-5', className)}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          {Icon && <Icon className="h-4 w-4 text-muted" aria-hidden="true" />} {title}
        </h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {right}
    </div>
    {children}
  </Card>
);

/** A labelled checkbox with an optional line of explanation under it. */
export const Toggle = ({ label, checked, onChange, disabled, hint }) => (
  <label className={cx('flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors', !disabled && 'hover:bg-subtle')}>
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="mt-0.5 h-4 w-4 rounded border-line accent-[var(--primary)]"
    />
    <span className="min-w-0">
      {label}
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
    </span>
  </label>
);
