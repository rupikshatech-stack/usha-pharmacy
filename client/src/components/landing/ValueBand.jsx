import { useRef } from 'react';
import { CalendarClock, Calculator, Boxes, ReceiptText } from 'lucide-react';
import useRise from './useRise';

const POINTS = [
  [ReceiptText, 'Billing at the counter', 'A keyboard-first Selling Point with batch selection, discounts and payment modes.'],
  [Boxes, 'Stock you can trust', 'Medicines, compounds and bulk import, with reorder levels that flag what to buy.'],
  [CalendarClock, 'Expiry under control', 'Batch-wise dates and expiry intelligence, so the earliest-expiry stock sells first.'],
  [Calculator, 'Numbers that make sense', 'Sales, purchase, profitability and GST reports from the same records.'],
];

/** A band of four glass cards between the hero and the features. */
export default function ValueBand() {
  const root = useRef(null);
  useRise(root);
  return (
    <section ref={root}>
      <div className="mx-auto max-w-6xl px-4 py-20 sm:py-28">
        <h2 data-rise className="mx-auto max-w-4xl text-center text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
          One system for the counter, the stockroom and the books
        </h2>
        <ul className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map(([Icon, title, body]) => (
            <li key={title} data-rise className="lp-lift rounded-2xl border border-ink/10 bg-ink/[0.04] p-6">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-ink/10 text-ink"><Icon size={20} aria-hidden="true" /></span>
              <h3 className="mt-4 text-base font-bold">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
