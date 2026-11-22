import { useRef } from 'react';
import useRise from './useRise';

/*
 * A thin capability strip under the hero. These are facts about what the software does, NOT customer counts or
 * adoption numbers: there is no real usage data to quote, and inventing it would be a lie.
 */
const STATS = [
  ['8', 'modules, one system'],
  ['Batch-wise', 'stock and expiry'],
  ['GST-ready', 'invoices and reports'],
  ['Multi-branch', 'with role-based access'],
];

export default function StatsRow() {
  const root = useRef(null);
  useRise(root);
  return (
    <section ref={root} aria-label="At a glance" className="border-y border-ink/10">
      <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-y-8 px-4 py-10 sm:grid-cols-4 sm:gap-6">
        {STATS.map(([value, label]) => (
          <div key={label} data-rise className="text-center">
            <dt className="sr-only">{label}</dt>
            <dd>
              <span className="block text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{value}</span>
              <span className="mt-1 block text-[12px] text-muted">{label}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
