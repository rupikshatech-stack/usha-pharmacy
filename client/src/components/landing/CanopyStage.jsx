import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import CanopyBackdrop from './CanopyBackdrop';

/*
 * The canopy hero of "Overstory Studio Landing" (MIT, Kedhareswer Naidu), with only a heading in the sky.
 *
 * Arrival: the first time the band is on screen, the eyebrow rises in and the heading rises line by line out of a
 * mask while the trees close in around the sky (that part is CanopyBackdrop's).
 * Alive: sway, falling leaves, pointer parallax (the heading drifts a little with the pointer too), a gust on click.
 * Rise: the band is a tall wrapper around a sticky stage. Scrolling it lifts you up through the leaves: each layer
 * zooms and turns at its own depth, the sky widens, the heading lifts away and blurs out, and a bank of mist (the
 * page's porcelain) rolls up; then the scene fades so the page's own backdrop carries on with no seam.
 *
 * The rise is the template's ScrollTrigger timeline re-timed by hand (no gsap): progress is the wrapper's scroll
 * position, eased toward on every frame so it trails the scroll by about 0.9s, as `scrub: 0.9` does.
 * With reduced motion it is the still canopy with the heading in place: no pin, no arrival, no rise.
 */

const ZOOM = [1.55, 1.95, 2.6, 3.6];
const TURN = [2, -3, 5, -9];
const SCRUB = 0.3; // seconds of the exponential catch-up; ~95% caught up after 0.9s

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** progress of `t` through [a, a + d], 0 before and 1 after */
const span = (t, a, d) => clamp01((t - a) / d);
const power1In = (t) => t * t;
const power2In = (t) => t * t * t;
const power1InOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export default function CanopyStage({ eyebrow, lines, headingId, seed = 23 }) {
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const wrap = useRef(null);
  const stage = useRef(null);
  const copy = useRef(null);
  const veil = useRef(null);

  // hide the words before the first paint, so the arrival starts from nothing (never from CSS: no script, no hiding)
  useLayoutEffect(() => {
    if (still) return;
    copy.current.querySelectorAll('[data-line] > span').forEach((s) => {
      s.style.transform = 'translateY(115%) rotate(2.5deg)';
    });
    copy.current.querySelector('[data-eyebrow]').style.opacity = '0';
  }, [still]);

  useEffect(() => {
    if (still) return undefined;
    const el = wrap.current;
    const st = stage.current;
    const cp = copy.current;
    const vl = veil.current;
    const rises = [...st.querySelectorAll('[data-climb]')];
    const skyCv = st.querySelector('[data-sky-cv]');
    const canopy = st.querySelector('.lp-canopy');
    let raf = 0;
    let last = 0;
    let cur = 0;
    let px = 0;
    let pxTarget = 0;

    /* arrival, once, when most of the stage is on screen */
    const arrive = () => {
      const ease = 'cubic-bezier(0.16, 1, 0.3, 1)'; // expo.out
      const eb = cp.querySelector('[data-eyebrow]');
      eb.animate([{ transform: 'translateY(16px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 1000, delay: 250, easing: ease, fill: 'backwards' }).onfinish = () => {
        eb.style.opacity = '';
      };
      cp.querySelectorAll('[data-line] > span').forEach((s, i) => {
        s.animate([{ transform: 'translateY(115%) rotate(2.5deg)' }, { transform: 'translateY(0) rotate(0deg)' }], { duration: 1500, delay: 300 + i * 120, easing: ease, fill: 'backwards' }).onfinish = () => {
          s.style.transform = '';
        };
        s.style.transform = '';
      });
    };
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          arrive();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(st);

    /* the rise */
    const apply = (t) => {
      const z = power2In(t);
      rises.forEach((r, i) => {
        r.style.transform = `scale(${(1 + (ZOOM[i] - 1) * z).toFixed(4)}) rotate(${(TURN[i] * z).toFixed(3)}deg)`;
      });
      if (skyCv) skyCv.style.transform = `scale(${(1 + 0.22 * t).toFixed(4)})`;
      const c = power1In(span(t, 0.05, 0.5));
      cp.style.transform = `translate3d(${px.toFixed(2)}px, ${(-window.innerHeight * 0.16 * c).toFixed(1)}px, 0) scale(${(1 - 0.08 * c).toFixed(4)})`;
      cp.style.opacity = String(1 - c);
      cp.style.filter = c > 0.001 ? `blur(${(10 * c).toFixed(2)}px)` : '';
      cp.style.visibility = c >= 0.999 ? 'hidden' : '';
      vl.style.transform = `translateY(${(50 - 100 * power1InOut(span(t, 0.45, 0.55))).toFixed(2)}%)`;
      // once the mist has covered it, the whole scene fades, so the page's own backdrop takes over with no seam
      const out = String(1 - span(t, 0.88, 0.12));
      canopy.style.opacity = out;
      vl.style.opacity = out;
    };
    const target = () => {
      const r = el.getBoundingClientRect();
      const run = r.height - st.offsetHeight;
      return run > 0 ? clamp01(-r.top / run) : 0;
    };
    const tick = (now) => {
      raf = 0;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const goal = target();
      const k = 1 - Math.exp(-dt / SCRUB);
      cur += (goal - cur) * k;
      px += (pxTarget - px) * (1 - Math.exp(-dt / 0.45));
      const moving = Math.abs(goal - cur) > 0.0005 || Math.abs(pxTarget - px) > 0.05;
      if (!moving) cur = goal;
      apply(cur);
      if (moving) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onMove = (e) => {
      const b = st.getBoundingClientRect();
      pxTarget = ((e.clientX - b.left) / b.width - 0.5) * 6;
      kick();
    };

    cur = target();
    apply(cur);
    window.addEventListener('scroll', kick, { passive: true });
    window.addEventListener('resize', kick);
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) st.addEventListener('pointermove', onMove);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('scroll', kick);
      window.removeEventListener('resize', kick);
      st.removeEventListener('pointermove', onMove);
    };
  }, [still]);

  return (
    <div ref={wrap} className={still ? 'lp-cstage-wrap is-still' : 'lp-cstage-wrap'}>
      <div ref={stage} className="lp-cstage">
        <CanopyBackdrop hostRef={stage} seed={seed} />
        <div ref={copy} className="lp-cstage-copy">
          <p data-eyebrow className="text-[12px] font-bold uppercase tracking-[0.2em]">
            {eyebrow}
          </p>
          <h2 id={headingId} className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
            {lines.map((l) => (
              <span key={l} data-line className="lp-cstage-line">
                <span>{l}</span>
              </span>
            ))}
          </h2>
        </div>
        <div ref={veil} className="lp-cstage-veil" aria-hidden="true" />
      </div>
    </div>
  );
}
