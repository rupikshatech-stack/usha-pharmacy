import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, ArrowUpRight, Banknote, CreditCard, FileText, Package, PiggyBank, Receipt, RefreshCw, RotateCcw, TrendingUp, Undo2 } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { MIX_DESTINATIONS, mixAccessibleName } from '../../utils/analytics';
import { Button, Card, EmptyState, ErrorState, Skeleton, cx } from '../../components/common/ui';
import KpiCard from '../../components/analytics/KpiCard';
import RevenueChart from '../../components/analytics/RevenueChart';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import BusinessInsights from '../../components/analytics/BusinessInsights';

const ICONS = {
  totalSales: Banknote,
  totalPurchases: Package,
  grossProfit: PiggyBank,
  netSales: Receipt,
  transactions: FileText,
  averageInvoice: CreditCard,
  receivables: ArrowLeftRight,
  salesReturns: Undo2,
};

const MIX_BAR = { sales: 'bg-primary', purchases: 'bg-info', salesReturns: 'bg-warning', purchaseReturns: 'bg-orange' };

/**
 * Business Analytics. Every figure on this page is aggregated by the server from the records the rest of the system
 * keeps — invoices, orders, returns, batches — so nothing here can disagree with the ledger. The filters are part of
 * the question, not decoration: changing a date or a store asks the server again.
 */
export default function Analytics() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [refresh, setRefresh] = useState(0);

  const branches = useFetch('/branches');
  const stores = (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive');
  const { data, loading, error, reload } = useFetch('/analytics/overview', { ...periodQuery(period), k: refresh });
  // The insights are a second, independent question: if a rule cannot be worked out, the figures above still stand.
  const insights = useFetch('/analytics/insights', { ...periodQuery(period), k: refresh });

  const mix = data?.transactionMix || [];
  const biggest = Math.max(1, ...mix.map((m) => Math.abs(m.amount)));
  /**
   * The Transaction Report, asking exactly the question this page is asking — the same period and the same store, so
   * clicking through never quietly changes what is being looked at.
   */
  const periodParams = (extra = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    p.set('range', period.range);
    if (period.from) p.set('from', period.from);
    if (period.to) p.set('to', period.to);
    if (period.branchId) p.set('branchId', period.branchId);
    return p.toString();
  };
  const reportLink = (type) => `/analytics/transactions?${periodParams({ type })}`;
  /**
   * Where a slice of the breakdown leads: sales and purchases each have a report of their own, which says far more
   * about them than a list of documents can; the two kinds of return lead to that list, filtered to them.
   */
  const mixLink = (key) => {
    const dest = MIX_DESTINATIONS[key] || MIX_DESTINATIONS.salesReturns;
    return `${dest.path}?${periodParams(dest.type ? { type: dest.type } : {})}`;
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Business Analytics</h1>
          <p className="mt-1 text-sm text-muted">Monitor business performance, inventory health, and financial activity.</p>
        </div>
        <div className="flex items-center gap-2">
          {[
            ['Sales report', `/analytics/sales?${periodParams()}`, Receipt],
            ['Purchase report', `/analytics/purchases?${periodParams()}`, Package],
            ['Transactions', reportLink(), FileText],
          ].map(([label, to, Icon]) => (
            <Link
              key={to}
              to={to}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
            >
              <Icon className="h-4 w-4" aria-hidden="true" /> {label}
            </Link>
          ))}
          <Button variant="secondary" onClick={() => { setRefresh((n) => n + 1); reload(); }} loading={loading && Boolean(data)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </header>

      <Card className="p-3 sm:p-4">
        <PeriodFilters value={period} onChange={setPeriod} stores={stores} storesLoading={branches.loading}>
          {data?.period && (
            <p className="pb-2 text-xs text-muted">
              Compared with the {data.period.days} days before · times in {data.period.timezone}
            </p>
          )}
        </PeriodFilters>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 8 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <BusinessInsights data={insights.data} loading={insights.loading} error={insights.error} />

          <RevenueChart series={data?.series} period={data?.period} loading={loading} error={null} onRetry={reload} />

          <Card className="p-5" aria-label="Transaction breakdown">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-bold">Transaction breakdown</h2>
                <p className="text-xs text-muted">What happened in this period, and what it came to. Choose one to see every document behind it.</p>
              </div>
              {data?.notes?.grossMargin !== undefined && data?.notes?.grossMargin !== null && (
                <span className="rounded-full bg-sage px-3 py-1 text-xs font-bold text-sage-ink">Gross margin {data.notes.grossMargin}%</span>
              )}
            </div>
            {loading && !data ? (
              <Skeleton className="h-40 w-full" />
            ) : mix.every((m) => !m.count) ? (
              <EmptyState icon={TrendingUp} title="Nothing happened in this period" hint="Choose a longer period, or a different store." />
            ) : (
              <ul className="space-y-1">
                {mix.map((m) => (
                  <li key={m.key}>
                    <Link
                      to={mixLink(m.key)}
                      className="group block rounded-xl px-2 py-2 transition-colors hover:bg-subtle"
                      aria-label={mixAccessibleName(m, inr(m.amount))}
                    >
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="flex items-center gap-1.5 font-semibold">
                          {m.label}
                          <ArrowUpRight className="h-3.5 w-3.5 text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                        </span>
                        <span className="tabular-nums">
                          <span className="text-muted">{m.count.toLocaleString('en-IN')} · </span>
                          {inr(m.amount)}
                          {m.share > 0 && <span className="ml-2 text-xs text-muted">{m.share}%</span>}
                        </span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-subtle group-hover:bg-card">
                        <div className={cx('h-full rounded-full', MIX_BAR[m.key] || 'bg-warning')} style={{ width: `${Math.round((Math.abs(m.amount) / biggest) * 100)}%` }} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {data?.notes?.netProfitReason && (
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-subtle p-3 text-xs text-muted">
                <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-semibold">Net profit is not shown.</span> {data.notes.netProfitReason}
                </span>
              </p>
            )}
          </Card>

          {data?.totals?.current && (
            <Card className="p-5" aria-label="How these figures are worked out">
              <h2 className="text-[15px] font-bold">How these figures are worked out</h2>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                {[
                  ['Gross sales', `${inr(data.totals.current.grossSales)} — completed invoices, GST included`],
                  ['Less returns', `${inr(data.totals.current.salesReturns)} — goods customers brought back`],
                  ['Net sales', `${inr(data.totals.current.netSales)}`],
                  ['Cost of goods sold', `${inr(data.totals.current.cogs)} — ${data.totals.current.unitsSold.toLocaleString('en-IN')} units at what their batch cost`],
                  ['Gross profit', `${inr(data.totals.current.grossProfit)} — net sales less cost`],
                  ['GST inside sales', `${inr(data.totals.current.tax)} — reconciled in the GST report`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3 border-b border-line py-1">
                    <dt className="text-muted">{label}</dt>
                    <dd className="text-right font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-[11px] text-muted">Sales are tax-inclusive and batch costs are not, so gross profit is a trading margin. Stock moved between stores is never a sale or a purchase.</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
