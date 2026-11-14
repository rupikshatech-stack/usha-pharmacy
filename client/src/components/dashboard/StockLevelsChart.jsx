import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Package } from 'lucide-react';
import { EmptyState, ErrorState, Skeleton } from '../common/ui';
import ChartCard from './ChartCard';
import { chartAxis, compactNumber } from './ChartTooltip';

const short = (s) => (s.length > 16 ? `${s.slice(0, 15)}…` : s);

function StockTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const m = payload[0].payload;
  const low = m.qty < m.reorderLevel;
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-pop">
      <div className="mb-1 font-semibold">{m.name}</div>
      <div className="text-muted">
        Available: <span className="font-semibold text-ink">{m.qty} units</span>
      </div>
      <div className="text-muted">
        Reorder level: <span className="font-semibold text-ink">{m.reorderLevel}</span>
        {low && <span className="ml-1.5 font-semibold text-warning">· below</span>}
      </div>
    </div>
  );
}

/** Medicines with the most stock available (horizontal bar chart so long names stay readable). */
export default function StockLevelsChart({ stock }) {
  const items = stock.data?.items;
  const height = items ? Math.max(220, items.length * 38 + 36) : 288;

  return (
    <ChartCard title="Medicine stock levels" subtitle="Highest available stock by medicine">
      {stock.error ? (
        <ErrorState message={stock.error} onRetry={stock.reload} />
      ) : !items ? (
        <Skeleton className="h-72 w-full" />
      ) : items.length ? (
        <>
          <div style={{ height }} role="img" aria-label={`Bar chart of stock: ${items.map((m) => `${m.name} ${m.qty}`).join(', ')}`}>
            <ResponsiveContainer>
              <BarChart data={items} layout="vertical" margin={{ left: 0, right: 20, top: 4, bottom: 4 }} barCategoryGap={10}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--line)" />
                <XAxis type="number" {...chartAxis} tickFormatter={compactNumber} allowDecimals={false} />
                <YAxis type="category" dataKey="name" {...chartAxis} width={118} tickFormatter={short} interval={0} />
                <Tooltip content={<StockTooltip />} cursor={{ fill: 'var(--subtle)' }} />
                <Bar dataKey="qty" name="Units" radius={[0, 6, 6, 0]} maxBarSize={22}>
                  {items.map((m) => (
                    <Cell key={m.medicineId} fill={m.qty < m.reorderLevel ? 'var(--warning)' : 'var(--primary)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {items.some((m) => m.qty < m.reorderLevel) && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <span className="h-2.5 w-2.5 rounded-sm bg-warning" aria-hidden="true" /> Below reorder level
            </p>
          )}
        </>
      ) : (
        <EmptyState icon={Package} title="No stock available" hint="Add a medicine with a batch to see stock levels here." />
      )}
    </ChartCard>
  );
}
