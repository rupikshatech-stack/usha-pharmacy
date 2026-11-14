import { Building2, Boxes, FilterX, Layers, Tag, Truck } from 'lucide-react';
import { Button, Card, Select, SearchInput, cx, inputCls } from '../../common/ui';
import { activeFilterCount } from '../../../utils/expiryView';

/** The grouping toggle, which is a view of the same question rather than a filter on it. */
const GROUPS = [
  ['none', 'All medicines', Boxes],
  ['company', 'Group by company', Building2],
  ['supplier', 'Group by supplier', Truck],
  ['category', 'Group by category', Tag],
];

/** Date ranges people actually ask for, as {expiryFrom, expiryTo} calendar days. */
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function expiryPreset(key, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = (delta) => new Date(today.getFullYear(), today.getMonth() + delta, 1);
  const monthEnd = (delta) => new Date(today.getFullYear(), today.getMonth() + delta + 1, 0);
  switch (key) {
    case 'thisMonth':
      return { expiryFrom: day(monthStart(0)), expiryTo: day(monthEnd(0)) };
    case 'nextMonth':
      return { expiryFrom: day(monthStart(1)), expiryTo: day(monthEnd(1)) };
    case 'next3':
      return { expiryFrom: day(today), expiryTo: day(monthEnd(2)) };
    case 'overdue':
      return { expiryFrom: '', expiryTo: day(new Date(today.getTime() - 86400000)) };
    default:
      return { expiryFrom: '', expiryTo: '' };
  }
}
const PRESETS = [
  ['', 'All expiry dates'],
  ['overdue', 'Already expired'],
  ['thisMonth', 'This month'],
  ['nextMonth', 'Next month'],
  ['next3', 'Next 3 months'],
  ['custom', 'Custom range…'],
];

/**
 * Everything that narrows the register.
 *
 * The filters are the question, not decoration: changing one asks the server again, and the figures above the table
 * follow. They all live in the address bar too, so a narrowed view can be bookmarked or sent to a colleague — which
 * is the difference between "I found something" and "look at this".
 */
export default function ExpiryFilters({ state, set, options, stores, storesLoading, searchDraft, onSearchDraft, onClear }) {
  const active = activeFilterCount(state);
  const custom = Boolean(state.expiryFrom || state.expiryTo);
  // Which preset the current dates correspond to, so the dropdown shows the truth after a reload from the URL.
  const presetKey = PRESETS.slice(1, -1).find(([k]) => {
    const p = expiryPreset(k);
    return p.expiryFrom === state.expiryFrom && p.expiryTo === state.expiryTo;
  })?.[0];
  const presetValue = presetKey || (custom ? 'custom' : '');

  return (
    <Card className="space-y-3 p-3 sm:p-4">
      {/* The three things people reach for first. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[15rem] flex-1">
          <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
          <SearchInput value={searchDraft} onChange={onSearchDraft} label="Search the register" placeholder="Medicine, batch, category, company, supplier or HSN…" />
        </div>
        <Select label="Status" className="w-44" value={state.status} onChange={(e) => set({ status: e.target.value })} disabled={!options}>
          {(options?.statuses || [{ value: 'all', label: 'All stock' }]).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select
          label="Store"
          className="w-48"
          value={state.branchId}
          onChange={(e) => set({ branchId: e.target.value })}
          disabled={storesLoading}
          hint={stores.length <= 1 ? undefined : undefined}
        >
          <option value="">All stores</option>
          {stores.map((b) => (
            <option key={b._id} value={b._id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Select label="Expiry dates" className="w-44" value={presetValue} onChange={(e) => set(e.target.value === 'custom' ? { expiryFrom: state.expiryFrom || '', expiryTo: state.expiryTo || '' } : expiryPreset(e.target.value))}>
          {PRESETS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        {presetValue === 'custom' && (
          <>
            <label className="text-[13px] font-semibold">
              <span className="mb-1.5 block">From</span>
              <input type="date" className={cx(inputCls, 'w-40')} value={state.expiryFrom} onChange={(e) => set({ expiryFrom: e.target.value })} />
            </label>
            <label className="text-[13px] font-semibold">
              <span className="mb-1.5 block">To</span>
              <input type="date" className={cx(inputCls, 'w-40')} value={state.expiryTo} onChange={(e) => set({ expiryTo: e.target.value })} />
            </label>
          </>
        )}
      </div>

      {/* The rest, which matter less often but matter a lot when they do. */}
      <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <Select label="Risk" className="w-36" value={state.riskLevel} onChange={(e) => set({ riskLevel: e.target.value })} disabled={!options}>
          <option value="">Any risk</option>
          {(options?.riskLevels || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select label="Category" className="w-44" value={state.categoryId} onChange={(e) => set({ categoryId: e.target.value })} disabled={!options}>
          <option value="">Any category</option>
          {(options?.categories || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select label="Company" className="w-44" value={state.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} disabled={!options}>
          <option value="">Any company</option>
          {(options?.manufacturers || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select label="Supplier" className="w-48" value={state.supplierId} onChange={(e) => set({ supplierId: e.target.value })} disabled={!options}>
          <option value="">Any supplier</option>
          {(options?.suppliers || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select label="Schedule" className="w-40" value={state.scheduleCategory} onChange={(e) => set({ scheduleCategory: e.target.value })} disabled={!options}>
          <option value="">Any schedule</option>
          {(options?.schedules || []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <label className="text-[13px] font-semibold">
          <span className="mb-1.5 block">Worth at least</span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">₹</span>
            <input
              type="number"
              min={0}
              step={500}
              className={cx(inputCls, 'w-32 pl-7')}
              value={state.minValue}
              onChange={(e) => set({ minValue: e.target.value })}
              placeholder="0"
              aria-label="Minimum value at cost"
            />
          </div>
        </label>
        {active > 0 && (
          <Button variant="secondary" onClick={onClear}>
            <FilterX className="h-4 w-4" aria-hidden="true" /> Clear {active} filter{active === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      {/* How the rows are arranged. A segmented control, because these are four views of one list. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
          <Layers className="h-4 w-4" aria-hidden="true" /> Arrange
        </span>
        <div className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-subtle p-1" role="group" aria-label="How to group the register">
          {GROUPS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => set({ groupBy: value })}
              aria-pressed={state.groupBy === value}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors',
                state.groupBy === value ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
