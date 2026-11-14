import { useEffect } from 'react';
import { Download, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, dateTimeFmt, expiryFmt, inr } from '../../utils/format';
import { Button, ErrorState, Modal, Skeleton } from '../common/ui';

const TERMS = { cod: 'Cash on Delivery', advance: 'Advance Payment', credit: 'Credit', partial: 'Partial Payment' };
const Row = ({ label, children, strong }) => (
  <div className={`flex justify-between gap-4 border-b border-neutral-300 py-1 text-sm ${strong ? 'font-extrabold' : ''}`}>
    <dt className="text-neutral-600">{label}</dt>
    <dd className="text-right tabular-nums">{children}</dd>
  </div>
);

/** Opens the browser's print dialog with the order number as the document's title, so "Save as PDF" proposes a sensible file name. */
function printAs(name) {
  const previous = document.title;
  const restore = () => {
    document.title = previous;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  document.title = name;
  window.print();
}

/**
 * The order as a document: a preview you can print on paper or save as a PDF (the print dialog's "Save as PDF"; there is no separate PDF
 * generator in the project). The printed page contains only the document itself, in black on white.
 */
export default function OrderDocument({ id, download = false, onClose }) {
  const { data, loading, error, reload } = useFetch(`/orders/${id}/print`); // everything the document needs, assembled by the server
  const o = data?.order;
  const org = data?.organization || {};
  const pdf = () => {
    toast('In the print window, choose “Save as PDF” as the destination.', { icon: '📄' });
    printAs(o.orderNo);
  };

  // "Download PDF" from the order's details goes straight to the print window once the document is ready
  useEffect(() => {
    if (download && o) {
      toast('In the print window, choose “Save as PDF” as the destination.', { icon: '📄' });
      const t = setTimeout(() => printAs(o.orderNo), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [download, o]);

  return (
    <Modal
      wide
      title={o ? `Order document — ${o.orderNo}` : 'Order document'}
      description="Print it, or download it as a PDF from the print window."
      onClose={onClose}
      footer={
        o ? (
          <>
            <Button variant="secondary" onClick={pdf}>
              <Download className="h-4 w-4" /> Download PDF
            </Button>
            <Button onClick={() => printAs(o.orderNo)}>
              <Printer className="h-4 w-4" /> Print Order
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !o ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <article id="print-area" aria-label={`Purchase order ${o.orderNo}`} className="mx-auto max-w-3xl rounded-lg border border-line bg-white p-6 text-black sm:p-8">
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
              <h2 className="text-xl font-extrabold tracking-tight">Purchase Order</h2>
              <p className="font-mono text-lg font-bold">{o.orderNo}</p>
              <p className="text-sm text-neutral-600">{o.statusLabel}</p>
            </div>
          </header>

          <section className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-600">Supplier</h3>
              <p className="font-semibold">{o.supplier?.name}</p>
              {o.supplier?.contactPerson && <p className="text-sm text-neutral-700">Attn: {o.supplier.contactPerson}</p>}
              {o.supplier?.address && <p className="text-sm text-neutral-700">{o.supplier.address}</p>}
              {(o.supplier?.phone || o.supplier?.email) && <p className="text-sm text-neutral-700">{[o.supplier.phone, o.supplier.email].filter(Boolean).join(' · ')}</p>}
              {o.supplier?.gstin && <p className="text-sm text-neutral-700">GSTIN {o.supplier.gstin}</p>}
            </div>
            <dl>
              <Row label="Order date">{dateFmt(o.orderDate)}</Row>
              {o.expectedDate && <Row label="Expected delivery">{dateFmt(o.expectedDate)}</Row>}
              {o.branchName && <Row label="Deliver to">{o.branchName}</Row>}
              {o.referenceNo && <Row label="Reference">{o.referenceNo}</Row>}
              {o.payment?.terms && <Row label="Payment terms">{TERMS[o.payment.terms] || o.payment.terms}</Row>}
            </dl>
          </section>

          <table className="mt-5 w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-y-2 border-black text-xs uppercase tracking-wider">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Product</th>
                <th className="py-2 pr-2 text-right">Qty</th>
                <th className="py-2 pr-2 text-right">Free</th>
                <th className="py-2 pr-2 text-right">Rate</th>
                <th className="py-2 pr-2 text-right">Disc %</th>
                <th className="py-2 pr-2 text-right">GST %</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i, n) => (
                <tr key={n} className="border-b border-neutral-300 align-top">
                  <td className="py-2 pr-2 tabular-nums">{n + 1}</td>
                  <td className="py-2 pr-2 font-medium">
                    {i.name}
                    <div className="text-xs font-normal text-neutral-700">{[i.unit, i.manufacturer].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.quantity}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.freeQuantity || 0}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{inr(i.rate)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.discountPercent || 0}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{i.gstPercent || 0}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{inr(i.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="ml-auto mt-4 max-w-xs">
            <Row label="Subtotal">{inr(o.subtotal)}</Row>
            <Row label="Discount">− {inr(o.discountTotal)}</Row>
            <Row label="GST">{inr(o.gstTotal)}</Row>
            {(o.charges?.shipping > 0 || o.charges?.packaging > 0 || o.charges?.other > 0) && (
              <Row label="Additional charges">{inr((o.charges.shipping || 0) + (o.charges.packaging || 0) + (o.charges.other || 0) + (o.charges.gstAmount || 0))}</Row>
            )}
            {o.charges?.additionalDiscount > 0 && <Row label="Additional discount">− {inr(o.charges.additionalDiscount)}</Row>}
            <Row label="Grand total" strong>
              {inr(o.grandTotal)}
            </Row>
            {o.payment?.advance > 0 && <Row label="Advance paid">{inr(o.payment.advance)}</Row>}
            {o.payment?.terms && <Row label="Balance">{inr(o.payment.remaining)}</Row>}
          </dl>

          {o.notes && (
            <p className="mt-4 text-sm">
              <span className="font-bold">Notes: </span>
              {o.notes}
            </p>
          )}

          <section className="mt-10 grid grid-cols-2 gap-10 text-sm">
            {[
              ['Prepared by', o.createdByName, o.createdAt],
              ['Authorized by', o.approvedByName, o.approvedAt],
            ].map(([label, name, at]) => (
              <div key={label}>
                <div className="flex h-12 items-end border-b border-black pb-1 text-xs text-neutral-700">{name ? `${name}${at ? ` · ${dateTimeFmt(at)}` : ''}` : ''}</div>
                <p className="mt-1 font-semibold">{label}</p>
                <p className="text-neutral-700">Name, signature and date</p>
              </div>
            ))}
          </section>
          <p className="mt-6 text-[11px] text-neutral-600">
            Printed {dateTimeFmt(data.printedAt)}
            {data.printedBy?.name ? ` by ${data.printedBy.name}` : ''}
            {o.orderedAt ? ` · sent to the supplier ${dateFmt(o.orderedAt)}` : ''}
            {o.expectedDate ? ` · expected ${expiryFmt(o.expectedDate)}` : ''}
          </p>
        </article>
      )}
    </Modal>
  );
}
