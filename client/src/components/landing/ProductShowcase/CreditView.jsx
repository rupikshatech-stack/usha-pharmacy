import { Paperclip, UserCheck, Users, WalletCards } from 'lucide-react';
import { inr } from '../../../utils/format';
import { FakeButton, Kpi, Panel, Pill, ViewHeader } from './ShowcaseParts';

const ledger = [
  { name: 'Ramesh Kumar', last: 'Payment received · 18 Nov', bal: 4200, status: ['Current', 'success'] },
  { name: 'City Clinic', last: 'Invoice INV-1241 · 12 Nov', bal: 38600, status: ['Due soon', 'warning'] },
  { name: 'Lakshmi Nursing Home', last: 'Invoice INV-1198 · 29 Oct', bal: 52400, status: ['Overdue', 'danger'] },
  { name: 'Sunita Devi', last: 'Payment received · 15 Nov', bal: 1850, status: ['Current', 'success'] },
  { name: 'Green Valley Hospital', last: 'Invoice INV-1230 · 09 Nov', bal: 27500, status: ['Due soon', 'warning'] },
];

export default function CreditView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Credit management" subtitle="Customer ledger and credit requests" right={<Pill tone="info">Sample data</Pill>} />

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Outstanding" value="₹1.24 L" icon={WalletCards} tone="warning" />
        <Kpi label="Customers on credit" value="18" icon={Users} tone="info" />
        <Kpi label="Overdue" value="4" icon={UserCheck} tone="danger" />
      </div>

      <div className="grid min-h-0 flex-1 gap-3 @2xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Panel className="!p-0 overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-subtle text-left text-[10.5px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-bold">Customer</th>
                <th className="hidden px-3 py-2 font-bold @lg:table-cell">Last entry</th>
                <th className="px-3 py-2 text-right font-bold">Balance</th>
                <th className="px-3 py-2 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <td className="px-3 py-2 font-semibold text-ink">{r.name}</td>
                  <td className="hidden px-3 py-2 text-muted @lg:table-cell">{r.last}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(r.bal)}</td>
                  <td className="px-3 py-2"><Pill tone={r.status[1]}>{r.status[0]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Credit request">
          <div className="space-y-2 text-[12px]">
            <div className="flex justify-between"><span className="text-muted">Customer</span><span className="font-semibold text-ink">City Clinic</span></div>
            <div className="flex justify-between"><span className="text-muted">Requested</span><span className="font-semibold tabular-nums">{inr(25000)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Status</span><Pill tone="warning">Pending approval</Pill></div>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-2.5 py-1.5 text-muted">
              <Paperclip size={13} aria-hidden="true" /> payment-proof.pdf
            </div>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2 pt-3">
            <FakeButton className="justify-center">Decline</FakeButton>
            <FakeButton primary className="justify-center">Approve</FakeButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}
