import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';
import ShowcaseFrame from './ShowcaseFrame';
import ShowcaseProgress from './ShowcaseProgress';
import { Pill } from './ShowcaseParts';
import useFitScale from './useFitScale';
import { DESIGN_H, DESIGN_W } from './showcaseData';
import { SLIDES } from './slides';
import './showcase.css';

gsap.registerPlugin(ScrollTrigger, useGSAP);

const N = SLIDES.length;
const pad = (i) => String(i + 1).padStart(2, '0');

/* The pinned tour needs room and permission to animate. Phones and reduced-motion visitors get stacked cards. */
const PINNED_QUERY = '(min-width: 768px) and (prefers-reduced-motion: no-preference)';

function useTourMode() {
  const [mode, setMode] = useState(() => (window.matchMedia(PINNED_QUERY).matches ? 'pinned' : 'stacked'));
  useEffect(() => {
    const mq = window.matchMedia(PINNED_QUERY);
    const sync = () => setMode(mq.matches ? 'pinned' : 'stacked');
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return mode;
}

function Copy({ step, index, active, withHighlights }) {
  return (
    <div data-copy className="showcase-copy" aria-hidden={index !== active}>
      <p className="text-[12px] font-bold tabular-nums tracking-wide text-primary">
        {pad(index)} <span className="text-muted">/ {pad(N - 1)}</span>
      </p>
      <h3 className="mt-2 text-2xl font-extrabold leading-tight tracking-tight text-ink lg:text-[2rem]">{step.title}</h3>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{step.description}</p>
      {withHighlights && (
        <ul className="mt-5 hidden space-y-2.5 lg:block">
          {step.highlights.map((h) => (
            <li key={h} className="flex items-start gap-2.5 text-sm font-semibold text-ink">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
              {h}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Desktop and tablet: one pinned stage, five scenes driven by scroll progress. */
function PinnedTour() {
  const stage = useRef(null);
  const slot = useRef(null);
  const [active, setActive] = useState(0);
  const scale = useFitScale(slot);

  useGSAP(
    () => {
      const root = stage.current;
      const mm = gsap.matchMedia();

      mm.add({ full: '(min-width: 1024px)', compact: '(max-width: 1023px)' }, (ctx) => {
        const { full } = ctx.conditions;
        const scenes = gsap.utils.toArray('[data-scene]', root);
        const copies = gsap.utils.toArray('[data-copy]', root);
        const fills = gsap.utils.toArray('[data-fill]', root);
        // On a tablet the per-block nudges are dropped: the cross-fade alone carries the transition.
        const reveals = scenes.map((s) => (full ? gsap.utils.toArray('[data-reveal]', s) : []));

        gsap.set(scenes.slice(1), { autoAlpha: 0, y: 18, scale: 1.012 });
        gsap.set(copies.slice(1), { autoAlpha: 0, y: 20 });
        reveals.slice(1).forEach((r) => r.length && gsap.set(r, { autoAlpha: 0, y: 12 }));
        gsap.set(fills, { scaleX: 0 });

        const tl = gsap.timeline({
          defaults: { ease: 'none' },
          scrollTrigger: {
            trigger: root,
            start: 'top 80px', // clears the sticky site header
            end: () => `+=${Math.round((window.innerHeight - 80) * N * (full ? 0.9 : 0.7))}`,
            pin: true,
            scrub: 0.6,
            anticipatePin: 1,
            invalidateOnRefresh: true,
            onUpdate: (self) => {
              const next = Math.min(N - 1, Math.floor(self.progress * N));
              setActive((prev) => (prev === next ? prev : next));
            },
          },
        });

        // Scene i takes over at time i; the cross-fade straddles that boundary so reversing is symmetrical.
        for (let i = 1; i < N; i += 1) {
          tl.to(scenes[i - 1], { autoAlpha: 0, y: -14, scale: 0.985, duration: 0.3, ease: 'power1.in' }, i - 0.15)
            .to(copies[i - 1], { autoAlpha: 0, y: -16, duration: 0.25, ease: 'power1.in' }, i - 0.15)
            .to(scenes[i], { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, ease: 'power1.out' }, i - 0.05)
            .to(copies[i], { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power1.out' }, i);
          if (reveals[i].length) tl.to(reveals[i], { autoAlpha: 1, y: 0, duration: 0.25, stagger: 0.04, ease: 'power1.out' }, i + 0.05);
        }
        // Each step's bar fills while that step is current; this also pads the timeline to exactly N units.
        fills.forEach((f, i) => tl.to(f, { scaleX: 1, duration: 1 }, i));
      });

      // Fonts changing the height of the section above would otherwise leave the pin start stale.
      const abort = new AbortController();
      document.fonts?.ready.then(() => !abort.signal.aborted && ScrollTrigger.refresh());

      return () => {
        abort.abort();
        mm.revert();
      };
    },
    { scope: stage },
  );

  return (
    <div ref={stage} data-stage className="w-full">
      <div className="mx-auto flex h-[calc(100svh-5rem)] max-w-[96rem] flex-col gap-4 px-6 pb-6 pt-4 lg:grid lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-12 lg:px-12 lg:py-10">
        <div className="flex flex-col justify-center gap-6 lg:gap-8 lg:self-center">
          <div className="showcase-copy-stack">
            {SLIDES.map((s, i) => <Copy key={s.id} step={s} index={i} active={active} withHighlights />)}
          </div>
          <ShowcaseProgress active={active} />
        </div>

        <div ref={slot} className="relative min-h-0 w-full flex-1 lg:h-full">
          <div
            className="absolute left-1/2 top-1/2"
            style={{ width: DESIGN_W, height: DESIGN_H, transform: `translate(-50%, -50%) scale(${scale})` }}
          >
            <ShowcaseFrame active={active}>
              {SLIDES.map(({ id, view: View }) => (
                <div key={id} data-scene className="showcase-scene">
                  <View />
                </div>
              ))}
            </ShowcaseFrame>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Phones and reduced motion: compact preview cards, one per module, with a light reveal where motion is allowed. */
function StackedTour() {
  const root = useRef(null);

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const cards = gsap.utils.toArray('[data-card]', root.current);
      gsap.set(cards, { autoAlpha: 0, y: 24 });
      ScrollTrigger.batch(cards, {
        start: 'top 90%',
        once: true,
        onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.1, ease: 'power2.out', overwrite: true }),
      });
    },
    { scope: root },
  );

  return (
    <div ref={root} className="mx-auto grid max-w-6xl gap-6 px-4 pb-16 sm:pb-24 md:grid-cols-2">
      {SLIDES.map((s, i) => {
        const View = s.view;
        return (
          <article key={s.id} data-card className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
            <div className="p-5 pb-4">
              <p className="text-[12px] font-bold tabular-nums tracking-wide text-primary">{pad(i)} <span className="text-muted">/ {pad(N - 1)}</span></p>
              <h3 className="mt-1.5 text-lg font-extrabold leading-snug tracking-tight text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.description}</p>
            </div>
            <div className="relative max-h-[24rem] overflow-hidden border-t border-line bg-app" inert aria-hidden="true">
              <div className="flex items-center justify-between border-b border-line bg-subtle px-3 py-1.5">
                <span className="text-[11px] font-bold text-muted">{s.short}</span>
                <Pill tone="info">Illustrative data</Pill>
              </div>
              <View />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-app to-transparent" />
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default function ProductShowcase() {
  const mode = useTourMode();

  return (
    <section id="platform" aria-labelledby="showcase-heading" className="scroll-mt-20 border-y border-ink/10 bg-ink/[0.025]">
      <header className="mx-auto max-w-3xl px-4 pb-10 pt-20 text-center sm:pb-14 sm:pt-32">
        <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-muted">Explore the platform</p>
        <h2 id="showcase-heading" className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-[-0.03em] text-ink sm:text-6xl">
          Everything your pharmacy needs. One intelligent platform.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          From the first sale of the day to the monthly review, Usha Pharmacy keeps billing, stock, batches and reporting in one place.
          The screens below use illustrative sample data.
        </p>
      </header>
      {/* Keyed so that switching layouts replaces the whole subtree; GSAP's pin spacer is never left inside React's tree. */}
      <div key={mode}>{mode === 'pinned' ? <PinnedTour /> : <StackedTour />}</div>
    </section>
  );
}
