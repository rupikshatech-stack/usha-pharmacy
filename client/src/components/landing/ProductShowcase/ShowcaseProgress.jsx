import { cx } from '../../common/ui';
import { SLIDES } from './slides';

/**
 * Step indicator, sized from the number of slides. Each bar's `[data-fill]` is scrubbed by the scroll timeline
 * while its step is current. Only the current step's name is spelled out, so any number of steps stays legible.
 */
export default function ShowcaseProgress({ active }) {
  const n = SLIDES.length;
  return (
    <div>
      <ol className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }} aria-label="Product tour progress">
        {SLIDES.map((s, i) => (
          <li key={s.id} aria-current={i === active ? 'step' : undefined}>
            <div className="h-1 overflow-hidden rounded-full bg-primary/15">
              <div data-fill className="showcase-fill h-full rounded-full bg-primary" />
            </div>
            <span className={cx('mt-2 block text-[10.5px] font-bold tabular-nums transition-colors duration-300', i === active ? 'text-ink' : 'text-muted')}>
              {String(i + 1).padStart(2, '0')}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-1 text-[12px] font-semibold text-ink" aria-hidden="true">{SLIDES[active].short}</p>
    </div>
  );
}
