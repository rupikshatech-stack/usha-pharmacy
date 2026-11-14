import { useEffect, useState } from 'react';
import { AlertTriangle, Building2, Check, Plus, Save, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { orderService } from '../../services/orderService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { expiryFmt, inr, newIdempotencyKey } from '../../utils/format';
import {
  PAYMENT_STATUS_LABEL,
  blankCharges,
  blankPayment,
  computeOrder,
  lineFromProduct,
  orderErrorsFromServer,
  orderToForm,
  supplierOrderTerms,
  supplierTermsNote,
  toCalcInput,
  toOrderPayload,
  toOrderUpdatePayload,
  validateOrder,
} from '../../utils/orderForm';
import { Button, ErrorState, FormField, Modal, SearchInput, Skeleton, cx, inputCls } from '../common/ui';
import NewSupplierDialog from './NewSupplierDialog';

const numCls = 'h-9 text-right tabular-nums';
const today = () => new Date().toISOString().slice(0, 10);

const Section = ({ n, title, hint, children }) => (
  <section aria-label={title} className="rounded-xl border border-line p-4">
    <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-sage text-[11px] text-sage-ink" aria-hidden="true">
        {n}
      </span>
      {title}
    </h3>
    {hint && <p className="-mt-1 mb-3 text-xs text-muted">{hint}</p>}
    {children}
  </section>
);

const Row = ({ label, value, strong, muted }) => (
  <div className={cx('flex items-center justify-between gap-4 py-1 text-sm', strong && 'border-t border-line pt-2 text-base font-extrabold', muted && 'text-muted')}>
    <dt>{label}</dt>
    <dd className="tabular-nums">{value}</dd>
  </div>
);

/**
 * Add Order: the supplier (with their details), the products (searched from the existing inventory, with stock, unit and last purchase
 * price), per-line quantity / free quantity / rate / discount / GST, the extra charges, a live summary, and the payment terms.
 * Every number is calculated in whole paise as you type; the server recalculates and checks it all before saving.
 * Payment is only recorded: nothing is paid or started from here.
 *
 * The idempotency key is made once when the form opens and reused for every attempt, so a double click or a retry after a timeout
 * cannot create the order twice.
 */
export default function AddOrderDialog({ order, supplierId, onDone, onClose }) {
  const editing = Boolean(order); // editing a draft: the same form, filled in
  const init = order ? orderToForm(order) : null;
  const meta = useFetch('/orders/meta');
  const suppliers = useFetch('/suppliers', { limit: 100 });
  const branches = useFetch('/branches');
  const [key] = useState(() => newIdempotencyKey());
  const [f, setF] = useState(() => init?.f || { orderDate: today(), expectedDate: '', supplierId: supplierId || '', branchId: '', referenceNo: '', notes: '' });
  const [lines, setLines] = useState(() => init?.lines || []);
  const [charges, setCharges] = useState(() => init?.charges || blankCharges());
  const [payment, setPayment] = useState(() => init?.payment || blankPayment());
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const found = useFetch('/orders/products', { search: q });
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(null); // 'draft' | 'ordered'
  const [termsChosen, setTermsChosen] = useState(false); // once the person picks the terms themselves, the supplier never overrides them

  const supplier = suppliers.data?.items.find((s) => s._id === f.supplierId);
  const suggestedTerms = !editing && !termsChosen ? supplierOrderTerms(supplier) : null;
  // choosing a supplier starts the terms off at whatever they are normally paid on; it is only a starting point and changing it sticks
  useEffect(() => {
    if (suggestedTerms && suggestedTerms !== payment.terms) setPayment((p) => ({ ...p, terms: suggestedTerms, ...(['cod', 'credit'].includes(suggestedTerms) && { advance: '' }) }));
  }, [suggestedTerms, payment.terms]);
  const defaultBranch = branches.data?.find((b) => b.isDefault);
  const branchId = f.branchId || defaultBranch?._id || '';
  const set = (patch) => {
    setF((x) => ({ ...x, ...patch }));
    setServerErrors({});
  };
  const state = { ...f, branchId, lines, charges, payment };
  const errors = validateOrder(state);
  const shown = (k, live = false) => serverErrors[k] || (submitted || live ? errors[k] : undefined);
  const calc = computeOrder(toCalcInput(state));
  const gstRates = meta.data?.gstRates || [0, 5, 12, 18, 28];

  const add = (p) => {
    if (lines.some((l) => l.key === p._id)) return;
    setLines((ls) => [...ls, lineFromProduct(p)]);
    setServerErrors({});
  };
  const setLine = (k, patch) => {
    setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
    setServerErrors({});
  };
  const setCharge = (patch) => {
    setCharges((c) => ({ ...c, ...patch }));
    setServerErrors({});
  };
  const setPay = (patch) => {
    setPayment((p) => ({ ...p, ...patch }));
    setServerErrors({});
  };

  const submit = async (status) => {
    setSubmitted(true);
    setGeneral('');
    if (busy || Object.keys(errors).length) return;
    setBusy(status);
    try {
      const o = editing ? await orderService.update(order._id, toOrderUpdatePayload(state)) : await orderService.create(toOrderPayload(state, status, key));
      if (editing) toast.success(`Order ${o.orderNo} updated — ${inr(o.grandTotal)}`);
      else toast.success(`Order ${o.orderNo} ${o.status === 'draft' ? 'saved as a draft' : o.status === 'pending' ? 'submitted for approval' : 'approved'} — ${inr(o.grandTotal)}`);
      onDone(o);
    } catch (e) {
      const { fields, general: g } = orderErrorsFromServer(e, lines);
      setServerErrors(fields);
      setGeneral(g);
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const sel = (error) => cx(inputCls, 'pr-8', error && 'border-danger');
  const chargesTotal = calc.chargesTotal + calc.chargesGst;

  return (
    <>
      <Modal
        wide="xl"
        title={editing ? `Edit Order ${order.orderNo}` : 'Add Order'}
        description={
          editing
            ? 'Change this draft. It is saved as a draft again; submit it from its details when it is ready.'
            : 'Order stock from a supplier. Payment is only recorded here; nothing is paid from this screen.'
        }
        onClose={() => !busy && onClose()}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={Boolean(busy)}>
              Cancel
            </Button>
            {editing ? (
              <Button variant="accent" onClick={() => submit('draft')} loading={busy === 'draft'} disabled={Boolean(busy)}>
                <Save className="h-4 w-4" /> Save changes
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => submit('draft')} loading={busy === 'draft'} disabled={Boolean(busy)}>
                  <Save className="h-4 w-4" /> Save as draft
                </Button>
                <Button variant="accent" onClick={() => submit('submitted')} loading={busy === 'submitted'} disabled={Boolean(busy)}>
                  <Check className="h-4 w-4" /> Submit order
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="space-y-4">
          {/* A. Order information */}
          <Section n="A" title="Order information">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <FormField label="Order ID" hint={editing ? undefined : 'Assigned when the order is saved.'}>
                {(a) => <input {...a} readOnly value={editing ? order.orderNo : meta.data?.nextOrderNo || '…'} className={cx(inputCls, 'bg-subtle font-mono')} />}
              </FormField>
              <FormField label="Order date" required>
                {(a) => <input {...a} type="date" value={f.orderDate} onChange={(e) => set({ orderDate: e.target.value })} className={inputCls} />}
              </FormField>
              <FormField label="Expected delivery date" error={shown('expectedDate')}>
                {(a) => (
                  <input
                    {...a}
                    type="date"
                    min={f.orderDate || undefined}
                    value={f.expectedDate}
                    onChange={(e) => set({ expectedDate: e.target.value })}
                    className={cx(inputCls, shown('expectedDate') && 'border-danger')}
                  />
                )}
              </FormField>
              <FormField label="Supplier" required error={shown('supplierId')}>
                {(a) => (
                  <div className="flex gap-2">
                    <select {...a} value={f.supplierId} onChange={(e) => set({ supplierId: e.target.value })} className={sel(shown('supplierId'))}>
                      <option value="">{suppliers.loading && !suppliers.data ? 'Loading suppliers…' : 'Choose a supplier…'}</option>
                      {(suppliers.data?.items || []).map((s) => (
                        <option key={s._id} value={s._id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <Button type="button" variant="secondary" className="shrink-0 px-3" onClick={() => setAddingSupplier(true)} aria-label="Add a new supplier">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </FormField>
              <FormField label="Branch" required error={shown('branchId')} hint="Where the goods will be delivered.">
                {(a) => (
                  <select {...a} value={branchId} onChange={(e) => set({ branchId: e.target.value })} className={sel(shown('branchId'))}>
                    {(branches.data || [])
                      .filter((b) => b.status === 'active')
                      .map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.name}
                          {b.isDefault ? ' (main)' : ''}
                        </option>
                      ))}
                  </select>
                )}
              </FormField>
              <FormField label="Order reference number" error={shown('referenceNo')} hint="The supplier’s quote or PO number, if any.">
                {(a) => <input {...a} maxLength={60} value={f.referenceNo} onChange={(e) => set({ referenceNo: e.target.value })} className={inputCls} />}
              </FormField>
              <FormField label="Order notes" error={shown('notes')} className="sm:col-span-2 xl:col-span-3">
                {(a) => <textarea {...a} rows={2} maxLength={500} value={f.notes} onChange={(e) => set({ notes: e.target.value })} className={cx(inputCls, 'h-auto py-2')} />}
              </FormField>
            </div>
            {suppliers.error && <ErrorState message={suppliers.error} onRetry={suppliers.reload} />}
            {supplier && (
              <div className="mt-3 rounded-lg bg-sage/40 p-3" aria-label="Supplier details">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Building2 className="h-4 w-4 text-muted" aria-hidden="true" /> {supplier.name}
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
                  {[
                    ['Contact person', supplier.contactPerson],
                    ['Phone number', supplier.phone],
                    ['Email', supplier.email],
                    ['GST number', supplier.gstin],
                    ['Address', supplier.addressLine],
                    ['Owed to this supplier', supplier.outstandingAmount > 0 ? `${inr(supplier.outstandingAmount)} across ${supplier.openOrders} open order${supplier.openOrders === 1 ? '' : 's'}` : 'Nothing outstanding'],
                  ].map(([k, v]) => (
                    <div key={k} className={k === 'Address' ? 'col-span-2' : ''}>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{k}</dt>
                      <dd className="mt-0.5 break-words font-medium">{v || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </Section>

          {/* B. Products */}
          <Section n="B" title="Add products to order" hint="Search your products by name, generic name, SKU, manufacturer or batch number.">
            <SearchInput value={search} onChange={setSearch} label="Search products" placeholder="Search products…" />
            <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line">
              {found.loading && !found.data ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-2/3" />
                </div>
              ) : found.error ? (
                <ErrorState message={found.error} onRetry={found.reload} />
              ) : found.data?.length ? (
                <ul className="divide-y divide-line" aria-label="Matching products">
                  {found.data.map((p) => {
                    const added = lines.some((l) => l.key === p._id);
                    return (
                      <li key={p._id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <div className="min-w-0">
                          <div className="font-semibold">
                            {p.name} {p.unit && <span className="font-normal text-muted">· {p.unit}</span>}
                          </div>
                          <div className="text-xs text-muted">
                            {[p.sku && `SKU ${p.sku}`, p.genericName, p.manufacturer, p.category].filter(Boolean).join(' · ') || 'No further details'}
                          </div>
                          <div className="text-xs text-muted">
                            Stock {p.currentStock} · last purchase price {p.purchasePrice > 0 ? inr(p.purchasePrice) : '—'}
                            {p.batches.length > 0 &&
                              ` · batches: ${p.batches
                                .slice(0, 2)
                                .map((b) => `${b.batchNumber} (${b.quantity}, exp ${expiryFmt(b.expiryDate)})`)
                                .join(', ')}`}
                          </div>
                        </div>
                        <Button size="sm" variant="secondary" disabled={added} onClick={() => add(p)} aria-label={added ? `${p.name} is already on the order` : `Add ${p.name}`}>
                          {added ? (
                            'Added'
                          ) : (
                            <>
                              <Plus className="h-3.5 w-3.5" /> Add
                            </>
                          )}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-3 py-4 text-center text-sm text-muted">No product matches “{q}”.</p>
              )}
            </div>

            {shown('lines') && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {shown('lines')}
              </p>
            )}
            {lines.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      {['Product', 'Quantity', 'Free qty', 'Purchase rate', 'Discount %', 'GST %', 'GST amount', 'Total amount', ''].map((h, i) => (
                        <th key={h || 'x'} scope="col" className={cx('px-3 py-2 font-semibold', i >= 1 && i <= 7 && 'text-right')}>
                          {h || <span className="sr-only">Remove</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, n) => {
                      const c = calc.lines[n];
                      const err = (field) => shown(`line.${l.key}.${field}`, true);
                      const cell = (field, label, width, extra) => (
                        <td className="px-2 py-2 text-right align-top">
                          <input
                            inputMode="decimal"
                            aria-label={`${label} of ${l.product.name}`}
                            aria-invalid={Boolean(err(field))}
                            value={l[field]}
                            onChange={(e) => setLine(l.key, { [field]: e.target.value })}
                            className={cx(inputCls, numCls, width, err(field) && 'border-danger', extra)}
                          />
                          {err(field) && (
                            <p role="alert" className="ml-auto mt-1 max-w-[9rem] text-right text-[11px] text-danger">
                              {err(field)}
                            </p>
                          )}
                        </td>
                      );
                      return (
                        <tr key={l.key} className="border-t border-line">
                          <td className="px-3 py-2 align-top">
                            <div className="font-medium">{l.product.name}</div>
                            <div className="text-xs text-muted">
                              {[l.product.unit, l.product.sku && `SKU ${l.product.sku}`, l.product.genericName, l.product.manufacturer, l.product.category]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                            {l.product.currentStock !== undefined && <div className="text-xs text-muted">Stock {l.product.currentStock}</div>}
                          </td>
                          {cell('quantity', 'Quantity', 'w-20')}
                          {cell('freeQuantity', 'Free quantity', 'w-20')}
                          {cell('rate', 'Purchase rate', 'w-24')}
                          {cell('discountPercent', 'Discount %', 'w-20')}
                          {cell('gstPercent', 'GST %', 'w-20')}
                          <td className="px-3 py-2 text-right tabular-nums">{inr(c.gstAmount)}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{inr(c.total)}</td>
                          <td className="px-2 py-2 text-right">
                            <Button size="sm" variant="ghost" aria-label={`Remove ${l.product.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* C. Additional charges + summary */}
          <Section n="C" title="Additional charges">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ['shipping', 'Shipping charges'],
                  ['packaging', 'Packaging charges'],
                  ['other', 'Other charges'],
                  ['additionalDiscount', 'Additional discount'],
                ].map(([k, label]) => (
                  <FormField key={k} label={`${label} (₹)`} error={shown(`charges.${k}`)}>
                    {(a) => (
                      <input
                        {...a}
                        inputMode="decimal"
                        value={charges[k]}
                        placeholder="0.00"
                        onChange={(e) => setCharge({ [k]: e.target.value })}
                        className={cx(inputCls, 'tabular-nums', shown(`charges.${k}`) && 'border-danger')}
                      />
                    )}
                  </FormField>
                ))}
                <FormField label="GST on charges" error={shown('charges.gstPercent')}>
                  {(a) => (
                    <select {...a} value={charges.gstPercent} onChange={(e) => setCharge({ gstPercent: e.target.value })} className={sel(shown('charges.gstPercent'))}>
                      {gstRates.map((r) => (
                        <option key={r} value={String(r)}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
              </div>
              <section aria-label="Order summary" className="rounded-xl bg-subtle p-4">
                <h4 className="mb-2 text-sm font-bold">Order summary</h4>
                <dl>
                  <Row label="Total items" value={calc.totalItems} />
                  <Row label="Total quantity" value={calc.totalFreeQuantity ? `${calc.totalQuantity} + ${calc.totalFreeQuantity} free` : calc.totalQuantity} />
                  <Row label="Subtotal" value={inr(calc.subtotal)} />
                  <Row label="Discount" value={`− ${inr(calc.discount)}`} />
                  <Row label="Tax (GST)" value={inr(calc.gst)} />
                  <Row label="Additional charges" value={inr(chargesTotal)} />
                  {calc.additionalDiscount > 0 && <Row label="Additional discount" value={`− ${inr(calc.additionalDiscount)}`} />}
                  <Row label="Grand total" value={inr(calc.grandTotal)} strong />
                </dl>
              </section>
            </div>
          </Section>

          {/* D. Payment */}
          <Section n="D" title="Payment information" hint="This only records what was agreed or paid. No payment is made or started from here.">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <FormField label="Payment terms" required hint={supplier && !termsChosen ? supplierTermsNote(supplier) : undefined}>
                {(a) => (
                  <select
                    {...a}
                    value={payment.terms}
                    onChange={(e) => {
                      setTermsChosen(true);
                      setPay({ terms: e.target.value, ...(['cod', 'credit'].includes(e.target.value) && { advance: '' }) });
                    }}
                    className={sel()}
                  >
                    {(
                      meta.data?.paymentTerms || [
                        { value: 'cod', label: 'Cash on Delivery' },
                        { value: 'advance', label: 'Advance Payment' },
                        { value: 'credit', label: 'Credit' },
                        { value: 'partial', label: 'Partial Payment' },
                      ]
                    ).map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label="Payment method" error={shown('payment.method')}>
                {(a) => (
                  <select {...a} value={payment.method} onChange={(e) => setPay({ method: e.target.value })} className={sel(shown('payment.method'))}>
                    <option value="">Not paid yet</option>
                    {(meta.data?.paymentMethods || ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque']).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label="Advance payment (₹)" error={shown('payment.advance')}>
                {(a) => (
                  <input
                    {...a}
                    inputMode="decimal"
                    value={payment.advance}
                    placeholder="0.00"
                    disabled={['cod', 'credit'].includes(payment.terms)}
                    onChange={(e) => setPay({ advance: e.target.value })}
                    className={cx(inputCls, 'tabular-nums', shown('payment.advance') && 'border-danger')}
                  />
                )}
              </FormField>
              <FormField label="Remaining amount (₹)">
                {(a) => <input {...a} readOnly value={calc.remaining.toFixed(2)} className={cx(inputCls, 'bg-subtle tabular-nums')} />}
              </FormField>
              <FormField label="Payment status">
                {(a) => <input {...a} readOnly value={PAYMENT_STATUS_LABEL[calc.paymentStatus]} className={cx(inputCls, 'bg-subtle')} />}
              </FormField>
            </div>
          </Section>

          {general && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {general}
            </p>
          )}
          {submitted && Object.keys(errors).length > 0 && !busy && (
            <p role="status" className="text-sm text-danger">
              Please fix the highlighted fields before saving the order.
            </p>
          )}
        </div>
      </Modal>
      {addingSupplier && (
        <NewSupplierDialog
          onClose={() => setAddingSupplier(false)}
          onDone={(s) => {
            setAddingSupplier(false);
            suppliers.reload();
            set({ supplierId: s._id });
          }}
        />
      )}
    </>
  );
}
