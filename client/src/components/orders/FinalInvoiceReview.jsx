import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Link2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiBillingService } from '../../services/aiBillingService';
import { useFetch } from '../../hooks/useFetch';
import { dateFmt, expiryFmt, inr } from '../../utils/format';
import { purchaseMode } from '../../utils/goodsReceipt';
import { Badge, Button, ErrorState, SearchInput, Skeleton, cx, inputCls } from '../common/ui';

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const money = (v) => (v === null || v === undefined ? '—' : inr(v));

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/** One existing order offered for linking, with the per-product comparison with the invoice. */
function OrderOption({ o, busy, onLink }) {
  const [ack, setAck] = useState(false);
  const diff = o.comparison.differences > 0;
  return (
    <li className="rounded-xl border border-line p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">
            {o.orderNo} <Badge tone={o.receivable ? 'info' : 'neutral'}>{o.statusLabel}</Badge>
          </div>
          <div className="text-xs text-muted">
            {o.supplier?.name} · {o.referenceNo ? `ref ${o.referenceNo} · ` : ''}
            {dateFmt(o.orderDate)} · {money(o.grandTotal)}
            {o.branchName ? ` · ${o.branchName}` : ''}
          </div>
        </div>
        {o.linkable ? (
          <div className="flex flex-col items-end gap-1">
            {diff && (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed the differences
              </label>
            )}
            <Button size="sm" variant="accent" onClick={() => onLink(o, ack)} disabled={busy || (diff && !ack)} aria-label={`Link order ${o.orderNo}`}>
              <Link2 className="h-3.5 w-3.5" /> Link this order
            </Button>
          </div>
        ) : (
          <p className="max-w-xs text-xs text-danger">{o.blockedBecause}</p>
        )}
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-xs" aria-label={`Comparison with ${o.orderNo}`}>
          <thead className="text-muted">
            <tr>
              {['Product', 'Ordered', 'Previously received', 'Invoice quantity', 'Remaining', 'Difference'].map((h) => (
                <th key={h} className="px-2 py-1 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {o.comparison.rows.map((r) => (
              <tr key={r.medicineId} className="border-t border-line">
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1 tabular-nums">{r.orderedQuantity}</td>
                <td className="px-2 py-1 tabular-nums">{r.previouslyReceived}</td>
                <td className="px-2 py-1 tabular-nums">{r.onInvoice ? r.invoiceQuantity : '—'}</td>
                <td className="px-2 py-1 tabular-nums">{r.remainingQuantity}</td>
                <td className={cx('px-2 py-1 tabular-nums', r.onInvoice && r.difference !== 0 && 'font-semibold text-warning')}>
                  {r.onInvoice ? (r.difference > 0 ? `+${r.difference}` : r.difference) : '—'}
                </td>
              </tr>
            ))}
            {o.comparison.notOnOrder.map((n) => (
              <tr key={n.medicineId} className="border-t border-line text-danger">
                <td className="px-2 py-1">{n.name}</td>
                <td colSpan={3} className="px-2 py-1">
                  Not on this order (invoice: {n.invoiceQuantity})
                </td>
                <td />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </li>
  );
}

/**
 * FINAL INVOICE REVIEW: the whole verified invoice on one page — supplier, invoice, medicines with their confirmed products and batches, the financial
 * summary — with the checks that must pass, the person's verification, and then the purchase order (a new one made from the invoice, or an existing one
 * linked). Nothing here receives goods or changes stock; that is the goods receipt.
 */
export default function FinalInvoiceReview({ upload, onBack, onProceed }) {
  const id = upload._id;
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [checked, setChecked] = useState(false);
  const [ackDup, setAckDup] = useState(false);
  const [mode, setMode] = useState('create');
  const [branchId, setBranchId] = useState('');
  const [ordered, setOrdered] = useState(true);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState(null);
  const [failure, setFailure] = useState('');
  const suppliers = useFetch('/suppliers', { limit: 100 });
  const branches = useFetch('/branches');
  const branchList = Array.isArray(branches.data) ? branches.data : branches.data?.items || [];

  const load = useCallback(async () => {
    try {
      setError('');
      const x = await aiBillingService.finalReview(id);
      setR(x);
      setSupplierId((s) => s || String(x.supplier.record?._id || ''));
    } catch (e) {
      setError(e.message);
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the review is loaded when the page opens
    load();
  }, [load]);

  const loadOptions = useCallback(
    async (q) => {
      try {
        setOptions(await aiBillingService.purchaseOrderOptions(id, q));
      } catch (e) {
        setOptions({ orders: [], error: e.message });
      }
    },
    [id],
  );
  useEffect(() => {
    if (!r?.verification.verified || r.purchase || mode !== 'link') return undefined;
    const t = setTimeout(() => loadOptions(search.trim()), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [r?.verification.verified, r?.purchase, mode, search, loadOptions]);

  const act = async (fn, okMessage) => {
    setBusy(true);
    setFailure('');
    try {
      const out = await fn();
      if (okMessage) toast.success(okMessage(out));
      await load();
      return out;
    } catch (e) {
      setFailure(e.message);
      toast.error(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="border-t border-line p-4 sm:p-5">
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  if (!r) {
    return (
      <div className="space-y-3 border-t border-line p-4 sm:p-5">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Preparing the final review…
        </p>
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const read = r.supplier.read;
  const rec = r.supplier.record;
  const t = r.totals || {};
  const blockers = r.checks.filter((c) => c.blocking && !c.ok);
  const verified = r.verification.verified;
  const purchase = r.purchase;
  const order = purchase ? { orderNo: purchase.orderNo } : null;

  return (
    <div className="space-y-5 border-t border-line p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
            Final invoice review{' '}
            {verified ? (
              <Badge tone="success">Verified</Badge>
            ) : r.verification.stale ? (
              <Badge tone="warning">Changed — verify again</Badge>
            ) : (
              <Badge tone="warning">Not verified</Badge>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {upload.uploadId} · {purchaseMode(purchase)}
          </p>
        </div>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back to product matching
        </Button>
      </div>

      <div role="status" className="flex items-start gap-3 rounded-xl bg-subtle p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
        <p>
          Check everything below against the document. Verifying does not change stock: the stock only changes when you confirm a goods receipt with the quantities that actually
          arrived.
        </p>
      </div>

      {/* ---- checks ---- */}
      <section aria-label="Checks" className="space-y-1">
        <h3 className="text-sm font-bold">Checks</h3>
        <ul className="divide-y divide-line rounded-xl border border-line text-sm">
          {r.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 px-3 py-2">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              ) : c.blocking ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              )}
              <div>
                <span className={cx(!c.ok && c.blocking && 'font-semibold text-danger')}>{c.label}</span>
                {c.message && <p className="text-xs text-muted">{c.message}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- supplier and invoice ---- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Supplier information" className="space-y-2">
          <h3 className="text-sm font-bold">Supplier information</h3>
          <dl className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
            <Field label="Supplier name">{dash(rec?.name || read.name)}</Field>
            <Field label="GSTIN">{dash(rec?.gstin || read.gstin)}</Field>
            <Field label="Address">
              {dash(
                rec?.address && typeof rec.address === 'object'
                  ? [rec.address.line1, rec.address.city, rec.address.state].filter(Boolean).join(', ')
                  : rec?.address || read.address,
              )}
            </Field>
            <Field label="Contact">{dash([rec?.phone || read.phone, rec?.email || read.email].filter(Boolean).join(' · '))}</Field>
          </dl>
          {!verified && (
            <label className="block text-xs font-semibold text-muted">
              Supplier in your records
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className={cx(inputCls, 'mt-1 font-normal text-ink')}
                aria-label="Supplier in your records"
              >
                <option value="">{rec ? rec.name : 'Choose the supplier…'}</option>
                {(suppliers.data?.items || []).map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name}
                    {s.gstin ? ` (${s.gstin})` : ''}
                  </option>
                ))}
              </select>
              {r.supplier.suggested && <span className="mt-0.5 block font-normal">Found by GST number or exact name.</span>}
            </label>
          )}
        </section>
        <section aria-label="Invoice information" className="space-y-2">
          <h3 className="text-sm font-bold">Invoice information</h3>
          <dl className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
            <Field label="Invoice number">{dash(r.invoice.invoiceNumber)}</Field>
            <Field label="Invoice date">{r.invoice.invoiceDate ? dateFmt(r.invoice.invoiceDate) : '—'}</Field>
            <Field label="Invoice type">{dash(r.invoice.invoiceType)}</Field>
            <Field label="Purchase order reference">{dash(r.invoice.purchaseOrderNumber)}</Field>
          </dl>
          {r.existingInvoice && (
            <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
              This supplier’s invoice {r.existingInvoice.invoiceNumber} is already recorded ({r.existingInvoice.orderNo}).
            </p>
          )}
        </section>
      </div>

      {/* ---- products ---- */}
      <section aria-label="Product information" className="space-y-2">
        <h3 className="text-sm font-bold">Product information</h3>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[60rem] border-collapse text-left text-xs">
            <thead className="bg-subtle">
              <tr>
                {['#', 'Medicine', 'Confirmed product', 'Batch', 'Expiry', 'Mfg', 'Quantity', 'Free', 'Rate', 'MRP', 'Discount', 'GST', 'Line total'].map((h) => (
                  <th key={h} className="px-2 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={l.itemId} className="border-t border-line align-top">
                  <td className="px-2 py-1.5 text-muted">{i + 1}</td>
                  <td className="px-2 py-1.5">{dash(l.invoiceMedicineName)}</td>
                  <td className="px-2 py-1.5">
                    {l.productName ? (
                      <>
                        <div className="font-medium">{l.productName}</div>
                        <div className="text-muted">ID {String(l.productId).slice(-6)}</div>
                      </>
                    ) : (
                      <Badge tone="danger">Not confirmed</Badge>
                    )}
                  </td>
                  <td className={cx('px-2 py-1.5', !l.batchNumber && 'text-warning')}>{l.batchNumber || 'missing'}</td>
                  <td className={cx('px-2 py-1.5', !l.expiryDate && 'text-warning')}>{l.expiryDate ? expiryFmt(l.expiryDate) : 'missing'}</td>
                  <td className="px-2 py-1.5">{l.manufacturingDate ? expiryFmt(l.manufacturingDate) : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{dash(l.quantity)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{dash(l.freeQuantity)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{money(l.purchaseRate)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{money(l.mrp)}</td>
                  <td className="px-2 py-1.5 tabular-nums">
                    {l.discount?.percentage != null ? `${l.discount.percentage}%` : l.discount?.amount != null ? money(l.discount.amount) : '—'}
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{l.gst?.percentage != null ? `${l.gst.percentage}%` : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{money(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- financial ---- */}
      <section aria-label="Financial information" className="space-y-2">
        <h3 className="text-sm font-bold">Financial information</h3>
        <dl className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Subtotal">{money(t.subtotal)}</Field>
          <Field label="Discount">{money(t.discount)}</Field>
          <Field label="Taxable amount">{money(t.taxableAmount)}</Field>
          <Field label="CGST">{money(t.cgst)}</Field>
          <Field label="SGST">{money(t.sgst)}</Field>
          <Field label="IGST">{money(t.igst)}</Field>
          <Field label="Additional charges">
            {money(
              [t.otherCharges, t.shippingCharges, t.packagingCharges].some((v) => v != null) ? (t.otherCharges || 0) + (t.shippingCharges || 0) + (t.packagingCharges || 0) : null,
            )}
          </Field>
          <Field label="Round off">{t.roundOff == null ? '—' : t.roundOff}</Field>
          <Field label="Grand total">
            <span className="text-base font-extrabold">{money(t.grandTotal)}</span>
          </Field>
        </dl>
      </section>

      {/* ---- verification ---- */}
      {!verified && (
        <section aria-label="Verification" className="space-y-3 rounded-xl border border-line p-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1" />
            <span>I have verified this invoice against the original document: the supplier, invoice details, medicines, batches and totals.</span>
          </label>
          {r.existingInvoice && (
            <label className="flex items-start gap-2 text-sm text-danger">
              <input type="checkbox" checked={ackDup} onChange={(e) => setAckDup(e.target.checked)} className="mt-1" />
              <span>This is a different invoice with the same number (only someone who can approve orders may record this).</span>
            </label>
          )}
          {blockers.length > 0 && (
            <p role="status" className="text-sm text-danger">
              Resolve first: {blockers.map((b) => b.label).join('; ')}.
            </p>
          )}
          {failure && (
            <p role="alert" className="text-sm text-danger">
              {failure}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              variant="accent"
              loading={busy}
              disabled={
                busy ||
                !checked ||
                blockers.some((b) => b.key !== 'supplier' && b.key !== 'duplicate') ||
                (blockers.some((b) => b.key === 'duplicate') && !ackDup) ||
                (blockers.some((b) => b.key === 'supplier') && !supplierId)
              }
              onClick={() =>
                act(
                  () => aiBillingService.verifyInvoice(id, { confirmed: true, supplierId: supplierId || undefined, acknowledgeDuplicate: ackDup || undefined }),
                  () => 'Invoice verified.',
                )
              }
            >
              <ShieldCheck className="h-4 w-4" /> Confirm invoice verified
            </Button>
          </div>
        </section>
      )}

      {/* ---- purchase order ---- */}
      {verified && (
        <section aria-label="Purchase order" className="space-y-3">
          <h3 className="text-sm font-bold">Purchase order</h3>
          {purchase ? (
            <div className="space-y-3 rounded-xl border border-success/40 bg-success/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-semibold">
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> {purchaseMode(purchase)}
              </p>
              <p className="text-muted">The invoice is recorded in the purchase history. No stock has changed yet.</p>
              <div className="flex justify-end">
                <Button variant="accent" onClick={() => onProceed(order)}>
                  Proceed to Goods Receipt
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Purchase order options" className="flex gap-1 border-b border-line">
                {[
                  ['create', 'Create new purchase order'],
                  ['link', 'Link existing purchase order'],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    role="tab"
                    type="button"
                    aria-selected={mode === k}
                    onClick={() => setMode(k)}
                    className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', mode === k ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {failure && (
                <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {failure}
                </p>
              )}
              {mode === 'create' ? (
                <div className="space-y-3 rounded-xl border border-line p-3 text-sm">
                  <p className="text-muted">
                    An order is made in Orders from this invoice: {rec?.name || read.name}, invoice {r.invoice.invoiceNumber}, {r.lines.length} product
                    {r.lines.length === 1 ? '' : 's'}, quantities, free quantities, purchase rates, discounts, GST and the additional charges.
                  </p>
                  <label className="block text-xs font-semibold text-muted sm:max-w-xs">
                    Receiving branch
                    <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={cx(inputCls, 'mt-1 font-normal text-ink')} aria-label="Receiving branch">
                      <option value="">Main store</option>
                      {branchList.filter((b) => b.status === 'active').map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} className="mt-1" />
                    <span>Also mark it as ordered, so goods can be received (this follows your approval settings and permissions).</span>
                  </label>
                  <div className="flex justify-end">
                    <Button
                      variant="accent"
                      loading={busy}
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => aiBillingService.createPurchaseOrder(id, { ...(branchId && { branchId }), status: ordered ? 'ordered' : 'draft' }),
                          (o) => `Purchase order ${o.order.orderNo} created — no stock changed.${o.note ? ` ${o.note}` : ''}`,
                        )
                      }
                    >
                      Create Purchase Order
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <SearchInput value={search} onChange={setSearch} placeholder="Order ID, supplier, supplier invoice number or PO number" label="Search orders" />
                  {!options ? (
                    <Skeleton className="h-20 w-full" />
                  ) : options.error ? (
                    <ErrorState message={options.error} />
                  ) : options.orders.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">No matching orders. Create a new purchase order instead.</p>
                  ) : (
                    <ul aria-label="Orders" className="space-y-2">
                      {options.orders.map((o) => (
                        <OrderOption
                          key={o._id}
                          o={o}
                          busy={busy}
                          onLink={(ord, ack) =>
                            act(
                              () => aiBillingService.linkPurchaseOrder(id, { orderId: ord._id, acknowledgeDifferences: ack }),
                              () => `Linked to ${ord.orderNo}. The order was not changed.`,
                            )
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
