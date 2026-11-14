import { Link } from 'react-router-dom';
import { AlertTriangle, FileText, IndianRupee, TrendingUp } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';
import { inr } from '../../utils/format';
import { Card, ErrorState, Skeleton, StatCard } from '../../components/common/ui';
import ChartCard from '../../components/dashboard/ChartCard';
import WelcomeBanner from '../../components/dashboard/WelcomeBanner';
import MonthlySalesChart from '../../components/dashboard/MonthlySalesChart';
import StockLevelsChart from '../../components/dashboard/StockLevelsChart';
import InventoryAlerts from '../../components/dashboard/InventoryAlerts';
import ActivityTimeline from '../../components/dashboard/ActivityTimeline';
import QuickAccess from '../../components/dashboard/QuickAccess';
import OrderStats from '../../components/dashboard/OrderStats';

const skeletonRows = (n, h) => (
  <div className="space-y-3">
    {Array.from({ length: n }, (_, i) => (
      <Skeleton key={i} className={h} />
    ))}
  </div>
);

/**
 * The tenant dashboard. Every section loads from its own endpoint, so each one has its own
 * skeleton / error / empty state and a slow or failing query never blanks the whole page.
 */
export default function Dashboard() {
  const overview = useFetch('/dashboard/overview');
  const monthly = useFetch('/dashboard/monthly-sales', { months: 6 });
  const stock = useFetch('/dashboard/stock-levels', { limit: 8 });
  const alerts = useFetch('/dashboard/alerts');
  const activity = useFetch('/dashboard/recent-activity', { limit: 8 });
  const d = overview.data;

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
      <WelcomeBanner overview={d} />

      {/* KPI cards */}
      {overview.error ? (
        <Card>
          <ErrorState message={overview.error} onRetry={overview.reload} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            loading={!d}
            label="Today's Revenue"
            icon={IndianRupee}
            tone="success"
            value={d && inr(d.todayRevenue)}
            trend={d?.todayVsYesterday}
            hint={d && `vs ${inr(d.yesterdayRevenue)} yesterday`}
          />
          <StatCard
            loading={!d}
            label="Total Revenue"
            icon={TrendingUp}
            tone="sage"
            value={d && inr(d.totalRevenue)}
            trend={d?.monthVsLastMonth}
            hint={d && (d.totalRefunds > 0 ? `${d.period.label} · ${inr(d.totalRefunds)} refunded · net ${inr(d.netRevenue)}` : `${d.period.label} · month vs last month`)}
          />
          <StatCard
            loading={!d}
            label="Total Invoices"
            icon={FileText}
            tone="neutral"
            value={d?.totalInvoices}
            trend={d?.invoicesVsYesterday}
            hint={d && `Completed in ${d.period.label} · today vs yesterday`}
          />
          <StatCard
            loading={!d}
            label="Low Stock Alerts"
            icon={AlertTriangle}
            tone={d?.lowStockAlerts ? 'danger' : 'success'}
            value={d?.lowStockAlerts}
            hint={d && (d.lowStockAlerts ? 'Medicines below reorder level' : 'Every medicine is above its reorder level')}
          />
        </div>
      )}

      {/* Charts */}
      <div className="grid gap-5 xl:grid-cols-2">
        <MonthlySalesChart sales={monthly} />
        <StockLevelsChart stock={stock} />
      </div>

      {/* Quick access, alerts and recent activity */}
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5">
          <QuickAccess />
          <ChartCard
            title="Inventory alerts"
            subtitle="Below reorder level, and expiring within 90 days"
            right={alerts.data && (alerts.data.counts.expired > 0 || alerts.data.counts.expiringSoon > 0) && <span className="text-xs text-muted">{alerts.data.counts.expired} expired · {alerts.data.counts.expiringSoon} expiring</span>}
          >
            {alerts.error ? <ErrorState message={alerts.error} onRetry={alerts.reload} /> : !alerts.data ? skeletonRows(3, 'h-10 w-full') : <InventoryAlerts data={alerts.data} />}
          </ChartCard>
          <OrderStats />
        </div>

        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-bold">Recent activity</h2>
              <p className="text-xs text-muted">Latest events in your workspace</p>
            </div>
            <Link to="/activity" className="text-xs font-semibold text-primary hover:underline">
              View all
            </Link>
          </div>
          {activity.error ? <ErrorState message={activity.error} onRetry={activity.reload} /> : !activity.data ? skeletonRows(5, 'h-9 w-full') : <ActivityTimeline items={activity.data.items} />}
        </Card>
      </div>
    </div>
  );
}
