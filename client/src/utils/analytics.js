/**
 * The Business Analytics screens: the ranges people actually ask for, and how a figure is shown.
 * Every number comes from the server already worked out — nothing here recalculates a business figure, it only
 * decides how to say it.
 */
const pad = (n) => String(n).padStart(2, '0');
/** A calendar day as the API wants it (YYYY-MM-DD), read in the browser's own timezone. */
export const dayString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/**
 * The quick ranges, as {from,to} calendar days. `now` is injectable so this can be tested at any instant.
 * A range always ends on a day that has happened: "this month" stops today, not on the 31st.
 */
export function quickRange(key, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const month = (delta) => new Date(today.getFullYear(), today.getMonth() + delta, 1);
  switch (key) {
    case 'today':
      return { from: dayString(today), to: dayString(today) };
    case 'yesterday':
      return { from: dayString(shift(today, -1)), to: dayString(shift(today, -1)) };
    case 'last7':
      return { from: dayString(shift(today, -6)), to: dayString(today) };
    case 'last30':
      return { from: dayString(shift(today, -29)), to: dayString(today) };
    case 'thisMonth':
      return { from: dayString(month(0)), to: dayString(today) };
    case 'lastMonth': {
      const start = month(-1);
      return { from: dayString(start), to: dayString(new Date(today.getFullYear(), today.getMonth(), 0)) };
    }
    case 'thisQuarter': {
      const start = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
      return { from: dayString(start), to: dayString(today) };
    }
    case 'thisYear':
      return { from: dayString(new Date(today.getFullYear(), 0, 1)), to: dayString(today) };
    default:
      return null; // custom: whatever the person picked
  }
}

export const QUICK_RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['last30', 'Last 30 days'],
  ['thisMonth', 'This month'],
  ['lastMonth', 'Last month'],
  ['thisQuarter', 'This quarter'],
  ['thisYear', 'This year'],
  ['custom', 'Custom'],
];

/** "₹1.2L", "₹45.6K", "₹980" — money on a card or an axis, where space is short and the exact paisa is not the point. */
export function compactMoney(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 10000000) return `${sign}₹${(a / 10000000).toFixed(a >= 100000000 ? 0 : 2)}Cr`;
  if (a >= 100000) return `${sign}₹${(a / 100000).toFixed(a >= 1000000 ? 0 : 2)}L`;
  if (a >= 1000) return `${sign}₹${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}K`;
  return `${sign}₹${a.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** How a KPI's change reads: the arrow, the words, and whether it is good news. Falling returns are good news. */
export function trendOf(kpi) {
  const { change: c, key } = kpi;
  const goodWhenDown = key === 'salesReturns' || key === 'receivables';
  if (!c || c.percent === null) return { label: c?.isNew ? 'New in this period' : 'No change', tone: 'neutral', direction: 'flat' };
  if (c.percent === 0) return { label: 'No change', tone: 'neutral', direction: 'flat' };
  const up = c.percent > 0;
  return {
    label: `${up ? '+' : ''}${c.percent}% vs previous period`,
    tone: up === goodWhenDown ? 'down' : 'up', // "up" means good, not upward
    direction: up ? 'up' : 'down',
  };
}

/** The metrics the revenue chart can show, and where each one lives on a series point. */
export const CHART_METRICS = [
  { key: 'sales', label: 'Sales', colour: 'var(--primary)' },
  { key: 'purchases', label: 'Purchases', colour: 'var(--info)' },
  { key: 'invoices', label: 'Invoices', colour: 'var(--purple)', format: 'number' },
];

/** The x-axis label for a bucket: a day, the week it starts, or the month. */
export function bucketLabel(key, bucket) {
  const [y, m, d] = String(key).split('-');
  const month = new Date(Number(y), Number(m) - 1, 1).toLocaleString('en-IN', { month: 'short' });
  if (bucket === 'month') return `${month} ${String(y).slice(2)}`;
  if (bucket === 'week') return `${d} ${month}`;
  return `${d} ${month}`;
}
