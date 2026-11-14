import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton, cx } from '../../common/ui';
import { inr } from '../../../utils/format';
import { compactMoney } from '../../../utils/analytics';

/**
 * A month of expiries as a heatmap.
 *
 * The register answers "what do I deal with first". This answers the question that comes next when planning rather
 * than reacting: WHEN does the wave hit. Four hundred dates in a list is noise; a month you can point at and say
 * "the twenty-third is going to hurt" is a plan — for a clearance push, or for timing a collection with a distributor.
 *
 * The colour is value at cost, not risk, because that is what you are planning around. The small dot carries the
 * worst risk sitting on that day, so a quiet-looking day holding one critical lot still announces itself.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const shiftMonth = (key, by) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Five steps of intensity. A day with nothing on it stays blank — an empty day is information too. */
function heat(value, busiest) {
  if (!value) return 'bg-transparent';
  const share = busiest > 0 ? value / busiest : 0;
  if (share > 0.75) return 'bg-primary/80 text-white';
  if (share > 0.5) return 'bg-primary/55 text-white';
  if (share > 0.25) return 'bg-primary/35';
  if (share > 0.1) return 'bg-primary/20';
  return 'bg-primary/10';
}

const RISK_DOT = { critical: 'bg-danger', high: 'bg-orange', medium: 'bg-warning', low: 'bg-info', safe: 'bg-success' };

export default function ExpiryCalendar({ data, loading, onMonth, onPickDay }) {
  if (loading && !data) return <Skeleton className="h-[30rem] w-full rounded-2xl" />;
  if (!data) return null;

  const busiest = Math.max(0, ...data.days.map((d) => d.costValue));
  const today = new Date().toISOString().slice(0, 10);
  // Which way the arrows can go: only to months that actually hold something, so nobody walks through empty years.
  const withStock = data.monthsWithStock || [];
  const prev = [...withStock].filter((m) => m < data.month).pop() || shiftMonth(data.month, -1);
  const next = withStock.find((m) => m > data.month) || shiftMonth(data.month, 1);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[15px] font-bold">{monthLabel(data.month)}</h2>
          <p className="text-xs text-muted">
            {data.totals.batches === 0
              ? 'Nothing expires this month.'
              : `${data.totals.batches} lot${data.totals.batches === 1 ? '' : 's'} · ${inr(data.totals.costValue)} at cost${data.totals.projectedLoss > 0 ? ` · ${inr(data.totals.projectedLoss)} projected loss` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => onMonth(prev)} aria-label="Previous month with stock">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onMonth(new Date().toISOString().slice(0, 7))}>
            This month
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onMonth(next)} aria-label="Next month with stock">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {data.totals.batches === 0 && withStock.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing to plan around" hint="No lot in this view has an expiry date, or the filters have excluded everything." />
      ) : (
        <div className="p-4">
          <div className="grid grid-cols-7 gap-1.5" role="grid" aria-label={`Expiries in ${monthLabel(data.month)}`}>
            {WEEKDAYS.map((d) => (
              <div key={d} className="pb-1 text-center text-[11px] font-bold uppercase tracking-wide text-muted" role="columnheader">
                {d}
              </div>
            ))}
            {/* The blanks before the first of the month, so the grid lines up with a real calendar. */}
            {Array.from({ length: data.startWeekday }, (_, i) => (
              <div key={`pad-${i}`} aria-hidden="true" />
            ))}
            {data.days.map((d) => {
              const day = Number(d.date.slice(8));
              const isToday = d.date === today;
              const empty = d.batches === 0;
              return (
                <button
                  key={d.date}
                  type="button"
                  role="gridcell"
                  disabled={empty}
                  onClick={() => !empty && onPickDay?.(d)}
                  title={empty ? `${d.date}: nothing expires` : `${d.date}: ${d.batches} lot${d.batches === 1 ? '' : 's'}, ${inr(d.costValue)} at cost${d.projectedLoss ? `, ${inr(d.projectedLoss)} projected loss` : ''}`}
                  aria-label={empty ? `${d.date}, nothing expires` : `${d.date}, ${d.batches} lots, ${inr(d.costValue)} at cost. Show these in the table.`}
                  className={cx(
                    'relative flex min-h-[4.5rem] flex-col rounded-lg border p-1.5 text-left transition-all',
                    heat(d.costValue, busiest),
                    empty ? 'cursor-default border-line/60 opacity-60' : 'cursor-pointer border-line hover:ring-2 hover:ring-[var(--primary)]',
                    isToday && 'ring-2 ring-[var(--accent)]',
                  )}
                >
                  <span className={cx('text-[11px] font-bold tabular-nums', isToday && 'text-accent')}>{day}</span>
                  {!empty && (
                    <>
                      <span className="mt-auto text-[12px] font-bold tabular-nums leading-tight">{compactMoney(d.costValue)}</span>
                      <span className="flex items-center gap-1 text-[10px] leading-tight opacity-80">
                        {d.worstRisk && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', RISK_DOT[d.worstRisk])} aria-hidden="true" />}
                        {d.batches} lot{d.batches === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              Less
              <span className="h-3 w-3 rounded-sm bg-primary/10" />
              <span className="h-3 w-3 rounded-sm bg-primary/20" />
              <span className="h-3 w-3 rounded-sm bg-primary/35" />
              <span className="h-3 w-3 rounded-sm bg-primary/55" />
              <span className="h-3 w-3 rounded-sm bg-primary/80" />
              More value expiring
            </span>
            {data.busiest && (
              <span>
                Worst day: <strong className="text-ink">{new Date(`${data.busiest.date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</strong> ·{' '}
                {inr(data.busiest.costValue)} across {data.busiest.batches} lot{data.busiest.batches === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
