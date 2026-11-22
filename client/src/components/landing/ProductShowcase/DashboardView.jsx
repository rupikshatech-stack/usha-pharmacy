import { IndianRupee, Wallet, Receipt, PackageX, ShoppingCart, PackagePlus, TriangleAlert } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { inr } from '../../../utils/format';
import { CHART } from './showcaseData';
import { Kpi, Meter, Panel, ViewHeader } from './ShowcaseParts';

const monthly = [
  ['Jan', 3.1], ['Feb', 3.4], ['Mar', 3.2], ['Apr', 3.9], ['May', 4.1], ['Jun', 3.8],
  ['Jul', 4.4], ['Aug', 4.7], ['Sep', 4.5], ['Oct', 5.1], ['Nov', 5.4], ['Dec', 5.9],
].map(([m, v]) => ({ m, v }));

const stock = [
  { name: 'Paracetamol 500mg', pct: 86, tone: 'primary' },
  { name: 'Cetirizine 10mg', pct: 64, tone: 'primary' },
  { name: 'Amoxicillin 500mg', pct: 28, tone: 'warning' },
  { name: 'Insulin Glargine', pct: 14, tone: 'danger' },
];

const activity = [
  { icon: ShoppingCart, text: 'Invoice INV-1284 raised · 6 items', time: '2 min ago' },
  { icon: PackagePlus, text: 'Stock received · Cetirizine 10mg × 400', time: '38 min ago' },
  { icon: TriangleAlert, text: 'Low stock · Insulin Glargine', time: '1 hr ago' },
];

export default function DashboardView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Good morning, Asha" subtitle="Here is how the pharmacy is doing today." right={<span className="text-[11px] font-semibold text-muted">Sample data</span>} />

      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Kpi label="Today's revenue" value={inr(48250)} delta="+8.2% vs yesterday" icon={IndianRupee} tone="success" />
        <Kpi label="Total revenue" value="₹38.6 L" delta="This financial year" icon={Wallet} tone="info" />
        <Kpi label="Total invoices" value="1,284" delta="126 today" icon={Receipt} tone="purple" />
        <Kpi label="Low stock alerts" value="9" delta="Needs reorder" icon={PackageX} tone="danger" />
      </div>

      <div className="grid min-h-0 gap-3 @2xl:grid-cols-3">
        <Panel title="Monthly sales (₹ lakh)" className="@2xl:col-span-2">
          <div role="img" aria-label="Area chart of monthly sales across the year" className="min-h-0">
            <ResponsiveContainer width="100%" height={150} initialDimension={{ width: 520, height: 150 }}>
              <AreaChart data={monthly} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="showcase-sales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="m" tick={CHART.tick} axisLine={false} tickLine={false} />
                <YAxis tick={CHART.tick} axisLine={false} tickLine={false} />
                <Area type="monotone" dataKey="v" stroke={CHART.primary} strokeWidth={2} fill="url(#showcase-sales)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Medicine stock levels">
          <ul className="space-y-2.5">
            {stock.map((s) => (
              <li key={s.name}>
                <div className="mb-1 flex justify-between text-[11.5px]">
                  <span className="truncate font-semibold text-ink">{s.name}</span>
                  <span className="tabular-nums text-muted">{s.pct}%</span>
                </div>
                <Meter pct={s.pct} tone={s.tone} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title="Recent activity" className="@2xl:flex">
        <ul className="grid gap-2 @2xl:grid-cols-3">
          {activity.map(({ icon: Icon, text, time }) => (
            <li key={text} className="flex items-center gap-2.5 text-[11.5px]">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sage text-sage-ink">
                <Icon size={13} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-semibold text-ink">{text}</span>
                <span className="text-muted">{time}</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
