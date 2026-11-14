import { ArrowUpRight, Printer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Modal, StatusBadge } from '../common/ui';
import { dateTimeFmt, getDisplayTimezone, inr } from '../../utils/format';
import { TYPE_TONE, amountNote, originOf } from '../../utils/transactions';
import { useAuth } from '../../context/AuthContext';

const money = (v) => (v === null || v === undefined ? '—' : inr(v));
const text = (v) => (v === null || v === undefined || v === '' ? '—' : v);

/**
 * One transaction, in full. The columns a reader can fit on a table are never the whole document, so this says
 * everything the ledger holds about it — including, plainly, whether it counts towards a total and why not.
 *
 * The document itself is not reproduced here: this is the ledger's record OF it, and "Open the original" goes to the
 * module that owns it. Printing follows the project's `#print-area` rule, so only this record reaches the paper.
 */
export default function TransactionDetails({ row, onClose }) {
  const { user } = useAuth();
  if (!row) return null;
  const origin = originOf(row);
  const note = amountNote(row);

  const rows = [
    ['Type', <Badge key="t" tone={TYPE_TONE[row.type] || 'neutral'}>{row.typeLabel}</Badge>],
    ['Reference', <span key="r" className="font-mono font-semibold">{row.reference}</span>],
    ...(row.secondary ? [['Related document', <span key="s" className="font-mono">{row.secondary}</span>]] : []),
    ['Date', dateTimeFmt(row.date)],
    ['Status', <StatusBadge key="st" status={row.status} />],
    [row.partyKind === 'supplier' ? 'Supplier' : row.partyKind === 'customer' ? 'Customer' : 'Party', text(row.partyName)],
    ...(row.partyPhone ? [['Phone', row.partyPhone]] : []),
    [row.toBranchName ? 'Route' : 'Store', row.toBranchName ? `${text(row.branchName)} → ${row.toBranchName}` : text(row.branchName)],
    ['Lines', Number(row.lines || 0).toLocaleString('en-IN')],
    ['Units', Number(row.units || 0).toLocaleString('en-IN')],
    ['Taxable', money(row.taxable)],
    ['Discount', money(row.discount)],
    ['GST', money(row.tax)],
    [row.type === 'transfer' ? 'Stock value' : 'Amount', <span key="a" className="text-base font-bold tabular-nums">{money(row.amount)}</span>],
    ['Outstanding', row.due > 0 ? <span key="d" className="font-semibold text-warning tabular-nums">{inr(row.due)}</span> : '—'],
    ['Payment mode', text(row.paymentMode)],
    ['Payment status', row.paymentStatus ? <StatusBadge key="ps" status={row.paymentStatus} /> : '—'],
    ['Counts as trade', row.countsAsTrade ? 'Yes' : 'No'],
    ['Recorded by', text(row.who)],
  ];

  return (
    <Modal
      title={`${row.typeLabel} ${row.reference}`}
      description={row.partyName}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" /> Print
          </Button>
          {origin && (
            <Link
              to={origin.path}
              onClick={onClose}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover"
            >
              {origin.label}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
        </>
      }
    >
      {/* Only this element is printed (see the #print-area rule in index.css), so paper carries the record and
          nothing of the page around it. */}
      <div id="print-area">
        <div className="mb-3 hidden border-b border-line pb-2 print:block">
          <p className="text-base font-bold">{user?.organization?.name}</p>
          <p className="text-xs">
            {row.typeLabel} {row.reference} · printed {dateTimeFmt(new Date())} ({getDisplayTimezone()})
          </p>
        </div>

        {note && (
          <p className="mb-3 rounded-xl bg-subtle p-3 text-xs text-muted">
            <span className="font-semibold text-ink">Not counted. </span>
            {note}
          </p>
        )}

        <dl className="grid gap-x-6 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm">
              <dt className="shrink-0 text-muted">{label}</dt>
              <dd className="text-right font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        {(row.taxable === null || row.tax === null) && (
          <p className="mt-3 text-[11px] text-muted">
            A return and a transfer carry no tax breakdown of their own, so those cells are empty rather than zero. Return tax is adjusted in the GST report.
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted">
          This is the analytics record of the transaction, read from the document itself. {origin ? 'Open the original for the full document.' : ''}
        </p>
      </div>
    </Modal>
  );
}
