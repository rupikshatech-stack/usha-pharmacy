import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cx } from '../common/ui';
import useRise from './useRise';
import CanopyStage from './CanopyStage';

const TABS = [
  {
    id: 'retail',
    label: 'Retail pharmacy',
    title: 'For the counter that never stops',
    body: 'Bill quickly, pick the right batch, and keep an eye on what is about to expire, all from one keyboard-friendly screen.',
    points: ['Keyboard-first Selling Point', 'Batch-wise stock and MRP', 'Sales returns and credit customers'],
  },
  {
    id: 'chain',
    label: 'Branch chains',
    title: 'For pharmacies with more than one store',
    body: 'See every branch together, move stock between stores, and give each person only the access their role needs.',
    points: ['Inter-store stock transfers', 'Branch-wise performance reports', 'Role-based permissions per user'],
  },
  {
    id: 'wholesale',
    label: 'Wholesale & distribution',
    title: 'For suppliers, orders and credit',
    body: 'Track purchase orders and supplier performance, manage customer credit, and keep reports ready for the books.',
    points: ['Purchase orders and supplier directory', 'Credit requests and ledger', 'Purchase, sales and GST reports'],
  },
];

/** An accessible tab set: arrow keys move between tabs, and only the selected panel is shown. */
export default function Audiences() {
  const root = useRef(null);
  const [active, setActive] = useState(0);
  useRise(root);

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (active + step + TABS.length) % TABS.length;
    setActive(next);
    document.getElementById(`aud-tab-${TABS[next].id}`)?.focus();
  };

  const tab = TABS[active];
  return (
    <section id="who" ref={root} aria-labelledby="who-heading" className="lp-who scroll-mt-20">
      {/* the view up through the trees with the heading in the patch of sky; scrolling rises through it into mist */}
      <CanopyStage eyebrow="Who it’s for" lines={['Made for how pharmacies', 'actually work']} headingId="who-heading" seed={23} />
      <div className="lp-who-in mx-auto max-w-6xl px-4 pb-20 pt-6 sm:pb-32">

        <div data-rise role="tablist" aria-label="Who Usha Pharmacy is for" onKeyDown={onKeyDown} className="mx-auto flex max-w-2xl flex-wrap justify-center gap-2">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`aud-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls="aud-panel"
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={cx(
                'lp-btn h-11 rounded-full px-5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                i === active ? 'lp-cta-glow bg-primary text-on-primary' : 'lp-who-tab text-muted hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id="aud-panel" role="tabpanel" aria-labelledby={`aud-tab-${tab.id}`} data-rise className="lp-lift lp-who-panel mx-auto mt-8 max-w-3xl rounded-2xl p-7 sm:p-10">
          <h3 className="text-2xl font-extrabold tracking-tight text-ink">{tab.title}</h3>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{tab.body}</p>
          <ul className="mt-5 grid gap-2.5 sm:grid-cols-3">
            {tab.points.map((p) => (
              <li key={p} className="flex items-start gap-2 text-sm font-semibold text-ink">
                <Check size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" /> {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
