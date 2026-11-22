import { useEffect, useRef } from 'react';
import { createWarp } from './warp';
import { createFlat } from './flat';
import { HOLD } from './core';
import './stripcarousel.css';

/*
 * The Warp Cards canvas, with no section chrome of its own, so it can be dropped into an existing scene.
 *
 * It lives inside the zoom-split scene's layer band and is revealed once the scroll-driven split has finished;
 * the scene owns its opacity, this component only owns the rendering.
 *
 * Resilience, in the order it matters:
 *  - reduced motion renders one still frame and never starts a loop
 *  - no WebGL 2 (or a shader that will not build) falls back to the flat 2D path, never a blank canvas
 *  - a lost GL context is caught and the engine rebuilt on restore
 *  - the font wait is capped, so a slow or blocked webfont cannot stall the first paint
 */

const FONT_WAIT_MS = 600;

export default function WarpStage({ className = '' }) {
  const canvasRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let engine = null;
    let raf = 0;
    const state = { disposed: false };
    let start = performance.now();
    let visible = true;

    const build = () => {
      engine?.dispose?.();
      let centred = null;
      const onCentre = (id) => {
        if (id === centred) return;
        centred = id;
        if (id) host.dataset.card = id; else delete host.dataset.card;
      };
      engine = createWarp(canvas, onCentre) || createFlat(canvas);
      host.dataset.mode = engine?.flat ? 'flat' : 'webgl2';
      return engine;
    };

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    const drawOnce = (t) => {
      try {
        engine?.render(t, dpr());
      } catch {
        // a mid-frame context loss lands here; the restore handler rebuilds
      }
    };

    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (!visible) return;
      drawOnce((now - start) / 1000);
    };

    const onLost = (e) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      raf = 0;
      engine = null;
    };
    const onRestored = () => {
      if (state.disposed) return;
      build();
      if (still) drawOnce(HOLD * 0.55);
      else if (!raf) raf = requestAnimationFrame(loop);
    };
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; }, { threshold: 0.01 });
    io.observe(canvas);
    const onVis = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);
    const onResize = () => { if (still) drawOnce(HOLD * 0.55); };
    window.addEventListener('resize', onResize);

    const begin = () => {
      if (state.disposed) return;
      if (!build()) return;
      if (still) {
        // a representative still: one card centred, part-way through its values
        drawOnce(HOLD * 0.55);
        return;
      }
      start = performance.now();
      raf = requestAnimationFrame(loop);
    };

    const fonts = document.fonts?.ready;
    if (fonts) {
      let done = false;
      const go = () => { if (!done) { done = true; begin(); } };
      const timer = setTimeout(go, FONT_WAIT_MS); // capped: a blocked webfont cannot stall us
      fonts.then(() => { clearTimeout(timer); go(); }).catch(go);
    } else {
      begin();
    }

    return () => {
      state.disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      engine?.dispose?.();
      engine = null;
    };
  }, []);

  return (
    <div ref={hostRef} className={`sc-stage ${className}`}>
      <canvas ref={canvasRef} className="sc-canvas" aria-hidden="true" />
    </div>
  );
}
