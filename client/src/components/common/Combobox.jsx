import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FormField, cx, inputCls } from './ui';

/**
 * Searchable dropdown. Type to filter the suggestions; free text is allowed
 * (e.g. a brand-new manufacturer) unless `strict` is set.
 */
export function Combobox({ label, value, onChange, options = [], placeholder, error, hint, required, strict }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(q)).slice(0, 8);
  }, [options, value]);

  useEffect(() => {
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pick = (v) => {
    onChange(v);
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && filtered[active]) {
      e.preventDefault();
      pick(filtered[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <FormField label={label} error={error} hint={hint} required={required}>
      {(a) => (
        <div ref={ref} className="relative">
          <input
            {...a}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onBlur={() => strict && !options.includes(value) && onChange('')}
            onKeyDown={onKey}
            className={cx(inputCls, 'pr-8', error && 'border-danger')}
          />
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          {open && filtered.length > 0 && (
            <ul id={listId} role="listbox" className="anim-pop absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-pop">
              {filtered.map((o, i) => (
                <li
                  key={o}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cx('cursor-pointer px-3 py-1.5 text-sm', i === active && 'bg-subtle')}
                >
                  {o}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FormField>
  );
}
