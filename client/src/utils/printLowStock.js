import { inr } from './format';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = { out: 'OUT OF STOCK', critical: 'CRITICAL', low: 'LOW' };

/**
 * The printed Low Stock Report — a purchase worksheet.
 *
 * This sheet is carried round the stockroom and read off to a distributor on the phone, so it prints the WHOLE
 * filtered list the server returned, not the page on screen, and it carries its own provenance: the organization,
 * the store, who ran it and — most importantly — the exact MOMENT it was true. A stock position with no timestamp
 * is dangerous on paper: somebody finds it a week later and orders from it.
 *
 * It ends with a signature line and an "ordered" column, because the point of the sheet is to be worked through.
 * Light colours only: this is for paper.
 */
export function printLowStockReport({ data, rows, org, user, storeName }) {
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return false;

  const when = new Date(data.asOf).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const s = data.summary;

  const body = rows
    .map(
      (r, i) => `<tr>
<td class="n">${i + 1}</td>
<td><strong>${esc(r.medicineName)}</strong><br><small>${esc([r.salt, r.strength, r.packSize].filter(Boolean).join(' · ') || '—')}</small></td>
<td><small>${esc(r.manufacturer || 'No manufacturer')}${r.category ? ` · ${esc(r.category)}` : ''}</small></td>
<td class="t">${r.thresholdSet ? esc(r.threshold.toLocaleString('en-IN')) : '<small>not set</small>'}</td>
<td class="t ${r.available === 0 ? 'zero' : ''}">${esc(r.available.toLocaleString('en-IN'))}<br><small>${esc(r.unit || '')}</small></td>
<td class="t"><strong>${r.shortfall === null ? '—' : esc(r.shortfall.toLocaleString('en-IN'))}</strong></td>
<td class="t">${r.estimatedCost === null ? '<small>no price on record</small>' : esc(inr(r.estimatedCost))}</td>
<td class="c"><span class="s s-${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span></td>
<td class="order"></td>
</tr>`,
    )
    .join('');

  const cards = (data.cards || [])
    .map((c) => `<div class="card"><div class="big">${esc(c.value.toLocaleString('en-IN'))}</div><div class="lbl">${esc(c.label)}</div></div>`)
    .join('');

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Low stock — ${esc(org?.name || '')} — ${esc(when)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17px; margin: 0; }
  .sub { color: #666; font-size: 10px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
  .asof { border: 1.5px solid #8a4a12; background: #fff6e8; color: #6b3a0e; padding: 5px 8px; border-radius: 5px; font-size: 10px; font-weight: 700; white-space: nowrap; }
  .cards { display: flex; gap: 8px; margin-bottom: 10px; }
  .card { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 6px 8px; }
  .card .big { font-size: 18px; font-weight: 700; }
  .card .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  table.reg { width: 100%; border-collapse: collapse; }
  table.reg th { background: #f0f0f0; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; padding: 5px 4px; border-bottom: 1.5px solid #999; }
  table.reg td { padding: 5px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  table.reg tr { break-inside: avoid; }
  thead { display: table-header-group; }
  small { color: #666; font-size: 9px; }
  .t { text-align: right; white-space: nowrap; }
  .c { text-align: center; }
  .n { color: #888; text-align: right; }
  .zero { color: #8a1c1c; font-weight: 700; }
  .order { width: 80px; border-left: 1px solid #ddd; }
  .s { display: inline-block; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 700; white-space: nowrap; }
  .s-out { background: #fde2e2; color: #8a1c1c; }
  .s-critical { background: #ffe8d4; color: #8a4a12; }
  .s-low { background: #fff3cd; color: #7a5c06; }
  tfoot td { padding-top: 8px; font-weight: 700; border-top: 1.5px solid #999; }
  footer { margin-top: 14px; display: flex; justify-content: space-between; font-size: 9px; color: #666; border-top: 1px solid #ccc; padding-top: 6px; }
</style></head><body>
<header>
  <div>
    <h1>${esc(org?.name || 'Pharmacy')} — Low Stock Report</h1>
    <div class="sub">${esc(storeName || 'All stores')} · Printed by ${esc(user?.name || 'Unknown')}</div>
    <div class="sub">
      Suggested order quantities bring each medicine back to its own reorder level. They are arithmetic, not a
      forecast of demand. Estimated cost uses the last price actually paid for that medicine.
    </div>
  </div>
  <div class="asof">Stock position as at<br>${esc(when)}</div>
</header>

<div class="cards">${cards}</div>

<table class="reg">
  <thead><tr>
    <th class="n">#</th><th>Product</th><th>Maker &amp; category</th>
    <th class="t">Reorder level</th><th class="t">Sellable</th><th class="t">Suggested order</th>
    <th class="t">Est. cost</th><th class="c">Status</th><th>Ordered</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="9">Nothing needs ordering under these filters.</td></tr>'}</tbody>
  <tfoot><tr>
    <td colspan="5">${esc(rows.length.toLocaleString('en-IN'))} medicine${rows.length === 1 ? '' : 's'} to review</td>
    <td class="t">${esc((s.suggestedUnits || 0).toLocaleString('en-IN'))}</td>
    <td class="t">${s.costKnown ? esc(inr(s.estimatedCost)) + (s.costIsPartial ? '<br><small>partial</small>' : '') : '<small>cost not known</small>'}</td>
    <td colspan="2"></td>
  </tr></tfoot>
</table>

${s.noCost || s.noThreshold ? `<p class="sub">${esc([data.notes?.noThreshold, data.notes?.noCost].filter(Boolean).join(' '))}</p>` : ''}

<footer>
  <span>Ordered by ______________________ · Supplier ______________________ · Date ____________</span>
  <span>${esc(org?.name || '')}</span>
</footer>
</body></html>`);
  w.document.close();
  w.focus();
  // Let the layout settle before the dialog opens, or the first page can print half-measured.
  setTimeout(() => w.print(), 350);
  return true;
}
