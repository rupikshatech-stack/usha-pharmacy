import { Badge, cx } from '../../common/ui';
import { RISK_LABEL, RISK_TONE, countdownLabel, expiryTone, shelfLifeUsed } from '../../../utils/expiryView';
import { expiryFmt } from '../../../utils/format';
import { compactMoney } from '../../../utils/analytics';

/**
 * The risk band, with the score behind it. The band is what people act on; the score is there so two Criticals can be
 * told apart, and so nobody has to take the word "Critical" on trust.
 */
export function RiskBadge({ level, score, loss }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <Badge tone={RISK_TONE[level] || 'neutral'} dot>
        {RISK_LABEL[level] || level} · {score}
      </Badge>
      {loss > 0 && (
        <span className="text-[11px] font-semibold tabular-nums text-danger" title={`₹${loss.toLocaleString('en-IN')} projected to be lost`}>
          {compactMoney(loss)} at risk
        </span>
      )}
    </div>
  );
}

/**
 * When a lot expires: the date, how long that is in words, and how much of its shelf life has gone.
 *
 * The bar is deliberately not a risk indicator — it says how far through its life the lot is, which is a different
 * question from whether it will sell. The badge beside it answers that one.
 */
export function ExpiryTimeline({ expiryDate, daysToExpiry, receivedAt }) {
  const tone = expiryTone(daysToExpiry);
  const used = shelfLifeUsed(receivedAt, expiryDate);
  const BAR = { danger: 'bg-danger', orange: 'bg-orange', warning: 'bg-warning', success: 'bg-success', neutral: 'bg-muted' };
  const TEXT = { danger: 'text-danger', orange: 'text-orange', warning: 'text-warning', success: 'text-success', neutral: 'text-muted' };

  return (
    <div className="min-w-[8.5rem]">
      <div className="whitespace-nowrap text-[13px] font-medium tabular-nums">{expiryFmt(expiryDate)}</div>
      <div className={cx('whitespace-nowrap text-[11px] font-semibold', TEXT[tone])}>{countdownLabel(daysToExpiry)}</div>
      <div
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-subtle"
        role="img"
        aria-label={`${used}% of this lot's shelf life has passed`}
        title={`${used}% of shelf life used`}
      >
        <div className={cx('h-full rounded-full transition-all', BAR[tone])} style={{ width: `${used}%` }} />
      </div>
    </div>
  );
}

/** What the lot IS right now, when that is something other than simply "expiring". */
export function LotStatusBadge({ row }) {
  if (row.status === 'disposed') return <Badge tone="neutral" dot>Written off</Badge>;
  if (row.supplierReturnStatus === 'returned') return <Badge tone="purple" dot>Returned</Badge>;
  if (row.supplierReturnStatus === 'requested') return <Badge tone="warning" dot>Return requested</Badge>;
  if (row.clearanceFlagged) return <Badge tone="info" dot>Clearance {row.clearanceDiscount ? `${row.clearanceDiscount}%` : ''}</Badge>;
  if (row.batchStatus === 'quarantined') return <Badge tone="warning" dot>Quarantined</Badge>;
  const WORD = { expired: ['danger', 'Expired'], under15: ['danger', 'Under 15 days'], under30: ['orange', 'Under 30 days'], under90: ['warning', 'Under 90 days'], safe: ['success', 'Safe'] };
  const [tone, text] = WORD[row.bucket] || ['neutral', row.bucket];
  return <Badge tone={tone} dot>{text}</Badge>;
}
