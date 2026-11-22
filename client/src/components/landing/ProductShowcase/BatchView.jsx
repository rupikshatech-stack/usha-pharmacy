import { Panel, Pill, ViewHeader } from './ShowcaseParts';

// Expiry states are fixed strings on purpose: the preview must look the same whenever it is opened.
const WARN = {
  expired: ['Expired', 'danger'],
  soon: ['Expires in 12 days', 'danger'],
  near: ['Expires in 58 days', 'orange'],
  watch: ['Expires in 4 months', 'orange'],
  ok: ['Good', 'success'],
};

const rows = [
  { med: 'Amoxicillin 500mg', batch: 'AX2291', mfg: '01/2024', exp: '06/2025', qty: 40, mrp: 118, w: 'expired' },
  { med: 'Azithromycin 250mg', batch: 'AZ1187', mfg: '09/2024', exp: '12/2025', qty: 64, mrp: 96.5, w: 'soon' },
  { med: 'Cetirizine 10mg', batch: 'CT8820', mfg: '02/2025', exp: '01/2026', qty: 210, mrp: 32, w: 'near' },
  { med: 'Pantoprazole 40mg', batch: 'PN3304', mfg: '05/2025', exp: '04/2026', qty: 180, mrp: 74, w: 'watch' },
  { med: 'Paracetamol 500mg', batch: 'PC4410', mfg: '03/2025', exp: '03/2027', qty: 900, mrp: 18.5, w: 'ok' },
  { med: 'Paracetamol 500mg', batch: 'PC4552', mfg: '08/2025', exp: '08/2027', qty: 340, mrp: 18.5, w: 'ok' },
  { med: 'Metformin 500mg', batch: 'MT7761', mfg: '06/2025', exp: '05/2027', qty: 620, mrp: 41, w: 'ok' },
];

const mrp = (n) => `₹${n.toFixed(2)}`;

export default function BatchView() {
  return (
    <div className="@container flex h-full flex-col gap-3 p-4">
      <ViewHeader title="Batches & expiry" subtitle="Earliest expiry first" right={<span className="text-[11px] font-semibold text-muted">7 of 218 batches</span>} />

      <div data-reveal className="grid grid-cols-3 gap-3">
        {[
          ['Expired', '1', 'danger'],
          ['Within 30 days', '1', 'danger'],
          ['Within 90 days', '2', 'orange'],
        ].map(([label, n, tone]) => (
          <div key={label} className="flex items-center justify-between rounded-xl border border-line bg-card px-3 py-2">
            <span className="text-[11px] font-semibold text-muted">{label}</span>
            <Pill tone={tone}>{n} {n === '1' ? 'batch' : 'batches'}</Pill>
          </div>
        ))}
      </div>

      <Panel className="flex-1 !p-0 overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-subtle text-left text-[10.5px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-bold">Medicine</th>
              <th className="px-3 py-2 font-bold">Batch</th>
              <th className="hidden px-3 py-2 font-bold @lg:table-cell">Mfg</th>
              <th className="hidden px-3 py-2 font-bold @lg:table-cell">Expiry</th>
              <th className="px-3 py-2 text-right font-bold">Qty</th>
              <th className="hidden px-3 py-2 text-right font-bold @lg:table-cell">MRP</th>
              <th className="px-3 py-2 font-bold">Warning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [label, tone] = WARN[r.w];
              return (
                <tr key={r.batch} className="border-t border-line">
                  <td className="px-3 py-2 font-semibold text-ink">{r.med}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{r.batch}</td>
                  <td className="hidden px-3 py-2 tabular-nums text-muted @lg:table-cell">{r.mfg}</td>
                  <td className="hidden px-3 py-2 tabular-nums @lg:table-cell">{r.exp}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty}</td>
                  <td className="hidden px-3 py-2 text-right tabular-nums @lg:table-cell">{mrp(r.mrp)}</td>
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
