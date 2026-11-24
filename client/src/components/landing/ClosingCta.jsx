import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ctaPrimary } from './LandingNav';
import Reveal from './Reveal';

// Lazy here too: a static import anywhere would pull three.js back into the main bundle.

const COLUMNS = [
  ['Product', [['#modules', 'Modules'], ['#platform', 'Platform'], ['#motion', 'The demo']]],
  ['Company', [['#why', 'Why this exists'], ['#who', 'Who it’s for'], ['#how', 'How it works']]],
  ['Account', [['/login', 'Sign in']]],
];

/** The closing call to action over a dimmed, static particle object, followed by the footer. */
export default function ClosingCta() {
  return (
    <>
      <section id="end" className="lp-forest-zone relative overflow-hidden border-t border-ink/10">
        <Reveal className="relative mx-auto max-w-4xl px-4 py-28 text-center sm:py-40">
          <h2 className="text-4xl font-extrabold leading-[1.05] tracking-[-0.035em] text-ink sm:text-6xl">
            Put the counter, the stockroom and the books on one system.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base text-muted sm:text-lg">Sign in to your workspace to get started.</p>
          <Link to="/login" className={`${ctaPrimary} mt-10`}>Sign in <ArrowRight size={16} aria-hidden="true" /></Link>
        </Reveal>
      </section>

      <footer className="lp-forest-zone border-t border-ink/10">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="inline-block rounded-lg bg-white px-2.5 py-1.5">
              <img src="/logo/logo.jpg" alt="Usha Pharmacy" className="block h-12 w-auto select-none mix-blend-multiply" draggable="false" />
            </span>
            <p className="mt-2 max-w-xs text-[12px] leading-relaxed text-muted">
              Billing, stock, batches and reporting for pharmacies and wholesalers.
            </p>
          </div>
          {COLUMNS.map(([heading, links]) => (
            <nav key={heading} aria-label={heading}>
              <h2 className="text-[11px] font-bold uppercase tracking-wide text-ink">{heading}</h2>
              <ul className="mt-4 space-y-2.5">
                {links.map(([href, label]) => (
                  <li key={label}>
                    <a href={href} className="text-[12.5px] text-muted transition-colors hover:text-ink">{label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="border-t border-ink/10">
          <p className="mx-auto max-w-6xl px-4 py-6 text-center text-[11.5px] text-muted">© Usha Pharmacy</p>
        </div>
      </footer>
    </>
  );
}
