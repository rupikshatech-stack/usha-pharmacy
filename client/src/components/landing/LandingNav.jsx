import { Link } from 'react-router-dom';

export const ctaCls =
  'lp-btn inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
export const ctaPrimary = `${ctaCls} lp-cta-glow bg-primary text-on-primary hover:bg-primary-hover`;
export const ctaSecondary = `${ctaCls} border border-ink/15 bg-ink/5 text-ink hover:bg-ink/10`;

const LINKS = [
  ['#modules', 'Modules'],
  ['#platform', 'Platform'],
  ['#why', 'Why this exists'],
  ['#how', 'How it works'],
];

/** Sticky site header. Its 5rem height is also the pin offset used by the product showcase. */
export default function LandingNav() {
  return (
    <header className="sticky top-0 z-40 h-20 border-b border-ink/10 bg-[color-mix(in_srgb,var(--app)_95%,transparent)]">
      {/* Full width rather than the page's centred column, so the logo sits in the left corner and the button in the
          right. From md up it is a 1fr / auto / 1fr grid, which keeps the links truly centred however wide the logo is. */}
      <nav aria-label="Main" className="flex h-full items-center justify-between gap-4 px-3 sm:px-5 md:grid md:grid-cols-[1fr_auto_1fr]">
        <Link to="/" aria-label="Usha Pharmacy, home" className="justify-self-start rounded-lg bg-white px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
          <img src="/logo/logo.jpg" alt="Usha Pharmacy" className="block h-16 w-auto select-none mix-blend-multiply" draggable="false" />
        </Link>
        <ul className="hidden items-center gap-7 md:flex">
          {LINKS.map(([href, label]) => (
            <li key={href}>
              <a href={href} className="text-sm font-semibold text-muted outline-none transition-colors hover:text-ink focus-visible:text-ink focus-visible:underline">
                {label}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 md:justify-self-end">
          <a href="#motion" className={`${ctaPrimary} !h-10 !rounded-full !px-5`}>Get started</a>
        </div>
      </nav>
    </header>
  );
}
