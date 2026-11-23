import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Skeleton, cx } from './ui';

/**
 * Enterprise table: sticky header, optional sortable columns, skeleton loading rows,
 * and horizontal scroll on narrow screens. Columns: { key, header, render, sortable,
 * sortKey, align, className, hideBelow ('sm'|'md'|'lg') }.
 */
const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

/**
 * A table wider than its box scrolls sideways. On a phone nothing says so, and the columns past the edge (the total, the actions) are simply
 * not there as far as the person looking can tell. This reports whether there is more to the right / has been scrolled away on the left,
 * so the table can show an edge fade, a shadow beside the pinned first column, and a one-line hint.
 */
function useSideScroll(deps) {
  const ref = useRef(null);
  const [edge, setEdge] = useState({ more: false, atStart: true, atEnd: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { more: max > 2, atStart: el.scrollLeft <= 2, atEnd: el.scrollLeft >= max - 2 };
      setEdge((prev) => (prev.more === next.more && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [ref, edge];
}

export function DataTable({ columns, rows, rowKey, loading, skeletonRows = 6, sort, onSort, empty, minWidth = 720 }) {
  const [scroller, edge] = useSideScroll([rows?.length, columns.length, loading]);
  // The first column stays put while the rest scroll under it, so a row is still identifiable at the far end. Its cells need a solid
  // background (they would otherwise show what slides beneath), hence group-hover instead of the row's own translucent hover.
  const pinned = 'sticky left-0 max-sm:max-w-[46vw]';
  const pinnedShadow = !edge.atStart && 'shadow-[6px_0_8px_-6px_rgba(23,40,33,0.28)]';
  return (
    <div className="relative">
      <div ref={scroller} className="max-h-[calc(100vh-22rem)] min-h-40 overflow-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead className="sticky top-0 z-10 bg-subtle text-[11px] uppercase tracking-wider text-muted">
          <tr>
            {columns.map((c, ci) => {
              const sk = c.sortKey || c.key;
              const active = sort?.by === sk;
              const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sortable ? ariaSort || 'none' : undefined}
                  className={cx('whitespace-nowrap px-4 py-2.5 font-semibold', ci === 0 && cx('z-20 bg-subtle', pinned, pinnedShadow), c.align === 'right' && 'text-right', c.hideBelow && hide[c.hideBelow], c.className)}
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(sk)}
                      className={cx('inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink', active && 'text-ink')}
                    >
                      {c.header}
                      {active ? (
                        sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-50" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={i} className="border-t border-line">
                  {columns.map((c) => (
                    <td key={c.key} className={cx('px-4 py-3', c.hideBelow && hide[c.hideBelow])}>
                      <Skeleton className="h-4 w-full max-w-[9rem]" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((r, i) => (
                <tr key={rowKey(r)} className="group border-t border-line transition-colors hover:bg-subtle/70">
                  {columns.map((c, ci) => (
                    <td
                      key={c.key}
                      className={cx('px-4 py-2.5 align-middle', ci === 0 && cx('z-[1] bg-card group-hover:bg-subtle', pinned, pinnedShadow), c.align === 'right' && 'text-right', c.hideBelow && hide[c.hideBelow], c.className)}
                    >
                      {c.render ? c.render(r, i) : r[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && empty}
      </div>
      {/* the edge fade says "there is more this way"; it goes once you reach the end */}
      {edge.more && !edge.atEnd && (
        <div aria-hidden="true" data-testid="table-more-right" className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card via-card/80 to-transparent" />
      )}
      {edge.more && !edge.atEnd && (
        <p className="border-t border-line px-4 py-1.5 text-center text-[11px] text-muted md:hidden" data-testid="table-scroll-hint">Swipe sideways for more columns →</p>
      )}
    </div>
  );
}
