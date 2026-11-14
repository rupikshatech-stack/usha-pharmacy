import { Input, Select } from '../common/ui';
import { QUICK_RANGES, quickRange } from '../../utils/analytics';

/**
 * The question every analytics screen asks: which period, and which store. One control for both, so the Overview and
 * the Transaction Report cannot drift apart in what "Last 30 days" means or which stores are on offer.
 *
 * `value` is { range, from, to, branchId }; `onChange` is given the whole next value. The caller holds the state,
 * because it is also what the caller sends to the server.
 */
export default function PeriodFilters({ value, onChange, stores = [], storesLoading, children }) {
  const { range, from, to, branchId } = value;
  const badRange = Boolean(from && to && from > to);

  const chooseRange = (key) => onChange(key === 'custom' ? { ...value, range: key } : { ...value, range: key, ...quickRange(key) });
  const setDay = (which) => (e) => onChange({ ...value, range: 'custom', [which]: e.target.value });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select label="Period" className="w-44" value={range} onChange={(e) => chooseRange(e.target.value)}>
        {QUICK_RANGES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </Select>
      <Input label="From" type="date" className="w-40" value={from || ''} max={to || undefined} onChange={setDay('from')} />
      <Input
        label="To"
        type="date"
        className="w-40"
        value={to || ''}
        min={from || undefined}
        onChange={setDay('to')}
        error={badRange ? 'The end date is before the start date' : undefined}
      />
      <Select
        label="Store"
        className="w-52"
        value={branchId || ''}
        disabled={storesLoading}
        onChange={(e) => onChange({ ...value, branchId: e.target.value })}
        hint={stores.length > 1 ? undefined : 'Every store you may see.'}
      >
        <option value="">All stores</option>
        {stores.map((b) => (
          <option key={b._id} value={b._id}>
            {b.name}
          </option>
        ))}
      </Select>
      {children}
    </div>
  );
}

/** The period as the API wants it: calendar days, and nothing at all while the two dates are the wrong way round. */
export function periodQuery({ range, from, to, branchId }) {
  const resolved = range === 'custom' ? { from, to } : quickRange(range) || { from, to };
  const backwards = Boolean(resolved.from && resolved.to && resolved.from > resolved.to);
  return {
    from: resolved.from || undefined,
    to: backwards ? undefined : resolved.to || undefined,
    branchId: branchId || undefined,
  };
}

/** The initial state of the control: a named quick range, resolved to the days it means. */
export const initialPeriod = (range = 'thisMonth', branchId = '') => ({ range, ...quickRange(range), branchId });
