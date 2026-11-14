import { Inbox } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { inr } from '../../utils/format';
import { EmptyState, Skeleton, cx } from '../common/ui';
import ChartCard from '../dashboard/ChartCard';
import ChartTooltip from '../dashboard/ChartTooltip';

/**
 * One cut of a report's money: the rows in order, each with a bar for its share of the total. A bar is the honest
 * shape for this — it is a part of a known whole, and the longest bar is the answer to "where does the money come
 * from?" without the reader having to compare numbers.
 *
 * Rows arrive already summed, already ordered and already carrying their share, from the same aggregation as the
 * figures above them; nothing is recalculated here. `rows` is [{ id, label, amount, share, ...meta }].
 */
export function Breakdown({ title, subtitle, rows, loading, meta, emptyTitle = 'Nothing in this period', emptyHint, limit = 8, onSelect }) {
  const shown = (rows || []).slice(0, limit);

  return (
    <ChartCard title={title} subtitle={subtitle}>
      {loading && !rows ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : !shown.length ? (
        <EmptyState icon={Inbox} title={emptyTitle} hint={emptyHint} />
      ) : (
        <ul className="space-y-2.5">
          {shown.map((r, i) => {
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{r.label}</span>
                  <span className="shrink-0 tabular-nums font-semibold">{inr(r.amount)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{ width: `${Math.max(r.share || 0, r.amount ? 1.5 : 0)}%`, opacity: 1 - i * 0.08 }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-muted">
                    {r.share ?? 0}%{meta ? ` · ${meta(r)}` : ''}
                  </span>
                </div>
              </>
            );
            return (
              <li key={r.id ?? r.label}>
                {onSelect ? (
                  <button type="button" onClick={() => onSelect(r)} className="w-full rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-subtle">
                    {body}
                  </button>
                ) : (
                  <div className="px-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ChartCard>
  );
}

const SLICE = ['var(--primary)', 'var(--info)', 'var(--accent)', 'var(--purple)', 'var(--orange)', 'var(--muted)'];

/**
 * The same cut as a donut, for the few cases where the reader is asking how the whole divides rather than which row
 * is biggest — payment methods, where there are four of them and the mix itself is the point.
 */
export function DonutBreakdown({ title, subtitle, rows, loading, emptyTitle = 'Nothing in this period' }) {
  const data = (rows || []).filter((r) => r.amount > 0);
  const total = data.reduce((n, r) => n + r.amount, 0);

  return (
    <ChartCard title={title} subtitle={subtitle}>
      {loading && !rows ? (
        <Skeleton className="h-60 w-full" />
      ) : !data.length ? (
        <EmptyState icon={Inbox} title={emptyTitle} />
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="h-48 w-48 shrink-0" role="img" aria-label={`${title}: ${data.map((r) => `${r.label} ${r.share}%`).join(', ')}`}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data} dataKey="amount" nameKey="label" innerRadius={48} outerRadius={76} paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
                  {data.map((r, i) => (
                    <Cell key={r.id ?? r.label} fill={SLICE[i % SLICE.length]} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="min-w-[12rem] flex-1 space-y-2">
            {data.map((r, i) => (
              <li key={r.id ?? r.label} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full')} style={{ background: SLICE[i % SLICE.length] }} aria-hidden="true" />
                  <span className="truncate">{r.label}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-semibold">{inr(r.amount)}</span>
                  <span className="ml-2 text-[11px] text-muted">{r.share}%</span>
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 border-t border-line pt-2 text-sm font-bold">
              <span>Total</span>
              <span className="tabular-nums">{inr(total)}</span>
            </li>
          </ul>
        </div>
      )}
    </ChartCard>
  );
}
