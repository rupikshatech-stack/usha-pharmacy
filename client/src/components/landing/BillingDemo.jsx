import { useEffect, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { inr } from '../../utils/format';
import { cx } from '../common/ui';

/*
 * A looping simulation of one bill being raised at the counter: the operator types a medicine, picks it, the line is
 * added, the total ticks up, then the invoice is generated and the bill clears. Illustrative data only, never the API.
 * It starts when scrolled into view, pauses when it leaves, and shows the finished bill with no motion when the
 * visitor prefers reduced motion.
 */

const ITEMS = [
  { q: 'Para', name: 'Paracetamol 500mg', batch: 'PC4410', qty: 2, rate: 18.5 },
  { q: 'Ceti', name: 'Cetirizine 10mg', batch: 'CT8820', qty: 1, rate: 32 },
  { q: 'Panto', name: 'Pantoprazole 40mg', batch: 'PN3304', qty: 2, rate: 74 },
];
const line = (i) => i.qty * i.rate;
const FULL_TOTAL = ITEMS.reduce((s, i) => s + line(i), 0);

/*
 * The script, as a list of steps with their hold time in ms. Paced to be read, not to look busy: an unhurried
 * typing speed, a beat on the suggestion before it is taken, and a long hold on the finished invoice. One full
 * bill runs about 20 s, which is what SCENES['pos'] in LaptopStage is sized to cover.
 */
const STEPS = [];
ITEMS.forEach((item, i) => {
  for (let c = 1; c <= item.q.length; c += 1) STEPS.push({ typed: item.q.slice(0, c), rows: i, ms: 150 });
  STEPS.push({ typed: item.q, rows: i, suggest: true, ms: 1500 });
  STEPS.push({ typed: '', rows: i + 1, ms: 1900 });
});
STEPS.push({ typed: '', rows: ITEMS.length, paid: true, ms: 2000 });
STEPS.push({ typed: '', rows: ITEMS.length, paid: true, done: true, ms: 4200 });
STEPS.push({ typed: '', rows: 0, ms: 1600 });

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the bill is doing right now, so a caller can caption it without reaching into the step list. */
const stageOf = (s) => {
  if (s.done) return 'invoiced';
  if (s.paid) return 'paying';
  if (s.rows === 0 && !s.typed) return 'idle';
  return s.typed ? 'searching' : 'added';
};

export default function BillingDemo({ onStage, paused = false }) {
  const host = useRef(null);
  // Reduced motion starts on the finished bill and never advances.
  const [still] = useState(prefersStill);
  const [i, setI] = useState(() => (prefersStill() ? STEPS.length - 2 : 0));

  useEffect(() => {
    if (still || paused) return undefined;
    let timer = 0;
    const state = { running: false };
    const tick = () => {
      setI((n) => {
        const next = (n + 1) % STEPS.length;
        timer = window.setTimeout(tick, STEPS[next].ms);
        return next;
      });
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !state.running) {
        state.running = true;
        timer = window.setTimeout(tick, 400);
      } else if (!e.isIntersecting && state.running) {
        state.running = false;
        clearTimeout(timer);
      }
    });
    if (host.current) io.observe(host.current);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [still, paused]);

  // Report the current stage upward. Derived from the same step the view renders, never a second timeline.
  const stage = stageOf(STEPS[i]);
  useEffect(() => {
    onStage?.(stage);
  }, [stage, onStage]);

  const s = STEPS[i];
  const rows = ITEMS.slice(0, s.rows);
  const total = rows.reduce((sum, r) => sum + line(r), 0);

  return (
    <div ref={host} className="grid content-center gap-3 p-4 text-left @container sm:p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="rounded-xl border border-ink/10 bg-ink/[0.03]">
        <div className="flex items-center justify-between border-b border-ink/10 px-3 py-2">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted">Bill · INV-1285</span>
          <span className="text-[10.5px] text-muted">{rows.length} item{rows.length === 1 ? '' : 's'}</span>
        </div>
        <table className="w-full text-[12px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-ink/5 last:border-0">
                <td className="px-3 py-2 font-semibold text-ink">{r.name}</td>
                <td className="hidden px-2 py-2 text-muted @md:table-cell">{r.batch}</td>
                <td className="px-2 py-2 text-right tabular-nums text-muted">× {r.qty}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{inr(line(r))}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td className="px-3 py-6 text-center text-[11.5px] text-muted">Scan or search to add the first item…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <span className={cx('flex h-9 items-center gap-2 rounded-lg border bg-ink/[0.03] px-3 text-[12px]', s.typed ? 'border-primary text-ink' : 'border-ink/10 text-muted')}>
            <Search size={13} aria-hidden="true" />
            {s.typed || 'Search medicine…'}
            {!still && s.typed && <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-primary" />}
          </span>
          {s.suggest && (
            <span className="absolute inset-x-0 top-10 z-10 block rounded-lg border border-primary/50 bg-[#141c33] px-2.5 py-1.5 text-[11.5px] shadow-lg">
              <span className="block font-semibold text-ink">{ITEMS[s.rows].name}</span>
              <span className="text-muted">Batch {ITEMS[s.rows].batch} · in stock</span>
            </span>
          )}
        </div>

        <div className="rounded-xl border border-ink/10 bg-ink/[0.03] p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-muted">Total</span>
            <span className="text-xl font-extrabold tabular-nums text-primary transition-all duration-300">{inr(total)}</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${(total / FULL_TOTAL) * 100}%` }} />
          </div>
        </div>

        <div
          className={cx(
            'flex h-10 items-center justify-center gap-2 rounded-lg text-[12.5px] font-bold transition-colors duration-300',
            s.done ? 'bg-success-soft text-success' : s.paid ? 'bg-primary text-on-primary' : 'border border-ink/10 text-muted',
          )}
        >
          {s.done ? <><Check size={15} aria-hidden="true" /> Invoice generated</> : 'Generate invoice'}
        </div>
      </div>
    </div>
  );
}
