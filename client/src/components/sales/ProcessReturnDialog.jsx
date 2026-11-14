import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, PackageCheck, Receipt, Undo2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesReturnService } from '../../services/salesReturnService';
import { useDebounced, useFetch } from '../../hooks/useFetch';
import { dateFmt, expiryFmt, inr, newIdempotencyKey } from '../../utils/format';
import {
  CONDITION_LABEL,
  blankRefund,
  defaultRefund,
  fieldErrorsFromServer,
  lineAmount,
  linesFromInvoice,
  normalizeRestock,
  restockBlock,
  returnTotal,
  selectedLines,
  toPayload,
  validateReturn,
} from '../../utils/salesReturnValidation';
import { Button, ErrorState, FormField, Modal, SearchInput, Skeleton, cx, inputCls } from '../common/ui';

const numCls = 'h-9 w-20 px-1.5 text-right tabular-nums';
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

/**
 * Process New Return: find the original invoice, choose what is coming back (never more than was bought minus what already came back),
 * say why, check each unit's condition and decide on restocking, then record the refund. Amounts are computed here for display and again
 * by the server, which is the only one that decides. Nothing is paid from here — the refund is only recorded.
 *
 * Restocking is never automatic: a line is restocked only when its units are good, the reason allows it, the batch can take them back,
 * and the person ticks that they inspected them.
 *
 * The idempotency key is made once when the dialog opens and reused for every attempt, so a double click or a retry after a timeout
 * cannot record the return (or restock the units) twice.
 */
export default function ProcessReturnDialog({ onDone, onClose }) {
  const meta = useFetch('/sales-returns/meta');
  const m = meta.data;
  const noRestock = m?.noRestockReasons || ['expired', 'damaged'];
  const [key] = useState(() => newIdempotencyKey());
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const found = useFetch('/sales-returns/invoices', { search: q });
  const [invoice, setInvoice] = useState(null);
  const [loadingInvoice, setLoadingInvoice] = useState(false);
  const [invoiceError, setInvoiceError] = useState('');
  const [lines, setLines] = useState([]);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [refund, setRefund] = useState(blankRefund());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [busy, setBusy] = useState(false);

  const total = returnTotal(lines);
  const refundNow = { ...refund, amount: refund.amountTouched ? refund.amount : total > 0 ? defaultRefund(invoice, total).toFixed(2) : '' };
  const state = { invoice, lines, reason, notes, refund: refundNow };
  const errors = validateReturn(state, noRestock);
  const shown = (k, live = false) => serverErrors[k] || (submitted || live ? errors[k] : undefined);
  const chosen = selectedLines(lines);
  const restockUnits = chosen.filter((l) => l.restock).reduce((n, l) => n + (Number(l.quantity) || 0), 0);

  const choose = async (id) => {
    setLoadingInvoice(true);
    setInvoiceError('');
    try {
      const inv = await salesReturnService.invoice(id);
      setInvoice(inv);
      setLines(linesFromInvoice(inv));
      setServerErrors({});
      setRefund(blankRefund());
    } catch (e) {
      setInvoiceError(e.message);
    } finally {
      setLoadingInvoice(false);
    }
  };
  const change = () => {
    setInvoice(null);
    setLines([]);
    setServerErrors({});
    setRefund(blankRefund());
  };
  const setLine = (k, patch) => {
    setLines((ls) => ls.map((l) => (l.key === k ? normalizeRestock({ ...l, ...patch }, reason, noRestock) : l)));
    setServerErrors({});
  };
  const changeReason = (r) => {
    setReason(r);
    setLines((ls) => ls.map((l) => normalizeRestock(l, r, noRestock)));
    setServerErrors({});
  };

  const confirm = async () => {
    setSubmitted(true);
    setGeneral('');
    if (busy || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const r = await salesReturnService.create(toPayload(state, key));
      const units = r.items.reduce((n, i) => n + (i.restockedQuantity || 0), 0);
      toast.success(`Return ${r.returnNo} recorded — ${inr(r.returnValue)}${units ? `, ${units} unit${units === 1 ? '' : 's'} back in stock` : ', nothing restocked'}`);
      onDone(r);
    } catch (e) {
      const { fields, general: g } = fieldErrorsFromServer(e, lines);
      setServerErrors(fields);
      setGeneral(g);
      toast.error(e.message);
      if (e.status === 409 && invoice) choose(invoice._id); // someone else returned some of these units: show the new numbers
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide="xl"
      title="Process New Return"
      description="Record a customer's return against the original invoice. Nothing goes back into stock unless you verify it."
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="accent" onClick={confirm} loading={busy} disabled={!invoice}>
            <Undo2 className="h-4 w-4" /> Process return
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* A. Invoice information */}
        <Section n="A" title="Invoice information">
          {!invoice ? (
            <div>
              <SearchInput value={search} onChange={setSearch} label="Search invoice" placeholder="Invoice number, customer name or phone…" />
              {shown('invoice') && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {shown('invoice')}
                </p>
              )}
              {invoiceError && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {invoiceError}
                </p>
              )}
              <div className="mt-2 overflow-hidden rounded-lg border border-line">
                {found.loading && !found.data ? (
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-2/3" />
                  </div>
                ) : found.error ? (
                  <ErrorState message={found.error} onRetry={found.reload} />
                ) : found.data?.length ? (
                  <ul className="divide-y divide-line" aria-label="Matching invoices">
                    {found.data.map((i) => (
                      <li key={i._id}>
                        <button
                          type="button"
                          onClick={() => choose(i._id)}
                          disabled={loadingInvoice || i.returnableUnits === 0}
                          aria-label={`Select invoice ${i.invoiceNo}`}
                          className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <span>
                            <span className="font-mono font-semibold">{i.invoiceNo}</span>
                            <span className="ml-2 text-muted">
                              {dateFmt(i.invoiceDate)} · {i.customer?.name}
                              {i.customer?.phone ? ` · ${i.customer.phone}` : ''}
                            </span>
                          </span>
                          <span className="text-xs text-muted">
                            {inr(i.total)} · {i.returnableUnits === 0 ? 'fully returned' : `${i.returnableUnits} unit${i.returnableUnits === 1 ? '' : 's'} returnable`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3 py-4 text-center text-sm text-muted">No completed invoice matches “{q}”.</p>
                )}
              </div>
            </div>
          ) : (
            <div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3 xl:grid-cols-6">
                {[
                  [
                    'Invoice number',
                    <span key="n" className="font-mono">
                      {invoice.invoiceNo}
                    </span>,
                  ],
                  ['Invoice date', dateFmt(invoice.invoiceDate)],
                  ['Customer name', invoice.customer?.name],
                  ['Customer phone', invoice.customer?.phone || '—'],
                  ['Original invoice total', inr(invoice.total)],
                  ['Original payment method', invoice.paymentType],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{k}</dt>
                    <dd className="mt-0.5 font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              <Button size="sm" variant="ghost" className="mt-3" onClick={change} disabled={busy}>
                Change invoice
              </Button>
            </div>
          )}
        </Section>

        {invoice && (
          <>
            {/* B. Product return details (+ D. restocking, per selected product) */}
            <Section
              n="B"
              title="Product return details"
              hint="Tick the products that are coming back. You can only return what was bought on this invoice, minus anything already returned."
            >
              {shown('lines') && (
                <p role="alert" className="mb-2 text-sm text-danger">
                  {shown('lines')}
                </p>
              )}
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-subtle text-[11px] uppercase tracking-wider text-muted">
                    <tr>
                      <th scope="col" className="w-10 px-3 py-2">
                        <span className="sr-only">Return</span>
                      </th>
                      <th scope="col" className="px-3 py-2 font-semibold">
                        Product
                      </th>
                      <th scope="col" className="px-3 py-2 font-semibold">
                        Batch
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Original qty
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Previously returned
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Returnable
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Qty returning
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Unit price
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        Return amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const none = l.returnableQuantity === 0;
                      const qErr = shown(`line.${l.key}.quantity`, l.selected && l.quantity !== '');
                      return (
                        <tr key={l.key} className={cx('border-t border-line align-top', none && 'text-muted')}>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`Return ${l.name}`}
                              checked={l.selected}
                              disabled={none}
                              onChange={(e) => setLine(l.key, { selected: e.target.checked, quantity: e.target.checked ? String(Math.min(1, l.returnableQuantity)) : '' })}
                              className="h-4 w-4 accent-[var(--primary)]"
                            />
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {l.name}
                            {none && <div className="text-xs font-normal">Already returned in full</div>}
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-mono text-[13px]">{l.batchNo || '—'}</div>
                            {l.expiryDate && <div className="text-xs text-muted">Exp {expiryFmt(l.expiryDate)}</div>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.originalQuantity}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.previouslyReturned}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.returnableQuantity}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={l.returnableQuantity}
                              step={1}
                              aria-label={`Quantity of ${l.name} being returned`}
                              aria-invalid={Boolean(qErr)}
                              disabled={!l.selected}
                              value={l.quantity}
                              onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                              className={cx(inputCls, numCls, qErr && 'border-danger')}
                            />
                            {qErr && (
                              <p role="alert" className="ml-auto mt-1 max-w-[14rem] text-right text-xs text-danger">
                                {qErr}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{inr(l.unitPrice)}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.selected ? inr(lineAmount(l)) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {chosen.length > 0 && (
                <div className="mt-4 space-y-3">
                  <h4 className="flex items-center gap-2 text-sm font-bold">
                    <PackageCheck className="h-4 w-4 text-muted" aria-hidden="true" /> Condition and restocking
                  </h4>
                  <p className="flex items-start gap-2 text-xs text-muted">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Returned medicines are never added back automatically. Damaged, expired or opened units can’t go back to sellable stock; good units go back to their original
                    batch only when you confirm you inspected them.
                  </p>
                  {chosen.map((l) => {
                    const block = restockBlock(l, reason, noRestock);
                    return (
                      <div key={l.key} className="rounded-lg border border-line p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-sm font-semibold">
                            {l.name} <span className="font-mono text-xs font-normal text-muted">{l.batchNo}</span>
                          </div>
                          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
                            Condition
                            <select
                              aria-label={`Condition of ${l.name}`}
                              value={l.condition}
                              onChange={(e) => setLine(l.key, { condition: e.target.value })}
                              className={cx(inputCls, 'h-9 w-auto min-w-56 pr-7 text-[13px] text-ink')}
                            >
                              {(m?.conditions || Object.entries(CONDITION_LABEL).map(([value, label]) => ({ value, label }))).map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className={cx('mt-2 flex items-start gap-2 text-sm', block && 'text-muted')}>
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                            aria-label={`Add ${l.name} back to sellable stock`}
                            checked={l.restock}
                            disabled={Boolean(block)}
                            onChange={(e) => setLine(l.key, { restock: e.target.checked, verified: false })}
                          />
                          <span>
                            Add these units back to sellable stock
                            {block && <span className="block text-xs">{block}</span>}
                          </span>
                        </label>
                        {l.restock && (
                          <label className="mt-2 flex items-start gap-2 pl-6 text-sm">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                              aria-label={`I inspected the returned ${l.name}`}
                              checked={l.verified}
                              onChange={(e) => setLine(l.key, { verified: e.target.checked })}
                            />
                            <span>I inspected these units: sealed, in date, packaging intact. They go back into batch {l.batchNo}.</span>
                          </label>
                        )}
                        {(shown(`line.${l.key}.verified`) || shown(`line.${l.key}.restock`)) && (
                          <p role="alert" className="mt-1 pl-6 text-xs text-danger">
                            {shown(`line.${l.key}.verified`) || shown(`line.${l.key}.restock`)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <p className="text-sm font-semibold" aria-live="polite">
                    Return value {inr(total)} ·{' '}
                    {restockUnits ? `${restockUnits} unit${restockUnits === 1 ? '' : 's'} will be added back to stock` : 'nothing will be added back to stock'}
                  </p>
                </div>
              )}
            </Section>

            {/* C. Return reason */}
            <Section n="C" title="Return reason">
              <div className="grid gap-3 md:grid-cols-2">
                <FormField label="Reason for return" required error={shown('reason')}>
                  {(a) => (
                    <select {...a} value={reason} onChange={(e) => changeReason(e.target.value)} className={cx(inputCls, 'pr-8', shown('reason') && 'border-danger')}>
                      <option value="">Choose a reason…</option>
                      {(m?.reasons || []).map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label="Additional remarks" error={shown('notes')} hint="Optional — up to 300 characters.">
                  {(a) => <textarea {...a} rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} className={cx(inputCls, 'h-auto py-2')} />}
                </FormField>
              </div>
            </Section>

            {/* E. Refund information */}
            <Section n="E" title="Refund information" hint="This only records the refund. No payment is made or started from here.">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <FormField label="Original payment method">{(a) => <input {...a} readOnly value={invoice.paymentType} className={cx(inputCls, 'bg-subtle')} />}</FormField>
                <FormField label="Refund method" required>
                  {(a) => (
                    <select {...a} value={refund.method} onChange={(e) => setRefund((r) => ({ ...r, method: e.target.value }))} className={cx(inputCls, 'pr-8')}>
                      {(m?.refundMethods || ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Store Credit']).map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label="Refund amount (₹)" required error={shown('refund.amount')} hint={`Up to the return value, ${inr(total)}${invoice.paymentType === 'Credit' || invoice.refundableLeft < invoice.total ? ` · ${inr(invoice.refundableLeft)} paid and refundable on this invoice` : ''}.`}>
                  {(a) => (
                    <input
                      {...a}
                      inputMode="decimal"
                      value={refundNow.amount}
                      onChange={(e) => setRefund((r) => ({ ...r, amount: e.target.value, amountTouched: true }))}
                      className={cx(inputCls, 'tabular-nums', shown('refund.amount') && 'border-danger')}
                    />
                  )}
                </FormField>
                <FormField label="Refund status" required>
                  {(a) => (
                    <select {...a} value={refund.status} onChange={(e) => setRefund((r) => ({ ...r, status: e.target.value }))} className={cx(inputCls, 'pr-8')}>
                      {(
                        m?.refundStatuses || [
                          { value: 'pending', label: 'Pending' },
                          { value: 'processing', label: 'Processing' },
                          { value: 'completed', label: 'Completed' },
                          { value: 'failed', label: 'Failed' },
                        ]
                      ).map((x) => (
                        <option key={x.value} value={x.value}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
                <FormField label="Refund transaction / reference ID" error={shown('refund.reference')} hint="Needed for a completed UPI, card or bank transfer refund.">
                  {(a) => (
                    <input
                      {...a}
                      value={refund.reference}
                      maxLength={100}
                      onChange={(e) => setRefund((r) => ({ ...r, reference: e.target.value }))}
                      className={cx(inputCls, shown('refund.reference') && 'border-danger')}
                    />
                  )}
                </FormField>
                <FormField label="Refund remarks" error={shown('refund.remarks')} hint="Required if you refund less than the full value.">
                  {(a) => (
                    <input
                      {...a}
                      value={refund.remarks}
                      maxLength={300}
                      onChange={(e) => setRefund((r) => ({ ...r, remarks: e.target.value }))}
                      className={cx(inputCls, shown('refund.remarks') && 'border-danger')}
                    />
                  )}
                </FormField>
              </div>
            </Section>
          </>
        )}

        {loadingInvoice && (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Receipt className="h-4 w-4" aria-hidden="true" /> Loading the invoice…
          </p>
        )}
        {general && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {general}
          </p>
        )}
        {submitted && Object.keys(errors).length > 0 && !busy && (
          <p role="status" className="flex items-center gap-2 text-sm text-danger">
            <CheckCircle2 className="h-4 w-4 rotate-45" aria-hidden="true" /> Please fix the highlighted fields before processing the return.
          </p>
        )}
      </div>
    </Modal>
  );
}
