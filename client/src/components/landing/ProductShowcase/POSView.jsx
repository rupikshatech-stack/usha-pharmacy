import { Banknote, ChevronDown, CreditCard, Minus, Plus, Search, Smartphone, User } from 'lucide-react';
import { inr } from '../../../utils/format';
import { cx } from '../../common/ui';
import { FakeButton, Panel, Pill, ViewHeader } from './ShowcaseParts';

const cart = [
  { name: 'Paracetamol 500mg', batch: 'PC4410', qty: 2, mrp: 18.5, disc: 5 },
  { name: 'Cetirizine 10mg', batch: 'CT8820', qty: 1, mrp: 32, disc: 0 },
  { name: 'Pantoprazole 40mg', batch: 'PN3304', qty: 2, mrp: 74, disc: 10 },
  { name: 'ORS Sachet', batch: 'OR1120', qty: 3, mrp: 21, disc: 0 },
];

const line = (i) => i.qty * i.mrp * (1 - i.disc / 100);
const gross = cart.reduce((s, i) => s + i.qty * i.mrp, 0);
const net = cart.reduce((s, i) => s + line(i), 0);

const suggestions = [
  ['Paracetamol 500mg', '1,240 in stock'],
  ['Paracetamol 650mg', '410 in stock'],
];

const modes = [
  ['Cash', Banknote],
  ['UPI', Smartphone],
  ['Card', CreditCard],
];

export default function POSView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Selling Point" subtitle="Counter 1 · Invoice INV-1285" right={<Pill tone="success">Sample bill</Pill>} />

      <div className="grid min-h-0 flex-1 gap-3 @2xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-3">
          <div data-reveal className="relative">
            <span className="flex h-8 items-center gap-2 rounded-lg border border-primary bg-card px-3 text-[12px] text-ink ring-2 ring-primary/15">
              <Search size={13} className="text-muted" aria-hidden="true" /> Paracetamol
              <kbd className="ml-auto rounded bg-subtle px-1.5 text-[10px] text-muted">F1</kbd>
            </span>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {suggestions.map(([n, s], i) => (
                <span key={n} className={cx('rounded-lg border px-2.5 py-1.5 text-[11.5px]', i === 0 ? 'border-primary bg-sage text-sage-ink' : 'border-line bg-card text-ink')}>
                  <span className="block font-semibold">{n}</span>
                  <span className="text-muted">{s}</span>
                </span>
              ))}
            </div>
          </div>

          <Panel title="Cart · 4 items" className="flex-1 !p-0 overflow-hidden">
            <table className="w-full text-[11.5px]">
              <thead className="bg-subtle text-left text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-bold">Item</th>
                  <th className="hidden px-2 py-1.5 font-bold @lg:table-cell">Batch</th>
                  <th className="px-2 py-1.5 text-center font-bold">Qty</th>
                  <th className="hidden px-2 py-1.5 text-right font-bold @lg:table-cell">Disc</th>
                  <th className="px-3 py-1.5 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((i) => (
                  <tr key={i.name} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold text-ink">{i.name}</td>
                    <td className="hidden px-2 py-2 @lg:table-cell">
                      <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 tabular-nums text-muted">
                        {i.batch} <ChevronDown size={11} aria-hidden="true" />
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="mx-auto flex w-fit items-center gap-1.5 tabular-nums">
                        <Minus size={11} className="text-muted" aria-hidden="true" /> {i.qty} <Plus size={11} className="text-muted" aria-hidden="true" />
                      </span>
                    </td>
                    <td className="hidden px-2 py-2 text-right tabular-nums text-muted @lg:table-cell">{i.disc}%</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{inr(line(i))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="Customer">
            <div className="flex items-center gap-2.5 text-[12px]">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-sage text-sage-ink"><User size={14} aria-hidden="true" /></span>
              <span>
                <span className="block font-semibold text-ink">Ramesh Kumar</span>
                <span className="text-muted">+91 98XXX XXX21</span>
              </span>
            </div>
          </Panel>

          <Panel title="Payment mode">
            <div className="grid grid-cols-3 gap-1.5">
              {modes.map(([label, Icon]) => (
                <span key={label} className={cx('flex h-8 items-center justify-center gap-1.5 rounded-lg border text-[11.5px] font-semibold', label === 'UPI' ? 'border-primary bg-sage text-sage-ink' : 'border-line text-muted')}>
                  <Icon size={13} aria-hidden="true" /> {label}
                </span>
              ))}
            </div>
          </Panel>

          <Panel title="Billing summary" className="flex-1">
            <dl className="space-y-1 text-[12px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal (MRP)</dt><dd className="tabular-nums">{inr(gross)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular-nums text-success">− {inr(gross - net)}</dd></div>
              <div className="flex justify-between border-t border-line pt-1.5 text-sm font-bold"><dt>Total</dt><dd className="tabular-nums text-primary">{inr(net)}</dd></div>
            </dl>
            <FakeButton primary className="mt-auto w-full justify-center !h-9">Generate invoice</FakeButton>
          </Panel>
        </div>
      </div>
    </div>
  );
}
