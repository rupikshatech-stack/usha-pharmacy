import { useEffect, useRef } from 'react';
import DarkPattern from './DarkPattern';

/*
 * The page's atmosphere, behind everything.
 *
 * Three fixed layers: a warm Clinical Porcelain gradient that carries the whole page; the dark hero pattern,
 * clipped to the hero's own rectangle (the 3D capsule sits above this layer, which is why the hero is painted here
 * and not as an opaque background on the hero itself); and a Deep Apothecary Forest overlay that fades in as the
 * final CTA arrives. The forest crossfade is driven straight from scrollY with a smoothstep and the hero clip from
 * the hero's bounding box, with no scroll library, so it costs one rAF-throttled style write and nothing else.
 *
 * Nothing here is interactive and nothing here blurs: a backdrop-filter over the live WebGL canvas stalls
 * software renderers badly, so the surfaces above use solid colour instead.
 */

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
};

export default function BackdropLayers() {
  const forest = useRef(null);
  const hero = useRef(null);

  useEffect(() => {
    const el = forest.current;
    const heroEl = hero.current;
    const heroSection = document.querySelector('.lp-hero--dark');
    if (!el || !heroEl) return undefined;
    let raf = 0;

    const apply = () => {
      raf = 0;
      const end = document.getElementById('end');
      const vh = window.innerHeight;
      if (!end) return;
      const endTop = end.getBoundingClientRect().top + window.scrollY;
      // fully porcelain until the last screen, fully forest once the CTA is seated
      const toForest = smoothstep(endTop - 0.9 * vh, endTop - 0.1 * vh, window.scrollY);
      el.style.opacity = String(toForest);
      // The dark pattern covers exactly the hero's rectangle: its bottom edge follows the hero's bottom edge up the screen,
      // so light copy always sits on dark, and the dark ends where the next section starts. (An opacity fade tied to scroll
      // distance cannot do this: the hero is taller than the screen, so its last lines are still showing while it fades.)
      const heroBottom = heroSection ? heroSection.getBoundingClientRect().bottom : vh;
      const heroOn = heroBottom > 0 ? 1 : 0;
      heroEl.style.clipPath = `inset(0 0 ${Math.max(0, vh - heroBottom)}px 0)`;
      heroEl.style.visibility = heroOn ? 'visible' : 'hidden'; // nothing to paint once the hero has left the screen
      document.documentElement.style.backgroundColor = toForest > 0.5 || heroBottom > 0.5 * vh ? '#0a1814' : '#f7f6f2';
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="lp-backdrop__base absolute inset-0" />
      <div ref={hero} className="absolute inset-0" style={{ willChange: 'opacity' }}>
        <DarkPattern />
      </div>
      <div ref={forest} className="lp-backdrop__forest absolute inset-0" style={{ opacity: 0 }} />
    </div>
  );
}
