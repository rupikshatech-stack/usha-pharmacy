import { ChevronDown, Plus, Search } from 'lucide-react';
import { FakeButton, Panel, Pill, ViewHeader } from './ShowcaseParts';

const rows = [
  { name: 'Paracetamol 500mg', maker: 'Sun Pharma', stock: 1240, reorder: 300 },
  { name: 'Amoxicillin 500mg', maker: 'Cipla', stock: 86, reorder: 150 },
  { name: 'Cetirizine 10mg', maker: 'Dr. Reddy’s', stock: 540, reorder: 200 },
  { name: 'Pantoprazole 40mg', maker: 'Lupin', stock: 410, reorder: 180 },
  { name: 'ORS Sachet', maker: 'FDC', stock: 0, reorder: 120 },
  { name: 'Insulin Glargine', maker: 'Biocon', stock: 32, reorder: 40 },
  { name: 'Metformin 500mg', maker: 'Mankind', stock: 980, reorder: 250 },
  { name: 'Azithromycin 250mg', maker: 'Alkem', stock: 145, reorder: 100 },
];

const status = (r) => (r.stock === 0 ? ['Out of stock', 'danger'] : r.stock <= r.reorder ? ['Low stock', 'warning'] : ['In stock', 'success']);

export default function InventoryView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Inventory" subtitle="1,482 medicines · 9 below reorder level" right={<FakeButton primary icon={Plus}>Add medicine</FakeButton>} />

      <div data-reveal className="flex gap-2">
        <span className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-card px-3 text-[12px] text-muted">
          <Search size={13} aria-hidden="true" /> Search by name, salt or manufacturer
        </span>
        <FakeButton className="hidden @lg:inline-flex">
          All categories <ChevronDown size={13} aria-hidden="true" />
        </FakeButton>
      </div>

      <Panel className="flex-1 !p-0 overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-subtle text-left text-[10.5px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-bold">Medicine</th>
              <th className="hidden px-3 py-2 font-bold @lg:table-cell">Manufacturer</th>
              <th className="px-3 py-2 text-right font-bold">Stock</th>
              <th className="hidden px-3 py-2 text-right font-bold @lg:table-cell">Reorder</th>
              <th className="px-3 py-2 font-bold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [label, tone] = status(r);
              return (
                <tr key={r.name} className="border-t border-line">
                  <td className="px-3 py-2 font-semibold text-ink">{r.name}</td>
                  <td className="hidden px-3 py-2 text-muted @lg:table-cell">{r.maker}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.stock.toLocaleString('en-IN')}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums text-muted @lg:table-cell">{r.reorder}</td>
                  <td className="px-3 py-2"><Pill tone={tone}>{label}</Pill></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
