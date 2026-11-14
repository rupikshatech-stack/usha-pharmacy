import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsUpDown, MoreHorizontal, PackageSearch } from 'lucide-react';
import { Badge, Button, EmptyState, Skeleton, cx } from '../../common/ui';
import { inr } from '../../../utils/format';
import { compactMoney } from '../../../utils/analytics';
import { ACTION_LABEL, availableActions, units as fmtUnits } from '../../../utils/expiryView';
import { ExpiryTimeline, LotStatusBadge, RiskBadge } from './RiskBadge';

/**
 * The Risk Inventory Register.
 *
 * This is the part of the screen a pharmacist actually works from, so it is built around one question: what do I deal
 * with first? That is why it sorts by risk out of the box rather than by expiry date — the soonest-expiring lot is
 * very often one that will sell itself, and putting it at the top would waste the most valuable row on the page.
 *
 * The table is deliberately not a generic one. `DataTable` handles the ordinary case well, but this list needs row
 * selection, collapsible groups with subtotals, and a per-row action menu, and bending the shared component to cover
 * all three would make it worse for every other screen that uses it.
 */

function SortHeader({ by, label, sort, onSort, align }) {
  const active = sort.sortBy === by;
  return (
    <button
      type="button"
      onClick={() => onSort(by)}
      className={cx('inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink', active && 'text-ink', align === 'right' && 'flex-row-reverse')}
    >
      {label}
      {active ? (
        sort.sortDir === 'asc' ? (
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-50" aria-hidden="true" />
      )}
    </button>
  );
}

/** The little menu on a row. Only ever offers what the server would actually accept for that lot. */
function RowActions({ row, onAction }) {
  const [open, setOpen] = useState(false);
  const actions = availableActions(row);
  if (!actions.length) return <span className="text-xs text-muted">—</span>;

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        aria-label={`Actions for batch ${row.batchNumber}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-subtle hover:text-ink"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={(e) => { e.stopPropagation(); setOpen(false); }} aria-hidden="true" />
          <div className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-line bg-card py-1 shadow-pop">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setOpen(false); onAction('transfer', [row]); }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-subtle"
            >
              Where would this sell?
            </button>
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(false); onAction(a, [row]); }}
                className={cx('block w-full px-3 py-2 text-left text-sm hover:bg-subtle', a === 'dispose' && 'text-danger')}
              >
                {ACTION_LABEL[a]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One lot. */
function Row({ row, index, selected, onSelect, onOpen, onAction }) {
  return (
    <tr
      className={cx('cursor-pointer border-t border-line transition-colors hover:bg-subtle/70', selected && 'bg-primary/5')}
      onClick={() => onOpen(row)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(row);
        }
      }}
    >
      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(row)}
          aria-label={`Select batch ${row.batchNumber}`}
          className="h-4 w-4 cursor-pointer rounded border-line accent-[var(--primary)]"
        />
      </td>
      <td className="px-2 py-2.5 text-right text-xs tabular-nums text-muted">{index}</td>
      <td className="px-4 py-2.5">
        <div className="min-w-0 max-w-[16rem]">
          <div className="truncate font-semibold">{row.medicineName}</div>
          <div className="truncate text-[11px] text-muted">
            {[row.strength, row.packSize, row.categoryName].filter(Boolean).join(' · ') || '—'}
          </div>
          <div className="truncate text-[11px] text-muted">
            {row.manufacturer || 'No company recorded'}
            {row.scheduleCategory ? ` · Sch ${row.scheduleCategory}` : ''}
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5 hidden lg:table-cell">
        <div className="min-w-0 max-w-[11rem]">
          <div className="truncate font-mono text-[12px] font-semibold">{row.batchNumber}</div>
          <div className="truncate text-[11px] text-muted">{row.supplierName || 'No supplier'}</div>
          {row.branchName && <div className="truncate text-[11px] text-muted">{row.branchName}</div>}
        </div>
      </td>
      <td className="px-4 py-2.5">
        <ExpiryTimeline expiryDate={row.expiryDate} daysToExpiry={row.daysToExpiry} receivedAt={row.receivedAt} />
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="whitespace-nowrap font-semibold tabular-nums">{row.quantity.toLocaleString('en-IN')}</div>
        <div className="whitespace-nowrap text-[11px] text-muted">{row.unit}</div>
        <div className="whitespace-nowrap text-[11px] text-muted" title="Average units sold a day, for this medicine in this store">
          {row.avgDailySales}/day
        </div>
      </td>
      <td className="px-4 py-2.5 text-right hidden md:table-cell">
        <div className="whitespace-nowrap font-semibold tabular-nums">{inr(row.costValue)}</div>
        <div className="whitespace-nowrap text-[11px] text-muted">{inr(row.mrpValue)} MRP</div>
      </td>
      <td className="px-4 py-2.5">
        <RiskBadge level={row.riskLevel} score={row.riskScore} loss={row.projectedLoss} />
      </td>
      <td className="px-4 py-2.5 hidden xl:table-cell">
        <LotStatusBadge row={row} />
      </td>
      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
        <RowActions row={row} onAction={onAction} />
      </td>
    </tr>
  );
}

/** A group's own line: what it is, and what it adds up to. */
function GroupHeader({ group, open, onToggle, colSpan }) {
  return (
    <tr className="border-t border-line bg-subtle/60">
      <td colSpan={colSpan} className="px-3 py-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
          <span className="truncate text-[13px] font-bold">{group.label}</span>
          <span className="shrink-0 text-xs text-muted">
            {group.batches} lot{group.batches === 1 ? '' : 's'} · {fmtUnits(group.quantity)}
          </span>
          {group.criticalBatches > 0 && (
            <Badge tone="danger">
              {group.criticalBatches} critical
            </Badge>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-4 text-xs">
            <span className="tabular-nums">
              <span className="text-muted">cost </span>
              <span className="font-bold">{compactMoney(group.costValue)}</span>
            </span>
            {group.projectedLoss > 0 && (
              <span className="tabular-nums text-danger">
                <span className="opacity-70">loss </span>
                <span className="font-bold">{compactMoney(group.projectedLoss)}</span>
              </span>
            )}
          </span>
        </button>
      </td>
    </tr>
  );
}

export default function ExpiryRegister({ data, loading, state, onSort, onOpen, onAction, selected, onSelect, onSelectAll }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const rows = data?.items || [];
  const groups = data?.groups;
  const COLS = 10;

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleGroup = (id) =>
    setCollapsed((s) => {
      const next = new Set(s);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Which group a row belongs to, so the page's rows can be shown under their own headings. */
  const groupKeyOf = (row) =>
    state.groupBy === 'company' ? row.manufacturer || '' : state.groupBy === 'supplier' ? row.supplierId || '' : state.groupBy === 'category' ? row.categoryId || '' : '';

  if (loading && !data) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        icon={PackageSearch}
        title="Nothing matches this question"
        hint="Widen the expiry dates, clear a filter, or choose All stock above. Expiring stock only appears here once a lot actually holds units."
      />
    );
  }

  // Grouped: each group's heading, then the rows of this page that belong to it.
  const body = [];
  if (groups && state.groupBy !== 'none') {
    let n = (data.page - 1) * data.limit;
    for (const g of groups) {
      const mine = rows.filter((r) => groupKeyOf(r) === String(g.id ?? ''));
      if (!mine.length) continue; // a group whose rows are all on another page
      const open = !collapsed.has(String(g.id));
      body.push(<GroupHeader key={`g-${g.id}`} group={g} open={open} onToggle={() => toggleGroup(g.id)} colSpan={COLS} />);
      if (open) {
        for (const r of mine) {
          n += 1;
          body.push(<Row key={r.id} row={r} index={n} selected={selected.has(r.id)} onSelect={onSelect} onOpen={onOpen} onAction={onAction} />);
        }
      }
    }
  } else {
    rows.forEach((r, i) => {
      body.push(
        <Row key={r.id} row={r} index={(data.page - 1) * data.limit + i + 1} selected={selected.has(r.id)} onSelect={onSelect} onOpen={onOpen} onAction={onAction} />,
      );
    });
  }

  return (
    <div className={cx('max-h-[calc(100vh-18rem)] min-h-40 overflow-auto', loading && 'opacity-60 transition-opacity')}>
      <table className="w-full text-left text-sm" style={{ minWidth: 1180 }}>
        <thead className="sticky top-0 z-10 bg-subtle text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="px-3 py-2.5">
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={() => onSelectAll(rows, !allOnPageSelected)}
                aria-label="Select every lot on this page"
                className="h-4 w-4 cursor-pointer rounded border-line accent-[var(--primary)]"
              />
            </th>
            <th scope="col" className="px-2 py-2.5 text-right font-semibold">
              #
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              <SortHeader by="medicine" label="Product details" sort={state} onSort={onSort} />
            </th>
            <th scope="col" className="hidden px-4 py-2.5 font-semibold lg:table-cell">
              Batch info
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              <SortHeader by="expiry" label="Expiry timeline" sort={state} onSort={onSort} />
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-semibold">
              <SortHeader by="quantity" label="Stock level" sort={state} onSort={onSort} align="right" />
            </th>
            <th scope="col" className="hidden px-4 py-2.5 text-right font-semibold md:table-cell">
              <SortHeader by="value" label="Value (₹)" sort={state} onSort={onSort} align="right" />
            </th>
            <th scope="col" className="px-4 py-2.5 font-semibold">
              <SortHeader by="loss" label="Risk" sort={state} onSort={onSort} />
            </th>
            <th scope="col" className="hidden px-4 py-2.5 font-semibold xl:table-cell">
              Status
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

/** The bar that appears once rows are ticked: what is selected, and what can be done to all of it at once. */
export function SelectionBar({ rows, onAction, onClear, actions }) {
  if (!rows.length) return null;
  const units = rows.reduce((n, r) => n + r.quantity, 0);
  const value = rows.reduce((n, r) => n + r.costValue, 0);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-primary/5 px-4 py-2.5">
      <span className="text-sm font-semibold">
        {rows.length} selected · {units.toLocaleString('en-IN')} units · {inr(value)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions.length === 0 && <span className="text-xs text-muted">No one action suits every lot selected.</span>}
        {actions.map((a) => (
          <Button key={a} size="sm" variant={a === 'dispose' ? 'danger' : 'secondary'} onClick={() => onAction(a, rows)}>
            {ACTION_LABEL[a]}
          </Button>
        ))}
        <Button size="sm" variant="secondary" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
