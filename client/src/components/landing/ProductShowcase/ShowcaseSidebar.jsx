import { Settings } from 'lucide-react';
import { cx } from '../../common/ui';
import { SLIDES } from './slides';

const EXTRA = [{ label: 'Settings', icon: Settings }];

/** The ERP's left navigation. Purely visual: it follows the scroll, it is not a control. */
export default function ShowcaseSidebar({ active }) {
  const item = (label, Icon, on) => (
    <div
      key={label}
      className={cx(
        'flex h-9 items-center gap-2.5 rounded-lg px-3 text-[12px] font-semibold transition-colors duration-300',
        on ? 'bg-white/15 text-white' : 'text-white/80',
      )}
    >
      <Icon size={15} aria-hidden="true" /> {label}
    </div>
  );

  return (
    <aside className="flex w-44 shrink-0 flex-col bg-side p-3 text-white">
      <div className="mb-4 rounded-lg bg-white px-2 py-1.5">
        <img src="/logo/logo.jpg" alt="Usha Pharmacy" className="block h-auto w-full select-none mix-blend-multiply" draggable="false" />
      </div>
      <nav className="space-y-0.5">
        {SLIDES.map((s, i) => item(s.nav, s.icon, i === active))}
      </nav>
      <div className="mt-auto space-y-0.5 border-t border-white/10 pt-3">{EXTRA.map((e) => item(e.label, e.icon, false))}</div>
    </aside>
  );
}
