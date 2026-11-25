import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../common/ui';
import StepPhone from './HowItWorksPhones';

const STEPS = [
  ['Sign in', 'Open your organization’s workspace with the account your administrator created for you.'],
  ['Bring in your stock', 'Add medicines and batches, or import your existing inventory in bulk.'],
  ['Start billing', 'Open the Selling Point, bill your first customer and watch stock update.'],
];
const SHOTS = ['/screenshots/step-1-sign-in.png', '/screenshots/step-2-stock.png', '/screenshots/step-3-billing.png'];
/** How strongly each card drifts against the track as it passes the middle of the screen. Small on purpose. */
const DEPTH = [0.05, 0.065, 0.08];
/** The width HowItWorksPhones draws a phone at; each card scales it to fit its slot. */
const PHONE_W = 248;

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Heading() {
  return (
    <div className="lp-how-head mx-auto max-w-3xl px-4 text-center">
      <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-primary">How it works</p>
      <h2 id="how-heading" className="lp-how-title mt-3 font-extrabold leading-[1.08] tracking-[-0.03em] text-ink">
        From sign-in to first bill in three steps
      </h2>
    </div>
  );
}

function StepCard({ i, title, body }) {
  return (
    <li className="lp-how-card">
      <div className="lp-how-slot">
        <div className="lp-how-phone">
          <StepPhone step={i} screenshot={SHOTS[i]} />
        </div>
      </div>
      <div className="lp-how-caption">
        <h3 className="flex items-center justify-center gap-2.5 font-bold text-ink">
          <span className="lp-how-num grid place-items-center rounded-full bg-primary font-extrabold tabular-nums text-on-primary">{i + 1}</span>
          {title}
        </h3>
        <p className="mt-1.5 leading-relaxed text-muted">{body}</p>
      </div>
    </li>
  );
}

/**
 * Three steps from sign-in to the first bill, as a filmstrip: the stage pins while the section scrolls past, and the
 * vertical scroll drives the track of phones sideways, each card drifting a little against it for depth.
 *
 * The section's height is set in CSS (the stage plus the track's overflow), so it is right before any script runs.
 * The script only maps scroll to the track: progress = clamp((scrollY - top) / range), translateX = -progress * range,
 * where top is the section's top and range the track's overflow, both read again on every frame and resize, so a
 * section above that changes height (several load late) cannot leave the mapping stale.
 *
 * With reduced motion there is no pin and nothing is tied to scroll: the steps are a plain vertical stack.
 * The closing CTA and footer live in ClosingCta.
 */
export default function HowItWorks() {
  const [still] = useState(prefersStill);
  const section = useRef(null);
  const stage = useRef(null);
  const track = useRef(null);

  // The phones are drawn at one size and scaled to their slot, which is sized from the section's --u.
  useLayoutEffect(() => {
    const el = section.current;
    const fit = () => {
      const slot = el.querySelector('.lp-how-slot');
      if (slot) el.style.setProperty('--k', String(slot.clientWidth / PHONE_W));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (still) return undefined;
    const sec = section.current;
    const tr = track.current;
    const cards = [...tr.children];
    let raf = 0;
    let range = 0;
    let vw = 0;
    let centres = [];

    const measure = () => {
      vw = stage.current.clientWidth;
      range = Math.max(0, tr.scrollWidth - vw);
      centres = cards.map((c) => c.offsetLeft + c.offsetWidth / 2); // layout positions: transforms do not move these
    };
    const apply = () => {
      raf = 0;
      // scrollY - top, read as the section's distance above the viewport, so a shifting page above never goes stale
      const p = range ? Math.min(1, Math.max(0, -sec.getBoundingClientRect().top / range)) : 0;
      const x = -p * range;
      tr.style.transform = `translate3d(${x}px, 0, 0)`;
      cards.forEach((c, i) => {
        const drift = (vw / 2 - (centres[i] + x)) * DEPTH[i];
        c.style.transform = `translate3d(${drift.toFixed(2)}px, 0, 0)`;
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onResize = () => {
      measure();
      onScroll();
    };

    measure();
    apply();
    const ro = new ResizeObserver(onResize);
    ro.observe(sec);
    ro.observe(tr);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    document.fonts?.ready.then(onResize);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [still]);

  const cards = STEPS.map(([title, body], i) => <StepCard key={title} i={i} title={title} body={body} />);

  return (
    <section id="how" ref={section} aria-labelledby="how-heading" className={cx('lp-how', still ? 'lp-how--still scroll-mt-20' : 'lp-how--film')}>
      {still ? (
        <div className="px-4 pb-24 pt-20 sm:pt-28">
          <Heading />
          <ol className="mt-14 flex flex-col items-center gap-16">{cards}</ol>
        </div>
      ) : (
        <div ref={stage} className="lp-how-stage">
          <Heading />
          <div className="lp-how-viewport">
            <ol ref={track} className="lp-how-track">
              {cards}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
