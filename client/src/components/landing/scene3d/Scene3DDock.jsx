import { useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { cx } from '../../common/ui';
import { PRESETS } from './presets';

/*
 * The collapsible dock for the 3D capsule. It is the only interactive thing above the scene, so it owns pointer
 * events while the canvas itself stays pointer-events: none.
 */
export default function Scene3DDock({ preset, onPreset, manualExplode, onExplode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 print:hidden">
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="lp-dock__toggle inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[12px] font-bold"
        >
          <Sparkles size={13} aria-hidden="true" />
          {open ? 'Hide 3D controls' : 'Show 3D controls'}
          <ChevronDown size={13} aria-hidden="true" className={cx('transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="lp-dock flex flex-wrap items-center justify-center gap-1.5 rounded-2xl px-2 py-2">
            {Object.entries(PRESETS).map(([key, p]) => (
              <button
                key={key}
                type="button"
                onClick={() => onPreset(key)}
                aria-pressed={preset === key}
                className={cx('lp-dock__chip h-8 rounded-full px-3 text-[11.5px] font-semibold', preset === key && 'is-on')}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onExplode(!manualExplode)}
              aria-pressed={manualExplode}
              className={cx('lp-dock__chip h-8 rounded-full px-3 text-[11.5px] font-semibold', manualExplode && 'is-on')}
            >
              Explode pellets
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
