import { AlertOctagon, CalendarClock, CircleAlert, Clock, IndianRupee, TrendingDown, Undo2 } from 'lucide-react';
import { Card, Skeleton, cx } from '../../common/ui';
import { compactMoney } from '../../../utils/analytics';

/**
 * The figures above the register.
 *
 * Every card is a filter you can click: the number and the list under it are the same question asked two ways, so a
 * card that says "9 critical" and a table that shows seven would be a bug the user can see. The buckets NEST — under
 * 30 days includes everything under 15 — because that is how a person reads them, and clicking through keeps that
 * meaning rather than quietly switching to an exclusive band.
 */

const CARD_ICON = { expired: AlertOctagon, under15: CircleAlert, under30: Clock, under90: CalendarClock };
const CARD_TONE = {
  expired: 'bg-danger/10 text-danger',
  under15: 'bg-danger/10 text-danger',
  under30: 'bg-orange/10 text-orange',
  under90: 'bg-warning/10 text-warning',
};

function Tile({ active, onClick, children, label, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cx(
        'group relative overflow-hidden rounded-2xl border bg-card p-4 text-left transition-all hover:shadow-pop focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]',
        active ? 'border-primary ring-1 ring-[var(--primary)]' : 'border-line',
      )}
    >
      {children}
    </button>
  );
}

export default function ExpiryKpis({ summary, loading, activeStatus, onPick }) {
  if (loading && !summary) {
    return (
      <section aria-label="Expiry figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </section>
    );
  }
  if (!summary) return null;

  const { cards, valueAtRisk, recoverable, projectedLoss } = summary;

  return (
    <section aria-label="Expiry figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
      {cards.map((c) => {
        const Icon = CARD_ICON[c.key];
        const active = activeStatus === c.filter;
        return (
          <Tile
            key={c.key}
            active={active}
            title={c.description}
            onClick={() => onPick(active ? 'all' : c.filter)}
            label={`${c.label}: ${c.batches} lots. ${c.description} ${active ? 'Showing these. Click to clear.' : 'Click to filter the register to these.'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-3xl font-bold tabular-nums tracking-tight">{c.batches.toLocaleString('en-IN')}</p>
                <p className="mt-0.5 text-[11px] font-bold uppercase leading-tight tracking-wide text-muted">{c.label}</p>
              </div>
              {Icon && (
                <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl', CARD_TONE[c.key])} aria-hidden="true">
                  <Icon className="h-4 w-4" />
                </span>
              )}
            </div>
            <p className="mt-2 text-sm font-semibold tabular-nums">{compactMoney(c.costValue)}</p>
            <p className="text-[11px] text-muted">at cost · {c.quantity.toLocaleString('en-IN')} units</p>
          </Tile>
        );
      })}

      {/* Value at risk, at both the price it cost and the price it would have fetched. Two numbers, because
          "how much am I out of pocket" and "how much revenue walks away" are different questions. */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-3xl font-bold tabular-nums tracking-tight">{compactMoney(valueAtRisk.cost)}</p>
            <p className="mt-0.5 text-[11px] font-bold uppercase leading-tight tracking-wide text-muted">Value at risk</p>
          </div>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sage text-sage-ink" aria-hidden="true">
            <IndianRupee className="h-4 w-4" />
          </span>
        </div>
        <p className="mt-2 text-sm font-semibold tabular-nums">{compactMoney(valueAtRisk.mrp)}</p>
        <p className="text-[11px] text-muted">at MRP · {valueAtRisk.batches} lots</p>
      </Card>

      {/* What a supplier might still take back — and, beside it, what cannot be recovered because no supplier
          was ever recorded. That second figure is uncomfortable and therefore worth showing. */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-3xl font-bold tabular-nums tracking-tight text-success">{compactMoney(recoverable.value)}</p>
            <p className="mt-0.5 text-[11px] font-bold uppercase leading-tight tracking-wide text-muted">Recoverable</p>
          </div>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-success/10 text-success" aria-hidden="true">
            <Undo2 className="h-4 w-4" />
          </span>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          {recoverable.batches} lots, within ±{recoverable.windowDays}d of expiry
        </p>
        {recoverable.noSupplier.batches > 0 && (
          <p className="mt-1 text-[11px] font-semibold text-muted" title={recoverable.noSupplier.description}>
            {compactMoney(recoverable.noSupplier.value)} has no supplier on record
          </p>
        )}
      </Card>

      {/* The number this whole screen exists to produce. */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-3xl font-bold tabular-nums tracking-tight text-danger">{compactMoney(projectedLoss.value)}</p>
            <p className="mt-0.5 text-[11px] font-bold uppercase leading-tight tracking-wide text-muted">Projected loss</p>
          </div>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger" aria-hidden="true">
            <TrendingDown className="h-4 w-4" />
          </span>
        </div>
        <p className="mt-2 text-[11px] text-muted" title={projectedLoss.description}>
          {Math.round(projectedLoss.quantity).toLocaleString('en-IN')} units unlikely to sell in time
        </p>
        <p className="text-[11px] text-muted">from {projectedLoss.velocityWindowDays}d of sales</p>
      </Card>
    </section>
  );
}
