import { CARDS, FACE_H, FACE_W, drawFace } from './face';
import { holdPhase, offsetOf, place, radiusFor, smoothIndex } from './core';

/*
 * The flat 2D fallback, used when WebGL 2 is missing or the context cannot be created.
 *
 * It runs the SAME `place()` math as the shader, so cards still sit on the arc and recede — they just cannot
 * genuinely bend or smear, since canvas 2D has no per-vertex control. Better a correct, readable carousel than
 * a blank canvas.
 */

export function createFlat(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const faces = CARDS.map(() => {
    const cv = document.createElement('canvas');
    cv.width = FACE_W;
    cv.height = FACE_H;
    return { cv, ctx: cv.getContext('2d') };
  });

  function render(time, dpr) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const idx = smoothIndex(time);
    const phase = holdPhase(time);
    const unit = Math.min(w / 2.9, h / 1.5); // same shorter-side framing as the GL path

    const order = CARDS.map((card, i) => ({ card, i, off: offsetOf(i, idx) }))
      .sort((a, b) => Math.abs(b.off) - Math.abs(a.off));

    for (const { card, i, off } of order) {
      const centred = Math.abs(off) < 0.5;
      drawFace(faces[i].ctx, card, centred ? phase : 1, centred);

      const pos = place(off, radiusFor(w / h));
      const persp = 1 / (1 - pos.z * 0.26);
      const cw = unit * 0.78 * persp;
      const ch = cw * (FACE_H / FACE_W);
      const cx = w / 2 + pos.x * unit * 0.42 * persp;
      const cy = h / 2;
      const fade = 1 - Math.min(1, Math.max(0, (Math.abs(off) - 0.75) / 1.0));

      ctx.save();
      ctx.globalAlpha = Math.max(0.08, fade);
      ctx.translate(cx, cy);
      // 2D cannot bend, so the yaw is approximated with a horizontal squeeze
      ctx.scale(Math.max(0.12, Math.cos(pos.ry)), 1);
      ctx.drawImage(faces[i].cv, -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
    }
  }

  return { render, dispose() {}, flat: true };
}
