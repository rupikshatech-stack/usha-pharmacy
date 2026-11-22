import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, ReceiptIndianRupee, Layers } from 'lucide-react';
import BillingDemo from './BillingDemo';
import BatchView from './ProductShowcase/BatchView';
import AnalyticsView from './ProductShowcase/AnalyticsView';
import { cx } from '../common/ui';
import useRise from './useRise';

/*
 * The tilted laptop: three real module screens cross-fading inside a CSS-3D laptop, with floating glow panels and
 * captions over it. Everything inside the screen is an existing component — the billing demo keeps its own timeline
 * and reports its stage back so the captions follow what is actually happening, rather than guessing on a timer.
 *
 * The whole sequence is gated on visibility and stops entirely for prefers-reduced-motion, which instead shows the
 * finished bill, one panel and one caption.
 */

/* Selling Point holds for one whole bill (~20 s); the two static screens hold long enough to actually read. */
const SCENES = [
  { id: 'pos', label: 'Selling Point', ms: 21000 },
  { id: 'expiry', label: 'Expiry Intelligence', ms: 13000 },
  { id: 'analytics', label: 'Business Analytics', ms: 13000 },
];

/** Caption per scene. The Selling Point's is chosen by the stage the bill is actually in. */
const BILL_CAPTIONS = {
  idle: 'Search, and the batch comes with it',
  searching: 'Search, and the batch comes with it',
  added: 'Every line carries its own batch',
  paying: 'The total updates as you bill',
  invoiced: 'Invoice raised, stock already updated',
};
const SCENE_CAPTION = { expiry: 'Catch expiry before it costs you', analytics: 'Your own numbers, ready to read' };

/*
 * Floating panels. Deliberately label what the software does — there is no customer data to quote, and a rupee
 * figure for "saved on expired stock" would be invented.
 */
const PANELS = [
  { icon: Layers, text: 'Batch tracked', cls: 'lp-panel--a' },
  { icon: ReceiptIndianRupee, text: 'GST-ready invoices', cls: 'lp-panel--b' },
  { icon: CalendarClock, text: 'Expiry flagged early', cls: 'lp-panel--c' },
];

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function LaptopStage() {
  const root = useRef(null);
  const stage = useRef(null);
  const [still] = useState(prefersStill);
  const [scene, setScene] = useState(0);
  // Bumped every time the Selling Point comes back round, so the bill restarts from an empty cart
  // rather than resuming halfway through the previous one.
  const [run, setRun] = useState(0);
  const [live, setLive] = useState(false);
  const [billStage, setBillStage] = useState('idle');
  useRise(root);

  // onStage is handed to a memoised setter so BillingDemo's effect doesn't re-run on every render here.
  const onStage = useCallback((s) => setBillStage(s), []);

  // Only run while the section is on screen.
  useEffect(() => {
    if (still || !stage.current) return undefined;
    const io = new IntersectionObserver(([e]) => setLive(e.isIntersecting), { threshold: 0.25 });
    io.observe(stage.current);
    return () => io.disconnect();
  }, [still]);

  useEffect(() => {
    if (!live) return undefined;
    const t = window.setTimeout(() => {
      setScene((n) => {
        const next = (n + 1) % SCENES.length;
        if (next === 0) setRun((r) => r + 1);
        return next;
      });
    }, SCENES[scene].ms);
    return () => clearTimeout(t);
  }, [live, scene]);

  const current = SCENES[scene];
  const caption = current.id === 'pos' ? BILL_CAPTIONS[billStage] : SCENE_CAPTION[current.id];
  // Reduced motion shows one panel; otherwise all three drift.
  const panels = still ? PANELS.slice(0, 1) : PANELS;

  return (
    <section id="motion" ref={root} aria-labelledby="motion-heading" className="lp-stage scroll-mt-16">
      <div className="lp-stage__glow" aria-hidden="true" />
      <div className="relative mx-auto max-w-6xl px-4 py-20 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <p data-rise className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">See it running</p>
          <h2 id="motion-heading" data-rise className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-5xl">
            From search to invoice, without leaving the keyboard
          </h2>
        </div>

        <div ref={stage} data-rise className="lp-stage__scene mt-16">
          {/* The laptop. aria-hidden because it is a decorative simulation; the caption list below carries the meaning. */}
          <div className="lp-laptop" aria-hidden="true">
            <div className="lp-laptop__lid">
              <div className="lp-laptop__screen">
                <div className="lp-laptop__chrome">
                  <span className="flex gap-1.5">
                    {[0, 1, 2].map((d) => <span key={d} className="h-1.5 w-1.5 rounded-full bg-ink/20" />)}
                  </span>
                  <span className="mx-auto text-[10px] text-muted">{current.label} · sample workspace</span>
                </div>
                <div className="lp-laptop__view">
                  <div className={cx('lp-scene', (still || scene === 0) && 'is-on')}>
                    <BillingDemo key={run} onStage={onStage} paused={!still && scene !== 0} />
                  </div>
                  <div className={cx('lp-scene', !still && scene === 1 && 'is-on')}><BatchView /></div>
                  <div className={cx('lp-scene', !still && scene === 2 && 'is-on')}><AnalyticsView /></div>
                </div>
              </div>
            </div>
            <div className="lp-laptop__base">
              <span className="lp-laptop__notch" />
            </div>
          </div>

          {/* Floating panels, positioned around the lid. */}
          <ul className="lp-panels" aria-hidden="true">
            {panels.map(({ icon: Icon, text, cls }) => (
              <li key={text} className={cx('lp-panel', cls)}>
                <Icon size={13} aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>

          {/* The caption. A live region so the sequence is announced rather than silently animating. */}
          <p className="lp-caption" aria-live="polite">
            <span key={caption} className="lp-caption__text">{caption}</span>
          </p>
        </div>

        <p data-rise className="mt-10 text-center text-[11px] text-muted">
          A simulation of the Selling Point, Expiry Intelligence and Analytics screens, using illustrative data.
        </p>
      </div>
    </section>
  );
}
