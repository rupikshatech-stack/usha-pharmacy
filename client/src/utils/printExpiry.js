import { expiryFmt, inr } from './format';
import { RISK_LABEL, countdownLabel } from './expiryView';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The printed Expiry Intelligence report.
 *
 * A printed copy leaves the building. It gets walked round the stockroom on a clipboard, faxed to a distributor,
 * handed to an auditor — so it has to say what it is a report OF without anybody remembering: the organization, its
 * GSTIN, which store, which filters were in force, who ran it and when. A sheet of numbers with no provenance is
 * worse than useless once it is a week old and somebody is making a decision on it.
 *
 * It prints the WHOLE filtered set the server returned, not the page on screen, and everything is HTML-escaped.
 * Light colours only: this is for paper, where a dark theme would be both unreadable and a waste of toner.
 */
export function printExpiryReport({ rows, totals, summary, org, user, filters, storeName }) {
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return false;

  const now = new Date();
  const when = now.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const line = (label, value) => (value ? `<tr><td class="k">${esc(label)}</td><td>${esc(value)}</td></tr>` : '');
  const applied = [
    ['Store', storeName],
    ['Status', filters.status && filters.status !== 'all' ? filters.status : 'All stock'],
    ['Search', filters.search],
    ['Company', filters.manufacturer],
    ['Supplier', filters.supplierId === 'none' ? 'No supplier recorded' : ''],
    ['Schedule', filters.scheduleCategory ? `Schedule ${filters.scheduleCategory}` : ''],
    ['Risk', filters.riskLevel ? RISK_LABEL[filters.riskLevel] : ''],
    ['Worth at least', filters.minValue ? inr(filters.minValue) : ''],
    ['Expiring between', filters.expiryFrom || filters.expiryTo ? `${filters.expiryFrom || 'any date'} and ${filters.expiryTo || 'any date'}` : ''],
  ]
    .map(([k, v]) => line(k, v))
    .join('');

  const body = rows
    .map(
      (r, i) => `<tr>
<td class="n">${i + 1}</td>
<td><strong>${esc(r.medicineName)}</strong><br><small>${esc([r.strength, r.packSize, r.manufacturer].filter(Boolean).join(' · ') || '—')}</small></td>
<td>${esc(r.batchNumber)}<br><small>${esc(r.supplierName || 'No supplier')}${r.branchName ? ` · ${esc(r.branchName)}` : ''}</small></td>
<td>${esc(expiryFmt(r.expiryDate))}<br><small>${esc(countdownLabel(r.daysToExpiry))}</small></td>
<td class="t">${esc(r.quantity.toLocaleString('en-IN'))}<br><small>${esc(r.unit)}</small></td>
<td class="t">${esc(inr(r.costValue))}<br><small>${esc(inr(r.mrpValue))} MRP</small></td>
<td class="t">${esc(r.projectedUnsoldQty.toLocaleString('en-IN'))}<br><small>${esc(inr(r.projectedLoss))}</small></td>
<td class="c"><span class="risk r-${esc(r.riskLevel)}">${esc(RISK_LABEL[r.riskLevel] || r.riskLevel)} ${esc(r.riskScore)}</span></td>
<td class="sign"></td>
</tr>`,
    )
    .join('');

  const cards = (summary?.cards || [])
    .map((c) => `<div class="card"><div class="big">${esc(c.batches)}</div><div class="lbl">${esc(c.label)}</div><div class="sub">${esc(inr(c.costValue))} at cost</div></div>`)
    .join('');

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Expiry report — ${esc(org?.name || '')} — ${esc(when)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17px; margin: 0; }
  .sub { color: #666; font-size: 10px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
  .meta { border-collapse: collapse; font-size: 10px; }
  .meta td { padding: 1px 6px 1px 0; vertical-align: top; }
  .meta .k { color: #666; white-space: nowrap; }
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
  .sign { width: 70px; border-left: 1px solid #ddd; }
  .risk { display: inline-block; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 700; white-space: nowrap; }
  .r-critical { background: #fde2e2; color: #8a1c1c; }
  .r-high     { background: #ffe8d4; color: #8a4a12; }
  .r-medium   { background: #fff3cd; color: #7a5c06; }
  .r-low      { background: #dceafe; color: #1c4b8a; }
  .r-safe     { background: #ddf3e4; color: #1c6b38; }
  tfoot td { padding-top: 8px; font-weight: 700; border-top: 1.5px solid #999; }
  footer { margin-top: 14px; display: flex; justify-content: space-between; font-size: 9px; color: #666; border-top: 1px solid #ccc; padding-top: 6px; }
</style></head><body>
<header>
  <div>
    <h1>${esc(org?.name || 'Inventory')} — Inventory Expiry Report</h1>
    <div class="sub">
      ${org?.gstin ? `GSTIN ${esc(org.gstin)} · ` : ''}${esc(storeName || 'All stores')} ·
      Generated ${esc(when)} by ${esc(user?.name || 'Unknown')}
    </div>
    <div class="sub">
      Projections use ${esc(summary?.settings?.velocityWindowDays ?? 60)} days of sales, shared across each medicine's lots earliest-expiry-first.
    </div>
  </div>
  <table class="meta">${applied || '<tr><td class="k">Filters</td><td>None</td></tr>'}</table>
</header>

<div class="cards">${cards}</div>

<table class="reg">
  <thead><tr>
    <th class="n">#</th><th>Product</th><th>Batch &amp; supplier</th><th>Expiry</th>
    <th class="t">Stock</th><th class="t">Value</th><th class="t">Projected loss</th><th class="c">Risk</th><th>Checked</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="9">Nothing matches these filters.</td></tr>'}</tbody>
  <tfoot><tr>
    <td colspan="4">${esc(rows.length.toLocaleString('en-IN'))} lot${rows.length === 1 ? '' : 's'}</td>
    <td class="t">${esc((totals?.quantity ?? 0).toLocaleString('en-IN'))}</td>
    <td class="t">${esc(inr(totals?.costValue))}</td>
    <td class="t">${esc(inr(totals?.projectedLoss))}</td>
    <td colspan="2"></td>
  </tr></tfoot>
</table>

<footer>
  <span>Checked by ______________________  ·  Signature ______________________  ·  Date ____________</span>
  <span>${esc(org?.name || '')} · page 1</span>
</footer>
</body></html>`);
  w.document.close();
  w.focus();
  // Let the layout settle before the dialog opens, or the first page can print half-measured.
  setTimeout(() => w.print(), 350);
  return true;
}
