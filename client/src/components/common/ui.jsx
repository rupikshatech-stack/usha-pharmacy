import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Inbox, Loader2, Search, X, TrendingDown, TrendingUp } from 'lucide-react';

export const cx = (...c) => c.filter(Boolean).join(' ');

/* ---------- Brand ---------- */

/**
 * Brand logo from /logo/logo.jpg. The artwork is dark-on-light, so on dark surfaces it sits on a
 * white tile. Falls back to a text mark if the file is missing.
 */
export function Logo({ onDark = false, className }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <TextLogo />;
  return (
    <div className={cx('rounded-lg bg-white', onDark && 'px-2.5 py-2', className)}>
      <img
        src="/logo/logo.jpg"
        alt="Usha Pharmacy"
        onError={() => setFailed(true)}
        className="block h-auto w-full select-none mix-blend-multiply"
        draggable="false"
      />
    </div>
  );
}

function TextLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-on-primary">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
          <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z" />
        </svg>
      </span>
      <span className="text-base font-extrabold tracking-tight">Usha Pharmacy</span>
    </div>
  );
}

/* ---------- Layout primitives ---------- */

export function Card({ className, children, ...p }) {
  return (
    <section {...p} className={cx('rounded-2xl border border-line bg-card shadow-card', className)}>
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  sage: 'bg-sage text-sage-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  purple: 'bg-purple-soft text-purple',
  orange: 'bg-orange-soft text-orange',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-subtle text-muted',
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'sage', trend, loading }) {
  const up = trend >= 0;
  const TrendIcon = up ? TrendingUp : TrendingDown;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className="text-sm font-medium text-muted">{label}</span>
        <span className={cx('grid h-9 w-9 place-items-center rounded-xl', tones[tone])}>
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-28" />
      ) : (
        <div className="mt-2 text-[26px] font-extrabold leading-tight tracking-tight tabular-nums">{value}</div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
        {typeof trend === 'number' && (
          <span className={cx('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold', up ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger')}>
            <TrendIcon className="h-3 w-3" aria-hidden="true" />
            {up ? '+' : ''}
            {trend}%
          </span>
        )}
        {hint}
      </div>
    </Card>
  );
}

/* ---------- Buttons ---------- */

const btn = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover shadow-sm',
  secondary: 'border border-line bg-card text-ink hover:bg-subtle',
  danger: 'bg-danger text-on-danger hover:opacity-90',
  accent: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  ghost: 'text-muted hover:bg-subtle hover:text-ink',
};

export function Button({ variant = 'primary', size = 'md', loading, className, children, ...p }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
        btn[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
export const PrimaryButton = (p) => <Button variant="primary" {...p} />;
export const SecondaryButton = (p) => <Button variant="secondary" {...p} />;

export function IconButton({ label, className, children, ...p }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...p}
      className={cx('grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-ink', className)}
    >
      {children}
    </button>
  );
}

/* ---------- Form controls ---------- */

export const inputCls =
  'h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted/70 transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-subtle disabled:text-muted';

export function FormField({ label, error, hint, required, children, className }) {
  const id = useId();
  return (
    <div className={cx('block text-sm', className)}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
      </label>
      {typeof children === 'function' ? children({ id, 'aria-invalid': Boolean(error) }) : children}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-muted">{hint}</p>
      )}
    </div>
  );
}
export const Field = FormField;

/**
 * Which on-screen keypad a number field should raise. A whole-number field that cannot go negative gets the digit pad; one that allows
 * fractions gets the decimal pad. A field that can be negative (a stock adjustment: -3) is left alone, because those keypads have no minus.
 */
export function keypadFor({ type, min, step, inputMode }) {
  if (inputMode || type !== 'number') return inputMode;
  if (min === undefined || Number(min) < 0) return undefined;
  return Number(step) === 1 ? 'numeric' : 'decimal';
}

export function Input({ label, error, hint, required, className, inputClassName, ...p }) {
  return (
    <FormField label={label} error={error} hint={hint} required={required} className={className}>
      {(a) => <input {...a} required={required} inputMode={keypadFor(p)} {...p} className={cx(inputCls, error && 'border-danger', inputClassName)} />}
    </FormField>
  );
}

export function Select({ label, error, hint, required, className, children, ...p }) {
  return (
    <FormField label={label} error={error} hint={hint} required={required} className={className}>
      {(a) => (
        <select {...a} {...p} className={cx(inputCls, 'pr-8')}>
          {children}
        </select>
      )}
    </FormField>
  );
}

export function SearchInput({ value, onChange, placeholder, label = 'Search', className, inputRef, ...p }) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        {...p}
        className={cx(inputCls, 'pl-9')}
      />
    </div>
  );
}

export function FilterDropdown({ label, value, onChange, options, allLabel = 'All' }) {
  return (
    <label className="flex items-center gap-2 text-xs font-semibold text-muted">
      <span className="hidden sm:inline">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(inputCls, 'h-9 w-auto min-w-32 pr-7 text-[13px] text-ink')}
      >
        <option value="">{allLabel} {label.toLowerCase()}</option>
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          const l = typeof o === 'string' ? o : o.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/* ---------- Feedback states ---------- */

export function Skeleton({ className }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-14 text-sm text-muted">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-sage text-sage-ink">
        <Icon className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="mt-1 font-semibold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-4 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-danger-soft text-danger">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </div>
      <p className="mt-1 font-semibold">Something went wrong</p>
      <p className="max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}

/* ---------- Badges ---------- */

export function Badge({ tone = 'neutral', children, dot }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', tones[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

const statusMap = {
  CONTINUE: ['success', 'Active'],
  DISCONTINUE: ['neutral', 'Discontinued'],
  OUT: ['danger', 'Out of stock'],
  LOW: ['warning', 'Low stock'],
  IN: ['success', 'In stock'],
  EXPIRED: ['danger', 'Expired'],
  EXPIRING: ['warning', 'Expiring'],
  // calculated by the server from batch data
  in_stock: ['success', 'In Stock'],
  low_stock: ['warning', 'Low Stock'],
  out_of_stock: ['danger', 'Out of Stock'],
  expired: ['danger', 'Expired'],
  archived: ['neutral', 'Archived'],
  // CSV import: row and import statuses
  valid: ['success', 'Valid'],
  invalid: ['danger', 'Invalid'],
  skipped: ['warning', 'Skipped'],
  imported: ['success', 'Imported'],
  failed: ['danger', 'Failed'],
  previewed: ['neutral', 'Awaiting confirmation'],
  importing: ['warning', 'Importing'],
  completed: ['success', 'Completed'],
  processed: ['success', 'Processed'],
  ordered: ['info', 'Ordered'],
  received: ['success', 'Received'],
  refund_pending: ['orange', 'Refund pending'],
  refunded: ['purple', 'Refunded'],
  draft: ['neutral', 'Draft'],
  pending: ['warning', 'Pending'],
  submitted: ['warning', 'Pending approval'],
  approved: ['sage', 'Approved'],
  rejected: ['danger', 'Rejected'],
  in_transit: ['info', 'In transit'],
  partially_dispatched: ['info', 'Partially dispatched'],
  partially_received: ['orange', 'Partially received'],
  completed_with_errors: ['warning', 'Completed with errors'],
  cancelled: ['neutral', 'Cancelled'],
  quarantined: ['warning', 'Quarantined'],
  recalled: ['danger', 'Recalled'],
};
export function StatusBadge({ status }) {
  const [tone, text] = statusMap[status] || ['neutral', status];
  return (
    <Badge tone={tone} dot>
      {text}
    </Badge>
  );
}

/* ---------- Dialogs ---------- */

export function Modal({ title, description, onClose, children, wide, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-center justify-center overflow-hidden p-3 sm:p-6" style={{ background: 'var(--overlay)' }} onMouseDown={onClose}>
      {/* The dialog never grows past the screen: its title and buttons stay put and only the middle scrolls, so a long
          form can be read without losing sight of what it is or where Save is. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cx('anim-pop flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-pop', wide === 'xl' ? 'max-w-6xl' : wide ? 'max-w-3xl' : 'max-w-lg')}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-bold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose} className="-mr-2 -mt-1">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, loading, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{message}</div>
    </Modal>
  );
}

/* ---------- Pagination ---------- */

export function Pagination({ page, pages, total, limit, onPage, onLimit, limits = [10, 25, 50], pageSummary = false }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
      <span>
        {pageSummary ? `Showing page ${page} of ${pages} with ${total} total record${total === 1 ? '' : 's'}` : limit ? `${from}–${to} of ${total}` : `${total} records`}
      </span>
      <div className="flex items-center gap-2">
        {onLimit && (
          <label className="flex items-center gap-1.5 text-xs">
            Rows
            <select aria-label="Rows per page" value={limit} onChange={(e) => onLimit(Number(e.target.value))} className={cx(inputCls, 'h-8 w-auto pr-6 text-[13px] text-ink')}>
              {limits.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {!pageSummary && (
          <span className="hidden text-xs sm:inline">
            Page {page} of {pages}
          </span>
        )}
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={pageSummary ? 'Previous page' : undefined}>
          {pageSummary ? 'Prev' : 'Previous'}
        </Button>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={pageSummary ? 'Next page' : undefined}>
          Next
        </Button>
      </div>
    </div>
  );
}
