import { useRef } from 'react';
import useRise from './useRise';

const STEPS = [
  ['Sign in', 'Open your organization’s workspace with the account your administrator created for you.'],
  ['Bring in your stock', 'Add medicines and batches, or import your existing inventory in bulk.'],
  ['Start billing', 'Open the Selling Point, bill your first customer and watch stock update.'],
];

/** Three steps from sign-in to the first bill. The closing CTA and footer live in ClosingCta. */
export default function HowItWorks() {
  const root = useRef(null);
  useRise(root);
  return (
    <section id="how" ref={root} aria-labelledby="how-heading" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <p data-rise className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">How it works</p>
          <h2 id="how-heading" data-rise className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
            From sign-in to first bill in three steps
          </h2>
        </div>
        <ol className="mt-16 grid gap-5 md:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} data-rise className="lp-lift rounded-2xl border border-ink/10 bg-ink/[0.035] p-7">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-primary text-sm font-extrabold tabular-nums text-on-primary">{i + 1}</span>
              <h3 className="mt-4 text-base font-bold text-ink">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
