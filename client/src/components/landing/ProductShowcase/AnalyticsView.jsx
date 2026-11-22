import { TriangleAlert, TrendingUp } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { CHART } from './showcaseData';
import { Meter, Panel, Pill, ViewHeader } from './ShowcaseParts';

const trend = [12, 14, 13, 16, 15, 18, 17, 21, 20, 24, 23, 27].map((v, i) => ({ w: `W${i + 1}`, v }));
const months = [
  ['Jul', 4.4], ['Aug', 4.7], ['Sep', 4.5], ['Oct', 5.1], ['Nov', 5.4], ['Dec', 5.9],
].map(([m, v]) => ({ m, v }));
const mix = [
  { name: 'Tablets', value: 46 },
  { name: 'Capsules', value: 22 },
  { name: 'Syrups', value: 14 },
  { name: 'Injectables', value: 10 },
  { name: 'Other', value: 8 },
];
const perf = [
  ['Antibiotics', 82],
  ['Analgesics', 68],
  ['Antidiabetics', 54],
  ['Supplements', 31],
];
const alerts = [
  ['Insulin Glargine', 'Below reorder', 'danger'],
  ['Amoxicillin 500mg', 'Expiring soon', 'orange'],
  ['ORS Sachet', 'Out of stock', 'danger'],
];

export default function AnalyticsView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader
        title="Business analytics"
        subtitle="Last 12 weeks"
        right={<Pill tone="success"><TrendingUp size={11} className="mr-1" aria-hidden="true" />+12.4% vs previous quarter</Pill>}
      />

      <div className="grid gap-3 @2xl:grid-cols-3">
        <Panel title="Revenue trend (₹ lakh)" className="@2xl:col-span-2">
          <div role="img" aria-label="Area chart of weekly revenue over twelve weeks">
            <ResponsiveContainer width="100%" height={130} initialDimension={{ width: 520, height: 130 }}>
              <AreaChart data={trend} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <defs>
                  <linearGradient id="showcase-trend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="w" tick={CHART.tick} axisLine={false} tickLine={false} />
                <YAxis tick={CHART.tick} axisLine={false} tickLine={false} />
                <Area type="monotone" dataKey="v" stroke={CHART.primary} strokeWidth={2} fill="url(#showcase-trend)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Sales performance">
          <ul className="space-y-2.5">
            {perf.map(([name, pct]) => (
              <li key={name}>
                <div className="mb-1 flex justify-between text-[11.5px]">
                  <span className="font-semibold text-ink">{name}</span>
                  <span className="tabular-nums text-muted">{pct}%</span>
                </div>
                <Meter pct={pct} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-3 @2xl:grid-cols-3">
        <Panel title="Monthly sales (₹ lakh)">
          <div role="img" aria-label="Bar chart of monthly sales for the last six months">
            <ResponsiveContainer width="100%" height={118} initialDimension={{ width: 240, height: 118 }}>
              <BarChart data={months} margin={{ top: 4, right: 0, left: -26, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="m" tick={CHART.tick} axisLine={false} tickLine={false} />
                <YAxis tick={CHART.tick} axisLine={false} tickLine={false} />
                <Bar dataKey="v" fill={CHART.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Inventory distribution">
          <div className="flex items-center gap-2">
            <div role="img" aria-label="Donut chart of stock by medicine form" className="shrink-0">
              <PieChart width={104} height={104}>
                <Pie data={mix} dataKey="value" innerRadius={30} outerRadius={50} paddingAngle={2} stroke="none" isAnimationActive={false}>
                  {mix.map((m, i) => <Cell key={m.name} fill={CHART.series[i]} />)}
                </Pie>
              </PieChart>
            </div>
            <ul className="min-w-0 space-y-1 text-[11px]">
              {mix.map((m, i) => (
                <li key={m.name} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CHART.series[i] }} />
                  <span className="truncate text-ink">{m.name}</span>
                  <span className="ml-auto tabular-nums text-muted">{m.value}%</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        <Panel title="Stock alerts">
          <ul className="space-y-2">
            {alerts.map(([name, why, tone]) => (
              <li key={name} className="flex items-center gap-2 text-[11.5px]">
                <TriangleAlert size={13} className={tone === 'danger' ? 'text-danger' : 'text-orange'} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-semibold text-ink">{name}</span>
                <Pill tone={tone}>{why}</Pill>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
