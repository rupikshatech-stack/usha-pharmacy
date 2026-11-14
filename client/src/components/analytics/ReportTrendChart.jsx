import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, LineChart as LineIcon, TrendingUp } from 'lucide-react';
import { bucketLabel, compactMoney } from '../../utils/analytics';
import { EmptyState, ErrorState, Skeleton, cx } from '../common/ui';
import ChartCard from '../dashboard/ChartCard';
import ChartTooltip, { chartAxis } from '../dashboard/ChartTooltip';

const BUCKET_WORD = { day: 'day by day', week: 'week by week', month: 'month by month' };

/**
 * One trend over a period, for any report. The figure and the chart type are the reader's choice, because a buyer
 * looking at order value and an owner looking at how many bills were written want different shapes.
 *
 * Every bucket of the period is drawn, including the empty ones — they arrive from the server as zeros, so a quiet
 * Sunday is visible rather than smoothed over, and nothing is invented to fill a gap.
 *
 * `metrics` is [{ key, label, colour, format }] where format 'number' means a count rather than money.
 */
export default function ReportTrendChart({ title, subtitle, series, metrics, loading, error, onRetry, period }) {
  const [metric, setMetric] = useState(metrics[0].key);
  const [kind, setKind] = useState('line');
  const chosen = metrics.find((m) => m.key === metric) || metrics[0];
  const points = (series?.points || []).map((p) => ({ ...p, label: bucketLabel(p.key, series?.bucket) }));
  const anything = points.some((p) => Number(p[chosen.key]) > 0);
  const money = chosen.format !== 'number';
  const Chart = kind === 'bar' ? BarChart : LineChart;

  const toggle = (value, current, set, label, Icon) => (
    <button
      key={value}
      type="button"
      aria-pressed={current === value}
      onClick={() => set(value)}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
        current === value ? 'bg-accent text-on-accent' : 'text-muted hover:bg-subtle hover:text-ink',
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </button>
  );

  return (
    <ChartCard
      title={title}
      subtitle={series ? `${BUCKET_WORD[series.bucket] || ''}${period?.days ? ` · ${period.days} days` : ''}` : subtitle}
      right={
        <div className="flex flex-wrap items-center gap-1">
          {metrics.length > 1 && (
            <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="What to show">
              {metrics.map((m) => toggle(m.key, metric, setMetric, m.label))}
            </div>
          )}
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
        <Skeleton className="h-72 w-full" />
      ) : anything ? (
        <div
          className="h-72"
          role="img"
          aria-label={`${kind === 'bar' ? 'Bar' : 'Line'} chart of ${chosen.label.toLowerCase()} ${BUCKET_WORD[series.bucket]}: ${points.map((p) => `${p.label} ${p[chosen.key]}`).join(', ')}`}
        >
          <ResponsiveContainer>
            <Chart data={points} margin={{ left: -4, right: 12, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
              <XAxis dataKey="label" {...chartAxis} interval="preserveStartEnd" minTickGap={24} />
              <YAxis {...chartAxis} width={62} tickFormatter={money ? compactMoney : (v) => Number(v).toLocaleString('en-IN')} allowDecimals={false} />
              <Tooltip content={<ChartTooltip money={money} />} cursor={kind === 'bar' ? { fill: 'var(--subtle)' } : { stroke: 'var(--line)', strokeWidth: 1 }} />
              {kind === 'bar' ? (
                <Bar dataKey={chosen.key} name={chosen.label} fill={chosen.colour} radius={[6, 6, 0, 0]} maxBarSize={44} />
              ) : (
                <Line
                  type="monotone"
                  dataKey={chosen.key}
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
