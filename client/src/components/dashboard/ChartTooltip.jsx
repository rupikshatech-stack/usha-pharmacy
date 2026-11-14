import { inr } from '../../utils/format';

/** Themed Recharts tooltip. Set money={false} for unit counts. */
export default function ChartTooltip({ active, payload, label, money = true }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-pop">
      {label && <div className="mb-1 font-semibold">{label}</div>}
      {payload.map((p) => (
        <div key={p.dataKey || p.name} className="flex items-center gap-2 text-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.payload?.fill || 'var(--primary)' }} />
          {p.name}: <span className="font-semibold text-ink">{money ? inr(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Shared axis styling for all dashboard charts. */
export const chartAxis = { tickLine: false, axisLine: false, fontSize: 12, stroke: 'var(--muted)' };

export const compactNumber = (n) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
