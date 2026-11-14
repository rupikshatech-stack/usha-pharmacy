import { useState } from 'react';
import { Eye, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { STATUS_TEXT, STATUS_TONE, rupees } from '../../utils/credit';
import { dateTimeFmt } from '../../utils/format';
import { Badge, Button, Card, EmptyState, ErrorState, FilterDropdown, IconButton, Input, Pagination, SearchInput } from '../common/ui';
import { DataTable } from '../common/DataTable';
import CreditProof from './CreditProof';
import CreditRequestDetails from './CreditRequestDetails';

/**
 * The credit requests as a table, in two modes — the same screen, filters and paging either way, so a request is only ever shown in one place:
 *   mode="mine"    History & Logs: a person's own requests and proofs (the server allows nothing else); an administrator may also show everyone's.
 *   mode="review"  the administrators' queue: every request of the organization, pending first, each row opening the review panel.
 * Filters: request id (and, when looking at everyone's, the requester's name or email), status, submitted date range. Paging 10 / 25 / 50 / 100.
 */
export default function CreditHistory({ mode = 'mine', canSeeAll, refreshKey, onReviewed }) {
  const review = mode === 'review';
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(review ? 'pending' : '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scope, setScope] = useState(review ? 'all' : 'mine');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [open, setOpen] = useState(null);
  const [proof, setProof] = useState(null);
  const q = useDebounced(search.trim(), 300);
  const rangeBad = from && to && from > to;
  const { data, loading, error, reload } = useFetch('/credits/requests', {
    search: q || undefined, status: status || undefined, from: rangeBad ? undefined : from || undefined, to: rangeBad ? undefined : to || undefined, scope, page, limit, k: refreshKey,
  });
  const all = scope === 'all' && (canSeeAll || review);
  const filtered = !!(q || from || to || (review ? status !== 'pending' : status));
  const reset = (fn) => (v) => {
    fn(v);
    setPage(1);
  };
  const clear = () => {
    setSearch('');
    setStatus(review ? 'pending' : '');
    setFrom('');
    setTo('');
    setPage(1);
  };
  // nobody reviews their own request (the server refuses it too), and only a pending one can be decided
  const reviewable = (r) => !!canSeeAll && r.status === 'pending' && String(r.userId) !== String(user?.id);

  const columns = [
    { key: 'n', header: '#', render: (r, i) => <span className="tabular-nums text-muted">{(page - 1) * limit + i + 1}</span> },
    { key: 'no', header: 'Request ID', render: (r) => <span className="font-mono font-semibold">{r.requestNo}</span> },
    { key: 'date', header: 'Date', hideBelow: 'sm', render: (r) => <span className="text-muted">{dateTimeFmt(r.createdAt)}</span> },
    ...(all ? [{ key: 'user', header: 'Requested by', render: (r) => <span title={r.userEmail}>{r.userName || '—'}</span> }] : []),
    { key: 'amount', header: 'Payment Amount', align: 'right', render: (r) => <span className="tabular-nums">{rupees(r.amount)}</span> },
    { key: 'approved', header: 'Approved Amount', hideBelow: 'md', align: 'right', render: (r) => <span className="tabular-nums">{r.approvedAmount != null ? rupees(r.approvedAmount) : '—'}</span> },
    { key: 'credits', header: 'Credits', hideBelow: 'md', align: 'right', render: (r) => <span className="tabular-nums">{r.approvedCredits != null ? r.approvedCredits : '—'}</span> },
    {
      key: 'proof',
      header: 'Payment Proof',
      hideBelow: 'sm',
      render: (r) => (
        <button type="button" className="text-sm font-semibold text-accent hover:underline" onClick={() => setProof(r)} aria-label={`View payment proof of ${r.requestNo}`}>
          View
        </button>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]} dot>{STATUS_TEXT[r.status] || r.status}</Badge> },
    { key: 'remarks', header: 'Admin Remarks', hideBelow: 'lg', render: (r) => <span className="text-muted">{r.remarks || '—'}</span> },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) =>
        review && reviewable(r) ? (
          <Button size="sm" onClick={() => setOpen(r)}>
            Review
          </Button>
        ) : (
          <IconButton label={`View request ${r.requestNo}`} onClick={() => setOpen(r)}>
            <Eye className="h-4 w-4" />
          </IconButton>
        ),
    },
  ];

  return (
    <Card className="rounded-2xl">
      <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
        <SearchInput
          className="w-full sm:w-72"
          label={all ? 'Search by user or request ID' : 'Search by request ID'}
          placeholder={all ? 'Search by user or request ID...' : 'Search by request ID...'}
          value={search}
          onChange={reset(setSearch)}
        />
        <FilterDropdown
          label="Status"
          value={status}
          allLabel="All"
          onChange={reset(setStatus)}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <Input label="From" type="date" value={from} max={to || undefined} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input label="To" type="date" value={to} min={from || undefined} onChange={(e) => reset(setTo)(e.target.value)} error={rangeBad ? 'The end date is before the start date' : undefined} />
        {filtered && (
          <button type="button" className="pb-2 text-sm font-semibold text-accent hover:underline" onClick={clear}>
            Clear filters
          </button>
        )}
        {!review && canSeeAll && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={scope === 'all'} onChange={(e) => reset(setScope)(e.target.checked ? 'all' : 'mine')} />
            Show everyone’s requests
          </label>
        )}
      </div>
      <div className="border-t border-line">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.items || []}
              rowKey={(r) => r._id}
              loading={loading && !data}
              minWidth={520}
              empty={
                filtered ? (
                  <EmptyState icon={Wallet} title="No matching credit requests" hint="Change or clear the filters to see more." />
                ) : review ? (
                  <EmptyState icon={Wallet} title="Nothing waiting for review" hint="Submitted credit requests appear here for approval." />
                ) : (
                  <EmptyState icon={Wallet} title="No credit requests yet" hint="Requests you submit will appear here with their status." />
                )
              }
            />
            <Pagination pageSummary limits={[10, 25, 50, 100]} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
          </>
        )}
      </div>
      {proof && <CreditProof request={proof} onClose={() => setProof(null)} />}
      {open && (
        <CreditRequestDetails
          request={open}
          showUser={all}
          canReview={reviewable(open)}
          onClose={() => setOpen(null)}
          onReviewed={() => {
            setOpen(null);
            reload();
            onReviewed?.();
          }}
        />
      )}
    </Card>
  );
}
