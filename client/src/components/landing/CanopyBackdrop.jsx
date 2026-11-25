import { useEffect, useRef } from 'react';

/*
 * A view straight up through a ring of autumn trees into a patch of sky, drawn to canvas: a seeded sky with clouds and
 * a sun glow, then four depth layers of branches and backlit leaves, far to near. Each layer sways on its own slow
 * loop, the layers shift against the pointer, leaves drift down across the sky, and a click on the sky sends a gust
 * that swings the branches and shakes a handful of leaves loose. When the section first comes on screen the trees
 * close in around the sky.
 *
 * Ported from the generated canopy of "Overstory Studio Landing" by Kedhareswer Naidu (MIT,
 * https://kedhar.pages.dev). Only the generated canopy is used: the template's embedded stock photo is not.
 *
 * Cost: the five canvases are drawn once, one per frame so the main thread never stalls, only when the section gets
 * near the screen, and again only when its box changes size a lot. Off screen, the sway pauses and no leaves fall.
 * With reduced motion it is the still canopy: no sway, no falling leaves, no parallax, no gust.
 */

const PALETTE = { shadow: [46, 20, 10], mid: [146, 62, 18], lit: [224, 138, 36], glow: [252, 210, 116], twig: [46, 30, 22], shape: 0.5 };
export const CANOPY_ACCENT = '#a5451a';
export const CANOPY_SOFT = '#f1b24a';

const SKY = { stops: [[0, [100, 150, 208]], [0.55, [166, 202, 233]], [1, [212, 228, 241]]], sun: [0.56, 0.28, 255, 255, 250, 0.62], cloud: [255, 255, 255, 0.9], haze: [194, 216, 236] };

/** Four depth layers, far to near. `reach` is where the leaves start, in units of the half-box ellipse. */
const LAYERS = [
  { reach: 0.6, band: 0.52, leaf: 0.011, twigs: 9, masses: 170, per: 26, haze: 0.44, blur: 0.5, res: 1.25 },
  { reach: 0.72, band: 0.58, leaf: 0.016, twigs: 8, masses: 135, per: 26, haze: 0.22, blur: 0, res: 1.25 },
  { reach: 0.86, band: 0.66, leaf: 0.023, twigs: 7, masses: 105, per: 24, haze: 0.08, blur: 0, res: 1 },
  { reach: 1.02, band: 0.86, leaf: 0.036, twigs: 6, masses: 82, per: 22, haze: 0, blur: 2.2, res: 0.8 },
];
/** How far each layer shifts against the pointer, in px. */
const DEPTH = [8, 14, 24, 40];
const IDLE_LEAVES = 5;
const BURST_LEAVES = 9;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (i, j) => hash(i * 57.0 + j * 131.0);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
}

function fbm(x, y) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    s += a * noise2(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s / 0.96875;
}

/** The radii of the box ellipse the canopy is measured in. Phones get a taller hole. */
function ellipse(w, h) {
  return { rx: Math.max(w / 2, h * 0.34), ry: h / 2 };
}

/** Normalised distance from the centre: 0 at the middle, 1 on the ellipse. */
function distAt(x, y, w, h) {
  const e = ellipse(w, h);
  const dx = (x - w / 2) / e.rx;
  const dy = (y - h / 2) / e.ry;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Where a layer's leaves begin at an angle: a lobed ring, different per seed, coherent across layers. */
function reachAt(theta, layer, seed) {
  const p1 = hash(seed + 1) * 6.283;
  const p2 = hash(seed + 2) * 6.283;
  const p3 = hash(seed + 3) * 6.283;
  const base = LAYERS[layer].reach;
  return base * (1 + 0.13 * Math.sin(3 * theta + p1 + layer * 0.55) + 0.08 * Math.sin(5 * theta + p2 - layer * 0.9) + 0.05 * Math.sin(8 * theta + p3 + layer * 1.7));
}

/** Every branch and leaf of one layer, for a box of w by h. Deterministic for a seed. */
function canopyPlan(w, h, layer, seed) {
  const spec = LAYERS[layer];
  const rand = mulberry32(seed * 977 + layer * 7919 + 13);
  const gauss = () => (rand() + rand() + rand() - 1.5) / 0.75;
  // leaves keep a minimum size, so a phone's canopy reads as dense as a desktop's
  const u = Math.max(Math.sqrt(w * h), 1000);
  const leafPx = spec.leaf * u;
  const cx = w / 2;
  const cy = h / 2;
  const area = clamp((w * h) / (1612 * 1008), 0.62, 1.35);
  const twigs = [];
  const clusters = [];
  const branchCap = Math.round(spec.masses * area * 0.9);
  let forks = 0;

  const thetaOf = (x, y) => {
    const e = ellipse(w, h);
    return Math.atan2((y - cy) / e.ry, (x - cx) / e.rx);
  };

  // branches reach in from beyond the frame and end in clusters at the hole's edge
  const grow = (x, y, dir, width, depth) => {
    const pts = [x, y];
    const step = u * 0.028;
    let px = x;
    let py = y;
    let a = dir;
    const stopAt = reachAt(thetaOf(x, y), layer, seed) + 0.02 + rand() * 0.08;
    for (let i = 0; i < 60; i++) {
      a += (rand() - 0.5) * 0.32;
      const toC = Math.atan2(cy - py, cx - px);
      let diff = toC - a;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      a += diff * 0.08;
      px += Math.cos(a) * step;
      py += Math.sin(a) * step;
      pts.push(px, py);
      const d = distAt(px, py, w, h);
      const here = reachAt(thetaOf(px, py), layer, seed);
      if (d < here + spec.band * 0.75 && i % 2 === 0 && clusters.length < branchCap) {
        clusters.push({ x: px + gauss() * leafPx, y: py + gauss() * leafPx, r: leafPx * (1.9 + rand() * 1.2), n: Math.round(spec.per * (0.7 + rand() * 0.5)), d });
      }
      if (depth < 2 && i > 3 && forks < spec.twigs * 2 && rand() < 0.16 && ++forks) {
        grow(px, py, a + (rand() < 0.5 ? -1 : 1) * (0.45 + rand() * 0.4), width * 0.55, depth + 1);
      }
      if (d < Math.min(stopAt, here + 0.04)) break;
    }
    clusters.push({ x: px, y: py, r: leafPx * 2.8, n: Math.round(spec.per * 1.4), d: distAt(px, py, w, h) });
    twigs.push({ p: pts, w: width });
  };

  for (let i = 0; i < spec.twigs; i++) {
    const t = (i / spec.twigs) * Math.PI * 2 + rand() * 0.5;
    const e = ellipse(w, h);
    const sx = cx + Math.cos(t) * e.rx * 1.55;
    const sy = cy + Math.sin(t) * e.ry * 1.55;
    grow(sx, sy, Math.atan2(cy - sy, cx - sx) + (rand() - 0.5) * 0.7, leafPx * (0.42 + rand() * 0.2), 0);
  }

  // masses fill the band behind the branches, with noise-shaped gaps of sky
  const want = Math.round(spec.masses * area);
  const off = hash(seed + layer) * 100;
  for (let tries = 0, got = 0; got < want && tries < want * 30; tries++) {
    const x = rand() * w;
    const y = rand() * h;
    const d = distAt(x, y, w, h);
    const r = reachAt(thetaOf(x, y), layer, seed);
    if (d < r || d > r + spec.band) continue;
    const gap = fbm(x / (u * 0.12) + off, y / (u * 0.12) - off);
    const nearEdge = 1 - (d - r) / spec.band;
    if (gap < 0.36 + nearEdge * 0.12) continue;
    clusters.push({ x, y, r: leafPx * (1.9 + rand() * 1.6), n: Math.round(spec.per * (0.8 + rand() * 0.5)), d });
    got++;
  }

  // outer clusters first, so the sunlit edge of the hole sits on top
  clusters.sort((p, q) => q.d - p.d);
  const leaves = [];
  for (const c of clusters) {
    const r = reachAt(thetaOf(c.x, c.y), layer, seed);
    const depthIn = clamp((c.d - r) / spec.band, 0, 1);
    const tx = cx - c.x;
    const ty = cy - c.y;
    const tl = Math.hypot(tx, ty) || 1;
    const group = [];
    for (let k = 0; k < c.n; k++) {
      const ox = gauss() * c.r * 0.55;
      const oy = gauss() * c.r * 0.55;
      const ol = Math.hypot(ox, oy) || 1;
      const toward = (ox * tx + oy * ty) / (ol * tl);
      const l = 0.5 + 0.28 * toward * Math.min(1, ol / c.r) + (rand() - 0.5) * 0.36 - depthIn * (0.3 + layer * 0.07) + 0.08;
      group.push({ x: c.x + ox, y: c.y + oy, s: leafPx * (0.72 + rand() * 0.6), a: Math.atan2(oy, ox) + (rand() - 0.5) * 1.3, l: clamp(l, 0, 1) });
    }
    group.sort((p, q) => p.l - q.l);
    for (const g of group) leaves.push(g);
  }
  return { twigs, leaves };
}

const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** Shadow to mid to sunlit to glowing, then hazed toward the sky for depth. */
function leafColor(l, hazeAmt) {
  const p = PALETTE;
  let c;
  if (l < 0.45) c = mix(p.shadow, p.mid, l / 0.45);
  else if (l < 0.86) c = mix(p.mid, p.lit, (l - 0.45) / 0.41);
  else c = mix(p.lit, p.glow, (l - 0.86) / 0.14);
  return mix(c, SKY.haze, hazeAmt);
}

function skyAt(t) {
  const { stops } = SKY;
  for (let i = 1; i < stops.length; i++) {
    const [a0, a1] = stops[i - 1];
    const [b0, b1] = stops[i];
    if (t <= b0) return mix(a1, b1, (t - a0) / (b0 - a0));
  }
  return stops[stops.length - 1][1];
}

function drawSky(cv, w, h, seed) {
  const k = 0.32;
  const W = Math.max(8, Math.round(w * k));
  const H = Math.max(8, Math.round(h * k));
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(W, H);
  const off = hash(seed) * 50;
  const [sx, sy, sr, sg, sb, sa] = SKY.sun;
  for (let y = 0; y < H; y++) {
    const base = skyAt(y / (H - 1));
    for (let x = 0; x < W; x++) {
      const dx = x / W - sx;
      const dy = (y / H - sy) * (h / w);
      let c = mix(base, [sr, sg, sb], Math.exp(-(dx * dx + dy * dy) * 9) * sa);
      const n = fbm(x / (W * 0.16) + off, y / (H * 0.2) - off * 0.5);
      const wisp = fbm(x / (W * 0.05) - off, y / (H * 0.07) + off);
      c = mix(c, SKY.cloud, smoothstep(0.5, 0.82, n * 0.8 + wisp * 0.25) * SKY.cloud[3]);
      const i = (y * W + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawLayer(cv, w, h, layer, seed) {
  const spec = LAYERS[layer];
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * spec.res;
  const W = Math.max(4, Math.round(w * dpr));
  const H = Math.max(4, Math.round(h * dpr));
  const plan = canopyPlan(w, h, layer, seed);
  const target = spec.blur > 0 ? document.createElement('canvas') : cv;
  target.width = W;
  target.height = H;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const hazeAmt = spec.haze;
  // branches
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = rgb(mix(PALETTE.twig, SKY.haze, hazeAmt));
  for (const t of plan.twigs) {
    const n = t.p.length / 2;
    for (let i = 1; i < n; i++) {
      ctx.lineWidth = Math.max(0.6, t.w * (1 - (i / n) * 0.8)) * dpr;
      ctx.beginPath();
      ctx.moveTo(t.p[(i - 1) * 2] * dpr, t.p[(i - 1) * 2 + 1] * dpr);
      ctx.lineTo(t.p[i * 2] * dpr, t.p[i * 2 + 1] * dpr);
      ctx.stroke();
    }
  }
  // leaves
  const shape = PALETTE.shape;
  const vein = layer >= 2;
  for (const f of plan.leaves) {
    const c = Math.cos(f.a) * dpr;
    const s = Math.sin(f.a) * dpr;
    ctx.setTransform(c, s, -s, c, f.x * dpr, f.y * dpr);
    const L = f.s * 0.5;
    const Wd = f.s * shape;
    ctx.fillStyle = rgb(leafColor(f.l, hazeAmt));
    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.quadraticCurveTo(0, -Wd, L, 0);
    ctx.quadraticCurveTo(0, Wd, -L, 0);
    ctx.fill();
    if (f.l > 0.72) {
      ctx.fillStyle = rgb(leafColor(Math.min(1, f.l + 0.16), hazeAmt), 0.7);
      ctx.beginPath();
      ctx.moveTo(-L * 0.55, 0);
      ctx.quadraticCurveTo(0, -Wd * 0.5, L * 0.7, 0);
      ctx.quadraticCurveTo(0, Wd * 0.5, -L * 0.55, 0);
      ctx.fill();
    }
    if (vein && f.s > 14) {
      ctx.strokeStyle = rgb(leafColor(f.l * 0.55, hazeAmt), 0.55);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-L * 0.9, 0);
      ctx.lineTo(L * 0.8, 0);
      ctx.stroke();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (target !== cv) {
    cv.width = W;
    cv.height = H;
    const out = cv.getContext('2d');
    if (!out) return;
    out.filter = `blur(${spec.blur * dpr}px)`;
    out.drawImage(target, 0, 0);
    out.filter = 'none';
  }
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function FallingLeaf({ burst, i }) {
  return (
    <span className="lp-canopy-fall" data-fall={burst ? 'burst' : 'idle'}>
      <svg viewBox="0 0 24 24" style={{ color: i % 3 ? CANOPY_ACCENT : CANOPY_SOFT }}>
        <path fill="currentColor" d="M2 12C6 5 14 3.5 22 12c-8 8.5-16 7-20 0z" />
        <path d="M3 12h17" stroke="rgba(0,0,0,.25)" strokeWidth="0.8" />
      </svg>
    </span>
  );
}

/**
 * The canopy, filling its positioned parent. `hostRef` is the section it sits in: pointer moves there shift the
 * layers, and a click there that does not land on a control sends a gust.
 */
export default function CanopyBackdrop({ hostRef, seed = 23 }) {
  const box = useRef(null);
  const sky = useRef(null);
  const canvases = useRef([]);

  useEffect(() => {
    const el = box.current;
    const host = hostRef.current;
    if (!el || !host) return undefined;
    const still = reduced();
    const layers = [...el.querySelectorAll('[data-layer]')];
    const gusts = [...el.querySelectorAll('[data-gust]')];
    const zooms = [...el.querySelectorAll('[data-zoom]')];
    const skyBox = el.querySelector('[data-sky]');
    const idle = [...el.querySelectorAll('[data-fall="idle"]')];
    const burst = [...el.querySelectorAll('[data-fall="burst"]')];

    let alive = true;
    let job = 0;
    let size = { w: 0, h: 0 };
    let drawn = false;
    let near = false;
    let onScreen = false;
    let entered = false;
    const timers = new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };

    /* drawing: one canvas per frame, only once the section is near */
    const draw = () => {
      cancelAnimationFrame(job);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w < 2 || h < 2) return;
      size = { w, h };
      const work = [
        () => sky.current && drawSky(sky.current, w, h, seed),
        ...LAYERS.map((_, i) => () => {
          const cv = canvases.current[i];
          // the layer box is larger than the stage (see .lp-canopy-layer), so plan for its own size
          if (cv?.parentElement) drawLayer(cv, cv.parentElement.clientWidth, cv.parentElement.clientHeight, i, seed);
        }),
      ];
      let i = 0;
      const next = () => {
        if (!alive) return;
        try {
          work[i]();
        } catch {
          /* a canvas that cannot draw leaves the CSS sky behind it */
        }
        i++;
        if (i < work.length) job = requestAnimationFrame(next);
        else {
          drawn = true;
          el.setAttribute('data-drawn', '');
          if (onScreen) enter();
        }
      };
      job = requestAnimationFrame(next);
    };

    /* arrival: the trees close in around the sky, the first time the drawn canopy is on screen */
    const enter = () => {
      if (entered || still) return;
      entered = true;
      skyBox.animate([{ transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 2600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      zooms.forEach((z, i) => {
        z.animate(
          [
            { transform: `scale(${1.45 + i * 0.28}) rotate(${i % 2 ? -6 : 6}deg)`, opacity: 0 },
            { transform: 'scale(1) rotate(0deg)', opacity: 1 },
          ],
          { duration: 2600, delay: i * 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
        );
      });
    };

    /* leaves in the air: a few always drifting down while the section is on screen */
    const fall = (leaf, delay) => {
      later(() => {
        if (!alive || !onScreen) {
          leaf.dataset.waiting = '1';
          return;
        }
        const w = host.clientWidth;
        const h = host.clientHeight;
        const x = w * Math.random();
        const r = Math.random() * 360;
        const anim = leaf.animate(
          [
            { transform: `translate(${x}px, -60px) rotate(${r}deg)`, opacity: 0.9 },
            { transform: `translate(${x + Math.random() * 240 - 120}px, ${h + 60}px) rotate(${r + Math.random() * 540 - 270}deg)`, opacity: 0.9 },
          ],
          { duration: 11000 + Math.random() * 8000, easing: 'linear' },
        );
        anim.onfinish = () => fall(leaf, Math.random() * 3000);
      }, delay);
    };
    const wake = () => {
      idle.forEach((leaf) => {
        if (leaf.dataset.waiting) {
          delete leaf.dataset.waiting;
          fall(leaf, Math.random() * 2500);
        }
      });
    };

    /* a gust: the layers swing and spring back, and a handful of leaves shake loose */
    const gust = (fx) => {
      const dir = fx < 0.5 ? 1 : -1;
      gusts.forEach((g, i) => {
        const peak = dir * (0.6 + i * 0.5);
        g.animate(
          [
            { transform: 'rotate(0deg)' },
            { transform: `rotate(${peak}deg)`, offset: 0.18 },
            { transform: `rotate(${-peak * 0.35}deg)`, offset: 0.42 },
            { transform: `rotate(${peak * 0.12}deg)`, offset: 0.66 },
            { transform: 'rotate(0deg)' },
          ],
          { duration: 1900 + i * 60, easing: 'ease-out' },
        );
      });
      const w = host.clientWidth;
      const h = host.clientHeight;
      burst.forEach((leaf, i) => {
        leaf.getAnimations().forEach((a) => a.cancel());
        const x = w * (0.15 + Math.random() * 0.7);
        const r = Math.random() * 360;
        leaf.animate(
          [
            { transform: `translate(${x}px, -40px) rotate(${r}deg)`, opacity: 1 },
            { transform: `translate(${x + dir * (80 + Math.random() * 220)}px, ${h * (0.7 + Math.random() * 0.5)}px) rotate(${r + 220 + Math.random() * 300}deg)`, opacity: 1 },
          ],
          { duration: 3200 + Math.random() * 2000, delay: i * 60, easing: 'cubic-bezier(0.55, 0, 1, 0.45)', fill: 'backwards' },
        );
      });
    };
    const onClick = (e) => {
      if (e.target.closest('a, button, input, [role="tabpanel"]')) return;
      const b = host.getBoundingClientRect();
      gust((e.clientX - b.left) / b.width);
    };

    /* pointer parallax: each layer eases toward its offset */
    const target = layers.map(() => [0, 0]);
    const cur = layers.map(() => [0, 0]);
    let praf = 0;
    const settle = () => {
      praf = 0;
      let moving = false;
      layers.forEach((l, i) => {
        cur[i][0] += (target[i][0] - cur[i][0]) * 0.06;
        cur[i][1] += (target[i][1] - cur[i][1]) * 0.06;
        if (Math.abs(target[i][0] - cur[i][0]) > 0.05 || Math.abs(target[i][1] - cur[i][1]) > 0.05) moving = true;
        l.style.transform = `translate3d(${cur[i][0].toFixed(2)}px, ${cur[i][1].toFixed(2)}px, 0)`;
      });
      if (moving) praf = requestAnimationFrame(settle);
    };
    const onMove = (e) => {
      const b = host.getBoundingClientRect();
      const nx = (e.clientX - b.left) / b.width - 0.5;
      const ny = (e.clientY - b.top) / window.innerHeight - 0.5;
      layers.forEach((_, i) => {
        target[i][0] = -nx * DEPTH[i];
        target[i][1] = -ny * DEPTH[i] * 0.7;
      });
      if (!praf) praf = requestAnimationFrame(settle);
    };

    const ro = new ResizeObserver(() => {
      if (!near) return;
      // mobile toolbars change the height by a little; do not regrow the forest for that
      if (drawn && Math.abs(el.clientWidth - size.w) < 40 && Math.abs(el.clientHeight - size.h) < 140) return;
      draw();
    });
    ro.observe(el);
    const nearIo = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting) && !near) {
          near = true;
          draw();
        }
      },
      { rootMargin: '900px 0px' },
    );
    nearIo.observe(el);
    const seenIo = new IntersectionObserver((es) => {
      onScreen = es.some((e) => e.isIntersecting);
      el.toggleAttribute('data-on', onScreen);
      if (onScreen) {
        if (drawn) enter();
        if (!still) wake();
      }
    });
    seenIo.observe(el);

    if (!still) {
      idle.forEach((leaf, i) => {
        leaf.dataset.waiting = '1';
        later(() => {
          if (leaf.dataset.waiting && onScreen) {
            delete leaf.dataset.waiting;
            fall(leaf, 0);
          }
        }, 1600 + i * 2400);
      });
      host.addEventListener('click', onClick);
      if (finePointer()) host.addEventListener('pointermove', onMove);
    }

    return () => {
      alive = false;
      cancelAnimationFrame(job);
      cancelAnimationFrame(praf);
      timers.forEach(clearTimeout);
      ro.disconnect();
      nearIo.disconnect();
      seenIo.disconnect();
      host.removeEventListener('click', onClick);
      host.removeEventListener('pointermove', onMove);
      el.querySelectorAll('[data-fall], [data-gust], [data-zoom], [data-sky]').forEach((n) => n.getAnimations().forEach((a) => a.cancel()));
    };
  }, [hostRef, seed]);

  return (
    <div ref={box} className="lp-canopy" aria-hidden="true">
      <div className="lp-canopy-sky" data-sky>
        <canvas ref={sky} className="lp-canopy-cv" data-sky-cv />
      </div>
      {LAYERS.map((_, i) => (
        <div key={i} className="lp-canopy-layer" data-layer={i}>
          <div className="lp-canopy-fill" data-gust={i}>
            {/* data-climb is the scroll flight's (CanopyStage), data-zoom the arrival's: separate so they never fight */}
            <div className="lp-canopy-fill" data-climb={i}>
              <div className="lp-canopy-fill" data-zoom={i}>
                <div className={`lp-canopy-fill lp-canopy-sway lp-canopy-sway-${i}`}>
                  <canvas
                    ref={(c) => {
                      canvases.current[i] = c;
                    }}
                    className="lp-canopy-cv"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
      <div className="lp-canopy-falls">
        {Array.from({ length: IDLE_LEAVES + BURST_LEAVES }, (_, i) => (
          <FallingLeaf key={i} i={i} burst={i >= IDLE_LEAVES} />
        ))}
      </div>
    </div>
  );
}
