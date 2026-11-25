import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../common/ui';
import StepPhone from './HowItWorksPhones';

const STEPS = [
  ['Sign in', 'Open your organization’s workspace with the account your administrator created for you.'],
  ['Bring in your stock', 'Add medicines and batches, or import your existing inventory in bulk.'],
  ['Start billing', 'Open the Selling Point, bill your first customer and watch stock update.'],
];
const SHOTS = ['/screenshots/step-1-sign-in.png', '/screenshots/step-2-stock.png', '/screenshots/step-3-billing.png'];
/** How strongly each phone drifts against the track as it passes the middle of the screen. Small on purpose. */
const DEPTH = [0.02, 0.025, 0.03];
/** Each phone's resting tilt in degrees; it leans a little further either way as it travels. */
const TILT = [-2.5, 2, -2];
/** The size HowItWorksPhones draws a phone at; each slot scales it to fit. */
const PHONE_W = 248;
const PHONE_H = 516;

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Heading() {
  return (
    <div className="lp-how-head">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">How it works</p>
      <h2 id="how-heading" className="lp-how-title mt-3 text-ink">
        From sign-in to first bill in three steps
      </h2>
    </div>
  );
}

/** One screen of the filmstrip: the step's number, title and text, then its phone. */
function StepItem({ i, title, body }) {
  return (
    <li className="lp-how-item">
      <div className="lp-how-text">
        <span className="lp-how-num grid place-items-center rounded-full bg-primary font-bold tabular-nums text-on-primary">{i + 1}</span>
        <h3 className="mt-4 font-bold text-ink">{title}</h3>
        <p className="mt-2 leading-relaxed text-muted">{body}</p>
      </div>
      <div className="lp-how-phonewrap">
        <div className="lp-how-slot">
          <div className="lp-how-phone">
            <StepPhone step={i} screenshot={SHOTS[i]} />
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * Three steps from sign-in to the first bill, as three screens of a filmstrip. The stage pins while the section
 * scrolls past, the heading holds at its top left, and the vertical scroll drives the screens sideways: each one is
 * the step's text with its phone beside it, the next step's text waiting at the right. Each phone drifts and leans a
 * little as it travels, for depth.
 *
 * The mapping is progress = clamp((scrollY - top) / range), translateX = -progress * range, where top is the
 * section's top and range the track's overflow. Both are read on every frame and resize, so sections above that
 * load late cannot leave it stale; the section's height is set from the measured range (CSS gives a close first
 * value, so the page does not jump before the script runs).
 *
 * With reduced motion there is no pin and nothing is tied to scroll: the steps are a plain vertical stack.
 * The closing CTA and footer live in ClosingCta.
 */
export default function HowItWorks() {
  const [still] = useState(prefersStill);
  const section = useRef(null);
  const stage = useRef(null);
  const track = useRef(null);

  // The phones are drawn at one size and scaled to their slot, which is sized in the section's CSS.
  useLayoutEffect(() => {
    const el = section.current;
    const fit = () => {
      const slot = el.querySelector('.lp-how-slot');
      if (slot) el.style.setProperty('--k', String(Math.min(slot.clientWidth / PHONE_W, slot.clientHeight / PHONE_H)));
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
    const items = [...tr.children];
    const phones = items.map((li) => li.querySelector('.lp-how-phonewrap'));
    let raf = 0;
    let range = 0;
    let vw = 0;
    let centres = [];

    const measure = () => {
      vw = stage.current.clientWidth;
      range = Math.max(0, tr.scrollWidth - vw);
      // exact pin length: the stage's height plus the sideways run
      sec.style.height = `${stage.current.offsetHeight + range}px`;
      // layout positions on the track (offsets ignore transforms, so the drift never feeds back into itself)
      centres = phones.map((ph, i) => items[i].offsetLeft + ph.offsetLeft + ph.offsetWidth / 2);
    };
    const apply = () => {
      raf = 0;
      // scrollY - top, read as the section's distance above the viewport, so a shifting page above never goes stale
      const p = range ? Math.min(1, Math.max(0, -sec.getBoundingClientRect().top / range)) : 0;
      const x = -p * range;
      tr.style.transform = `translate3d(${x}px, 0, 0)`;
      phones.forEach((ph, i) => {
        const off = vw / 2 - (centres[i] + x);
        const lean = Math.max(-1, Math.min(1, off / vw)) * 2;
        ph.style.transform = `translate3d(${(off * DEPTH[i]).toFixed(2)}px, 0, 0) rotate(${(TILT[i] + lean).toFixed(2)}deg)`;
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
    ro.observe(stage.current);
    ro.observe(tr);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    document.fonts?.ready.then(onResize);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      sec.style.height = '';
    };
  }, [still]);

  const items = STEPS.map(([title, body], i) => <StepItem key={title} i={i} title={title} body={body} />);

  return (
    <section id="how" ref={section} aria-labelledby="how-heading" className={cx('lp-how', still ? 'lp-how--still scroll-mt-20' : 'lp-how--film')}>
      {still ? (
        <div className="lp-how-glow px-4 pb-24 pt-20 sm:px-[4vw] sm:pt-28">
          <Heading />
          <ol className="mt-14 flex flex-col items-center gap-20">{items}</ol>
        </div>
      ) : (
        <div ref={stage} className="lp-how-stage lp-how-glow">
          <Heading />
          <div className="lp-how-viewport">
            <ol ref={track} className="lp-how-track">
              {items}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
