import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ShoppingCart, Trash2, Pause, Save, Printer, RotateCcw, Minus, Plus, Pill, ListOrdered, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { invoiceService } from '../../services/invoiceService';
import { inr, newIdempotencyKey } from '../../utils/format';
import { cartBill } from '../../utils/cartBill';
import { useFetch, useDebounced } from '../../hooks/useFetch';
import { printInvoice } from '../../utils/printInvoice';
import { Button, EmptyState, ErrorState, Modal, Spinner, cx, inputCls } from '../../components/common/ui';

const HELD_KEY = 'usha:held-bills';
const readHeld = () => {
  try {
    return JSON.parse(localStorage.getItem(HELD_KEY)) || [];
  } catch {
    return [];
  }
};
const writeHeld = (v) => {
  try {
    localStorage.setItem(HELD_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const blank = { customer: { name: '', phone: '', gstin: '' }, paymentType: 'Cash', discount: { type: 'percent', value: '' }, paid: '' };

const Shortcut = ({ k, label }) => (
  <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-1 text-[11px] text-muted">
    <kbd className="rounded bg-subtle px-1 font-mono font-bold text-primary">{k}</kbd>
    {label}
  </span>
);

export default function SellingPoint() {
  // What the PREVIEW needs from the organization before any invoice exists: the seller's state (the first two digits of its GSTIN, which
  // decides CGST+SGST versus IGST) and whether the bill is rounded. It comes from /pos/context, open to anyone who can sell, so it does not
  // depend on `settings:read` (a cashier usually has none): the preview now agrees with the invoice the server saves for every user.
  const ctx = useFetch('/pos/context');
  const orgState = ctx.data?.sellerState || '';
  const [search, setSearch] = useState('');  const q = useDebounced(search, 250);
  const { data: products, loading, error, reload } = useFetch('/pos/products', { q });

  const [cart, setCart] = useState([]);
  const [form, setForm] = useState(blank);
  const [held, setHeld] = useState(readHeld);
  const [showHeld, setShowHeld] = useState(false);
  const [saving, setSaving] = useState(false);

  const searchRef = useRef(null);
  // Customer + billing details are collapsed by default so the medicine list gets the height; the total stays in view.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const phoneRef = useRef(null);
  const payRef = useRef(null);
  const amountRef = useRef(null);
  const keyRef = useRef({ signature: null, key: null }); // idempotency key for the bill being saved

  const add = (p) => {
    if (!p.nextBatch) return toast.error(`${p.medicineName} is out of stock`);
    setCart((c) => {
      const i = c.findIndex((x) => x.medicineId === p._id);
      if (i >= 0) {
        if (c[i].quantity >= p.availableStock) {
          toast.error(`Only ${p.availableStock} in stock`);
          return c;
        }
        return c.map((x, n) => (n === i ? { ...x, quantity: x.quantity + 1 } : x));
      }
      return [
        ...c,
        {
          medicineId: p._id,
          name: p.medicineName,
          manufacturer: p.manufacturer,
          batchNo: p.nextBatch.batchNumber,
          expiryDate: p.nextBatch.expiryDate,
          mrp: p.nextBatch.mrp,
          price: p.nextBatch.sellingPrice, // GST-inclusive, as on the shelf
          gstPercent: p.gstPercentage ?? 0,
          stock: p.availableStock,
          quantity: 1,
          discountPercent: 0,
        },
      ];
    });
  };

  const patch = (id, changes) => setCart((c) => c.map((x) => (x.medicineId === id ? { ...x, ...changes } : x)));
  const setQty = (item, qty) => {
    const n = Math.max(1, Math.min(item.stock, Number(qty) || 1));
    patch(item.medicineId, { quantity: n });
  };

  // the same arithmetic the server will apply when the bill is saved (prices are GST-inclusive, so the tax is split out of them, never added on)
  const roundOff = ctx.data?.roundOff ?? false;
  const totals = useMemo(
    () =>
      cartBill({
        cart,
        discount: form.discount,
        customerGstin: form.customer.gstin,
        orgState,
        paymentType: form.paymentType,
        paid: form.paid,
        // The organization's own rounding rule - the same one the server applies when the bill is saved - so the total
        // on the cart is the total that will be printed. It used to be left out, and the cart said ₹99.30 while the
        // invoice said ₹99.
        roundOff,
      }),
    [cart, form, orgState, roundOff],
  );

  const reset = useCallback(() => {
    keyRef.current = { signature: null, key: null }; // a fresh bill is a fresh sale
    setCart([]);
    setForm(blank);
    searchRef.current?.focus();
  }, []);

  const hold = useCallback(() => {
    if (!cart.length) return toast.error('Nothing to hold');
    const next = [{ id: Date.now(), at: new Date().toISOString(), cart, form }, ...held];
    setHeld(next);
    writeHeld(next);
    reset();
    toast.success('Bill put on hold');
  }, [cart, form, held, reset]);

  const resume = (bill) => {
    setCart(bill.cart);
    setForm(bill.form);
    const next = held.filter((h) => h.id !== bill.id);
    setHeld(next);
    writeHeld(next);
    setShowHeld(false);
  };

  const save = useCallback(
    async (print = false) => {
      if (!cart.length) return toast.error('Add at least one item');
      if (form.customer.phone && !/^\d{10}$/.test(form.customer.phone)) return toast.error('Phone must be 10 digits');
      setSaving(true);
      try {
        const payload = {
          customer: { name: form.customer.name || undefined, phone: form.customer.phone, ...(form.customer.gstin ? { gstin: form.customer.gstin.toUpperCase() } : {}) },
          items: cart.map((i) => ({ medicineId: i.medicineId, quantity: i.quantity, discountPercent: i.discountPercent })),
          discount: form.discount.value ? { type: form.discount.type, value: Number(form.discount.value) } : undefined,
          paymentType: form.paymentType,
          paid: form.paymentType === 'Credit' ? Number(form.paid) || 0 : undefined,
        };
        // Idempotency: retrying the SAME bill (double-click, dropped connection) reuses one key, so the
        // server can never record it twice. Editing the bill makes it a different sale with a new key.
        const signature = JSON.stringify(payload);
        if (keyRef.current.signature !== signature) keyRef.current = { signature, key: newIdempotencyKey() };
        const inv = await invoiceService.create({ ...payload, idempotencyKey: keyRef.current.key });
        toast.success(`Invoice ${inv.invoiceNo} saved — ${inr(inv.total)}`);
        if (print && !(await printInvoice(inv))) toast.error('Allow pop-ups to print');
        reset();
        reload();
      } catch (e) {
        toast.error(e.message);
        reload(); // stock may have changed
      } finally {
        setSaving(false);
      }
    },
    [cart, form, reset, reload],
  );

  // Keyboard shortcuts (refs to latest handlers so the listener never goes stale).
  const handlers = useRef({});
  handlers.current = { save, hold, reset, setShowHeld };
  useEffect(() => {
    const onKey = (e) => {
      const h = handlers.current;
      // The fields live in the collapsible block: open it first, then focus once it has rendered.
      const focusDetail = (ref) => { setDetailsOpen(true); setTimeout(() => ref.current?.focus(), 0); };
      const map = {
        F1: () => searchRef.current?.focus(),
        F2: () => h.save(false),
        F5: () => h.save(true),
        F6: () => h.hold(),
        F7: () => h.setShowHeld(true),
        F8: () => focusDetail(phoneRef),
        F9: () => focusDetail(payRef),
        F10: () => focusDetail(amountRef),
        Escape: () => h.reset(),
      };
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        return h.save(false);
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        return h.save(true);
      }
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        return searchRef.current?.focus();
      }
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setCust = (k) => (e) => setForm((f) => ({ ...f, customer: { ...f.customer, [k]: e.target.value } }));

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Product picker */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Medicines">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-card px-4 py-3">
          <h1 className="sr-only">Selling Point</h1>
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" aria-hidden="true" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && products?.length === 1) {
                  add(products[0]);
                  setSearch('');
                }
              }}
              aria-label="Search medicine"
              placeholder="Search medicine (F1 or /) — Enter adds a single match"
              className={cx(inputCls, 'rounded-full border-primary/60 pl-10')}
            />
          </div>
          <Button variant="secondary" onClick={() => setShowHeld(true)}>
            <ListOrdered className="h-4 w-4" /> Held Bills {held.length > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-on-primary">{held.length}</span>}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 bg-subtle px-4 py-2.5">
          <Shortcut k="F1" label="Search" />
          <Shortcut k="F2" label="Save" />
          <Shortcut k="F5" label="Save & Print" />
          <Shortcut k="F6" label="Hold" />
          <Shortcut k="F7" label="Held Bills" />
          <Shortcut k="F8" label="Cust Phone" />
          <Shortcut k="F9" label="Pay Mode" />
          <Shortcut k="F10" label="Amount" />
          <Shortcut k="Esc" label="Clear" />
        </div>
        {/* tabIndex makes the list scrollable by keyboard even when it is empty or shows a message, which is the only way to reach it without a pointer */}
        <div className="min-h-[260px] flex-1 overflow-y-auto p-4" tabIndex={0} role="region" aria-label="Search results">
          {loading && !products ? (
            <Spinner />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : products.length === 0 ? (
            <EmptyState icon={Pill} title="No medicines found" hint="Add medicines with stock under Stock Management → All Inventory." />
          ) : (
            // The fourth column waits until there is genuinely room for it. The billing column takes its width out
            // of this one, so `xl:grid-cols-4` was leaving ~139px per card and the price collided with the stock
            // count. Four cards need ~700px here, which is a ~1800px screen (the `3xl` breakpoint defined in
            // index.css); below that, three readable cards.
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 3xl:grid-cols-4">
              {products.map((p) => {
                const out = !p.nextBatch;
                return (
                  <button
                    key={p._id}
                    onClick={() => add(p)}
                    disabled={out}
                    className={cx(
                      'relative rounded-2xl border p-3 text-left transition',
                      out ? 'cursor-not-allowed border-line bg-subtle opacity-60' : 'border-line bg-card hover:border-primary hover:shadow-md',
                    )}
                  >
                    {out && <span className="absolute right-2 top-2 rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-on-danger">Out</span>}
                    <div className="mb-2 grid h-12 w-12 place-items-center rounded-xl bg-sage text-sage-ink">
                      <Pill className="h-6 w-6" aria-hidden="true" />
                    </div>
                    <div className="line-clamp-2 text-sm font-bold">{p.medicineName}</div>
                    <div className="truncate text-xs uppercase text-muted">{p.manufacturer || '—'}</div>
                    {/* flex-wrap, so a card too narrow for both on one line puts the stock count on the next line
                        by itself. The price never shrinks and never truncates: a half-shown price ("₹102.…") is
                        worse than useless on a till, and before this it was overlapping the stock count outright. */}
                    <div className="mt-2 flex flex-wrap items-end justify-between gap-x-2 gap-y-0.5">
                      <div className="shrink-0">
                        <div className="text-[10px] font-semibold uppercase text-muted">Price</div>
                        <div className="whitespace-nowrap font-extrabold tabular-nums">{inr(p.nextBatch?.sellingPrice ?? 0)}</div>
                      </div>
                      <span className="whitespace-nowrap text-xs text-muted">{p.availableStock} in stock</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
          className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-subtle/60 px-4 py-2 text-left hover:bg-subtle"
        >
          <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-muted">
            <ChevronUp className={cx("h-4 w-4 transition-transform", detailsOpen && "rotate-180")} aria-hidden="true" />
            Customer & billing
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-xs text-muted">Total payable</span>
            <span className="text-lg font-extrabold tabular-nums">{inr(totals.total)}</span>
          </span>
        </button>
        {/* Stacked: customer and payment first, then the billing summary, in one column of full-width fields.
            It scrolls if the screen is short; otherwise it takes its own
            height and no more - the medicine list above it keeps the rest. */}
        <div className={cx("shrink-0 content-start gap-3 overflow-y-auto border-t border-line bg-subtle/60 p-3 max-h-[45vh]", detailsOpen ? "grid" : "hidden")}>
          <div className="space-y-2 rounded-2xl border border-line bg-card p-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Customer & payment</div>
            <input className={inputCls} placeholder="Walk-in Customer" aria-label="Customer name" value={form.customer.name} onChange={setCust('name')} />
            <input ref={phoneRef} className={inputCls} inputMode="numeric" maxLength={10} placeholder="10-digit number (F8)" aria-label="Customer phone" value={form.customer.phone} onChange={(e) => setForm((f) => ({ ...f, customer: { ...f.customer, phone: e.target.value.replace(/\D/g, '') } }))} />
            <input
              className={inputCls}
              maxLength={15}
              placeholder="Customer GSTIN (optional)"
              aria-label="Customer GSTIN"
              value={form.customer.gstin}
              onChange={(e) => setForm((f) => ({ ...f, customer: { ...f.customer, gstin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '') } }))}
            />
            <select ref={payRef} className={inputCls} aria-label="Payment type" value={form.paymentType} onChange={(e) => setForm({ ...form, paymentType: e.target.value })}>
              {['Cash', 'UPI', 'Card', 'Credit'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div className="space-y-2 rounded-2xl border border-line bg-card p-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Billing summary</div>
            <dl className="space-y-1 text-xs" aria-label="Billing breakdown">
              <div className="flex justify-between">
                <dt className="text-muted">Gross (inclusive of GST)</dt>
                <dd className="tabular-nums">{inr(totals.subTotal)}</dd>
              </div>
              {totals.itemDisc > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Item discount</dt>
                  <dd className="tabular-nums text-success">− {inr(totals.itemDisc)}</dd>
                </div>
              )}
              {totals.disc > 0 && (
                <div className="flex justify-between">
                  <dt className="text-muted">Bill discount</dt>
                  <dd className="tabular-nums text-success">− {inr(totals.disc)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted">Taxable value</dt>
                <dd className="tabular-nums">{inr(totals.taxable)}</dd>
              </div>
              {totals.igst > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-muted">IGST</dt>
                  <dd className="tabular-nums">{inr(totals.igst)}</dd>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted">CGST</dt>
                    <dd className="tabular-nums">{inr(totals.cgst)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">SGST</dt>
                    <dd className="tabular-nums">{inr(totals.sgst)}</dd>
                  </div>
                </>
              )}
              {totals.roundOff !== 0 && (
                <div className="flex justify-between" data-testid="pos-round-off">
                  <dt className="text-muted">Round off</dt>
                  <dd className="tabular-nums">{inr(totals.roundOff)}</dd>
                </div>
              )}
            </dl>
            <div className="flex items-baseline justify-between border-t border-line pt-2">
              <span className="font-semibold">Total payable</span>
              <span className="text-2xl font-extrabold tabular-nums" data-testid="pos-total">{inr(totals.total)}</span>
            </div>
            <p className="text-[11px] text-muted">GST is included in the price. The server works the bill out again when it is saved.</p>
            <div className="flex gap-2">
              <select className={cx(inputCls, 'w-24')} aria-label="Discount type" value={form.discount.type} onChange={(e) => setForm({ ...form, discount: { ...form.discount, type: e.target.value } })}>
                <option value="percent">%</option>
                <option value="amount">₹</option>
              </select>
              <input type="number" min="0" className={inputCls} placeholder="Discount" aria-label="Bill discount" value={form.discount.value} onChange={(e) => setForm({ ...form, discount: { ...form.discount, value: e.target.value } })} />
            </div>
            <input
              ref={amountRef}
              type="number"
              min="0"
              disabled={form.paymentType !== 'Credit'}
              className={inputCls}
              placeholder={form.paymentType === 'Credit' ? 'Amount paid now (F10)' : 'Paid in full'}
              aria-label="Amount paid"
              value={form.paymentType === 'Credit' ? form.paid : ''}
              onChange={(e) => setForm({ ...form, paid: e.target.value })}
            />
            <div className="flex justify-between text-xs">
              <span className="text-muted">Due amount</span>
              <span className={cx('font-bold tabular-nums', totals.due > 0 && 'text-danger')}>{inr(totals.due)}</span>
            </div>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-line p-3 sm:grid-cols-4">
          <Button onClick={reset} className="bg-sage0"><RotateCcw className="h-4 w-4" /> Reset</Button>
          <Button variant="secondary" onClick={hold}><Pause className="h-4 w-4" /> Hold</Button>
          <Button variant="secondary" loading={saving} onClick={() => save(false)}><Save className="h-4 w-4" /> Save</Button>
          <Button loading={saving} onClick={() => save(true)}><Printer className="h-4 w-4" /> Save & Print</Button>
        </div>
      </section>

      {/* Cart + billing */}
      {/*
        The billing column. It was a flat 480px, which is where both complaints came from: six columns of cart
        crammed into it overflowed sideways (one axis set to `auto` promotes the other to `auto` too, so the
        horizontal scrollbar was a side effect, not a layout choice), and the list itself was left fighting the two
        cards below it for height. It now widens with the screen and the cart is the part that gets the slack.

        The widths are a split, not a grab: every pixel added here comes out of the medicine picker on the left.
        1024 keeps the old 480 because there is simply nothing spare at that size; the growth starts at 1280, where
        the picker can afford it.
      */}
      <aside className="flex w-full flex-col border-line bg-card lg:order-first lg:w-[420px] lg:border-r xl:w-[460px] 2xl:w-[520px]">
        {/* The count is worth stating: once the list scrolls, "how many lines are on this bill?" stops being
            answerable by looking. */}
        <div className="flex items-center justify-between border-b border-line bg-subtle/60 px-3 py-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted">Items on this bill</span>
          <span className="rounded-full bg-card px-2 py-0.5 text-xs font-bold tabular-nums" aria-live="polite">
            {cart.length} {cart.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        {/*
          flex-1 with a real floor: the cart is the panel that grows, and it scrolls DOWN, never across.

          It stays a real <table> on purpose. The row/columnheader semantics are what a screen reader reads out,
          and what the browser tests locate a line by — swapping in <div>s would look identical and quietly break
          both. Only the widths changed.
        */}
        <div className="min-h-[220px] flex-1 overflow-y-auto overflow-x-hidden">
          {cart.length === 0 ? (
            <EmptyState icon={ShoppingCart} title="No items added yet" hint="Search or press F1 to add medicine" />
          ) : (
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                {/* The medicine name takes whatever the numbers do not, so nothing has to scroll sideways. */}
                <col />
                <col className="w-[64px]" />
                <col className="w-[56px]" />
                <col className="w-[104px]" />
                <col className="w-[68px]" />
                <col className="w-[36px]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-card text-[10px] uppercase text-muted shadow-[0_1px_0_var(--line)]">
                <tr>
                  {['Item', 'Price', 'Disc%', 'Qty', 'Total', ''].map((h) => (
                    <th key={h} className="px-2.5 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cart.map((i) => (
                  <tr key={i.medicineId} className="border-t border-line align-middle">
                    <td className="px-2.5 py-2">
                      {/* title= so a name too long for the column is still readable on hover */}
                      <div className="truncate font-semibold" title={i.name}>{i.name}</div>
                      <div className="truncate text-muted">Batch {i.batchNo}</div>
                    </td>
                    <td className="px-2.5 py-2 tabular-nums">{inr(i.price)}</td>
                    <td className="px-2.5 py-2">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        aria-label={`Discount percent for ${i.name}`}
                        value={i.discountPercent}
                        onChange={(e) => patch(i.medicineId, { discountPercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                        // This column is only ~36px of input: the browser's own up/down arrows took most of it and clipped the number
                        // ("0" showed as a sliver). The value is typed, so the arrows go and the number is centred.
                        className="w-full rounded-lg border border-line bg-card px-1 py-1 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex items-center gap-1">
                        <button aria-label="Decrease quantity" onClick={() => setQty(i, i.quantity - 1)} className="shrink-0 rounded-md border border-line p-1"><Minus className="h-3 w-3" /></button>
                        <input
                          type="number"
                          aria-label={`Quantity for ${i.name}`}
                          value={i.quantity}
                          onChange={(e) => setQty(i, e.target.value)}
                          className="w-full min-w-0 rounded-md border border-line bg-card py-1 text-center"
                        />
                        <button aria-label="Increase quantity" onClick={() => setQty(i, i.quantity + 1)} className="shrink-0 rounded-md border border-line p-1"><Plus className="h-3 w-3" /></button>
                      </div>
                    </td>
                    <td className="px-2.5 py-2 font-semibold tabular-nums">{inr(i.price * i.quantity * (1 - i.discountPercent / 100))}</td>
                    <td className="px-1.5">
                      <button aria-label={`Remove ${i.name}`} onClick={() => setCart((c) => c.filter((x) => x.medicineId !== i.medicineId))} className="rounded-md p-1 text-danger hover:bg-danger-soft"><Trash2 className="h-4 w-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </aside>

      {showHeld && (
        <Modal title="Held bills" onClose={() => setShowHeld(false)}>
          {held.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No held bills.</p>
          ) : (
            <ul className="divide-y divide-line">
              {held.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <div className="font-semibold">{b.form.customer.name || 'Walk-in Customer'} · {b.cart.length} item(s)</div>
                    <div className="text-xs text-muted">{new Date(b.at).toLocaleTimeString('en-IN')}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => resume(b)}>Resume</Button>
                    <Button variant="ghost" onClick={() => { const n = held.filter((h) => h.id !== b.id); setHeld(n); writeHeld(n); }} aria-label="Discard held bill"><Trash2 className="h-4 w-4 text-danger" /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
