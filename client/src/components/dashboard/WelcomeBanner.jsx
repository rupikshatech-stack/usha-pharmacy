import { TrendingDown, TrendingUp } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { getDisplayTimezone } from '../../utils/format';
import { countModules } from '../layout/nav';
import { Card, Skeleton, cx } from '../common/ui';

function Chip({ label, children, title }) {
  return (
    <div className="min-w-[96px] rounded-xl border border-line bg-card/80 px-4 py-2.5 text-center" title={title}>
      <div className="text-xl font-extrabold leading-tight tabular-nums">{children}</div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
    </div>
  );
}

/**
 * Tenant dashboard header: label, greeting, today's date (organization timezone), the signed-in
 * user's role, and three live counters — modules the user can open, permissions they hold, and the
 * month-on-month sales trend from the overview endpoint.
 */
export default function WelcomeBanner({ overview }) {
  const { user } = useAuth();
  const trend = overview?.monthVsLastMonth;
  const up = (trend ?? 0) >= 0;
  const TrendIcon = up ? TrendingUp : TrendingDown;

  return (
    <Card className="relative overflow-hidden p-5 sm:p-6">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-primary">Tenant dashboard</p>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight sm:text-[28px]">Welcome back, {user.organization?.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
            <span className="rounded-md bg-sage px-2 py-0.5 text-xs font-bold tracking-wide text-sage-ink">{user.role}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date().toISOString()}>
              {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: getDisplayTimezone() })}
            </time>
          </div>
        </div>

        <div className="flex flex-wrap gap-3" aria-label="Workspace summary">
          <Chip label="Modules" title="Modules you can open">{countModules(user)}</Chip>
          <Chip label="Permissions" title="Permissions granted to your role">{user.permissions?.length ?? 0}</Chip>
          <Chip label="Sales trend" title="Revenue this month vs last month">
            {trend === undefined ? (
              <Skeleton className="mx-auto h-6 w-14" />
            ) : (
              <span className={cx('inline-flex items-center gap-1', up ? 'text-success' : 'text-danger')}>
                <TrendIcon className="h-4 w-4" aria-hidden="true" />
                {up ? '+' : ''}
                {trend}%
              </span>
            )}
          </Chip>
        </div>
      </div>
    </Card>
  );
}
