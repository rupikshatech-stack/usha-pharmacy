import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Copy, SearchX } from 'lucide-react';
import toast from 'react-hot-toast';
import { useFetch } from '../../hooks/useFetch';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, SearchInput, Skeleton, cx } from '../../components/common/ui';
import { dateFmt } from '../../utils/format';
import { BUSINESS_CATEGORIES } from '../../utils/platformForm';

const LIMIT = 8;
const FILTERS = [
  ['', 'All'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
];
const categoryLabel = (v) => BUSINESS_CATEGORIES.find(([k]) => k === v)?.[1] || v || '—';

/**
 * The pharmacies already on this installation.
 *
 * It sits beside the onboarding form rather than under it, because its real job is to be read WHILE the form is
 * being filled in: the operator is on the telephone, and "have we already set these people up?" has to be
 * answerable without losing what has been typed.
 *
 * A row opens rather than links. There is nowhere to go — this is a directory, not a way into anybody's data —
 * but a name and an email address are exactly the things that do not fit in a narrow column, and they are also
 * exactly what the operator is reading back down the telephone. So the full text is a click away, in place.
 *
 * Its search and filter are owned by the page above, so the form can point at a pharmacy it thinks is a duplicate.
 */
export default function OrganizationDirectory({ search, onSearch, status, onStatus, page, onPage, reloadToken = 0, highlightId, className }) {
  const [openId, setOpenId] = useState(null);
  const [copied, setCopied] = useState('');
  const searchRef = useRef(null);
  const copyTimer = useRef(null);
  const { data, loading, error, reload } = useFetch('/platform/organizations', { search: search || undefined, status: status || undefined, page, limit: LIMIT });

  // A pharmacy was just created. It is the newest, and the list is newest-first, so go back to the top to show it.
  const seenToken = useRef(reloadToken);
  useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    if (page === 1) reload();
    else onPage(1);
  }, [reloadToken, page, onPage, reload]);

  // "/" jumps to the search, the way it does at the counter. Never while something is already being typed into.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copyEmail = async (id, email) => {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 2000);
    } catch {
      toast.error('The browser would not let me copy. Select the address and copy it by hand.');
    }
  };

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const narrowed = Boolean(search || status);

  // One sentence rather than a bare number, so it is worth hearing read out when the count changes.
  const summary = loading && !data ? 'Loading pharmacies…' : `${total} ${total === 1 ? 'pharmacy' : 'pharmacies'}${narrowed ? ' found' : ' on this installation'}`;

  const clearAll = () => {
    onSearch('');
    onStatus('');
  };

  return (
    <Card className={cx('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-bold">Pharmacies</h2>
          <span role="status" aria-atomic="true" className="text-[11px] tabular-nums text-muted">
            {summary}
          </span>
        </div>

        <SearchInput inputRef={searchRef} className="mt-2.5" value={search} onChange={onSearch} label="Search pharmacies" placeholder="Name or email  ( / )" />

        <div role="group" aria-label="Filter by status" className="mt-2 flex gap-1 rounded-lg bg-subtle p-1">
          {FILTERS.map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => onStatus(value)}
              aria-pressed={status === value}
              className={cx(
                'flex-1 cursor-pointer rounded-md px-2 py-1 text-[11.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                status === value ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
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
          narrowed ? (
            <EmptyState
              icon={SearchX}
              title="Nothing matches that"
              hint={search ? `No pharmacy here has “${search}” in its name or email.` : 'No pharmacy here has that status.'}
              action={
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear the filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Building2} title="No pharmacies yet" hint="The first one you onboard with the form beside this will appear here." />
          )
        ) : (
          <ul className="divide-y divide-line">
            {items.map((o) => {
              const open = openId === o.id;
              const place = [o.city, o.state].filter(Boolean).join(', ');
              return (
                <li key={o.id} className={cx('transition-colors', o.id === highlightId && 'bg-sage/50')}>
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : o.id)}
                    aria-expanded={open}
                    aria-controls={`org-detail-${o.id}`}
                    className="flex w-full cursor-pointer items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-subtle focus:outline-none focus-visible:bg-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{o.name}</span>
                      <span className="block truncate text-xs text-muted">{o.ownerEmail || 'No owner address on file'}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1.5">
                      {o.status === 'active' ? <Badge tone="success" dot>Active</Badge> : <Badge tone="danger" dot>Suspended</Badge>}
                      <span className="text-[11px] tabular-nums text-muted">{dateFmt(o.createdAt)}</span>
                    </span>
                    <ChevronDown className={cx('mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
                  </button>

                  {open && (
                    <div id={`org-detail-${o.id}`} className="anim-fade border-t border-line bg-subtle/40 px-4 py-3">
                      <dl className="space-y-2 text-xs">
                        <div>
                          <dt className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Full name</dt>
                          <dd className="mt-0.5 break-words font-semibold">{o.name}</dd>
                        </div>
                        <div>
                          <dt className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Owner</dt>
                          <dd className="mt-0.5 break-all">
                            {o.owner && <span className="mr-1.5 font-semibold">{o.owner}</span>}
                            {o.ownerEmail || '—'}
                          </dd>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <dt className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Category</dt>
                            <dd className="mt-0.5">{categoryLabel(o.businessCategory)}</dd>
                          </div>
                          <div>
                            <dt className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Administrators</dt>
                            <dd className="mt-0.5 tabular-nums">{o.administrators ?? '—'}</dd>
                          </div>
                        </div>
                        {place && (
                          <div>
                            <dt className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Place</dt>
                            <dd className="mt-0.5">{place}</dd>
                          </div>
                        )}
                      </dl>
                      {o.ownerEmail && (
                        <Button variant="secondary" size="sm" className="mt-3" onClick={() => copyEmail(o.id, o.ownerEmail)}>
                          {copied === o.id ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                          {copied === o.id ? 'Copied' : 'Copy the address'}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pages > 1 && !error && (
        <div className="shrink-0">
          <Pagination page={page} pages={pages} total={total} limit={LIMIT} onPage={onPage} />
        </div>
      )}
    </Card>
  );
}
