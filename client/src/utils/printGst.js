import { inr } from './format';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The printed GST summary.
 *
 * What gets printed is deliberately the SUMMARY — the tax statement, the rate breakdown and the HSN summary — and not
 * the invoice list. The invoice list is paged, so printing it would print page one of however many and look like the
 * whole thing; the CSV export carries every invoice, and the sheet says so. A printed page that quietly contains a
 * fraction of the data is worse than one that does not contain it at all.
 *
 * A printed copy leaves the building — it goes to an accountant, an auditor, a filing cabinet — so it carries its own
 * provenance: the organization and its GSTIN, the store, the period, the filters, who ran it and when. And it carries
 * the disclaimer at the top, in a box, because the one thing this report must never be mistaken for is a GST return.
 */
export function printGstReport({ data, org, user, storeName }) {
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return false;

  const when = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const s = data.summary;
  const period = `${new Date(data.period.from).toLocaleDateString('en-IN', { dateStyle: 'medium' })} to ${new Date(
    new Date(data.period.to).getTime() - 1,
  ).toLocaleDateString('en-IN', { dateStyle: 'medium' })}`;

  const money = (n) => esc(inr(n));
  const row = (label, value, cls = '') => `<tr class="${cls}"><td>${esc(label)}</td><td class="t">${money(value)}</td></tr>`;

  const statement = [
    row('Taxable sales', s.output.taxable),
    row('CGST charged', s.output.cgst),
    row('SGST charged', s.output.sgst),
    row('IGST charged', s.output.igst),
    row('Total tax charged on sales', s.output.tax, 'sum'),
    row('Less tax on sales returns', -s.salesReturns.tax),
    row('Net output tax', s.outputNet.tax, 'sum'),
    row('Taxable purchases', s.input.taxable),
    row('Input tax on purchases', s.input.tax),
    row('Less tax on purchase returns', -s.purchaseReturns.tax),
    row('Net input tax', s.inputNet.tax, 'sum'),
    `<tr class="net"><td>${esc(s.net.label)}</td><td class="t">${money(s.net.tax)}</td></tr>`,
  ].join('');

  const rates = (data.byRate || [])
    .map(
      (r) => `<tr>
<td>${esc(r.rate)}%</td><td class="t">${money(r.taxable)}</td><td class="t">${money(r.cgst)}</td>
<td class="t">${money(r.sgst)}</td><td class="t">${money(r.igst)}</td><td class="t"><strong>${money(r.tax)}</strong></td>
<td class="t">${esc(r.units.toLocaleString('en-IN'))}</td></tr>`,
    )
    .join('');

  const hsn = (data.hsn || [])
    .map(
      (r) => `<tr>
<td>${esc(r.hsnLabel)}</td><td>${esc(r.rate)}%</td><td class="t">${esc(r.units.toLocaleString('en-IN'))}</td>
<td class="t">${money(r.taxable)}</td><td class="t">${money(r.cgst)}</td><td class="t">${money(r.sgst)}</td>
<td class="t">${money(r.igst)}</td><td class="t"><strong>${money(r.tax)}</strong></td></tr>`,
    )
    .join('');

  const notes = [data.notes?.inclusivePricing, data.notes?.returnsDerived, data.notes?.inputSplit, data.notes?.hsnSource, data.notes?.roundOff, data.notes?.netPosition, data.notes?.unmatchedReturnLines]
    .filter(Boolean)
    .map((t) => `<li>${esc(t)}</li>`)
    .join('');

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>GST summary — ${esc(org?.name || '')} — ${esc(when)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 11px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17px; margin: 0; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 16px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  .sub { color: #666; font-size: 10px; }
  header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
  .warn { border: 1.5px solid #8a4a12; background: #fff6e8; color: #6b3a0e; padding: 6px 9px; border-radius: 5px; font-size: 10px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0f0f0; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; padding: 5px 4px; border-bottom: 1.5px solid #999; }
  td { padding: 4px; border-bottom: 1px solid #e2e2e2; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .t { text-align: right; white-space: nowrap; }
  tr.sum td { font-weight: 700; background: #fafafa; }
  tr.net td { font-weight: 700; font-size: 13px; border-top: 1.5px solid #111; border-bottom: 2px solid #111; }
  ul.notes { margin: 8px 0 0; padding-left: 16px; color: #555; font-size: 9px; }
  ul.notes li { margin-bottom: 2px; }
  footer { margin-top: 16px; display: flex; justify-content: space-between; font-size: 9px; color: #666; border-top: 1px solid #ccc; padding-top: 6px; }
</style></head><body>
<header>
  <h1>${esc(org?.name || 'Organization')} — GST Summary</h1>
  <div class="sub">
    ${org?.gstin ? `GSTIN ${esc(org.gstin)} · ` : 'GSTIN not recorded · '}${esc(storeName || 'All stores')} · ${esc(period)}
    (${esc(data.period.timezone)})
  </div>
  <div class="sub">
    Generated ${esc(when)} by ${esc(user?.name || 'Unknown')} ·
    GST rate filter: ${data.filters?.rate ? `${esc(data.filters.rate)}%` : 'all rates'} ·
    ${esc((s.output.invoices || 0).toLocaleString('en-IN'))} invoices, ${esc((s.input.orders || 0).toLocaleString('en-IN'))} purchase orders
  </div>
</header>

<div class="warn"><strong>Not a GST return.</strong> ${esc(data.notes?.disclaimer || '')}</div>

<h2>Tax statement</h2>
<table><tbody>${statement}</tbody></table>

<h2>By GST rate (sales)</h2>
<table>
  <thead><tr><th>Rate</th><th class="t">Taxable</th><th class="t">CGST</th><th class="t">SGST</th><th class="t">IGST</th><th class="t">Tax</th><th class="t">Units</th></tr></thead>
  <tbody>${rates || '<tr><td colspan="7">No sales in this period.</td></tr>'}</tbody>
</table>

<h2>HSN-wise summary (sales)</h2>
<table>
  <thead><tr><th>HSN</th><th>Rate</th><th class="t">Units</th><th class="t">Taxable</th><th class="t">CGST</th><th class="t">SGST</th><th class="t">IGST</th><th class="t">Tax</th></tr></thead>
  <tbody>${hsn || '<tr><td colspan="8">No sales in this period.</td></tr>'}</tbody>
</table>

<h2>How these figures are arrived at</h2>
<ul class="notes">${notes}</ul>
<p class="sub">Invoice-level detail is not printed here because it is paged on screen: export the CSV for every invoice in this period.</p>

<footer>
  <span>Prepared by ______________________ · Checked by ______________________ · Date ____________</span>
  <span>${esc(org?.name || '')}</span>
</footer>
</body></html>`);
  w.document.close();
  w.focus();
  // Let the layout settle before the dialog opens, or the first page can print half-measured.
  setTimeout(() => w.print(), 350);
  return true;
}
