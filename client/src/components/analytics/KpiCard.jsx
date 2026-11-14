import { useState } from 'react';
import { Info, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { inr } from '../../utils/format';
import { trendOf } from '../../utils/analytics';
import { Card, Skeleton, cx } from '../common/ui';

const TONE = {
  up: 'text-success',
  down: 'text-danger',
  neutral: 'text-muted',
};

/**
 * One headline figure: what it is now, how it compares with the period before, and — behind the little i — exactly how
 * it is worked out. The definition matters as much as the number: "sales" and "profit" are not the same thing and a
 * card that does not say which it means is worse than no card.
 */
export default function KpiCard({ kpi, icon: Icon, loading }) {
  const [open, setOpen] = useState(false);
  if (loading || !kpi) return <Skeleton className="h-28 w-full rounded-2xl" />;

  /**
   * A figure with no comparison is not a figure that "did not change": a stock balance has no previous period at all.
   * The card says which it is rather than printing a misleading zero.
   */
  const standing = !kpi.change;
  const trend = standing ? { label: 'As it stands now', tone: 'neutral', direction: 'flat' } : trendOf(kpi);
  const Arrow = trend.direction === 'up' ? TrendingUp : trend.direction === 'down' ? TrendingDown : Minus;
  const show = (n) => (kpi.format === 'number' ? Number(n || 0).toLocaleString('en-IN') : kpi.format === 'percent' ? `${Number(n || 0)}%` : inr(n));
  const value = show(kpi.value);
  const previous = kpi.previous === null || kpi.previous === undefined ? null : show(kpi.previous);

  return (
    <Card className="relative p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold uppercase tracking-wide text-muted">{kpi.label}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</p>
        </div>
        <div className="flex items-start gap-1">
          {Icon && (
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sage text-sage-ink" aria-hidden="true">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <button
            type="button"
            aria-label={`How ${kpi.label} is worked out`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted hover:bg-subtle hover:text-ink"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <p className={cx('mt-2 flex items-center gap-1 text-xs font-semibold', TONE[trend.tone])}>
        <Arrow className="h-3.5 w-3.5" aria-hidden="true" />
        {trend.label}
        {previous !== null && <span className="font-normal text-muted">· was {previous}</span>}
      </p>

      {open && (
        <p role="note" className="mt-2 rounded-lg bg-subtle p-2 text-xs text-muted">
          {kpi.description}
        </p>
      )}
    </Card>
  );
}
