import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, TrendingDown } from 'lucide-react';
import { Card, Skeleton, cx } from '../../common/ui';
import { inr } from '../../../utils/format';
import { compactMoney } from '../../../utils/analytics';

/**
 * The charts beside the register.
 *
 * Each one answers a question the table cannot: when the wave hits, who the money sits with, and whether any of this
 * is getting better. They are all built from the same assessed rows as the table, except the loss trend, which is
 * history rather than projection — and says so on its own face, because a reader who confuses the two will draw the
 * wrong conclusion from the only chart here that is a fact.
 */

const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

/** The shared panel: a title, the caveat, and whatever the chart turns out to be. */
function Panel({ title, note, children, className }) {
  return (
    <Card className={cx('flex flex-col p-4', className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-bold">{title}</h3>
        {note && (
          <span className="group relative shrink-0" tabIndex={0}>
            <Info className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            <span className="pointer-events-none absolute right-0 top-5 z-20 hidden w-64 rounded-lg border border-line bg-card p-2 text-xs text-muted shadow-pop group-hover:block group-focus:block">
              {note}
            </span>
            <span className="sr-only">{note}</span>
          </span>
        )}
      </div>
      {children}
    </Card>
  );
}

const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12, color: 'var(--ink)' };

/** A horizontal ranking. Bars read left to right, which is how a list of "who owes us the most trouble" should read. */
function Ranking({ rows, emptyHint, valueKey = 'costValue', badge }) {
  if (!rows?.length) return <p className="rounded-lg bg-subtle px-3 py-2.5 text-sm text-muted">{emptyHint}</p>;
  const biggest = Math.max(1, ...rows.map((r) => r[valueKey]));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate font-medium" title={r.label}>
              {r.label}
            </span>
            <span className="shrink-0 font-semibold tabular-nums" title={inr(r[valueKey])}>
              {compactMoney(r[valueKey])}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(2, (r[valueKey] / biggest) * 100)}%` }} />
            </div>
            <span className="shrink-0 text-[11px] text-muted">
              {r.batches} lot{r.batches === 1 ? '' : 's'}
            </span>
          </div>
          {badge?.(r)}
        </li>
      ))}
    </ul>
  );
}

export default function ExpiryInsights({ data, loading, onPickMonth }) {
  if (loading && !data) {
    return (
      <section aria-label="Expiry insights" className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className={cx('h-64 w-full rounded-2xl', i === 0 && 'xl:col-span-2')} />
        ))}
      </section>
    );
  }
  if (!data) return null;

  const wave = data.expiryByMonth.map((m) => ({ ...m, label: monthLabel(m.key) }));
  const trend = data.lossTrend.map((m) => ({ ...m, label: monthLabel(m.key) }));
  const waveEmpty = wave.every((m) => !m.costValue);
  const trendEmpty = trend.every((m) => !m.value);
  // Of the last six months, is the most recent worse than the average of the five before it?
  const earlier = trend.slice(0, 5).reduce((n, m) => n + m.value, 0) / 5;
  const latest = trend[trend.length - 1]?.value || 0;

  return (
    <section aria-label="Expiry insights" className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
      {/* The wave. Widest, because it is the one people plan against. */}
      <Panel title="What expires each month" note={data.notes.expiryByMonth} className="xl:col-span-2">
        {waveEmpty ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-sm text-muted">Nothing expires in the next year. Every lot in this view is either already expired or more than a year out.</p>
        ) : (
          <div className="min-h-[14rem] w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={wave} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} onClick={(e) => e?.activePayload?.[0] && onPickMonth?.(e.activePayload[0].payload.key)}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={56} />
                <Tooltip
                  cursor={{ fill: 'var(--subtle)' }}
                  contentStyle={tooltipStyle}
                  formatter={(v, n) => [inr(v), n === 'costValue' ? 'At cost' : 'Projected loss']}
                  labelFormatter={(l) => {
                    const row = wave.find((m) => m.label === l);
                    return `${l} · ${row?.batches || 0} lot${row?.batches === 1 ? '' : 's'}`;
                  }}
                />
                <Bar dataKey="costValue" fill="var(--primary)" radius={[4, 4, 0, 0]} cursor="pointer" />
                <Bar dataKey="projectedLoss" fill="var(--danger)" radius={[4, 4, 0, 0]} cursor="pointer" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          <span className="mr-3"><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-primary align-middle" /> value at cost</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-danger align-middle" /> projected loss</span>
          {onPickMonth && ' · click a month to see it day by day'}
        </p>
      </Panel>

      <Panel title="At-risk stock by company" note={data.notes.topManufacturers}>
        <Ranking rows={data.topManufacturers} emptyHint="No at-risk stock: nothing is inside the expiry buckets for this view." />
      </Panel>

      <Panel title="At-risk stock by supplier" note={data.notes.topSuppliers}>
        <Ranking
          rows={data.topSuppliers}
          emptyHint="No at-risk stock: nothing is inside the expiry buckets for this view."
          badge={(r) =>
            r.expiredValue > 0 ? (
              <p className="mt-0.5 text-[11px] font-semibold text-danger">{compactMoney(r.expiredValue)} of it has already expired</p>
            ) : null
          }
        />
      </Panel>

      {/* The one chart here that is a fact rather than a projection. */}
      <Panel title="What was actually written off" note={data.notes.lossTrend} className="xl:col-span-4">
        {trendEmpty ? (
          <p className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2.5 text-sm text-muted">
            <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            Nothing has been written off in the last six months. Once stock is disposed of from this screen it is counted here, so this and the projections above can be compared.
          </p>
        ) : (
          <>
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={56} />
                  <Tooltip
                    cursor={{ fill: 'var(--subtle)' }}
                    contentStyle={tooltipStyle}
                    formatter={(v, n, p) => [`${inr(v)} · ${p.payload.units.toLocaleString('en-IN')} units`, 'Written off']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {trend.map((m, i) => (
                      <Cell key={m.key} fill={i === trend.length - 1 ? 'var(--danger)' : 'var(--orange)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {earlier > 0 && (
              <p className={cx('mt-2 text-xs font-semibold', latest > earlier ? 'text-danger' : 'text-success')}>
                This month is {compactMoney(Math.abs(latest - earlier))} {latest > earlier ? 'worse' : 'better'} than the average of the five before it.
              </p>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
