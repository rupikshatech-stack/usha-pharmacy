/*
 * Point-cloud generators for the hero's morphing object. Each returns a Float32Array of 3 * n coordinates, scaled to
 * roughly the same bounding size so the lerp between any two shapes looks even.
 */
const TAU = Math.PI * 2;
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);

/** A pill: a cylinder along X with a hemisphere on each end, points on its surface. */
export function capsule(n) {
  const r = 0.62;
  const h = 0.9;
  const out = new Float32Array(n * 3);
  const pBody = h / (h + r); // share of the surface area that is the cylinder
  for (let i = 0; i < n; i += 1) {
    if (Math.random() < pBody) {
      const a = rand(0, TAU);
      out.set([rand(-h, h), r * Math.cos(a), r * Math.sin(a)], i * 3);
    } else {
      // uniform point on a sphere, pushed out to whichever end it faces
      const z = rand(-1, 1);
      const a = rand(0, TAU);
      const s = Math.sqrt(1 - z * z);
      const dx = z;
      const side = dx >= 0 ? 1 : -1;
      out.set([side * h + r * dx, r * s * Math.cos(a), r * s * Math.sin(a)], i * 3);
    }
  }
  return out;
}

/** A tablet: a flat round disc with a rim and a score line across its face. */
export function tablet(n) {
  const R = 1.25;
  const t = 0.13;
  const out = new Float32Array(n * 3);
  const pFace = R / (R + 2 * t);
  for (let i = 0; i < n; i += 1) {
    const roll = Math.random();
    if (roll < 0.06) {
      // the score line
      out.set([rand(-R * 0.92, R * 0.92), t + 0.012, rand(-0.025, 0.025)], i * 3);
    } else if (roll < 0.06 + 0.94 * pFace) {
      const a = rand(0, TAU);
      const rad = R * Math.sqrt(Math.random());
      out.set([rad * Math.cos(a), Math.random() < 0.5 ? t : -t, rad * Math.sin(a)], i * 3);
    } else {
      const a = rand(0, TAU);
      out.set([R * Math.cos(a), rand(-t, t), R * Math.sin(a)], i * 3);
    }
  }
  return out;
}

/** A medical cross: two crossing boxes, points on the outer surface only. */
export function cross(n) {
  const a = 1.2; // half arm length
  const w = 0.36; // half arm width
  const d = 0.2; // half depth
  const boxes = [
    { hx: a, hy: w, hz: d },
    { hx: w, hy: a, hz: d },
  ];
  const area = (b) => 8 * (b.hx * b.hy + b.hy * b.hz + b.hx * b.hz);
  const total = area(boxes[0]) + area(boxes[1]);
  const inside = (p, b) => Math.abs(p[0]) < b.hx - 1e-3 && Math.abs(p[1]) < b.hy - 1e-3 && Math.abs(p[2]) < b.hz - 1e-3;
  const out = new Float32Array(n * 3);
  let i = 0;
  while (i < n) {
    const bi = Math.random() * total < area(boxes[0]) ? 0 : 1;
    const b = boxes[bi];
    const faces = [b.hy * b.hz, b.hx * b.hz, b.hx * b.hy];
    const fs = faces[0] + faces[1] + faces[2];
    const pick = Math.random() * fs;
    const sign = Math.random() < 0.5 ? -1 : 1;
    let p;
    if (pick < faces[0]) p = [sign * b.hx, rand(-b.hy, b.hy), rand(-b.hz, b.hz)];
    else if (pick < faces[0] + faces[1]) p = [rand(-b.hx, b.hx), sign * b.hy, rand(-b.hz, b.hz)];
    else p = [rand(-b.hx, b.hx), rand(-b.hy, b.hy), sign * b.hz];
    if (inside(p, boxes[1 - bi])) continue; // hidden inside the other arm
    out.set(p, i * 3);
    i += 1;
  }
  return out;
}

export const SHAPES = [capsule, tablet, cross];
/** How far each shape is tilted toward the camera, so a flat shape is never seen edge-on. */
export const TILT_X = [0.2, 0.85, 0.05];
