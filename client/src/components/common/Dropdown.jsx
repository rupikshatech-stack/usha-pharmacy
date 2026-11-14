import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';

/** Click-outside + Escape aware popover. `trigger` receives { open, toggle, props }. */
export function Dropdown({ trigger, children, align = 'right', width = 'w-64', label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => setOpen((o) => !o);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle, props: { 'aria-haspopup': 'menu', 'aria-expanded': open } })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cx(
            'anim-pop absolute z-40 mt-2 overflow-hidden rounded-xl border border-line bg-card shadow-pop',
            width,
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, danger, className, children, ...p }) {
  return (
    <button
      type="button"
      role="menuitem"
      {...p}
      className={cx(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-subtle',
        danger ? 'text-danger' : 'text-ink',
        className,
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  );
}
