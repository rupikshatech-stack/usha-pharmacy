import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(ScrollTrigger, useGSAP);

/**
 * Light reveal for a landing section: every `[data-rise]` inside `scope` eases up as it enters the viewport.
 * Nothing is hidden for visitors who prefer reduced motion.
 */
export default function useRise(scope) {
  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const items = gsap.utils.toArray('[data-rise]', scope.current);
      if (!items.length) return;
      gsap.set(items, { autoAlpha: 0, y: 40 });
      ScrollTrigger.batch(items, {
        start: 'top 92%',
        once: true,
        onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, duration: 0.9, stagger: 0.09, ease: 'power3.out', overwrite: true }),
      });
    },
    { scope },
  );
}
