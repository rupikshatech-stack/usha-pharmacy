import { summaryCards } from '../../utils/importFile';
import { cx } from '../common/ui';

const TONE = {
  neutral: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** The import summary: total, valid, invalid, (imported), skipped (and failed). */
export default function ImportSummary({ summary, finished }) {
  const cards = summaryCards(summary, finished);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Import summary">
      {cards.map((c) => (
        <div key={c.key} className="rounded-xl border border-line bg-card px-4 py-3">
          <dt className="text-xs font-semibold text-muted">{c.label}</dt>
          <dd className={cx('mt-0.5 text-2xl font-bold tabular-nums', TONE[c.tone])}>{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}
