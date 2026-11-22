import { PackageCheck, Timer, Truck } from 'lucide-react';
import { inr } from '../../../utils/format';
import { Kpi, Meter, Panel, Pill, ViewHeader } from './ShowcaseParts';

const orders = [
  { po: 'PO-0412', supplier: 'MedLine Distributors', items: 14, value: 84200, due: '24 Nov', status: ['In transit', 'info'] },
  { po: 'PO-0411', supplier: 'Sri Balaji Pharma', items: 9, value: 41850, due: '22 Nov', status: ['Delayed', 'danger'] },
  { po: 'PO-0410', supplier: 'Apex Healthcare', items: 22, value: 126400, due: '20 Nov', status: ['Received', 'success'] },
  { po: 'PO-0409', supplier: 'MedLine Distributors', items: 6, value: 18900, due: '18 Nov', status: ['Received', 'success'] },
  { po: 'PO-0408', supplier: 'Unity Wholesale', items: 11, value: 57300, due: '27 Nov', status: ['Ordered', 'neutral'] },
];

const scorecard = [
  ['Apex Healthcare', 97],
  ['MedLine Distributors', 92],
  ['Unity Wholesale', 85],
  ['Sri Balaji Pharma', 68],
];

export default function OrdersView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Orders & suppliers" subtitle="Purchase orders · 5 shown of 38" right={<Pill tone="info">Sample data</Pill>} />

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Open orders" value="7" icon={Truck} tone="info" />
        <Kpi label="Awaiting delivery" value="3" icon={Timer} tone="warning" />
        <Kpi label="On-time delivery" value="94%" icon={PackageCheck} tone="success" />
      </div>

      <div className="grid min-h-0 flex-1 gap-3 @2xl:grid-cols-3">
        <Panel className="!p-0 overflow-hidden @2xl:col-span-2">
          <table className="w-full text-[12px]">
            <thead className="bg-subtle text-left text-[10.5px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-bold">Order</th>
                <th className="px-3 py-2 font-bold">Supplier</th>
                <th className="hidden px-3 py-2 text-right font-bold @lg:table-cell">Items</th>
                <th className="hidden px-3 py-2 text-right font-bold @lg:table-cell">Value</th>
                <th className="hidden px-3 py-2 font-bold @lg:table-cell">Due</th>
                <th className="px-3 py-2 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.po} className="border-t border-line">
                  <td className="px-3 py-2 tabular-nums text-muted">{o.po}</td>
                  <td className="px-3 py-2 font-semibold text-ink">{o.supplier}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums @lg:table-cell">{o.items}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums @lg:table-cell">{inr(o.value)}</td>
                  <td className="hidden px-3 py-2 tabular-nums text-muted @lg:table-cell">{o.due}</td>
                  <td className="px-3 py-2"><Pill tone={o.status[1]}>{o.status[0]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="On-time delivery by supplier">
          <ul className="space-y-3">
            {scorecard.map(([name, pct]) => (
              <li key={name}>
                <div className="mb-1 flex justify-between text-[11.5px]">
                  <span className="truncate font-semibold text-ink">{name}</span>
                  <span className="tabular-nums text-muted">{pct}%</span>
                </div>
                <Meter pct={pct} tone={pct < 75 ? 'danger' : 'primary'} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
