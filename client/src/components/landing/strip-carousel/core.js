/*
 * Warp Cards: the bend math and the loop timeline.
 *
 * `place(p)` is the whole trick. p is a card's signed position along the track in slot units: 0 is dead centre,
 * -1 and +1 are the neighbours. The track is an arc, so a card's x slides along it while z recedes and the card
 * yaws to face the camera. Past |p| > 1 an extra curl is added, which is what makes the outer cards peel away at
 * the sides instead of just sliding off.
 *
 * The same function runs in JS (for the flat 2D fallback) and in GLSL (for the real thing), so the two always
 * agree. Keep them in step if you change one.
 */

export const CARD_COUNT = 4; // four strip layers, not the reference's five

// --- timeline -------------------------------------------------------------
export const HOLD = 2.2; // a card sits centred while its values step
export const ROLL = 0.9; // then eases to the next card
export const SLOT = HOLD + ROLL;
export const LOOP = SLOT * CARD_COUNT; // 12.4s for four cards

// --- track shape ----------------------------------------------------------
export const RADIUS = 3.6; // the wide-screen arc; narrow viewports get less, see radiusFor()

/**
 * How wide the arc should be for a given stage aspect. A phone cannot fit three big cards
 * side by side, so the arc tightens and the neighbours tuck in behind the centred card
 * instead of flying off the canvas.
 */
export const radiusFor = (aspect) => 1.8 + (RADIUS - 1.8) * smoothstep(1.1, 2.4, aspect);
export const BEND = 1.15; // radians between adjacent slots. MUST match shaders.js
const CURL = 0.55; // extra outward peel once past the neighbours

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

/** Position, depth and yaw for a point at signed track position p. */
export function place(p, radius = RADIUS) {
  const over = Math.max(0, Math.abs(p) - 1) * Math.sign(p);
  const a = p * BEND + over * CURL;
  return {
    x: Math.sin(a) * radius,
    z: (Math.cos(a) - 1) * radius,
    ry: -a,
  };
}

/**
 * Continuous card index at time t: integer while a card holds, easing to the next during the roll.
 * The carousel's whole position is driven from this one number.
 */
export function smoothIndex(t) {
  const tt = ((t % LOOP) + LOOP) % LOOP;
  const i = Math.floor(tt / SLOT);
  const local = tt - i * SLOT;
  const f = local <= HOLD ? 0 : easeInOutCubic((local - HOLD) / ROLL);
  return i + f;
}

/** How far through its hold the centred card is, 0..1 (0 while rolling). */
export function holdPhase(t) {
  const tt = ((t % LOOP) + LOOP) % LOOP;
  const local = tt - Math.floor(tt / SLOT) * SLOT;
  return local <= HOLD ? local / HOLD : 1;
}

/**
 * Which step a card's value is on. `steps` values are spread across the hold, with a short settle at the end
 * so the final value is readable before the card leaves.
 */
export function stepper(phase, steps) {
  const usable = clamp(phase / 0.82, 0, 1);
  return Math.min(steps - 1, Math.floor(usable * steps));
}

/** 0..1 progress inside the current step, for digit roll animation. */
export function stepProgress(phase, steps) {
  const usable = clamp(phase / 0.82, 0, 1);
  const raw = usable * steps;
  return clamp(raw - Math.floor(raw), 0, 1);
}

/** The shortest signed distance from card i to the centre, given a continuous index. */
export function offsetOf(i, idx) {
  let d = i - idx;
  const half = CARD_COUNT / 2;
  while (d > half) d -= CARD_COUNT;
  while (d < -half) d += CARD_COUNT;
  return d;
}
