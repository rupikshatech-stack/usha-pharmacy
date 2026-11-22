import { useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import useRise from './useRise';

const WAVE = [
  ['Expired', 1, 'bg-danger'],
  ['≤ 30 days', 1, 'bg-danger'],
  ['≤ 90 days', 2, 'bg-orange'],
  ['≤ 180 days', 3, 'bg-amber'],
  ['Later', 10, 'bg-primary'],
];
const MAX = 10;

export default function WhyThisExists() {
  const root = useRef(null);
  useRise(root);
  return (
    <section id="why" ref={root} aria-labelledby="why-heading" className="scroll-mt-16">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:py-28 lg:grid-cols-2 lg:gap-20">
        <div>
          <p data-rise className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">Why this exists</p>
          <h2 id="why-heading" data-rise className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-5xl">
            Stock that expires on the shelf is money already spent
          </h2>
          <p data-rise className="mt-6 text-base leading-relaxed text-muted sm:text-lg">
            A pharmacy loses money quietly: a batch reaches its expiry date unnoticed, a hand-written bill takes the wrong
            rate, and the GST return is rebuilt from paper at the end of the month.
          </p>
          <p data-rise className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            Usha Pharmacy keeps billing, batches and reporting on the same records, so the earliest-expiry stock is the stock
            that sells, every bill carries the right batch and rate, and the reports are already written when you need them.
          </p>
        </div>

        <div data-rise className="lp-lift rounded-2xl border border-ink/10 bg-ink/[0.04] p-6 sm:p-8">
          <div className="flex items-center gap-2">
            <TriangleAlert size={16} className="text-orange" aria-hidden="true" />
            <h3 className="text-[13px] font-bold text-ink">Batches by time to expiry</h3>
          </div>
          <ul className="mt-6 space-y-4" role="img" aria-label="Illustrative chart: most batches expire later, a few are expired or expiring soon">
            {WAVE.map(([label, n, tone]) => (
              <li key={label}>
                <div className="mb-1.5 flex justify-between text-[11.5px]">
                  <span className="font-semibold text-ink">{label}</span>
                  <span className="tabular-nums text-muted">{n}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-ink/8">
                  <div className={`h-full rounded-full ${tone}`} style={{ width: `${(n / MAX) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[11px] text-muted">Illustrative figures, not real stock.</p>
        </div>
      </div>
    </section>
  );
}
