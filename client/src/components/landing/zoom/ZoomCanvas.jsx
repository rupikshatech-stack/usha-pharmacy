import { useEffect, useRef } from 'react';
import { SRC_H, SRC_W, TARGET, getSource, loadSource } from './sceneSource';

/*
 * The camera push-in. Not a CSS transform on an <img>: every frame this redraws the visible CROP of the source
 * at full canvas resolution, so the picture stays sharp all the way in instead of smearing like a scaled bitmap.
 *
 * `getProgress` is read each frame rather than passed as a prop, so the scroll timeline can drive it without
 * re-rendering React on every tick.
 */

const MAX_SCALE = 5.5;
const ease = (t) => t * t * (3 - 2 * t);

export default function ZoomCanvas({ getProgress, className = '' }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return undefined;
    let cancelled = false;

    // The cache that keeps this from burning a frame redrawing an identical picture.
    const last = { t: -1, w: 0, h: 0, dpr: 0 };
    let raf = 0;
    let visible = true;

    const draw = (force = false) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;
      // Quantised so sub-pixel scroll jitter doesn't count as a change.
      const t = Math.round(Math.min(1, Math.max(0, getProgress())) * 1000) / 1000;
      if (!force && t === last.t && w === last.w && h === last.h && dpr === last.dpr) return; // nothing moved

      if (w !== last.w || h !== last.h || dpr !== last.dpr) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      last.t = t;
      last.w = w;
      last.h = h;
      last.dpr = dpr;

      const cw = canvas.width;
      const ch = canvas.height;
      const src = getSource();
      if (!src) {
        ctx.fillStyle = '#0b1120';
        ctx.fillRect(0, 0, cw, ch);
        return;
      }

      // Exponential scale reads as a real push-in; linear would feel like it stalls at the end.
      const scale = MAX_SCALE ** ease(t);
      // Crop that covers the canvas at this scale (cover-fit, so no letterboxing).
      const cover = Math.max(cw / SRC_W, ch / SRC_H);
      const sw = cw / (cover * scale);
      const sh = ch / (cover * scale);
      // Pan from the frame's centre to the barcode as we go in.
      const cx = SRC_W / 2 + (TARGET.x - SRC_W / 2) * ease(t);
      const cy = SRC_H / 2 + (TARGET.y - SRC_H / 2) * ease(t);
      const sx = Math.min(SRC_W - sw, Math.max(0, cx - sw / 2));
      const sy = Math.min(SRC_H - sh, Math.max(0, cy - sh / 2));

      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
    };

    // Redraw once the photograph arrives, then every frame it is on screen.
    loadSource().then(() => { if (!cancelled) draw(true); });

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (visible) draw();
    };
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => draw(true));
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(canvas);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [getProgress]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
