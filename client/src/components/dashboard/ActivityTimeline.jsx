import { AlertTriangle, Building2, FileSpreadsheet, History, KeyRound, LogIn, LogOut, PackageCheck, PackagePlus, Pill, Receipt, Trash2 } from 'lucide-react';
import { dateTimeFmt, timeAgo } from '../../utils/format';
import { EmptyState, cx } from '../common/ui';

const sage = 'bg-sage text-sage-ink';
const neutral = 'bg-subtle text-muted';

/** Each audit-log action -> its icon, colour and short label. Unknown actions fall back to a generic "Event". */
const ACTIVITY = {
  INVOICE_CREATE: { icon: Receipt, tone: 'bg-success-soft text-success', label: 'Invoice created' },
  MEDICINE_UPDATE: { icon: PackageCheck, tone: sage, label: 'Inventory updated' },
  MEDICINE_CREATE: { icon: Pill, tone: sage, label: 'Medicine added' },
  MEDICINE_DELETE: { icon: Trash2, tone: 'bg-danger-soft text-danger', label: 'Medicine removed' },
  STOCK_ADD: { icon: PackagePlus, tone: sage, label: 'Batch added' },
  LOW_STOCK_ALERT: { icon: AlertTriangle, tone: 'bg-warning-soft text-warning', label: 'Low stock alert' },
  CSV_IMPORT_COMPLETED: { icon: FileSpreadsheet, tone: 'bg-success-soft text-success', label: 'CSV import completed' },
  INVENTORY_IMPORT_COMPLETED: { icon: FileSpreadsheet, tone: 'bg-success-soft text-success', label: 'CSV import completed' },
  ORGANIZATION_UPDATE: { icon: Building2, tone: sage, label: 'Organization updated' },
  AUTH_LOGIN: { icon: LogIn, tone: neutral, label: 'Sign-in' },
  AUTH_LOGOUT: { icon: LogOut, tone: neutral, label: 'Sign-out' },
  AUTH_PASSWORD_CHANGED: { icon: KeyRound, tone: neutral, label: 'Password changed' },
};

export const activityMeta = (action = '') => ACTIVITY[action] || { icon: History, tone: neutral, label: 'Event' };

/** Latest events: icon, description, and when it happened (relative, with the exact time on hover). */
export default function ActivityTimeline({ items }) {
  if (!items.length) return <EmptyState icon={History} title="No activity yet" hint="Invoices, stock changes and alerts will show up here." />;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-line">
      {items.map((a) => {
        const m = activityMeta(a.action);
        return (
          <li key={a.id} className="relative flex items-center gap-3">
            <span className={cx('relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-card', m.tone)}>
              <m.icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{a.message}</span>
              {a.userName && <span className="block text-xs text-muted">by {a.userName}</span>}
            </span>
            <span className="hidden rounded-full bg-subtle px-2 py-0.5 text-[11px] font-semibold text-muted md:inline">{m.label}</span>
            <time dateTime={a.createdAt} title={dateTimeFmt(a.createdAt)} className="shrink-0 text-xs text-muted">
              {timeAgo(a.createdAt)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
