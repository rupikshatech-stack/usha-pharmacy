import { useEffect, useRef } from 'react';

/*
 * The page's atmosphere, behind everything.
 *
 * Two fixed layers: a warm Clinical Porcelain gradient that carries the whole page, and a Deep Apothecary
 * Forest overlay that fades in as the final CTA arrives. The crossfade is driven straight from scrollY with a
 * smoothstep rather than a scroll library, so it costs one rAF-throttled style write and nothing else.
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

  useEffect(() => {
    const el = forest.current;
    if (!el) return undefined;
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
      document.documentElement.style.backgroundColor = toForest > 0.5 ? '#0a1814' : '#f7f6f2';
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
      <div ref={forest} className="lp-backdrop__forest absolute inset-0" style={{ opacity: 0 }} />
    </div>
  );
}
