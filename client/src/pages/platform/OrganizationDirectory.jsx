import { useEffect, useRef, useState } from 'react';
import { Building2, SearchX } from 'lucide-react';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Skeleton, cx } from '../../components/common/ui';
import { dateFmt } from '../../utils/format';

const LIMIT = 8;

/**
 * The pharmacies already on this installation.
 *
 * It sits beside the onboarding form rather than under it, because its real job is to be read WHILE the form is
 * being filled in: the operator is on the telephone, and the question "have we already set these people up?" has
 * to be answerable without losing what has been typed. The search goes to the server, so it finds a pharmacy on
 * page nine as readily as one on page one.
 *
 * It shows names, places and the owner's address — never anything from inside an organization. There is nothing
 * to click: this is a directory, not a way in.
 */
export default function OrganizationDirectory({ reloadToken = 0, className }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebounced(search.trim(), 300);
  const { data, loading, error, reload } = useFetch('/platform/organizations', { search: query || undefined, page, limit: LIMIT });

  // A pharmacy was just created. It is the newest, and the list is newest-first, so go back to the top to show it.
  const seenToken = useRef(reloadToken);
  useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    if (page === 1) reload();
    else setPage(1);
  }, [reloadToken, page, reload]);

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const searching = Boolean(query);

  const onSearch = (v) => {
    setSearch(v);
    setPage(1);
  };

  // One sentence rather than a bare number, so it is worth hearing read out when the count changes.
  const summary = loading && !data ? 'Loading pharmacies…' : `${total} ${total === 1 ? 'pharmacy' : 'pharmacies'}${searching ? ' found' : ' on this installation'}`;

  return (
    <Card className={cx('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-bold">Pharmacies</h2>
          <span role="status" aria-atomic="true" className="text-[11px] tabular-nums text-muted">
            {summary}
          </span>
        </div>
        <SearchInput className="mt-2.5" value={search} onChange={onSearch} label="Search pharmacies" placeholder="Name or email" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <ul className="divide-y divide-line" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="px-4 py-3">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          searching ? (
            <EmptyState
              icon={SearchX}
              title="Nothing matches that"
              hint={`No pharmacy here has “${query}” in its name or email. It may not be onboarded yet.`}
              action={
                <Button variant="secondary" size="sm" onClick={() => onSearch('')}>
                  Clear the search
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Building2} title="No pharmacies yet" hint="The first one you onboard with the form beside this will appear here." />
          )
        ) : (
          <ul className="divide-y divide-line">
            {items.map((o) => {
              const place = [o.city, o.state].filter(Boolean).join(', ');
              return (
                <li key={o.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold">{o.name}</p>
                      <p className="truncate text-xs text-muted">{o.ownerEmail || 'No owner address on file'}</p>
                      {place && <p className="truncate text-[11px] text-muted">{place}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {o.status === 'active' ? (
                        <Badge tone="success" dot>Active</Badge>
                      ) : (
                        <Badge tone="danger" dot>Suspended</Badge>
                      )}
                      <span className="text-[11px] tabular-nums text-muted">{dateFmt(o.createdAt)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pages > 1 && !error && (
        <div className="shrink-0">
          <Pagination page={page} pages={pages} total={total} limit={LIMIT} onPage={setPage} />
        </div>
      )}
    </Card>
  );
}
