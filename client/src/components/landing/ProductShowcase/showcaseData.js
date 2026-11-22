/*
 * Everything in the showcase is ILLUSTRATIVE sample data. It is deliberately kept in the showcase folder and never
 * read from, or sent to, the real API. The slides themselves are configured in slides.js.
 */

/** The fixed design size of the ERP frame. It is scaled to fit its slot, so the layout never reflows. */
export const DESIGN_W = 1040;
export const DESIGN_H = 640;

/** Shared chart styling, in tokens so the charts follow light and dark mode. */
export const CHART = {
  grid: 'var(--line)',
  tick: { fill: 'var(--muted)', fontSize: 10 },
  primary: 'var(--primary)',
  series: ['var(--primary)', 'var(--info)', 'var(--amber)', 'var(--purple)', 'var(--orange)'],
};
