import { Link } from 'react-router-dom';
import { AlertTriangle, ClipboardList } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { ErrorState, Skeleton, cx } from '../common/ui';
import ChartCard from './ChartCard';

/** Supplier orders at a glance: what waits for approval, what is on its way, what is late, and what is owed. Counted from the orders themselves. */
export default function OrderStats() {
  const { data, error, reload } = useFetch('/orders/summary');
  const rows = data && [
    { label: 'Waiting for approval', value: data.awaitingApproval },
    { label: 'Waiting for goods', value: data.awaitingReceipt },
    { label: 'Overdue', value: data.overdue, danger: data.overdue > 0 },
    { label: 'Open order value', value: inr(data.openValue) },
    { label: 'Owed to suppliers', value: inr(data.unpaidAmount) },
  ];
  return (
    <ChartCard
      title="Supplier orders"
      subtitle="Awaiting goods, approvals and payments"
      right={
        <Link to="/orders" className="text-xs font-semibold text-primary hover:underline">
          View orders
        </Link>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : data.total === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <ClipboardList className="h-4 w-4" aria-hidden="true" /> No orders placed with suppliers yet.
        </p>
      ) : (
        <dl className="divide-y divide-line text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between py-2">
              <dt className="text-muted">{r.label}</dt>
              <dd className={cx('flex items-center gap-1.5 font-semibold tabular-nums', r.danger && 'text-danger')}>
                {r.danger && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </ChartCard>
  );
}
