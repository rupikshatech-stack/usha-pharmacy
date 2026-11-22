import { clamp, lerp, smoothstep, stepProgress, stepper } from './core';

/*
 * Each card's face is drawn into its own 2D canvas every frame and uploaded as a texture. Drawing rather than
 * compositing DOM is what lets the big value roll digit-by-digit and the gauges animate, while the WebGL side
 * only ever deals with four flat images.
 *
 * Palette comes from the strip-layers artwork: brushed foil, pale blue glass, cream tablet, white label.
 */

export const CARDS = [
  {
    id: 'foil',
    index: '01',
    name: 'Foil backing',
    kind: 'foil',
    bg: ['#eef1f7', '#9aa5b8'],
    fg: '#1b2238',
    dim: '#5e6880',
    accent: '#175943',
    caption: 'Moisture barrier',
    steps: ['0.02mm', '0.04mm', '96.4%', '99.9%'],
    sub: ['lidding gauge', 'lidding gauge', 'moisture sealed', 'moisture sealed'],
    gauge: 'bar',
  },
  {
    id: 'blister',
    index: '02',
    name: 'Blister plastic',
    kind: 'blister',
    bg: ['#e7eff9', '#b4c8e0'],
    fg: '#1b2238',
    dim: '#5e6880',
    accent: '#175943',
    caption: 'Cavity forming',
    steps: ['2 cavities', '4 cavities', '6 cavities', 'Impact tested'],
    sub: ['thermoformed', 'thermoformed', 'thermoformed', 'drop 1.2m pass'],
    gauge: 'dots',
  },
  {
    id: 'tablet',
    index: '03',
    name: 'Tablet',
    kind: 'tablet',
    bg: ['#fcfcfa', '#e4e6ee'],
    fg: '#1b2238',
    dim: '#5e6880',
    accent: '#175943',
    caption: 'Unit dose',
    steps: ['250mg', '500mg', 'Scored', 'Batch PC4410'],
    sub: ['per tablet', 'per tablet', 'splits evenly', 'released'],
    gauge: 'fill',
  },
  {
    id: 'label',
    index: '04',
    name: 'Printed label',
    kind: 'label',
    bg: ['#ffffff', '#f1f3f8'],
    fg: '#11221d',
    dim: '#5e6880',
    accent: '#175943',
    caption: 'Batch & expiry',
    steps: ['', 'PC4410', 'PC4410', 'PC4410'],
    sub: ['', '', '03 / 2027', '03 / 2027'],
    gauge: 'countdown',
  },
];

export const FACE_W = 820;
export const FACE_H = 560;

const rr = (c, x, y, w, h, r) => {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
};

/** Digits slide upward into place; anything non-numeric cross-fades instead. */
function rollText(c, text, prev, x, y, size, prog, color) {
  c.save();
  c.font = `800 ${size}px "Inter", system-ui, -apple-system, sans-serif`;
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = color;
  const eased = smoothstep(0, 1, prog);
  const chars = text.split('');
  const prevChars = (prev || '').split('');
  let cx = x;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const was = prevChars[i];
    const w = c.measureText(ch).width;
    if (was !== undefined && was !== ch && /[0-9]/.test(ch)) {
      c.globalAlpha = eased;
      c.fillText(ch, cx, y + (1 - eased) * size * 0.45);
      c.globalAlpha = 1 - eased;
      c.fillText(was, cx, y - eased * size * 0.45);
      c.globalAlpha = 1;
    } else {
      c.fillText(ch, cx, y);
    }
    cx += w;
  }
  c.restore();
}

function drawGauge(c, card, W, H, phase, step) {
  const x = 52;
  const y = H - 108;
  const w = W - 104;
  const t = clamp((step + stepProgress(phase, card.steps.length)) / card.steps.length, 0, 1);

  c.save();
  c.textAlign = 'left';
  c.font = `700 19px "Inter", system-ui, sans-serif`;
  c.fillStyle = card.dim;

  if (card.gauge === 'bar') {
    c.fillText('SEAL INTEGRITY', x, y - 18);
    c.textAlign = 'right';
    c.fillStyle = card.accent;
    c.fillText(`${Math.round(t * 100)}%`, x + w, y - 18);
    c.fillStyle = 'rgba(27,34,56,0.14)';
    rr(c, x, y, w, 9, 5); c.fill();
    c.fillStyle = card.accent;
    rr(c, x, y, Math.max(9, w * t), 9, 5); c.fill();
  } else if (card.gauge === 'dots') {
    c.fillText('CAVITIES FORMED', x, y - 18);
    const n = 6;
    const lit = Math.round(t * n);
    for (let i = 0; i < n; i += 1) {
      c.beginPath();
      c.arc(x + 14 + i * 44, y + 5, 12, 0, Math.PI * 2);
      c.fillStyle = i < lit ? card.accent : 'rgba(27,34,56,0.15)';
      c.fill();
    }
  } else if (card.gauge === 'fill') {
    c.fillText('BATCH RELEASED', x, y - 18);
    c.fillStyle = 'rgba(27,34,56,0.14)';
    rr(c, x, y, w, 9, 5); c.fill();
    const g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, card.accent);
    g.addColorStop(1, '#2a8566');
    c.fillStyle = g;
    rr(c, x, y, Math.max(9, w * t), 9, 5); c.fill();
  } else {
    // countdown: days to expiry ticking down as the fields fill in
    const days = Math.round(lerp(486, 128, t));
    c.fillText('DAYS TO EXPIRY', x, y - 18);
    c.textAlign = 'right';
    c.font = `800 30px "Inter", system-ui, sans-serif`;
    c.fillStyle = card.accent;
    c.fillText(String(days), x + w, y - 14);
    c.textAlign = 'left';
    c.fillStyle = 'rgba(27,34,56,0.14)';
    rr(c, x, y, w, 9, 5); c.fill();
    c.fillStyle = card.accent;
    rr(c, x, y, Math.max(9, w * (0.25 + (1 - t) * 0.75)), 9, 5); c.fill();
  }
  c.restore();
}

/** Paints one card's face. `phase` is 0..1 through its hold; `active` dims a non-centred card's name. */
export function drawFace(c, card, phase, active) {
  const W = FACE_W;
  const H = FACE_H;
  c.clearRect(0, 0, W, H);

  // --- surface ---
  const g = c.createLinearGradient(0, 0, W * 0.8, H);
  g.addColorStop(0, card.bg[0]);
  g.addColorStop(1, card.bg[1]);
  c.fillStyle = g;
  rr(c, 0, 0, W, H, 30); c.fill();

  if (card.kind === 'foil') {
    c.save(); rr(c, 0, 0, W, H, 30); c.clip();
    c.globalAlpha = 0.45;
    for (let i = -H; i < W; i += 7) {
      c.strokeStyle = i % 14 === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(120,132,152,0.22)';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + H * 0.42, H); c.stroke();
    }
    c.restore();
  }
  if (card.kind === 'blister') {
    c.save(); rr(c, 0, 0, W, H, 30); c.clip();
    const s = c.createLinearGradient(0, 0, W, H);
    s.addColorStop(0.3, 'rgba(255,255,255,0)');
    s.addColorStop(0.47, 'rgba(255,255,255,0.62)');
    s.addColorStop(0.62, 'rgba(255,255,255,0)');
    c.fillStyle = s; c.fillRect(0, 0, W, H);
    c.restore();
  }

  c.strokeStyle = 'rgba(27,34,56,0.15)';
  c.lineWidth = 2;
  rr(c, 1, 1, W - 2, H - 2, 30); c.stroke();

  // --- header ---
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.font = `800 22px "Inter", system-ui, sans-serif`;
  c.fillStyle = card.accent;
  c.fillText(card.index, 52, 76);
  c.font = `700 26px "Inter", system-ui, sans-serif`;
  c.fillStyle = card.dim;
  c.fillText(card.caption.toUpperCase(), 96, 76);

  const step = stepper(phase, card.steps.length);
  const prog = stepProgress(phase, card.steps.length);
  const prev = step > 0 ? card.steps[step - 1] : '';

  if (card.kind === 'label') {
    // mirrors the printed artwork: two ruled rows that fill in
    c.font = `800 24px "Inter", system-ui, sans-serif`;
    c.fillStyle = card.dim;
    c.fillText('USHA PHARMACY', 52, 164);

    [['BATCH', card.steps[step]], ['EXP', card.sub[step]]].forEach(([k, v], i) => {
      const y = 246 + i * 82;
      c.strokeStyle = 'rgba(27,34,56,0.16)';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(52, y + 24); c.lineTo(W - 52, y + 24); c.stroke();
      c.textAlign = 'left';
      c.font = `700 24px "Inter", system-ui, sans-serif`;
      c.fillStyle = card.dim;
      c.fillText(k, 52, y);
      c.textAlign = 'right';
      if (v) {
        c.font = `800 32px "Inter", system-ui, sans-serif`;
        c.fillStyle = card.fg;
        c.globalAlpha = smoothstep(0, 1, prog);
        c.fillText(v, W - 52, y + 4);
        c.globalAlpha = 1;
      } else {
        c.font = `700 28px "Inter", system-ui, sans-serif`;
        c.fillStyle = 'rgba(27,34,56,0.24)';
        c.fillText('—', W - 52, y + 4);
      }
    });
    c.textAlign = 'left';
  } else {
    rollText(c, card.steps[step], prev, 52, 262, 78, prog, card.fg);
    c.font = `600 25px "Inter", system-ui, sans-serif`;
    c.fillStyle = card.dim;
    c.fillText(card.sub[step], 52, 308);
  }

  // --- footer name ---
  c.font = `800 27px "Inter", system-ui, sans-serif`;
  c.fillStyle = card.fg;
  c.globalAlpha = active ? 1 : 0.7;
  c.fillText(card.name, 52, H - 46);
  c.globalAlpha = 1;

  drawGauge(c, card, W, H, phase, step);
}
