import { useState } from 'react';
import { X } from 'lucide-react';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { productFrom } from '../../utils/aiBilling';
import { Button, ErrorState, SearchInput, Skeleton } from '../common/ui';

/** Find an existing product for one invoice line. The user always picks: nothing is chosen for them unless it matched exactly. */
export default function ProductPicker({ onPick, onCancel }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q);
  const found = useFetch('/orders/products', { search: term });
  return (
    <div className="rounded-lg border border-line bg-card p-2 shadow-sm">
      <div className="flex items-center gap-2">
        <SearchInput className="flex-1" value={q} onChange={setQ} label="Search products to match" placeholder="Search products…" />
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label="Close product search">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-2 max-h-44 overflow-y-auto">
        {found.loading && !found.data ? (
          <Skeleton className="h-5 w-full" />
        ) : found.error ? (
          <ErrorState message={found.error} onRetry={found.reload} />
        ) : found.data?.length ? (
          <ul aria-label="Products found">
            {found.data.map((p) => (
              <li key={p._id}>
                <button
                  type="button"
                  onClick={() => onPick(productFrom(p))}
                  aria-label={`Use ${p.name}`}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-subtle"
                >
                  <span className="font-medium">
                    {p.name} <span className="font-normal text-muted">{[p.unit, p.manufacturer].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="text-xs text-muted">stock {p.currentStock}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-2 text-sm text-muted">No product found.</p>
        )}
      </div>
    </div>
  );
}
