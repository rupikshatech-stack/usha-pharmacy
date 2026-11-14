import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, LineChart as LineIcon, TrendingUp } from 'lucide-react';
import { CHART_METRICS, bucketLabel, compactMoney } from '../../utils/analytics';
import { EmptyState, ErrorState, Skeleton, cx } from '../common/ui';
import ChartCard from '../dashboard/ChartCard';
import ChartTooltip, { chartAxis } from '../dashboard/ChartTooltip';

const BUCKET_WORD = { day: 'day by day', week: 'week by week', month: 'month by month' };

/**
 * How trade moved through the period. The metric and the chart type are the reader's choice, because a buyer looking at
 * purchases and an owner looking at invoice counts want different shapes. Buckets with no trade are drawn as zero —
 * they came from the server that way, so a quiet Sunday is visible rather than smoothed over.
 */
export default function RevenueChart({ series, loading, error, onRetry, period }) {
  const [metric, setMetric] = useState('sales');
  const [kind, setKind] = useState('line');
  const chosen = CHART_METRICS.find((m) => m.key === metric) || CHART_METRICS[0];
  const points = (series?.points || []).map((p) => ({ ...p, label: bucketLabel(p.key, series?.bucket) }));
  const hasTrade = points.some((p) => Number(p[metric]) > 0);
  const money = chosen.format !== 'number';
  const Chart = kind === 'bar' ? BarChart : LineChart;

  const toggle = (value, current, set, label, Icon) => (
    <button
      key={value}
      type="button"
      aria-pressed={current === value}
      onClick={() => set(value)}
      className={cx('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors', current === value ? 'bg-accent text-on-accent' : 'text-muted hover:bg-subtle hover:text-ink')}
    >
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </button>
  );

  return (
    <ChartCard
      title="Revenue performance"
      subtitle={series ? `${BUCKET_WORD[series.bucket] || ''}${period?.days ? ` · ${period.days} days` : ''}` : 'Trade over the period'}
      right={
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="What to show">
            {CHART_METRICS.map((m) => toggle(m.key, metric, setMetric, m.label))}
          </div>
          <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Chart type">
            {toggle('line', kind, setKind, 'Line', LineIcon)}
            {toggle('bar', kind, setKind, 'Bars', BarChart3)}
          </div>
        </div>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading && !series ? (
        <Skeleton className="h-80 w-full" />
      ) : hasTrade ? (
        <div className="h-80" role="img" aria-label={`${kind === 'bar' ? 'Bar' : 'Line'} chart of ${chosen.label.toLowerCase()} ${BUCKET_WORD[series.bucket]}: ${points.map((p) => `${p.label} ${p[metric]}`).join(', ')}`}>
          <ResponsiveContainer>
            <Chart data={points} margin={{ left: -4, right: 12, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
              <XAxis dataKey="label" {...chartAxis} interval="preserveStartEnd" minTickGap={24} />
              <YAxis {...chartAxis} width={62} tickFormatter={money ? compactMoney : (v) => Number(v).toLocaleString('en-IN')} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={kind === 'bar' ? { fill: 'var(--subtle)' } : { stroke: 'var(--line)', strokeWidth: 1 }} />
              {kind === 'bar' ? (
                <Bar dataKey={metric} name={chosen.label} fill={chosen.colour} radius={[6, 6, 0, 0]} maxBarSize={44} />
              ) : (
                <Line
                  type="monotone"
                  dataKey={metric}
                  name={chosen.label}
                  stroke={chosen.colour}
                  strokeWidth={2.5}
                  dot={points.length <= 31 ? { r: 3, fill: 'var(--card)', stroke: chosen.colour, strokeWidth: 2 } : false}
                  activeDot={{ r: 5.5, fill: chosen.colour, stroke: 'var(--card)', strokeWidth: 2 }}
                />
              )}
            </Chart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState icon={TrendingUp} title={`No ${chosen.label.toLowerCase()} in this period`} hint="Choose a different period, or a different figure to look at." />
      )}
    </ChartCard>
  );
}
