import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import useRise from './useRise';

export default function Hero() {
  const root = useRef(null);
  useRise(root);

  return (
    <section ref={root} className="lp-hero--dark relative overflow-hidden">
      <div className="absolute inset-0" aria-hidden="true">
        {/* Lifts the headline off the 3D capsule passing behind it. */}
        <div className="lp-hero-veil" />
      </div>

      <div data-hero-stage className="lp-hero-body relative mx-auto flex min-h-[min(44rem,100svh)] max-w-5xl flex-col items-center justify-center px-4 pb-24 pt-24 text-center sm:pb-32 sm:pt-32">
        <p data-rise className="text-[12px] font-semibold uppercase tracking-[0.22em] text-muted">
          Built for Indian pharmacies
        </p>
        <h1 data-rise className="mt-7 text-[2.75rem] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink sm:text-7xl lg:text-[5rem]">
          Run your pharmacy with <span className="lp-gradient-text">billing, stock and expiry</span> in one system.
        </h1>
        <p data-rise className="mx-auto mt-8 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          Usha Pharmacy brings the counter, the stockroom and the books together, with batch-wise stock, expiry tracking, GST reports and control across branches.
        </p>
        <div data-rise className="mt-11 flex flex-col items-center gap-5 sm:flex-row sm:justify-center">
          <a href="#motion" className="lp-glass-btn lp-glass-btn--light !h-12 !px-6 !text-sm">Try the live demo <ArrowRight size={16} aria-hidden="true" /></a>
          <a href="#modules" className="text-sm font-semibold text-muted underline-offset-4 outline-none transition-colors hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline">
            See all modules
          </a>
        </div>
        <p data-rise className="mt-10 text-[12px] text-muted">
          Already set up? <Link to="/login" className="font-semibold text-ink underline-offset-4 hover:underline">Sign in to your workspace</Link>
        </p>
      </div>
    </section>
  );
}
