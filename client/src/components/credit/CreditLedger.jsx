import { useState } from 'react';
import { Coins, ReceiptText } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { TXN_TEXT, creditWord, signedCredits } from '../../utils/credit';
import { dateTimeFmt } from '../../utils/format';
import { Card, EmptyState, ErrorState, Pagination, SearchInput, Skeleton } from '../common/ui';
import { DataTable } from '../common/DataTable';

/**
 * The credit ledger: every change to a credit balance, with the balance before and after. A person sees their own entries; an administrator can show everyone's.
 * Nothing here can be edited — the ledger is append-only on the server, and a correction is a new entry.
 */
export default function CreditLedger({ canSeeAll, refreshKey }) {
  const { user } = useAuth();
  const [scope, setScope] = useState('mine');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const q = useDebounced(search.trim(), 300);
  const all = canSeeAll && scope === 'all';
  const balance = useFetch('/credits/balance', { k: refreshKey });
  const { data, loading, error, reload } = useFetch('/credits/transactions', { search: q || undefined, scope, page, limit, k: refreshKey });

  const columns = [
    { key: 'txn', header: 'Transaction ID', render: (t) => <span className="font-mono font-semibold">{t.txnNo}</span> },
    { key: 'date', header: 'Date', hideBelow: 'sm', render: (t) => <span className="text-muted">{dateTimeFmt(t.createdAt)}</span> },
    ...(all ? [{ key: 'user', header: 'User', render: (t) => t.userName || '—' }] : []),
    { key: 'type', header: 'Type', hideBelow: 'md', render: (t) => TXN_TEXT[t.type] || t.type },
    { key: 'request', header: 'Request ID', hideBelow: 'md', render: (t) => <span className="font-mono">{t.requestNo || '—'}</span> },
    { key: 'credits', header: 'Credits', align: 'right', render: (t) => <span className={`tabular-nums font-semibold ${t.credits < 0 ? 'text-danger' : 'text-success'}`}>{signedCredits(t.credits)}</span> },
    { key: 'prev', header: 'Previous', hideBelow: 'lg', align: 'right', render: (t) => <span className="tabular-nums text-muted">{t.previousBalance}</span> },
    { key: 'next', header: 'New Balance', align: 'right', render: (t) => <span className="tabular-nums font-semibold">{t.newBalance}</span> },
    { key: 'desc', header: 'Description', hideBelow: 'lg', render: (t) => <span className="text-muted">{t.description}</span> },
    { key: 'by', header: 'Created By', hideBelow: 'lg', render: (t) => t.createdByName || '—' },
  ];

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 rounded-2xl p-4 sm:p-5">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent/10 text-accent" aria-hidden="true">
          <Coins className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted">Your credit balance</p>
          {balance.loading && !balance.data ? (
            <Skeleton className="mt-1 h-7 w-24" />
          ) : (
            <p className="text-2xl font-bold tabular-nums" aria-label={`Your credit balance is ${creditWord(balance.data?.balance)}`}>
              {Number(balance.data?.balance || 0).toLocaleString('en-IN')} <span className="text-sm font-semibold text-muted">credits</span>
            </p>
          )}
        </div>
        {balance.data?.lastTransaction && (
          <p className="text-xs text-muted sm:ml-auto">
            Last change {signedCredits(balance.data.lastTransaction.credits)} on {dateTimeFmt(balance.data.lastTransaction.createdAt)} ({balance.data.lastTransaction.txnNo})
          </p>
        )}
      </Card>

      <Card className="rounded-2xl">
        <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
          <SearchInput className="w-full sm:w-72" label="Search the ledger" placeholder="Search by transaction or request ID..." value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          {canSeeAll && (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" checked={scope === 'all'} onChange={(e) => { setScope(e.target.checked ? 'all' : 'mine'); setPage(1); }} />
              Show everyone’s entries
            </label>
          )}
          <p className="pb-2 text-xs text-muted">The ledger is append-only: a correction is a new entry, never a change to an old one.</p>
        </div>
        <div className="border-t border-line">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={data?.items || []}
                rowKey={(t) => t._id}
                loading={loading && !data}
                minWidth={640}
                empty={<EmptyState icon={ReceiptText} title="No credit transactions yet" hint={all ? 'Approved credit requests will appear here.' : `Credits approved for ${user?.name || 'you'} will appear here.`} />}
              />
              <Pagination pageSummary limits={[10, 25, 50, 100]} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} limit={limit} onPage={setPage} onLimit={(n) => { setLimit(n); setPage(1); }} />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
