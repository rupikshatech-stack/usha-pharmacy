import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Skeleton, cx } from './ui';

/**
 * Enterprise table: sticky header, optional sortable columns, skeleton loading rows,
 * and horizontal scroll on narrow screens. Columns: { key, header, render, sortable,
 * sortKey, align, className, hideBelow ('sm'|'md'|'lg') }.
 */
const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

export function DataTable({ columns, rows, rowKey, loading, skeletonRows = 6, sort, onSort, empty, minWidth = 720 }) {
  return (
    <div className="max-h-[calc(100vh-22rem)] min-h-40 overflow-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead className="sticky top-0 z-10 bg-subtle text-[11px] uppercase tracking-wider text-muted">
          <tr>
            {columns.map((c) => {
              const sk = c.sortKey || c.key;
              const active = sort?.by === sk;
              const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sortable ? ariaSort || 'none' : undefined}
                  className={cx('whitespace-nowrap px-4 py-2.5 font-semibold', c.align === 'right' && 'text-right', c.hideBelow && hide[c.hideBelow], c.className)}
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
                <tr key={rowKey(r)} className="border-t border-line transition-colors hover:bg-subtle/70">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx('px-4 py-2.5 align-middle', c.align === 'right' && 'text-right', c.hideBelow && hide[c.hideBelow], c.className)}
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
  );
}
