import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Info, Printer, Receipt, RefreshCw, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { analyticsService } from '../../services/analyticsService';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, inr } from '../../utils/format';
import { downloadText } from '../../utils/download';
import { printGstReport } from '../../utils/printGst';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Select, Skeleton, cx } from '../../components/common/ui';
import { DataTable } from '../../components/common/DataTable';
import PeriodFilters, { initialPeriod, periodQuery } from '../../components/analytics/PeriodFilters';

/**
 * The GST report.
 *
 * Every figure here was recorded on a document when it was made — the per-line tax snapshots on invoices, the GST on
 * order lines — so this screen adds up rather than recalculates. Two figures cannot be read off anything, because the
 * documents never stored them: the tax inside a sales return and the tax inside a reversed delivery. Those are worked
 * out from the rate on the original line, and the screen marks them as derived rather than letting them pass as
 * recorded.
 *
 * The disclaimer is at the top, not in a footnote: the one thing this report must never be mistaken for is a return.
 */
export default function GstReport() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(() => initialPeriod('thisMonth'));
  const [rate, setRate] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ by: 'date', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const q = useDebounced(search);

  const branches = useFetch('/branches');
  const stores = useMemo(
    () => (Array.isArray(branches.data) ? branches.data : branches.data?.items || []).filter((b) => b.status !== 'inactive'),
    [branches.data],
  );

  const query = useMemo(
    () => ({ ...periodQuery(period), rate: rate || undefined, search: q || undefined, sortBy: sort.by, sortDir: sort.dir }),
    [period, rate, q, sort],
  );
  const { data, loading, error, reload } = useFetch('/analytics/gst', { ...query, page, limit, k: refresh });
  const s = data?.summary;
  const storeName = stores.find((b) => b._id === period.branchId)?.name || 'All stores';

  const narrow = (set) => (value) => {
    set(value);
    setPage(1);
  };
  const onSort = (by) => narrow(setSort)((st) => (st.by === by ? { by, dir: st.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: 'desc' }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await analyticsService.exportGst(query);
      downloadText(file.fileName, file.csv);
      toast.success(`Exported ${file.rows.toLocaleString('en-IN')} invoice${file.rows === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const print = () => {
    if (!data) return;
    const opened = printGstReport({ data, org: data.organization, user, storeName });
    if (!opened) toast.error('Your browser blocked the print window. Allow pop-ups for this site and try again.');
  };

  const columns = [
    { key: 'invoiceNo', header: 'Invoice', sortable: true, render: (r) => <span className="font-mono text-[13px] font-semibold">{r.invoiceNo}</span> },
    { key: 'date', header: 'Date', sortable: true, render: (r) => <span className="whitespace-nowrap text-muted">{dateFmt(r.date)}</span> },
    {
      key: 'customer',
      header: 'Customer',
      render: (r) => (
        <div className="min-w-0 max-w-[14rem]">
          <div className="truncate font-medium">{r.customerName}</div>
          {r.customerGstin && <div className="truncate font-mono text-[11px] text-muted">{r.customerGstin}</div>}
        </div>
      ),
    },
    { key: 'branch', header: 'Store', hideBelow: 'lg', render: (r) => <span className="text-muted">{r.branchName || '—'}</span> },
    {
      key: 'supply',
      header: 'Supply',
      hideBelow: 'md',
      render: (r) => <Badge tone={r.interState ? 'info' : 'neutral'}>{r.interState ? 'Inter-state' : 'Intra-state'}</Badge>,
    },
    { key: 'rates', header: 'Rates', hideBelow: 'lg', render: (r) => <span className="text-muted">{(r.rates || []).map((x) => `${x}%`).join(', ') || '—'}</span> },
    { key: 'taxable', header: 'Taxable', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{inr(r.taxable)}</span> },
    { key: 'cgst', header: 'CGST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{r.cgst ? inr(r.cgst) : '—'}</span> },
    { key: 'sgst', header: 'SGST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{r.sgst ? inr(r.sgst) : '—'}</span> },
    { key: 'igst', header: 'IGST', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{r.igst ? inr(r.igst) : '—'}</span> },
    { key: 'tax', header: 'Total tax', sortable: true, align: 'right', render: (r) => <span className="font-semibold tabular-nums">{inr(r.tax)}</span> },
    { key: 'total', header: 'Invoice total', sortable: true, align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums">{inr(r.total)}</span> },
  ];

  const notes = [
    data?.notes?.inclusivePricing,
    data?.notes?.returnsDerived,
    data?.notes?.inputSplit,
    data?.notes?.hsnSource,
    data?.notes?.roundOff,
    data?.notes?.netPosition,
    data?.notes?.unmatchedReturnLines,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Business Intelligence</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">GST Report</h1>
          <p className="mt-1 text-sm text-muted">The tax charged on sales, the tax paid on purchases, and what that leaves.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/analytics"
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:bg-subtle"
          >
            Overview
          </Link>
          <Button variant="secondary" onClick={print} disabled={!data}>
            <Printer className="h-4 w-4" aria-hidden="true" /> Print summary
          </Button>
          <Button variant="secondary" onClick={exportCsv} loading={exporting} disabled={!data?.total}>
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

      <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
        <div>
          <p className="font-bold">This is not a GST return.</p>
          <p className="mt-0.5 text-muted">
            {data?.notes?.disclaimer || 'An operational summary built from the tax recorded on each document. Reconcile it against your accounting records before filing.'}
          </p>
        </div>
      </div>

      <Card className="space-y-3 p-3 sm:p-4">
        <PeriodFilters value={period} onChange={narrow(setPeriod)} stores={stores} storesLoading={branches.loading}>
          {data?.organization && (
            <p className="pb-2 text-xs text-muted">
              {data.organization.gstin ? `GSTIN ${data.organization.gstin}` : 'No GSTIN recorded for this organization'} · times in {data.period.timezone}
            </p>
          )}
        </PeriodFilters>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <Select
            label="GST rate"
            className="w-36"
            value={rate}
            onChange={(e) => narrow(setRate)(e.target.value)}
            disabled={!data}
            hint={data && !data.options.rates.length ? 'Nothing was sold in this period.' : undefined}
          >
            <option value="">All rates</option>
            {(data?.options?.rates || []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="min-w-[16rem] flex-1">
            <span className="mb-1.5 block text-[13px] font-semibold">Search</span>
            <SearchInput value={search} onChange={narrow(setSearch)} label="Search invoices" placeholder="Invoice number, customer or GSTIN…" />
          </div>
        </div>
      </Card>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Card className="p-5" aria-label="Tax statement">
              <div className="mb-4">
                <h2 className="text-[15px] font-bold">Tax statement</h2>
                <p className="text-xs text-muted">Output tax less input tax, as this system records them.</p>
              </div>
              {loading && !data ? (
                <div className="space-y-2">
                  {Array.from({ length: 10 }, (_, i) => (
                    <Skeleton key={i} className="h-7 w-full" />
                  ))}
                </div>
              ) : (
                <dl className="divide-y divide-line text-sm">
                  <Line label="Taxable sales" value={s.output.taxable} />
                  <Line label="CGST charged" value={s.output.cgst} muted />
                  <Line label="SGST charged" value={s.output.sgst} muted />
                  <Line label="IGST charged" value={s.output.igst} muted />
                  <Line label="Total tax charged on sales" value={s.output.tax} strong />
                  <Line label="Less tax on sales returns" value={-s.salesReturns.tax} tag="derived" />
                  <Line label="Net output tax" value={s.outputNet.tax} strong />
                  <Line label="Taxable purchases" value={s.input.taxable} />
                  <Line label="Input tax on purchases" value={s.input.tax} hint={s.input.chargesTax ? `includes ${inr(s.input.chargesTax)} on charges` : undefined} />
                  <Line label="Less tax on purchase returns" value={-s.purchaseReturns.tax} tag="derived" />
                  <Line label="Net input tax" value={s.inputNet.tax} strong />
                  <div className="flex items-baseline justify-between gap-3 border-t-2 border-ink/20 pt-3 text-base font-bold">
                    <dt>{s.net.label}</dt>
                    <dd className={cx('tabular-nums', s.net.payable ? 'text-danger' : 'text-success')}>{inr(s.net.tax)}</dd>
                  </div>
                </dl>
              )}
              {s && (s.output.roundOff !== 0 || s.output.interStateInvoices > 0) && (
                <p className="mt-3 text-xs text-muted">
                  {s.output.roundOff !== 0 && <>Round-off on these invoices: {inr(s.output.roundOff)} (not tax). </>}
                  {s.output.interStateInvoices > 0 && <>{s.output.interStateInvoices.toLocaleString('en-IN')} inter-state invoice(s). </>}
                  {s.output.withGstin > 0 && <>{s.output.withGstin.toLocaleString('en-IN')} to a GST-registered customer.</>}
                </p>
              )}
            </Card>

            <div className="space-y-4">
              <RateTable title="By GST rate (sales)" subtitle="From the tax recorded on each invoice line" rows={data?.byRate} loading={loading} />
              {Boolean(data?.returnsByRate?.length) && (
                <RateTable title="Sales returns by rate" subtitle="Derived from the rate on the invoice line each unit came back against" rows={data.returnsByRate} loading={false} />
              )}
              {Boolean(data?.inputByRate?.length) && (
                <RateTable title="Purchases by rate" subtitle="Input tax on order lines; purchases record no CGST/SGST split" rows={data.inputByRate} loading={false} inputOnly />
              )}
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-bold">HSN-wise summary</h2>
              <p className="text-xs text-muted">Sales by HSN code and rate. Codes come from the medicine records as they stand now.</p>
            </div>
            {loading && !data ? (
              <div className="p-4">
                <Skeleton className="h-32 w-full" />
              </div>
            ) : !data?.hsn?.length ? (
              <EmptyState icon={Receipt} title="Nothing was sold in this period" />
            ) : (
              <DataTable
                columns={[
                  { key: 'hsn', header: 'HSN', render: (r) => <span className="font-mono text-[13px]">{r.hsnLabel}</span> },
                  { key: 'rate', header: 'Rate', render: (r) => `${r.rate}%` },
                  { key: 'units', header: 'Units', align: 'right', render: (r) => <span className="tabular-nums text-muted">{r.units.toLocaleString('en-IN')}</span> },
                  { key: 'taxable', header: 'Taxable', align: 'right', render: (r) => <span className="tabular-nums">{inr(r.taxable)}</span> },
                  { key: 'cgst', header: 'CGST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{inr(r.cgst)}</span> },
                  { key: 'sgst', header: 'SGST', align: 'right', hideBelow: 'md', render: (r) => <span className="tabular-nums text-muted">{inr(r.sgst)}</span> },
                  { key: 'igst', header: 'IGST', align: 'right', hideBelow: 'lg', render: (r) => <span className="tabular-nums text-muted">{inr(r.igst)}</span> },
                  { key: 'tax', header: 'Tax', align: 'right', render: (r) => <span className="font-semibold tabular-nums">{inr(r.tax)}</span> },
                ]}
                rows={data.hsn}
                rowKey={(r) => `${r.hsn || 'none'}-${r.rate}`}
                minWidth={820}
              />
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-[15px] font-bold">Invoice-level tax detail</h2>
                <p className="text-xs text-muted">
                  {data ? `${data.total.toLocaleString('en-IN')} invoice${data.total === 1 ? '' : 's'} in this period` : 'Loading…'} · the CSV export carries every one of them
                </p>
              </div>
            </div>
            {data && !data.total ? (
              <EmptyState icon={Receipt} title="No invoices match this question" hint="Widen the period, or clear the rate filter." />
            ) : (
              <>
                <DataTable columns={columns} rows={data?.items || []} rowKey={(r) => r.id} loading={loading && !data} sort={sort} onSort={onSort} minWidth={1180} />
                <Pagination
                  page={page}
                  pages={data?.pages || 1}
                  total={data?.total || 0}
                  limit={limit}
                  onPage={setPage}
                  onLimit={(n) => {
                    setLimit(n);
                    setPage(1);
                  }}
                  pageSummary
                />
              </>
            )}
          </Card>

          {notes.length > 0 && (
            <Card className="space-y-1.5 p-4 text-xs text-muted">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink">How these figures are arrived at</p>
              {notes.map((note) => (
                <p key={note} className="flex gap-2">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{note}</span>
                </p>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** One line of the tax statement. A negative figure is shown as what it takes away, not as a minus sign to decode. */
function Line({ label, value, strong, muted, tag, hint }) {
  const negative = value < 0;
  return (
    <div className={cx('flex items-baseline justify-between gap-3 py-2', strong && 'font-bold', muted && 'text-muted')}>
      <dt className="flex items-center gap-2">
        {label}
        {tag && <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{tag}</span>}
        {hint && <span className="text-[11px] font-normal text-muted">{hint}</span>}
      </dt>
      <dd className="shrink-0 tabular-nums">{negative ? `(${inr(Math.abs(value))})` : inr(value)}</dd>
    </div>
  );
}

/** A small rate-breakdown table — the same shape for sales, returns and purchases. */
function RateTable({ title, subtitle, rows, loading, inputOnly }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[15px] font-bold">{title}</h2>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
      {loading && !rows ? (
        <div className="p-4">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !rows?.length ? (
        <EmptyState icon={Receipt} title="Nothing in this period" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Rate</th>
              <th className="px-4 py-2 text-right font-semibold">Taxable</th>
              {!inputOnly && <th className="hidden px-4 py-2 text-right font-semibold sm:table-cell">CGST</th>}
              {!inputOnly && <th className="hidden px-4 py-2 text-right font-semibold sm:table-cell">SGST</th>}
              {!inputOnly && <th className="hidden px-4 py-2 text-right font-semibold md:table-cell">IGST</th>}
              <th className="px-4 py-2 text-right font-semibold">Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rate} className="border-t border-line">
                <td className="px-4 py-2 font-semibold">{r.rate}%</td>
                <td className="px-4 py-2 text-right tabular-nums">{inr(r.taxable)}</td>
                {!inputOnly && <td className="hidden px-4 py-2 text-right tabular-nums text-muted sm:table-cell">{inr(r.cgst)}</td>}
                {!inputOnly && <td className="hidden px-4 py-2 text-right tabular-nums text-muted sm:table-cell">{inr(r.sgst)}</td>}
                {!inputOnly && <td className="hidden px-4 py-2 text-right tabular-nums text-muted md:table-cell">{inr(r.igst)}</td>}
                <td className="px-4 py-2 text-right font-semibold tabular-nums">{inr(r.tax)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
