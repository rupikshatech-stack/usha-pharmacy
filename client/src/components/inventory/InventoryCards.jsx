import { Package } from 'lucide-react';
import { Skeleton, StatusBadge } from '../common/ui';
import RowActions from './RowActions';

/** Mobile presentation of the inventory list: one card per medicine instead of a wide table. */
export default function InventoryCards({ items, loading, empty, ...actions }) {
  if (loading) {
    return (
      <ul className="space-y-3 p-3" aria-label="Loading inventory">
        {Array.from({ length: 5 }, (_, i) => (
          <li key={i} className="rounded-xl border border-line p-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
            <Skeleton className="mt-4 h-6 w-full" />
          </li>
        ))}
      </ul>
    );
  }
  if (!items.length) return empty;

  return (
    <ul className="space-y-3 p-3">
      {items.map((m) => (
        <li key={m._id} className="rounded-xl border border-line bg-card p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{m.medicineName}</div>
              <div className="truncate text-xs text-muted">{[m.genericName || m.salt, m.strength].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <RowActions m={m} {...actions} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={m.stockStatus} />
            {m.isActive === false && <StatusBadge status="archived" />}
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-muted">Total stock</dt>
              <dd className="text-sm font-bold tabular-nums">
                <Package className="mr-1 inline h-3.5 w-3.5 text-muted" aria-hidden="true" />
                {m.totalStock}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Reorder level</dt>
              <dd className="text-sm font-semibold tabular-nums">{m.reorderLevel}</dd>
            </div>
            <div>
              <dt className="text-muted">Category</dt>
              <dd className="truncate text-sm font-semibold">{m.categoryName || '—'}</dd>
            </div>
          </dl>
          <p className="mt-2 truncate text-xs text-muted">{m.manufacturer || 'No manufacturer'}</p>
          {m.expiredStock > 0 && <p className="mt-1 text-xs font-semibold text-danger">{m.expiredStock} expired unit(s) on hand</p>}
        </li>
      ))}
    </ul>
  );
}
