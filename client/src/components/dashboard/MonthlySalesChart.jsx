import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { EmptyState, ErrorState, Skeleton } from '../common/ui';
import ChartCard from './ChartCard';
import ChartTooltip, { chartAxis, compactNumber } from './ChartTooltip';

/** Monthly revenue for the last six months (line chart). `sales` is the useFetch result for /dashboard/monthly-sales. */
export default function MonthlySalesChart({ sales }) {
  const items = sales.data?.items;
  const hasSales = items?.some((m) => m.revenue > 0);

  return (
    <ChartCard title="Monthly sales" subtitle="Revenue from completed sales, last 6 months">
      {sales.error ? (
        <ErrorState message={sales.error} onRetry={sales.reload} />
      ) : !items ? (
        <Skeleton className="h-72 w-full" />
      ) : hasSales ? (
        <div className="h-72" role="img" aria-label={`Line chart of monthly revenue: ${items.map((m) => `${m.label} ${m.revenue}`).join(', ')}`}>
          <ResponsiveContainer>
            <LineChart data={items} margin={{ left: -4, right: 12, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
              <XAxis dataKey="label" {...chartAxis} tickFormatter={(s) => s.split(' ')[0]} />
              <YAxis {...chartAxis} width={56} tickFormatter={compactNumber} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--line)', strokeWidth: 1 }} />
              <Line
                type="monotone"
                dataKey="revenue"
                name="Revenue"
                stroke="var(--primary)"
                strokeWidth={2.5}
                dot={{ r: 3.5, fill: 'var(--card)', stroke: 'var(--primary)', strokeWidth: 2 }}
                activeDot={{ r: 5.5, fill: 'var(--primary)', stroke: 'var(--card)', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState icon={TrendingUp} title="No sales in the last 6 months" hint="Monthly revenue appears here once you complete your first invoice." />
      )}
    </ChartCard>
  );
}
