import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ArrowLeft, ArrowRight, CalendarClock, History, Layers, ShieldCheck } from 'lucide-react';
import { Kicker, stillMotion, useOvReveals } from './overstory/parts';

/*
 * "In the shade": the quotes band of "Overstory Studio Landing" (MIT, Kedhareswer Naidu), a dark forest band with
 * dappled light drifting across it. Where the template quotes customers, this holds the principles the app is built
 * on, because quotes would need real customers saying them. Each one is a thing the code does.
 *
 * They change on a timer you can see (the bar under the current dot fills), the timer pauses while you hover or focus
 * the band (and while it is off screen), and the words rise in on every change. With reduced motion nothing advances on its own.
 */

const PRINCIPLES = [
  {
    text: 'Stock and the bill move together. A sale, its stock movement and its invoice are saved as one, or not at all.',
    name: 'One transaction',
    role: 'Billing and stock',
    Icon: Layers,
  },
  {
    text: 'Expiry is a forecast, not a surprise. Every batch carries its date, and the expiry view shows which stock will not sell in time.',
    name: 'Expiry intelligence',
    role: 'Batches and expiry',
    Icon: CalendarClock,
  },
  {
    text: 'Each pharmacy sees only its own data. One system serves many pharmacies, and every record belongs to exactly one of them.',
    name: 'Kept apart by design',
    role: 'Data and access',
    Icon: ShieldCheck,
  },
  {
    text: 'Every change has a name on it. What was changed, when, and by whom is kept in an activity log.',
    name: 'Activity log',
    role: 'Accountability',
    Icon: History,
  },
];

export default function Principles() {
  const root = useRef(null);
  const [cur, setCur] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still] = useState(stillMotion);
  const [seen, setSeen] = useState(false);

  // the timer only runs while the band is on screen, so the first principle is the one you arrive to
  useEffect(() => {
    const io = new IntersectionObserver((es) => setSeen(es.some((e) => e.isIntersecting)), { threshold: 0.25 });
    io.observe(root.current);
    return () => io.disconnect();
  }, []);
  const p = PRINCIPLES[cur];
  const n = PRINCIPLES.length;

  useOvReveals(root);

  // the words rise on every change
  useLayoutEffect(() => {
    if (still || !root.current) return undefined;
    const ws = root.current.querySelectorAll('[data-quote] [data-qw]');
    const t = gsap.fromTo(ws, { yPercent: 110, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1, stagger: 0.02, ease: 'expo.out' });
    return () => t.kill();
  }, [cur, still]);

  return (
    <section
      id="principles"
      ref={root}
      className="lp-ov lp-ov-shade"
      aria-labelledby="principles-heading"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="lp-ov-dapple" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="lp-ov-wrap lp-ov-quote-wrap">
        <h2 id="principles-heading" className="sr-only">
          What it is built on
        </h2>
        <Kicker n="✦" text="In the shade, what it is built on" light />
        <figure className="lp-ov-quote" data-quote aria-live="polite">
          <blockquote>
            <p>
              {p.text.split(' ').map((w, i) => (
                <Fragment key={`${cur}-${i}`}>
                  <span className="lp-ov-w">
                    <span data-qw>{w}</span>
                  </span>{' '}
                </Fragment>
              ))}
            </p>
          </blockquote>
          <figcaption>
            <span className="lp-ov-avatar" aria-hidden="true">
              <p.Icon size={22} strokeWidth={2} />
            </span>
            <span>
              <b>{p.name}</b>
              <span>{p.role}</span>
            </span>
          </figcaption>
        </figure>
        <div className="lp-ov-quote-nav">
          <button type="button" className="lp-ov-round" aria-label="Previous principle" onClick={() => setCur((v) => (v - 1 + n) % n)}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <div className="lp-ov-dots">
            {PRINCIPLES.map((q, i) => (
              <button key={q.name} type="button" aria-label={`Principle ${i + 1} of ${n}`} aria-current={i === cur ? 'true' : undefined} onClick={() => setCur(i)}>
                {i === cur && !still ? <i key={cur} data-paused={paused || !seen ? '' : undefined} onAnimationEnd={() => setCur((v) => (v + 1) % n)} /> : null}
              </button>
            ))}
          </div>
          <button type="button" className="lp-ov-round" aria-label="Next principle" onClick={() => setCur((v) => (v + 1) % n)}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
