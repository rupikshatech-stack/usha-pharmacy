/*
 * The five scroll poses the capsule moves between.
 *
 * x and y are in half-viewport units (-1..1), s is the capsule's height as a fraction of the visible frustum
 * height at z = 0, rx/ry/rz are radians, and explode opens the shell 0..1.
 *
 * Each pose is anchored to a real section of this page. `at` resolves the scrollY the pose belongs to, so the
 * choreography follows the layout instead of hard-coded pixel offsets.
 */

const anchor = (id, frac) => () => {
  const el = document.getElementById(id);
  if (!el) return null;
  return el.getBoundingClientRect().top + window.scrollY + frac * window.innerHeight;
};

export const POSES = [
  { key: 'hero', at: () => 0, x: 0.48, y: 0.06, s: 0.58, rx: 0.25, ry: 0.4, rz: -0.42, explode: 0 },
  { key: 'modules', at: anchor('modules', 0.1), x: -0.68, y: 0.14, s: 0.42, rx: 0.15, ry: 2.1, rz: 0.28, explode: 0.65 },
  { key: 'why', at: anchor('why', 0.15), x: 0.64, y: -0.08, s: 0.46, rx: -0.22, ry: 4.1, rz: -0.35, explode: 0.15 },
  { key: 'who', at: anchor('who', 0.1), x: -0.62, y: -0.18, s: 0.44, rx: 0.18, ry: 5.8, rz: 0.2, explode: 0 },
  { key: 'end', at: anchor('end', 0), x: 0.46, y: 0.1, s: 0.52, rx: 0.22, ry: 7.4, rz: -0.32, explode: 0.3 },
];

/* On a narrow screen the capsule has to share the column with the copy, so it sits smaller and closer to centre. */
const MOBILE = {
  hero: { x: 0.0, y: 0.28, s: 0.3 },
  modules: { x: -0.3, y: 0.3, s: 0.26 },
  why: { x: 0.3, y: -0.3, s: 0.28 },
  who: { x: -0.28, y: -0.3, s: 0.24 },
  end: { x: 0.0, y: 0.26, s: 0.3 },
};

export const isMobile = () => window.innerWidth <= 820;

/** The pose list for the current breakpoint, with every `at` resolved to a scrollY. */
export function resolvePoses() {
  const mob = isMobile();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const out = [];
  for (const p of POSES) {
    const raw = p.at();
    if (raw === null) continue;
    out.push({ ...p, ...(mob ? MOBILE[p.key] : null), scroll: Math.min(raw, maxScroll) });
  }
  // keep them strictly increasing so the interpolation never divides by zero
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].scroll <= out[i - 1].scroll) out[i].scroll = out[i - 1].scroll + 1;
  }
  return out;
}

export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

/** The pose at a given scrollY, interpolated between the two surrounding anchors. */
export function poseAt(list, y) {
  if (!list.length) return null;
  if (y <= list[0].scroll) return list[0];
  const last = list[list.length - 1];
  if (y >= last.scroll) return last;
  let i = 0;
  while (i < list.length - 1 && y > list[i + 1].scroll) i += 1;
  const a = list[i];
  const b = list[i + 1];
  const t = easeInOutCubic((y - a.scroll) / (b.scroll - a.scroll));
  const mix = (k) => a[k] + (b[k] - a[k]) * t;
  return { x: mix('x'), y: mix('y'), s: mix('s'), rx: mix('rx'), ry: mix('ry'), rz: mix('rz'), explode: mix('explode') };
}
