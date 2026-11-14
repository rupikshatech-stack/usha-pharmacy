import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Plus, Trash2 } from 'lucide-react';
import { inr } from '../../utils/format';
import { blankLine, lineStatus, productFrom } from '../../utils/aiBilling';
import { Badge, Button, FormField, cx, inputCls } from '../common/ui';
import ProductPicker from './ProductPicker';

const numCls = 'h-9 text-right tabular-nums';
const STATUS = {
  ready: { tone: 'success', text: 'Checked' },
  'needs-product': { tone: 'warning', text: 'Choose product' },
  'check-numbers': { tone: 'danger', text: 'Check numbers' },
};

/**
 * The review of one invoice, read by a service or typed in by hand: the supplier and invoice details, an editable table of medicines (each matched to
 * an existing product only when the match was exact — otherwise the user chooses), the totals beside what the invoice says, and the confirmation.
 * It only edits the review in memory; saving is the page's job. Nothing here touches stock.
 */
export default function InvoiceReview({ r, setR, errors, show, suppliers, onAddSupplier, totals, confirmed, setConfirmed, onMatchName }) {
  const [picking, setPicking] = useState(null); // the line being matched by hand
  const shown = (k) => (show ? errors[k] : undefined);
  const setLine = (k, patch) => setR((x) => ({ ...x, lines: x.lines.map((l) => (l.key === k ? { ...l, ...patch } : l)) }));
  const pick = (l, p) => {
    setLine(l.key, {
      product: p,
      manufacturer: l.manufacturer || p.manufacturer || '',
      gstPercent: l.gstPercent === '' && p.gstPercent !== undefined ? String(p.gstPercent) : l.gstPercent,
    });
    setPicking(null);
  };
  const attention = r.lines.filter((l) => lineStatus(l) !== 'ready').length;
  const st = r.stated || {};

  return (
    <div className="space-y-4">
      <section aria-label="Invoice details" className="rounded-xl border border-line p-4">
        <h3 className="mb-3 text-sm font-bold">Supplier and invoice</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FormField label="Supplier" required error={shown('supplierId')}>
            {(a) => (
              <div className="flex gap-2">
                <select
                  {...a}
                  value={r.supplierId}
                  onChange={(e) => setR((x) => ({ ...x, supplierId: e.target.value }))}
                  className={cx(inputCls, 'pr-8', shown('supplierId') && 'border-danger')}
                >
                  <option value="">Choose a supplier…</option>
                  {(suppliers.data?.items || []).map((s) => (
                    <option key={s._id} value={s._id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <Button type="button" variant="secondary" className="shrink-0 px-3" onClick={onAddSupplier} aria-label="Add a new supplier">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            )}
          </FormField>
          <FormField label="Invoice number" error={shown('invoiceNo')}>
            {(a) => <input {...a} maxLength={60} value={r.invoiceNo} onChange={(e) => setR((x) => ({ ...x, invoiceNo: e.target.value }))} className={inputCls} />}
          </FormField>
          <FormField label="Invoice date">
            {(a) => <input {...a} type="date" value={r.invoiceDate} onChange={(e) => setR((x) => ({ ...x, invoiceDate: e.target.value }))} className={inputCls} />}
          </FormField>
        </div>
        {r.source === 'ai' && (r.supplier.read.name || r.supplier.read.gstin || r.supplier.read.address) && (
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3" aria-label="Supplier as read">
            <div>
              <dt className="inline font-semibold">Supplier read: </dt>
              <dd className="inline text-ink">{r.supplier.read.name || '—'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">GSTIN: </dt>
              <dd className="inline text-ink">{r.supplier.read.gstin || '—'}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Address: </dt>
              <dd className="inline text-ink">{r.supplier.read.address || '—'}</dd>
            </div>
            <p className="sm:col-span-3">
              {r.supplier.match.status === 'exact'
                ? `Matched to your supplier by ${r.supplier.match.by === 'gstin' ? 'GST number' : 'name'}.`
                : r.supplier.match.status === 'possible'
                  ? `Not an exact match — choose the supplier above (suggestions: ${r.supplier.match.candidates.map((c) => c.name).join(', ')}).`
                  : 'No supplier of yours matches — choose or add one.'}
            </p>
          </dl>
        )}
      </section>

      <section aria-label="Invoice lines" className="rounded-xl border border-line p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">Medicines on the invoice</h3>
          <p className="text-xs text-muted" aria-live="polite">
            {attention === 0 ? 'Every line is checked.' : `${attention} line${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention.`}
          </p>
        </div>
        {shown('lines') && (
          <p role="alert" className="mb-2 text-sm text-danger">
            {shown('lines')}
          </p>
        )}
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[1500px] text-left text-sm">
            <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
              <tr>
                {['As on the invoice', 'Product', 'Manufacturer', 'Batch', 'Mfg date', 'Expiry', 'Qty', 'Free', 'Rate', 'MRP', 'Disc %', 'GST %', 'Line total', 'Review', ''].map(
                  (h, i) => (
                    <th key={h || 'x'} scope="col" className={cx('px-2 py-2 font-semibold', i >= 6 && i <= 12 && 'text-right')}>
                      {h || <span className="sr-only">Remove</span>}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l, n) => {
                const s = lineStatus(l);
                const err = (f) => shown(`line.${l.key}.${f}`);
                const lineTotal = s === 'ready' ? Number(l.quantity) * Number(l.rate) * (1 - Number(l.discountPercent) / 100) * (1 + Number(l.gstPercent) / 100) : null;
                const field = (f, label, w, extra = {}) => (
                  <td className={cx('px-2 py-2 align-top', extra.right && 'text-right')}>
                    <input
                      {...(extra.type ? { type: extra.type } : { inputMode: extra.text ? 'text' : 'decimal' })}
                      aria-label={`${label} of line ${n + 1}`}
                      aria-invalid={Boolean(err(f))}
                      value={l[f]}
                      onChange={(e) => setLine(l.key, { [f]: e.target.value })}
                      className={cx(inputCls, extra.right && numCls, 'h-9', w, err(f) && 'border-danger')}
                    />
                    {err(f) && (
                      <p role="alert" className={cx('mt-1 max-w-[9rem] text-[11px] text-danger', extra.right && 'ml-auto text-right')}>
                        {err(f)}
                      </p>
                    )}
                  </td>
                );
                return (
                  <tr key={l.key} className={cx('border-t border-line', s !== 'ready' && 'bg-warning/5')}>
                    <td className="px-2 py-2 align-top">
                      <input
                        aria-label={`Name on the invoice of line ${n + 1}`}
                        value={l.name}
                        onChange={(e) => setLine(l.key, { name: e.target.value })}
                        onBlur={() => onMatchName?.(l)}
                        placeholder="Medicine as written"
                        className={cx(inputCls, 'h-9 min-w-[10rem]')}
                      />
                      {l.issues.length > 0 && <p className="mt-1 max-w-[14rem] text-[11px] text-warning">{l.issues.join(' ')}</p>}
                    </td>
                    <td className="min-w-[13rem] px-2 py-2 align-top">
                      {l.product ? (
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-medium">{l.product.name}</div>
                            <div className="text-xs text-muted">{[l.product.unit, l.product.sku].filter(Boolean).join(' · ')}</div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => setPicking(l.key)} aria-label={`Change the product of line ${n + 1}`}>
                            Change
                          </Button>
                        </div>
                      ) : picking === l.key ? (
                        <ProductPicker onPick={(p) => pick(l, p)} onCancel={() => setPicking(null)} />
                      ) : (
                        <div className="space-y-1">
                          {l.match.candidates.map((c) => (
                            <Button key={String(c.medicineId)} size="sm" variant="secondary" onClick={() => pick(l, productFrom(c))} aria-label={`Use ${c.name} for line ${n + 1}`}>
                              Use {c.name} ({Math.round(c.score * 100)}% alike)
                            </Button>
                          ))}
                          <Button size="sm" variant="ghost" onClick={() => setPicking(l.key)} aria-label={`Search a product for line ${n + 1}`}>
                            Search products…
                          </Button>
                          {err('product') && (
                            <p role="alert" className="text-[11px] text-danger">
                              {err('product')}
                            </p>
                          )}
                        </div>
                      )}
                      {l.product && err('product') && (
                        <p role="alert" className="mt-1 text-[11px] text-danger">
                          {err('product')}
                        </p>
                      )}
                    </td>
                    {field('manufacturer', 'Manufacturer', 'w-32', { text: true })}
                    {field('batchNumber', 'Batch number', 'w-28', { text: true })}
                    {field('manufacturingDate', 'Manufacturing date', 'w-36', { type: 'date' })}
                    {field('expiryDate', 'Expiry date', 'w-36', { type: 'date' })}
                    {field('quantity', 'Quantity', 'w-20', { right: true })}
                    {field('freeQuantity', 'Free quantity', 'w-16', { right: true })}
                    {field('rate', 'Rate', 'w-24', { right: true })}
                    {field('mrp', 'MRP', 'w-24', { right: true })}
                    {field('discountPercent', 'Discount %', 'w-16', { right: true })}
                    {field('gstPercent', 'GST %', 'w-16', { right: true })}
                    <td className="px-2 py-2 text-right align-top font-semibold tabular-nums">{lineTotal === null ? '—' : inr(Math.round(lineTotal * 100) / 100)}</td>
                    <td className="px-2 py-2 align-top">
                      <Badge tone={STATUS[s].tone}>{STATUS[s].text}</Badge>
                      {l.confidence !== null && l.confidence !== undefined && (
                        <div className={cx('mt-1 text-[11px]', l.confidence < 0.8 ? 'font-semibold text-warning' : 'text-muted')}>{Math.round(l.confidence * 100)}% confident</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right align-top">
                      <Button size="sm" variant="ghost" onClick={() => setR((x) => ({ ...x, lines: x.lines.filter((y) => y.key !== l.key) }))} aria-label={`Remove line ${n + 1}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setR((x) => ({ ...x, lines: [...x.lines, blankLine()] }))}>
          <Plus className="h-3.5 w-3.5" /> Add a line
        </Button>
      </section>

      <section aria-label="Invoice totals" className="grid gap-4 md:grid-cols-2">
        <dl className="rounded-xl bg-subtle p-4 text-sm">
          {[
            ['Subtotal', inr(totals.subtotal)],
            ['Discount', `− ${inr(totals.discount)}`],
            ['Taxable amount', inr(Math.round((totals.subtotal - totals.discount) * 100) / 100)],
            ['GST', inr(totals.gst)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between py-0.5 text-muted">
              <dt>{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 py-0.5 text-muted">
            <dt>
              <label htmlFor="additional-charges">Additional charges (₹)</label>
            </dt>
            <dd>
              <input
                id="additional-charges"
                inputMode="decimal"
                value={r.additionalCharges ?? ''}
                onChange={(e) => setR((x) => ({ ...x, additionalCharges: e.target.value === '' ? null : e.target.value }))}
                className={cx(inputCls, numCls, 'h-8 w-28')}
              />
            </dd>
          </div>
          <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-extrabold">
            <dt>Total from the lines</dt>
            <dd className="tabular-nums">{inr(totals.grandTotal)}</dd>
          </div>
          {totals.readyLines < r.lines.length && (
            <p className="mt-1 text-xs text-muted">
              Only the {totals.readyLines} checked line{totals.readyLines === 1 ? '' : 's'} are counted.
            </p>
          )}
        </dl>
        <div className="space-y-3 rounded-xl border border-line p-4 text-sm" aria-live="polite">
          <FormField label="Invoice total (as printed)" hint="Compared with the total worked out from the lines.">
            {(a) => (
              <input
                {...a}
                inputMode="decimal"
                value={r.statedTotal ?? ''}
                onChange={(e) => setR((x) => ({ ...x, statedTotal: e.target.value === '' ? null : Number(e.target.value) }))}
                className={cx(inputCls, 'tabular-nums')}
              />
            )}
          </FormField>
          {(st.subtotal != null || st.taxableAmount != null || st.cgst != null || st.sgst != null || st.igst != null) && (
            <p className="text-xs text-muted">
              The invoice says:
              {st.subtotal != null ? ` subtotal ${inr(st.subtotal)}` : ''}
              {st.taxableAmount != null ? ` · taxable ${inr(st.taxableAmount)}` : ''}
              {st.cgst != null ? ` · CGST ${inr(st.cgst)}` : ''}
              {st.sgst != null ? ` · SGST ${inr(st.sgst)}` : ''}
              {st.igst != null ? ` · IGST ${inr(st.igst)}` : ''}
            </p>
          )}
          {totals.matchesInvoice === null ? (
            <p className="text-muted">Enter the invoice total to compare it with the lines.</p>
          ) : totals.matchesInvoice ? (
            <p className="flex items-start gap-2 text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> The total from the lines matches the invoice ({inr(totals.stated)}).
            </p>
          ) : (
            <p role="alert" className="flex items-start gap-2 text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> The lines add up to {inr(totals.grandTotal)} but the invoice says {inr(totals.stated)} (a
              difference of {inr(Math.abs(totals.difference))}). Check the quantities, rates and GST.
            </p>
          )}
        </div>
      </section>

      <label className={cx('flex items-start gap-2 rounded-xl border p-3 text-sm', shown('confirmed') ? 'border-danger' : 'border-line')}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          aria-label="I have checked these details against the invoice"
        />
        <span>
          I have checked these details against the invoice.
          {shown('confirmed') && (
            <span role="alert" className="block text-xs text-danger">
              {shown('confirmed')}
            </span>
          )}
          <span className="mt-0.5 flex items-start gap-1 text-xs text-muted">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> Saving makes a draft order and changes no stock. Stock is only added when you confirm what actually
            arrived, in the Goods Received form.
          </span>
        </span>
      </label>
    </div>
  );
}
