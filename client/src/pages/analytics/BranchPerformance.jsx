import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Award, Building2, Download, Info, RefreshCw } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { compactMoney, trendOf } from '../../utils/analytics';
import { downloadText } from '../../utils/download';
import { Badge, Button, Card, EmptyState, ErrorState, Select, Skeleton, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';
import ChartCard from '../../components/dashboard/ChartCard';
import ChartTooltip, { chartAxis } from '../../components/dashboard/ChartTooltip';

/** What the comparison chart can show, and how to read it. */
const MEASURES = [
  { key: 'sales', label: 'Total sales', money: true },
  { key: 'netSales', label: 'Net sales', money: true },
  { key: 'profit', label: 'Gross profit', money: true },
  { key: 'purchases', label: 'Purchases', money: true },
  { key: 'stockValue', label: 'Inventory value', money: true },
  { key: 'invoices', label: 'Invoices', money: false },
  { key: 'average', label: 'Average invoice', money: true },
  { key: 'returnRate', label: 'Return rate', money: false, suffix: '%' },
];

const BAR = ['var(--primary)', 'var(--info)', 'var(--accent)', 'var(--purple)', 'var(--orange)', 'var(--success)'];

/**
 * Branch performance comparison.
 *
 * The point of this screen is that the comparison is fair: every store's figures are worked out by the same code from
 * the same definitions, and a store with no trade is still listed — "that branch sold nothing this month" is usually
 * the thing somebody came here to find out. Inventory value is marked as a position, because a store cannot have held
 * different stock "during" a date range.
 */
export default function BranchPerformance() {
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [measure, setMeasure] = useState('sales');
  const [sort, setSort] = useState({ by: 'sales', dir: 'desc' });
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );
  const query = useMemo(() => ({ ...periodQuery(period), sortBy: sort.by, sortDir: sort.dir }), [period, sort]);
  const { data, loading, error, reload } = useFetch('/analytics/branches', { ...query, k: refresh });

  const onSort = (by) => setSort((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportBranches(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} store${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const chosen = MEASURES.find((m) => m.key === measure) || MEASURES[0];
  const chartRows = (data?.rows || []).map((r) => ({ name: r.name, value: r[chosen.key] ?? 0 }));
  const anything = chartRows.some((r) => r.value > 0);

  const columns = [
    {
      key: 'name',
      header: 'Store',
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{r.name}</span>
            {r.isDefault && <Badge tone="neutral">Default</Badge>}
            {!r.known && <Badge tone="warning">Not on the list</Badge>}
          </div>
          {r.code && <div className="text-[11px] text-muted">{r.code}</div>}
        </div>
      ),
    },
    {
      key: 'sales',
      header: 'Total sales',
      sortable: true,
      align: 'right',
      render: (r) => {
        const trend = trendOf({ change: r.change.sales, key: 'sales' });
        return (
          <div className="text-right">
            <div className="font-semibold tabular-nums">{inr(r.sales)}</div>
            <div className={cx('text-[11px]', trend.tone === 'up' ? 'text-success' : trend.tone === 'down' ? 'text-danger' : 'text-muted')}>{trend.label}</div>
          </div>
        );
      },
    },
    { key: 'netSales', header: 'Net sales', sortable: true, align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums">{inr(r.netSales)}</span> },
    {
      key: 'returnRate',
      header: 'Return rate',
      sortable: true,
      align: 'right',
      hideBelow: 'lg',
      render: (r) => (
        <div className="text-right">
          <span className={cx('tabular-nums', r.returnRate >= 5 ? 'font-semibold text-danger' : 'text-muted')}>{r.returnRate}%</span>
          {r.returns > 0 && <div className="text-[11px] text-muted">{inr(r.returns)}</div>}
        </div>
      ),
    },
    {
      key: 'profit',
      header: 'Gross profit',
      sortable: true,
      align: 'right',
      render: (r) => (
        <div className="text-right">
          <div className="font-semibold tabular-nums">{inr(r.profit)}</div>
          <div className="text-[11px] text-muted">{r.margin === null ? 'no margin' : `${r.margin}% margin`}</div>
        </div>
      ),
    },
    { key: 'invoices', header: 'Invoices', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{r.invoices.toLocaleString('en-IN')}</span> },
    { key: 'average', header: 'Average invoice', sortable: true, align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums">{inr(r.average)}</span> },
    { key: 'purchases', header: 'Purchases', sortable: true, align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{inr(r.purchases)}</span> },
    {
      key: 'stock',
      header: 'Inventory value',
      sortable: true,
      align: 'right',
      render: (r) => (
        <div className="text-right">
          <div className="tabular-nums">{inr(r.stockValue)}</div>
          {r.expiredValue > 0 && <div className="text-[11px] text-danger">{inr(r.expiredValue)} expired</div>}
        </div>
      ),
    },
  ];

  const leader = (label, row, read) =>
    row ? (
      <div className="rounded-xl bg-subtle p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          <Award className="h-3.5 w-3.5" aria-hidden="true" /> {label}
        </p>
        <p className="mt-1 truncate text-sm font-bold">{row.name}</p>
        <p className="text-xs tabular-nums text-muted">{read(row)}</p>
      </div>
    ) : null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Branch Performance</h1>
          <p className="mt-1 text-sm text-muted">Every store you may report on, side by side, on the same figures.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            Overview
          </Link>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={!data?.rows?.length}>
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
          <section aria-label="Totals across stores" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {loading && !data
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)
              : [
                ['Stores compared', (data?.totals?.stores || 0).toLocaleString('en-IN'), null],
                ['Total sales', inr(data?.totals?.sales), `${(data?.totals?.invoices || 0).toLocaleString('en-IN')} invoices`],
                ['Gross profit', inr(data?.totals?.profit), data?.totals?.margin === null ? 'no margin yet' : `${data?.totals?.margin}% margin`],
                ['Inventory value', inr(data?.totals?.stockValue), 'at cost, as it stands now'],
              ].map(([label, value, hint]) => (
                <Card key={label} className="p-4">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</p>
                  <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</p>
                  {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
                </Card>
              ))}
          </section>

          <ChartCard
            title="Store comparison"
            subtitle="The same figure across every store"
            right={
              <Select aria-label="What to compare" className="w-44" value={measure} onChange={(e) => setMeasure(e.target.value)}>
                {MEASURES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </Select>
            }
          >
            {loading && !data ? (
              <Skeleton className="h-72 w-full" />
            ) : !anything ? (
              <EmptyState icon={Building2} title={`No ${chosen.label.toLowerCase()} to compare`} hint="Choose a different figure, or a longer period." />
            ) : (
              <div className="h-72" role="img" aria-label={`${chosen.label} by store: ${chartRows.map((r) => `${r.name} ${r.value}`).join(', ')}`}>
                <ResponsiveContainer>
                  <BarChart data={chartRows} margin={{ left: -4, right: 12, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--line)" />
                    <XAxis dataKey="name" {...chartAxis} interval={0} tickFormatter={(v) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : v)} />
                    <YAxis
                      {...chartAxis}
                      width={64}
                      tickFormatter={chosen.money ? compactMoney : (v) => `${Number(v).toLocaleString('en-IN')}${chosen.suffix || ''}`}
                      allowDecimals={false}
                    />
                    <Tooltip content={<ChartTooltip money={chosen.money} />} cursor={{ fill: 'var(--subtle)' }} />
                    <Bar dataKey="value" name={chosen.label} radius={[6, 6, 0, 0]} maxBarSize={64}>
                      {chartRows.map((r, i) => (
                        <Cell key={r.name} fill={BAR[i % BAR.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </ChartCard>

          {data?.leaders && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {leader('Most sales', data.leaders.sales, (r) => inr(r.sales))}
              {leader('Most profit', data.leaders.profit, (r) => inr(r.profit))}
              {leader('Best margin', data.leaders.margin, (r) => (r.margin === null ? '—' : `${r.margin}%`))}
              {leader('Highest average invoice', data.leaders.average, (r) => inr(r.average))}
            </div>
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-bold">Side by side</h2>
              <p className="text-xs text-muted">Sort by any column. A store with no trade is still listed.</p>
            </div>
            {data && !data.rows.length ? (
              <EmptyState icon={Building2} title="No stores to compare" hint="You may not be assigned to any store yet." />
            ) : (
              <DataTable columns={columns} rows={data?.rows || []} rowKey={(r) => r.id || 'none'} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1180} />
            )}
          </Card>

          <Card className="space-y-1.5 p-4 text-xs text-muted">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink">How these figures are arrived at</p>
            {[data?.notes?.definitions, data?.notes?.transfers, data?.notes?.stockHasNoPeriod, data?.notes?.scope].filter(Boolean).map((note) => (
              <p key={note} className="flex gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{note}</span>
              </p>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
