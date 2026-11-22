import { buildPlane, buildProgram } from './shaders';
import { CARDS, FACE_H, FACE_W, drawFace } from './face';
import { BEND, holdPhase, offsetOf, radiusFor, smoothIndex } from './core';

/*
 * The WebGL 2 path.
 *
 * One texture per card, re-uploaded from that card's 2D canvas each frame. Cards are drawn back-to-front with
 * premultiplied alpha and no depth test, so the bent neighbours layer correctly under the centred card.
 */

export function createWarp(canvas, onCentre) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let prog;
  try {
    prog = buildProgram(gl);
  } catch {
    return null; // shader refused: caller falls back to 2D
  }
  const plane = buildPlane(gl, 44);

  const U = {
    p: gl.getUniformLocation(prog, 'uP'),
    span: gl.getUniformLocation(prog, 'uSpan'),
    aspect: gl.getUniformLocation(prog, 'uAspect'),
    scale: gl.getUniformLocation(prog, 'uScale'),
    cardH: gl.getUniformLocation(prog, 'uCardH'),
    radius: gl.getUniformLocation(prog, 'uRadius'),
    alpha: gl.getUniformLocation(prog, 'uAlpha'),
    smear: gl.getUniformLocation(prog, 'uSmear'),
    tex: gl.getUniformLocation(prog, 'uTex'),
  };

  // one offscreen 2D canvas + texture per card
  const faces = CARDS.map(() => {
    const cv = document.createElement('canvas');
    cv.width = FACE_W;
    cv.height = FACE_H;
    const ctx = cv.getContext('2d');
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { cv, ctx, tex };
  });

  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  function render(time, dpr) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const idx = smoothIndex(time);
    const phase = holdPhase(time);

    gl.useProgram(prog);
    gl.bindVertexArray(plane.vao);

    const aspect = w / h;
    // Card geometry: pick a half-height in world units, then derive how many slot units
    // wide the card must span so its drawn aspect matches the face canvas. d(x)/d(p) at
    // the centre of the arc is BEND * RADIUS.
    const HALF_H = 0.93;
    const halfW = HALF_H * (FACE_W / FACE_H);
    const radius = radiusFor(aspect);
    const span = (2 * halfW) / (BEND * radius);
    // framed off the shorter side, so a narrow window shrinks instead of cropping
    const scale = 0.98 * Math.min(1, aspect / 1.6);

    gl.uniform1f(U.aspect, aspect);
    gl.uniform1f(U.scale, scale);
    gl.uniform1f(U.span, span);
    gl.uniform1f(U.cardH, HALF_H);
    gl.uniform1f(U.radius, radius);
    gl.uniform1i(U.tex, 0);

    // repaint every face, then draw furthest-first
    const order = CARDS.map((card, i) => ({ card, i, off: offsetOf(i, idx) }))
      .sort((a, b) => Math.abs(b.off) - Math.abs(a.off));

    const mid = order.find((o) => Math.abs(o.off) < 0.08);
    onCentre?.(mid ? mid.card.id : null);

    for (const { card, i, off } of order) {
      const centred = Math.abs(off) < 0.5;
      drawFace(faces[i].ctx, card, centred ? phase : 1, centred);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, faces[i].tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, faces[i].cv);

      gl.uniform1f(U.p, off);
      gl.uniform1f(U.alpha, 1);
      gl.uniform1f(U.smear, Math.min(1.6, Math.abs(off)));
      gl.drawArrays(gl.TRIANGLES, 0, plane.count);
    }

    gl.bindVertexArray(null);
  }

  function dispose() {
    faces.forEach((f) => gl.deleteTexture(f.tex));
    gl.deleteVertexArray(plane.vao);
    gl.deleteBuffer(plane.buf);
    gl.deleteProgram(prog);
  }

  return { render, dispose, gl };
}
