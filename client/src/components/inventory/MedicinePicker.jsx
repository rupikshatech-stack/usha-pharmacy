import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../../services/api';
import { useDebounced } from '../../hooks/useFetch';
import { FormField, cx, inputCls } from '../common/ui';

/**
 * Searchable medicine chooser: asks the server as you type (name, generic name, SKU, barcode).
 * With `multiple` it behaves as an "add" box (onChange is called with each pick and the box clears);
 * otherwise it shows the chosen medicine with a button to change it. `exclude` hides medicines by id.
 */
export default function MedicinePicker({ value, onChange, error, autoFocus, label = 'Medicine', required, multiple, exclude = [], className = 'sm:col-span-2', placeholder = 'Search by name, generic name, SKU or barcode…' }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const q = useDebounced(text, 250);
  const box = useRef(null);
  const showing = !multiple && value;

  useEffect(() => {
    if (showing || !open) return undefined;
    let current = true;
    api
      .get('/inventory', { params: { search: q, limit: 12, sortBy: 'medicineName' } })
      .then((d) => {
        if (!current) return;
        setOptions(d.items.filter((m) => !exclude.includes(m._id)));
        setActive(0);
      })
      .catch(() => current && setOptions([]));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, showing, exclude.join(',')]);

  useEffect(() => {
    const down = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, []);

  const pick = (m) => {
    onChange(m);
    setOpen(!multiple ? false : true);
    setText('');
  };

  return (
    <FormField label={label} required={required} error={error} className={className}>
      {(a) =>
        showing ? (
          <div className="flex h-10 items-center justify-between rounded-lg border border-line bg-subtle px-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-semibold">{value.medicineName}</span>
              {(value.strength || value.dosageForm) && <span className="text-muted"> · {[value.strength, value.dosageForm].filter(Boolean).join(' ')}</span>}
            </span>
            <button type="button" aria-label="Choose a different medicine" onClick={() => onChange(null)} className="ml-2 grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:text-ink">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div ref={box} className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              {...a}
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              autoComplete="off"
              autoFocus={autoFocus}
              value={text}
              placeholder={placeholder}
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setText(e.target.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, options.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && open && options[active]) {
                  e.preventDefault();
                  pick(options[active]);
                }
              }}
              className={cx(inputCls, 'pl-9', error && 'border-danger')}
            />
            {open && (
              <ul role="listbox" className="anim-pop absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-pop">
                {options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No medicines found</li>}
                {options.map((m, i) => (
                  <li
                    key={m._id}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(m);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cx('cursor-pointer px-3 py-1.5 text-sm', i === active && 'bg-subtle')}
                  >
                    <div className="font-medium">{m.medicineName}</div>
                    <div className="text-xs text-muted">{[m.strength, m.dosageForm, m.manufacturer].filter(Boolean).join(' · ') || '—'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      }
    </FormField>
  );
}
