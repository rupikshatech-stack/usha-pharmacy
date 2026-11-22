import { useRef } from 'react';
import { Boxes, Building2, CalendarClock, ChartNoAxesCombined, History, ReceiptText, Truck, Undo2, Wallet } from 'lucide-react';
import useRise from './useRise';

const FEATURES = [
  [ReceiptText, 'Fast billing', 'A keyboard-first Selling Point with batch selection, item discounts and payment modes.'],
  [Boxes, 'Inventory', 'Medicines, compounds and attributes, with bulk import and reorder levels.'],
  [CalendarClock, 'Batches & expiry', 'Batch-wise quantity and MRP, and expiry intelligence to sell earliest-expiry stock first.'],
  [Undo2, 'Sales returns', 'Handle returns in the same system as billing, so the history stays together.'],
  [ChartNoAxesCombined, 'Reports & GST', 'A GST report alongside sales, purchase, profitability and low-stock reports.'],
  [Truck, 'Suppliers & orders', 'A supplier directory, purchase orders and supplier performance reports.'],
  [Wallet, 'Credit management', 'Credit requests, a running ledger and payment proof for each customer.'],
  [Building2, 'Branches & transfers', 'Several branches in one system, with inter-store stock transfers.'],
  [History, 'Roles & activity log', 'Role-based permissions per user, and an activity log of who did what.'],
];

export default function FeatureGrid() {
  const root = useRef(null);
  useRise(root);
  return (
    <section id="features" ref={root} aria-labelledby="features-heading" className="scroll-mt-16">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <p data-rise className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">Key features</p>
          <h2 id="features-heading" data-rise className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
            Everything a pharmacy runs on, in one place
          </h2>
        </div>
        <ul className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([Icon, title, body]) => (
            <li key={title} data-rise className="lp-lift rounded-2xl border border-ink/10 bg-ink/[0.04] p-7">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-ink/10 text-ink"><Icon size={20} aria-hidden="true" /></span>
              <h3 className="mt-4 text-base font-bold text-ink">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
