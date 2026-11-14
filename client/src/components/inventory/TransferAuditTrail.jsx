import { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { dateTimeFmt } from '../../utils/format';
import { STATUS_LABEL } from '../../utils/transferValidation';
import { ErrorState, Skeleton, cx } from '../common/ui';

const ACTION_LABEL = { CREATED: 'Created', UPDATED: 'Edited', DELETED: 'Deleted', SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', DISPATCHED: 'Dispatched', RECEIVED: 'Received', CANCELLED: 'Cancelled' };

/**
 * The complete, permanent audit trail of one transfer: every change of state and every edit, who made it, at which branch, the status
 * before and after, and any remarks. Loaded only when opened. Entries can't be edited or removed.
 */
export default function TransferAuditTrail({ id, refreshKey }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Audit trail" className="rounded-xl border border-line">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-bold">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted" aria-hidden="true" /> Audit trail
        </span>
        <ChevronDown className={cx('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <Events id={id} refreshKey={refreshKey} />}
    </section>
  );
}

function Events({ id, refreshKey }) {
  const { data, loading, error, reload } = useFetch(`/transfers/${id}/events`, { limit: 100, v: refreshKey });
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="m-4 h-16" />;
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-subtle uppercase tracking-wider text-muted">
          <tr>
            {['When', 'Action', 'Status', 'By', 'Branch', 'Remarks'].map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.items.map((e) => (
            <tr key={e._id} className="border-t border-line align-top">
              <td className="whitespace-nowrap px-3 py-2 text-muted">{dateTimeFmt(e.timestamp)}</td>
              <td className="px-3 py-2 font-semibold">{ACTION_LABEL[e.action] || e.action}</td>
              <td className="whitespace-nowrap px-3 py-2">
                {e.previousStatus ? `${STATUS_LABEL[e.previousStatus] || e.previousStatus} → ` : ''}
                {e.newStatus ? STATUS_LABEL[e.newStatus] || e.newStatus : '—'}
              </td>
              <td className="px-3 py-2">{e.performedByName || '—'}</td>
              <td className="px-3 py-2">{e.branchName || '—'}</td>
              <td className="px-3 py-2 text-muted">{e.remarks || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-[11px] text-muted">This history is permanent: entries are written together with the change they describe and can never be edited or deleted.</p>
    </div>
  );
}
