import { useRef } from 'react';
import { BarChart3, Boxes, CalendarClock, ReceiptIndianRupee, ScanBarcode, ShieldCheck } from 'lucide-react';
import useRise from './useRise';

const MODULES = [
  [ScanBarcode, 'Selling Point', 'Keyboard-first billing with batch selection and payment modes.', ['Billing', 'Returns', 'Shortcuts']],
  [Boxes, 'Stock & batch tracking', 'Medicines, compounds and batches, with reorder levels that flag what to buy.', ['Inventory', 'Batches', 'Import']],
  [CalendarClock, 'Expiry intelligence', 'See what expires when, so the earliest-expiry stock is the stock that sells.', ['Expiry', 'FEFO', 'Alerts']],
  [ReceiptIndianRupee, 'GST & invoicing', 'Invoices and a GST report built from the same records as your sales.', ['GST', 'Invoices', 'Reports']],
  [ShieldCheck, 'Roles & multi-branch', 'Several branches in one system, with permissions per role and an activity log.', ['Branches', 'Roles', 'Transfers']],
  [BarChart3, 'Analytics', 'Sales, purchase, profitability and customer insight from your own numbers.', ['Trends', 'Profit', 'Low stock']],
];

export default function ModulesGrid() {
  const root = useRef(null);
  useRise(root);
  return (
    <section id="modules" ref={root} aria-labelledby="modules-heading" className="scroll-mt-16">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <p data-rise className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">Modules</p>
          <h2 id="modules-heading" data-rise className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
            Everything a pharmacy runs on
          </h2>
        </div>
        <ul className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map(([Icon, title, body, tags]) => (
            <li key={title} data-rise className="lp-lift flex flex-col rounded-2xl border border-ink/10 bg-ink/[0.035] p-7">
              <span className="grid h-11 w-11 place-items-center rounded-xl border border-ink/10 bg-ink/[0.06] text-ink">
                <Icon size={19} strokeWidth={1.6} aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-bold tracking-tight text-ink">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
              <ul className="mt-5 flex flex-wrap gap-1.5 pt-1">
                {tags.map((t) => (
                  <li key={t} className="rounded-full border border-ink/10 px-2.5 py-1 text-[10.5px] font-semibold text-muted">{t}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
