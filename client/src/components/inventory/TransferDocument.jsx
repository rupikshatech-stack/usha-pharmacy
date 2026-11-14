import { Download, Printer } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, dateTimeFmt, expiryFmt } from '../../utils/format';
import { STATUS_LABEL, transferCsvRows } from '../../utils/transferValidation';
import { toCsv } from '../../utils/importFile';
import { downloadText } from '../../utils/download';
import { Button, ErrorState, Modal, Skeleton } from '../common/ui';

const Row = ({ label, children }) => (
  <div className="flex justify-between gap-4 border-b border-neutral-300 py-1 text-sm">
    <dt className="text-neutral-600">{label}</dt>
    <dd className="text-right font-medium">{children}</dd>
  </div>
);

/**
 * The transfer as a document: a preview you can print (or save as PDF from the print dialog) and download as CSV.
 * The printed page contains only the document itself, in black on white.
 */
export default function TransferDocument({ id, onClose }) {
  const { data, loading, error, reload } = useFetch(`/transfers/${id}/print`); // everything the note needs, assembled by the server
  const t = data?.transfer;
  const org = data?.organization || {};
  const received = Boolean(t && (t.receipts?.length || ['partially_received', 'completed'].includes(t.status)));

  return (
    <Modal
      wide
      title={t ? `Transfer document — ${t.reference}` : 'Transfer document'}
      description="Print it, or choose “Save as PDF” in the print dialog to get a PDF."
      onClose={onClose}
      footer={
        t ? (
          <>
            <Button variant="secondary" onClick={() => downloadText(`${t.reference}.csv`, toCsv(transferCsvRows(t, org.name)))}>
              <Download className="h-4 w-4" /> Download CSV
            </Button>
            <Button onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !t ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <article id="print-area" aria-label={`Stock transfer ${t.reference}`} className="mx-auto max-w-3xl rounded-lg border border-line bg-white p-6 text-black sm:p-8">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-black pb-4">
            <div className="flex items-start gap-3">
              <img src="/logo/logo.jpg" alt="Usha Pharmacy" className="h-14 w-auto" />
              <div className="text-sm">
                <p className="text-base font-extrabold uppercase tracking-wide">{org.name}</p>
                {org.address && <p className="text-neutral-700">{org.address}</p>}
                {(org.phone || org.email) && <p className="text-neutral-700">{[org.phone, org.email].filter(Boolean).join(' · ')}</p>}
                {org.gstin && <p className="text-neutral-700">GSTIN {org.gstin}</p>}
              </div>
            </div>
            <div className="text-right">
              <h2 className="text-xl font-extrabold tracking-tight">Stock Transfer Note</h2>
              <p className="font-mono text-lg font-bold">{t.reference}</p>
              <p className="text-sm text-neutral-600">{STATUS_LABEL[t.status] || t.status}</p>
            </div>
          </header>

          <section className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-600">From</h3>
              <p className="font-semibold">{t.fromBranch.name}</p>
              {t.fromBranch.address && <p className="text-sm text-neutral-700">{t.fromBranch.address}</p>}
              {t.fromBranch.phone && <p className="text-sm text-neutral-700">{t.fromBranch.phone}</p>}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-600">To</h3>
              <p className="font-semibold">{t.toBranch.name}</p>
              {t.toBranch.address && <p className="text-sm text-neutral-700">{t.toBranch.address}</p>}
              {t.toBranch.phone && <p className="text-sm text-neutral-700">{t.toBranch.phone}</p>}
            </div>
          </section>

          <dl className="mt-4">
            <Row label="Transfer date">{dateFmt(t.transferDate)}</Row>
            {t.expectedArrivalDate && <Row label="Expected arrival">{dateFmt(t.expectedArrivalDate)}</Row>}
            <Row label="Created by">{t.createdByName || '—'}</Row>
            {t.notes && <Row label="Remarks">{t.notes}</Row>}
          </dl>

          <table className="mt-5 w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-y-2 border-black text-xs uppercase tracking-wider">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Medicine</th>
                <th className="py-2 pr-2">Batch</th>
                <th className="py-2 pr-2">Expiry</th>
                <th className="py-2 pr-2 text-right">Quantity</th>
                {received && <th className="py-2 pr-2 text-right">Received</th>}
                {received && <th className="py-2 text-right">Damaged / missing</th>}
              </tr>
            </thead>
            <tbody>
              {t.items.map((i, n) => (
                <tr key={String(i.batchId)} className="border-b border-neutral-300 align-top">
                  <td className="py-2 pr-2 tabular-nums">{n + 1}</td>
                  <td className="py-2 pr-2 font-medium">
                    {i.medicineName}
                    {i.remarks && <div className="text-xs font-normal text-neutral-700">Remarks: {i.remarks}</div>}
                  </td>
                  <td className="py-2 pr-2 font-mono text-[13px]">{i.batchNumber}</td>
                  <td className="py-2 pr-2">{expiryFmt(i.expiryDate)}</td>
                  <td className="py-2 pr-2 text-right font-semibold tabular-nums">{i.quantity}</td>
                  {received && <td className="py-2 pr-2 text-right tabular-nums">{i.receivedQuantity}</td>}
                  {received && <td className="py-2 text-right tabular-nums">{(i.damagedQuantity || 0) + (i.missingQuantity || 0)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-black font-bold">
                <td colSpan={4} className="py-2">
                  Total ({t.itemCount} item{t.itemCount === 1 ? '' : 's'})
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">{t.totalUnits}</td>
                {received && <td className="py-2 pr-2 text-right tabular-nums">{t.receivedUnits}</td>}
                {received && <td className="py-2 text-right tabular-nums">{(t.damagedUnits || 0) + (t.missingUnits || 0)}</td>}
              </tr>
            </tfoot>
          </table>

          <section className="mt-6">
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-600">History</h3>
            <ul className="space-y-0.5 text-sm">
              {t.timeline.map((e) => (
                <li key={`${e.event}-${e.ref || e.at}`}>
                  {dateTimeFmt(e.at)} — {e.label}
                  {e.by ? ` (${e.by})` : ''}
                  {e.note ? ` — “${e.note}”` : ''}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10 grid grid-cols-2 gap-10 text-sm">
            {[
              ['Dispatched by', t.dispatchedByName, t.dispatchedAt, t.fromBranch.name],
              ['Received by', t.receivedByName, t.receivedAt, t.toBranch.name],
            ].map(([label, name, at, store]) => (
              <div key={label}>
                <div className="flex h-12 items-end border-b border-black pb-1 text-xs text-neutral-700">{name ? `${name}${at ? ` · ${dateTimeFmt(at)}` : ''}` : ''}</div>
                <p className="mt-1 font-semibold">
                  {label} — {store}
                </p>
                <p className="text-neutral-700">Name, signature and date</p>
              </div>
            ))}
          </section>
          <p className="mt-6 text-[11px] text-neutral-600">
            Printed {dateTimeFmt(data.printedAt)}
            {data.printedBy?.name ? ` by ${data.printedBy.name}` : ''}
          </p>
        </article>
      )}
    </Modal>
  );
}
