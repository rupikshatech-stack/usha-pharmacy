import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid, Lightbulb, MonitorPlay, Workflow } from 'lucide-react';
import LiquidNav from './LiquidNav';

export const ctaCls =
  'lp-btn inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
export const ctaPrimary = `${ctaCls} lp-cta-glow bg-primary text-on-primary hover:bg-primary-hover`;
export const ctaSecondary = `${ctaCls} border border-ink/15 bg-ink/5 text-ink hover:bg-ink/10`;

const icon = (Cmp) => <Cmp size={18} strokeWidth={1.8} aria-hidden="true" />;
const LINKS = [
  { href: '#modules', label: 'Modules', icon: icon(LayoutGrid), fx: 'pop' },
  { href: '#platform', label: 'Platform', icon: icon(MonitorPlay), fx: 'spin' },
  { href: '#why', label: 'Why this exists', icon: icon(Lightbulb), fx: 'wave' },
  { href: '#how', label: 'How it works', icon: icon(Workflow), fx: 'glow' },
];

/** Which section the reader is in, so the drop follows the scroll. A click pins the answer briefly: the page scrolls
 *  past the sections in between, and the drop should not chase each of them on the way. */
function useActiveSection() {
  const [active, setActive] = useState(0);
  const lockUntil = useRef(0);
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      if (performance.now() < lockUntil.current) return;
      // The section most recently scrolled past (the nav's order is not the page's order), else the first item.
      let idx = 0;
      let best = -Infinity;
      LINKS.forEach(({ href }, i) => {
        const el = document.getElementById(href.slice(1));
        if (!el) return;
        const top = el.getBoundingClientRect().top;
        if (top <= window.innerHeight * 0.35 && top > best) { best = top; idx = i; }
      });
      setActive(idx);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read); };
    window.addEventListener('scroll', onScroll, { passive: true });
    read();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);
  const choose = (i) => { lockUntil.current = performance.now() + 1200; setActive(i); };
  return [active, choose];
}

/** Sticky site header. Its 5rem height is also the pin offset used by the product showcase. */
export default function LandingNav() {
  const [active, choose] = useActiveSection();
  // The bar is the app's own sidebar green (--side), so it matches the product screens further down the page. The logo is
  // a JPG on a white ground, so on a dark bar it is kept as a deliberate white badge instead of a box that looks pasted on.
  return (
    <header className="sticky top-0 z-40 h-20 border-b border-white/10 bg-side shadow-[0_10px_28px_-16px_rgba(10,22,18,0.55)]">
      {/* Full width rather than the page's centred column, so the logo sits in the left corner and the button in the
          right. From md up it is a 1fr / auto / 1fr grid, which keeps the links truly centred however wide the logo is. */}
      <div className="flex h-full items-center justify-between gap-4 px-3 sm:px-5 md:grid md:grid-cols-[1fr_auto_1fr]">
        <Link to="/" aria-label="Usha Pharmacy, home" className="justify-self-start rounded-xl bg-white px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-white/80">
          <img src="/logo/logo.jpg" alt="Usha Pharmacy" className="block h-16 w-auto select-none mix-blend-multiply" draggable="false" />
        </Link>
        <div className="hidden justify-self-center md:block">
          <LiquidNav items={LINKS} active={active} onChange={choose} tone="dark" label="Main" />
        </div>
        <div className="flex items-center gap-2 md:justify-self-end">
          <a href="#motion" className={`${ctaPrimary} !h-10 !rounded-full !bg-sage !px-5 !text-ink hover:!bg-white focus-visible:!ring-white/80`}>Get started</a>
        </div>
      </div>
    </header>
  );
}
