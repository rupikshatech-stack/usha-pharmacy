import { useLayoutEffect, useState } from 'react';
import { DESIGN_H, DESIGN_W } from './showcaseData';

/** Scale factor that fits the fixed-size ERP window into its slot, re-measured on every resize. */
export default function useFitScale(ref, { max = 1.15 } = {}) {
  const [scale, setScale] = useState(0.7);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth / DESIGN_W;
      const h = el.clientHeight / DESIGN_H;
      if (w > 0 && h > 0) setScale(Math.min(w, h, max) * 0.98);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, max]);
  return scale;
}
