import { ArrowRight, Check, Minus } from 'lucide-react';
import { inr } from '../../../utils/format';
import { Panel, Pill, ViewHeader } from './ShowcaseParts';

const branches = [
  { name: 'Main Store', sales: 48250, stock: '₹18.4 L' },
  { name: 'Wholesale Depot', sales: 126900, stock: '₹42.1 L' },
  { name: 'Market Road', sales: 21400, stock: '₹6.8 L' },
];

const columns = ['Billing', 'Inventory', 'Reports', 'Users'];
const roles = [
  ['Owner', [1, 1, 1, 1]],
  ['Store manager', [1, 1, 1, 0]],
  ['Pharmacist', [1, 1, 0, 0]],
  ['Cashier', [1, 0, 0, 0]],
];

export default function BranchView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Branches & access" subtitle="3 branches · 12 users" right={<Pill tone="info">Sample data</Pill>} />

      <div className="grid min-h-0 flex-1 gap-3 @2xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-3">
          {branches.map((b) => (
            <Panel key={b.name}>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-ink">{b.name}</span>
                <Pill tone="success">Open</Pill>
              </div>
              <div className="mt-1.5 flex gap-6 text-[11.5px]">
                <span><span className="block text-muted">Sales today</span><span className="font-bold tabular-nums text-ink">{inr(b.sales)}</span></span>
                <span><span className="block text-muted">Stock value</span><span className="font-bold tabular-nums text-ink">{b.stock}</span></span>
              </div>
            </Panel>
          ))}
          <Panel title="Stock transfer · TR-204">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-semibold text-ink">Wholesale Depot</span>
              <ArrowRight size={13} className="text-muted" aria-hidden="true" />
              <span className="font-semibold text-ink">Market Road</span>
              <Pill tone="info" className="ml-auto">In transit</Pill>
            </div>
            <p className="mt-1 text-[11.5px] text-muted">Paracetamol 500mg × 200 · Cetirizine 10mg × 120</p>
          </Panel>
        </div>

        <Panel title="Role permissions" className="min-h-0">
          <table className="w-full text-[12px]">
            <thead className="text-left text-[10.5px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5 font-bold">Role</th>
                {columns.map((c) => <th key={c} className="py-1.5 text-center font-bold">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {roles.map(([role, perms]) => (
                <tr key={role} className="border-t border-line">
                  <td className="py-2.5 font-semibold text-ink">{role}</td>
                  {perms.map((on, i) => (
                    <td key={columns[i]} className="py-2.5">
                      <span className="flex justify-center">
                        {on ? <Check size={14} className="text-success" aria-label="Allowed" /> : <Minus size={14} className="text-muted/50" aria-label="Not allowed" />}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-auto pt-3 text-[11px] text-muted">Each user sees only the screens their role allows.</p>
        </Panel>
      </div>
    </div>
  );
}
