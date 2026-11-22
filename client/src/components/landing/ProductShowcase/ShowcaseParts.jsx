import { cx } from '../../common/ui';

const PILL = {
  neutral: 'bg-subtle text-muted',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  orange: 'bg-orange-soft text-orange',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  purple: 'bg-purple-soft text-purple',
};

export function Pill({ tone = 'neutral', children, className }) {
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold', PILL[tone], className)}>
      {children}
    </span>
  );
}

/** A titled card. `data-reveal` lets the scroll timeline nudge each block as its scene arrives. */
export function Panel({ title, action, className, children }) {
  return (
    <section data-reveal className={cx('flex min-h-0 flex-col rounded-xl border border-line bg-card p-3', className)}>
      {(title || action) && (
        <header className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted">{title}</h4>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, delta, icon: Icon, tone = 'success' }) {
  return (
    <div data-reveal className="rounded-xl border border-line bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted">{label}</span>
        <span className={cx('grid h-6 w-6 place-items-center rounded-lg', PILL[tone])}>
          <Icon size={13} aria-hidden="true" />
        </span>
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums leading-tight text-ink">{value}</div>
      {delta && <div className="text-[10.5px] text-muted">{delta}</div>}
    </div>
  );
}

export function ViewHeader({ title, subtitle, right }) {
  return (
    <div data-reveal className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-base font-bold tracking-tight text-ink">{title}</h3>
        {subtitle && <p className="truncate text-[11.5px] text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/** A fake control. Real inputs would be focusable, so the preview uses plain elements. */
export function FakeButton({ children, icon: Icon, primary, className }) {
  return (
    <span
      className={cx(
        'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[12px] font-semibold',
        primary ? 'bg-primary text-on-primary' : 'border border-line bg-card text-ink',
        className,
      )}
    >
      {Icon && <Icon size={13} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Meter({ pct, tone = 'primary' }) {
  const fill = { primary: 'bg-primary', warning: 'bg-amber', danger: 'bg-danger', orange: 'bg-orange' }[tone];
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
      <div className={cx('h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}
