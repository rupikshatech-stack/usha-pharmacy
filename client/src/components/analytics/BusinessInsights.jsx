import { Link } from 'react-router-dom';
import { ArrowUpRight, CircleAlert, Info, Lightbulb, OctagonAlert, Sparkles, TrendingUp, TriangleAlert } from 'lucide-react';
import { inr } from '../../utils/format';
import { Card, EmptyState, Skeleton, cx } from '../common/ui';

/**
 * How each kind of insight is dressed. The order is the server's — most serious first — and the colour only ever
 * repeats what the severity already says, so the panel is readable without relying on colour alone.
 */
const TONE = {
  critical: { icon: OctagonAlert, ring: 'border-danger/40 bg-danger/5', chip: 'bg-danger/15 text-danger', label: 'Needs attention' },
  warning: { icon: TriangleAlert, ring: 'border-warning/40 bg-warning/5', chip: 'bg-warning/15 text-warning', label: 'Worth a look' },
  opportunity: { icon: Lightbulb, ring: 'border-accent/40 bg-accent/5', chip: 'bg-accent/15 text-accent', label: 'Opportunity' },
  positive: { icon: TrendingUp, ring: 'border-success/40 bg-success/5', chip: 'bg-success/15 text-success', label: 'Going well' },
  info: { icon: Info, ring: 'border-line bg-subtle/40', chip: 'bg-subtle text-muted', label: 'For information' },
};

/** A figure as the insight itself described it — the server says whether it is money, a count or a percentage. */
const show = (metric) => {
  if (!metric) return null;
  if (metric.format === 'money') return inr(metric.value);
  if (metric.format === 'percent') return `${metric.value > 0 ? '+' : ''}${metric.value}%`;
  if (metric.format === 'number') return Number(metric.value || 0).toLocaleString('en-IN');
  return String(metric.value);
};

/**
 * Business Insights: what this period's figures say, in sentences.
 *
 * Everything here is computed by the server as a rule over the same figures the reports show, so each card links to
 * the report that proves it — a statement nobody can check is worse than no statement. Nothing claims a cause, and
 * when nothing crosses a threshold the panel says so plainly rather than inventing filler: for a quiet week, "there
 * is nothing unusual" is the useful answer.
 */
export default function BusinessInsights({ data, loading, error }) {
  const insights = data?.insights || [];

  return (
    <Card className="p-5" aria-label="Business insights">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-bold">
            <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" /> Business insights
          </h2>
          <p className="text-xs text-muted">What this period&apos;s figures say. Every one links to the report behind it.</p>
        </div>
        {data?.counts?.total > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(data.counts.bySeverity)
              .filter(([, n]) => n > 0)
              .map(([severity, n]) => (
                <span key={severity} className={cx('rounded-full px-2.5 py-1 text-[11px] font-bold', TONE[severity]?.chip)}>
                  {n} {TONE[severity]?.label.toLowerCase()}
                </span>
              ))}
          </div>
        )}
      </div>

      {error ? (
        <p className="rounded-xl bg-subtle p-3 text-sm text-muted">Insights could not be worked out just now. The figures above are unaffected.</p>
      ) : loading && !data ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      ) : !insights.length ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing unusual in this period"
          hint={
            data?.examined?.invoices
              ? `${data.examined.invoices.toLocaleString('en-IN')} invoices and ${(data.examined.batchesOnHand || 0).toLocaleString('en-IN')} batches were examined. Nothing crossed a threshold worth reporting.`
              : 'There has been no trade in this period to say anything about yet.'
          }
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {insights.map((i) => {
            const tone = TONE[i.severity] || TONE.info;
            const Icon = tone.icon;
            return (
              <li key={i.key} className={cx('rounded-2xl border p-4 transition-shadow hover:shadow-sm', tone.ring)}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className={cx('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', tone.chip)} aria-hidden="true">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold leading-snug">{i.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">{i.detail}</p>
                    </div>
                  </div>
                  {i.metric && (
                    <div className="shrink-0 text-right">
                      <p className="text-base font-bold tabular-nums leading-tight">{show(i.metric)}</p>
                      <p className="text-[10px] uppercase tracking-wide text-muted">{i.metric.label}</p>
                    </div>
                  )}
                </div>

                {(i.evidence || i.link) && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2.5">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
                      {Object.values(i.evidence || {})
                        .filter(Boolean)
                        .map((e) => (
                          <span key={e.label}>
                            {e.label}: <span className="font-semibold text-ink">{show(e)}</span>
                          </span>
                        ))}
                    </div>
                    {i.link && (
                      <Link to={i.link} className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-primary hover:underline">
                        {i.linkLabel || 'Open the report'}
                        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data?.notes && (
        <p className="mt-4 flex gap-2 text-[11px] text-muted">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {data.notes.method} {data.notes.causation}
          </span>
        </p>
      )}
    </Card>
  );
}
