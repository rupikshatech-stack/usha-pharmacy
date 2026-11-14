import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Boxes, Download, Info, Package, Percent, PiggyBank, Receipt, RefreshCw, TrendingDown, TrendingUp, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { Button, Card, EmptyState, ErrorState, Skeleton, cx } from '../../components/common/ui';
import KpiCard from '../../components/analytics/KpiCard';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ReportTrendChart from '../../components/analytics/ReportTrendChart';
import { Breakdown } from '../../components/analytics/Breakdown';

const ICONS = {
  grossSales: Banknote,
  salesReturns: Undo2,
  netSales: Receipt,
  cogs: Package,
  grossProfit: PiggyBank,
  grossMargin: Percent,
  discounts: Percent,
  unitsSold: Boxes,
};

/**
 * The Profitability report: what the business MADE, not what it took in.
 *
 * The statement is the centre of this page on purpose. A single "profit" number invites the reader to trust it; a
 * statement that works down from gross sales to gross profit shows exactly where the money went, and shows plainly
 * that net profit is missing because the expenses it needs are not recorded anywhere in this system. Guessing it by
 * subtracting purchases from sales would be worse than leaving it out: stock bought and not yet sold is an asset.
 */
export default function Profitability() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );
  const query = useMemo(() => periodQuery(period), [period]);
  const { data, loading, error, reload } = useFetch('/analytics/profitability', { ...query, k: refresh });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportProfitability(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} medicine${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const marginRow = (r) => `${r.margin === null ? '—' : `${r.margin}%`} · ${r.units.toLocaleString('en-IN')} units`;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Profitability</h1>
          <p className="mt-1 text-sm text-muted">What the business made on what it sold, and where the margin comes from.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            Overview
          </Link>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={!data?.medicineCount}>
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setRefresh((n) => n + 1);
              reload();
            }}
            loading={loading && Boolean(data)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </header>

      <Card className="p-3 sm:p-4">
        <PeriodFilters value={period} onChange={setPeriod} stores={stores} storesLoading={branches.loading}>
          {data?.period && <p className="pb-2 text-xs text-muted">Compared with the {data.period.days} days before · times in {data.period.timezone}</p>}
        </PeriodFilters>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <section aria-label="Profit figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(data?.kpis || Array.from({ length: 8 })).map((k, i) => (
              <KpiCard key={k?.key || i} kpi={k} icon={k ? ICONS[k.key] : undefined} loading={!k} />
            ))}
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <Card className="p-5" aria-label="Trading statement">
              <div className="mb-4">
                <h2 className="text-[15px] font-bold">Trading statement</h2>
                <p className="text-xs text-muted">How gross sales become gross profit, in order.</p>
              </div>
              {loading && !data ? (
                <div className="space-y-3">
                  {Array.from({ length: 7 }, (_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (
                <>
                  <dl className="divide-y divide-line">
                    {(data?.statement || []).map((line) => (
                      <div
                        key={line.key}
                        className={cx(
                          'flex items-baseline justify-between gap-3 py-2.5 text-sm',
                          line.kind === 'total' && 'font-bold',
                          line.kind === 'unavailable' && 'text-muted',
                        )}
                      >
                        <dt className="flex items-center gap-2">
                          {line.label}
                          {line.note && <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{line.note}</span>}
                        </dt>
                        <dd className="shrink-0 tabular-nums">
                          {line.value === null ? (
                            <span className="text-xs font-semibold uppercase tracking-wide">Not available</span>
                          ) : (
                            <>
                              {inr(line.value)}
                              {line.margin !== undefined && <span className="ml-2 text-xs font-semibold text-success">{line.margin}%</span>}
                            </>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-4 space-y-2 rounded-xl bg-subtle p-3 text-xs text-muted">
                    {[data?.notes?.netProfitReason, data?.notes?.costMethod, data?.notes?.taxBasis, data?.notes?.lineLevel, data?.notes?.unknownCost]
                      .filter(Boolean)
                      .map((note) => (
                        <p key={note} className="flex gap-2">
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{note}</span>
                        </p>
                      ))}
                  </div>
                </>
              )}
            </Card>

            <ReportTrendChart
              title="Gross profit trend"
              subtitle="Profit over the period"
              series={data?.charts?.trend}
              period={data?.period}
              loading={loading}
              onRetry={reload}
              metrics={[
                { key: 'grossProfit', label: 'Gross profit', colour: 'var(--primary)' },
                { key: 'netSales', label: 'Net sales', colour: 'var(--info)' },
                { key: 'cogs', label: 'Cost of goods', colour: 'var(--orange)' },
              ]}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown
              title="Profit by store"
              subtitle="Net sales less what those units cost, per store"
              rows={(data?.charts?.byBranch || []).map((r) => ({ ...r, amount: r.profit, share: 0 }))}
              loading={loading}
              meta={(r) => (r.margin === null ? 'no margin' : `${r.margin}% margin`)}
              emptyTitle="Nothing was sold in this period"
            />
            <Breakdown
              title="Profit by category"
              subtitle="From invoice lines, so it adds up bar rounding"
              rows={(data?.charts?.byCategory || []).map((r) => ({ ...r, amount: r.profit, share: 0 }))}
              loading={loading}
              meta={(r) => (r.margin === null ? 'no margin' : `${r.margin}% margin`)}
            />
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />
                <div>
                  <h2 className="text-[15px] font-bold">Highest-margin medicines</h2>
                  <p className="text-xs text-muted">Only medicines whose batch cost is recorded can be ranked.</p>
                </div>
              </div>
              <MarginList rows={data?.charts?.topMargin} loading={loading} meta={marginRow} />
            </Card>
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-danger" aria-hidden="true" />
                <div>
                  <h2 className="text-[15px] font-bold">Lowest-margin medicines</h2>
                  <p className="text-xs text-muted">Worth a look at the buying price, or the selling one.</p>
                </div>
              </div>
              <MarginList rows={data?.charts?.lowMargin} loading={loading} meta={marginRow} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** A short ranked list of medicines with their margin — the same shape for the best and the worst. */
function MarginList({ rows, loading, meta }) {
  if (loading && !rows) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <EmptyState icon={Percent} title="No margin to rank yet" hint="A medicine needs a recorded batch cost and a sale in this period." />;
  return (
    <ol className="space-y-2">
      {rows.map((r, i) => (
        <li key={r.id} className="flex items-baseline justify-between gap-3 text-sm">
          <span className="flex min-w-0 gap-2">
            <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted">{i + 1}</span>
            <span className="truncate font-medium">{r.label}</span>
          </span>
          <span className="shrink-0 text-right tabular-nums">
            <span className="font-semibold">{inr(r.profit)}</span>
            <span className="ml-2 text-[11px] text-muted">{meta(r)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
