import { AlertTriangle, CalendarClock, CheckCircle2 } from 'lucide-react';
import { expiryFmt } from '../../utils/format';
import { EmptyState, cx } from '../common/ui';

/** Low-stock medicines and expiring/expired batches (data from /dashboard). */
export default function InventoryAlerts({ data }) {
  if (!data.lowStockItems.length && !data.expiringBatches.length) {
    return <EmptyState icon={CheckCircle2} title="No inventory alerts" hint="Stock levels and expiry dates look healthy." />;
  }
  return (
    <ul className="divide-y divide-line">
      {data.lowStockItems.map((m) => (
        <li key={`l${m.id}`} className="flex items-center gap-3 py-2.5">
          <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-lg', m.qty === 0 ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')}>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{m.name}</div>
            <div className="text-xs text-muted">Reorder level {m.reorderLevel}</div>
          </div>
          <span className={cx('text-sm font-bold tabular-nums', m.qty === 0 ? 'text-danger' : 'text-warning')}>{m.qty === 0 ? 'Out' : `${m.qty} left`}</span>
        </li>
      ))}
      {data.expiringBatches.map((b) => (
        <li key={`e${b.id}`} className="flex items-center gap-3 py-2.5">
          <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-lg', b.expired ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')}>
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{b.name}</div>
            <div className="text-xs text-muted">Batch {b.batchNumber} · {b.quantity} units</div>
          </div>
          <span className={cx('text-xs font-bold', b.expired ? 'text-danger' : 'text-warning')}>
            {b.expired ? 'Expired' : 'Exp.'} {expiryFmt(b.expiryDate)}
          </span>
        </li>
      ))}
    </ul>
  );
}
