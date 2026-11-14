import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../services/api';
import { useDebounced } from '../../hooks/useFetch';
import { expiryFmt } from '../../utils/format';
import { FormField, cx, inputCls } from '../common/ui';

/**
 * Searches the batches held in ONE store (the transfer's source) that still have sellable stock, as you type.
 * Calls onPick(batch) for the chosen one; batches already on the transfer are hidden.
 */
export default function TransferBatchPicker({ branchId, exclude = [], onPick, disabled, error }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const q = useDebounced(text, 250);
  const box = useRef(null);

  useEffect(() => {
    if (!open || !branchId) return undefined;
    let current = true;
    setLoading(true);
    api
      .get('/batches', { params: { branchId, search: q, limit: 15, sortBy: 'expiryDate', sortDir: 'asc' } })
      .then((d) => {
        if (!current) return;
        setOptions(d.items.filter((b) => b.sellableQuantity > 0 && !exclude.includes(b._id)));
        setActive(0);
      })
      .catch(() => current && setOptions([]))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, branchId, exclude.join(',')]);

  useEffect(() => {
    const down = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, []);

  const pick = (b) => {
    onPick(b);
    setText('');
    setOpen(false);
  };

  return (
    <FormField label="Add medicine" error={error} hint={!branchId ? 'Choose the source store first.' : 'Search by medicine name or batch number. Only batches with available stock in the source store are listed.'}>
      {(a) => (
        <div ref={box} className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            {...a}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            autoComplete="off"
            disabled={disabled || !branchId}
            value={text}
            placeholder={branchId ? 'Search and add medicine…' : 'Choose the source store first'}
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
          {open && branchId && (
            <ul role="listbox" aria-label="Batches in the source store" className="anim-pop absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-pop">
              {!loading && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No batches with available stock found</li>}
              {options.map((b, i) => (
                <li
                  key={b._id}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(b);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cx('flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-sm', i === active && 'bg-subtle')}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{b.medicineName}</span>
                    <span className="block text-xs text-muted">
                      Batch {b.batchNumber} · expires {expiryFmt(b.expiryDate)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums">{b.sellableQuantity} available</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FormField>
  );
}
