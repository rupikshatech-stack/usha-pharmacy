import { dateFmt, inr } from './format.js';
import { amountInWords } from './amountInWords.js';
import { upiPaymentUri } from './upi.js';
import { upiQrSvg } from './upiQr.js';

/**
 * The printed invoice, as one pure function.
 *
 * THE POINT OF THIS FILE: the settings screen's live preview and the invoice a customer is actually handed are the
 * SAME code. A preview that merely resembles the real thing is worse than no preview — somebody tunes the layout,
 * prints it, and finds the GSTIN missing. Here there is one renderer: the preview feeds it a sample invoice, the
 * till feeds it a real one, and neither can drift.
 *
 * EVERYTHING COMES FROM WHAT THE SERVER SAVED. The line snapshots (batch, expiry, the rate the tax was charged at)
 * and the totals are read, never recalculated in the browser. Prices are GST-inclusive, so the rate table explains
 * the total rather than adding to it.
 *
 * PAPER IS NOT A SCREEN. A 2-inch thermal roll is 58 mm wide with no colour and a cheap print head; A4 is a filing
 * document. They are different layouts, not the same layout scaled — the thermal sizes drop the table borders, the
 * accent colour and the side-by-side blocks, because on that paper they come out as grey mush.
 *
 * Everything is HTML-escaped: an invoice can carry a customer name somebody typed.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAPER = {
  A4: { width: '210mm', css: '@page { size: A4; margin: 12mm; }', narrow: false, base: 12 },
  A5: { width: '148mm', css: '@page { size: A5; margin: 8mm; }', narrow: false, base: 11 },
  thermal80: { width: '72mm', css: '@page { size: 80mm auto; margin: 3mm; }', narrow: true, base: 11 },
  thermal58: { width: '50mm', css: '@page { size: 58mm auto; margin: 2mm; }', narrow: true, base: 10 },
};

/** What a toggle means when the settings have not said. Matches the server's own defaults. */
const SHOW = {
  logo: true,
  gstin: true,
  drugLicenses: true,
  hsn: true,
  batchExpiry: true,
  mrp: true,
  discount: true,
  taxBreakup: true,
  amountInWords: true,
  bankDetails: false,
  upiQr: false,
  signature: true,
  computerGenerated: true,
};

/** A sample bill for the preview — recognisably fake, so nobody mistakes it for a real sale. */
export const SAMPLE_INVOICE = {
  invoiceNo: 'INV-00042',
  invoiceDate: new Date().toISOString(),
  customer: { name: 'Anita Sharma', phone: '98765 43210', gstin: '' },
  interState: false,
  items: [
    { name: 'Dolo 650', batchNo: 'B2451', expiryDate: '2028-04-30', hsn: '30049099', mrp: 32, price: 30.5, quantity: 2, discountPercent: 0, gstPercent: 12, amount: 61 },
    { name: 'Azithral 500', batchNo: 'AZ9912', expiryDate: '2027-11-30', hsn: '30042019', mrp: 118, price: 112, quantity: 1, discountPercent: 5, gstPercent: 12, amount: 106.4 },
    { name: 'Volini Spray', batchNo: 'VS7781', expiryDate: '2027-06-30', hsn: '30049099', mrp: 250, price: 243.75, quantity: 1, discountPercent: 0, gstPercent: 18, amount: 243.75 },
  ],
  subTotal: 411.15,
  itemDiscount: 5.6,
  discount: 0,
  taxableAmount: 365.22,
  cgstTotal: 22.97,
  sgstTotal: 22.96,
  igstTotal: 0,
  taxTotal: 45.93,
  roundOff: -0.15,
  total: 411,
  paid: 411,
  due: 0,
  paymentType: 'Cash',
  gstSummary: [
    { gstPercent: 12, taxable: 149.46, cgst: 8.97, sgst: 8.97, igst: 0 },
    { gstPercent: 18, taxable: 215.76, cgst: 14, sgst: 13.99, igst: 0 },
  ],
};

const money = (n) => esc(inr(n));

/**
 * @param {object} invoice   what the server saved for this sale (or SAMPLE_INVOICE for a preview)
 * @param {object} settings  the `invoice` block of GET /settings
 * @param {object} org       the `organization` block of GET /settings
 * @param {object} options   `preview` draws the watermark; `logoDataUrl` inlines a logo for the preview iframe
 */
export function renderInvoiceHtml({ invoice, settings = {}, org = {}, preview = false } = {}) {
  const inv = invoice || SAMPLE_INVOICE;
  const template = settings.template || {};
  const show = { ...SHOW, ...(template.show || {}) };
  const terms = settings.terms || {};
  const paper = PAPER[template.paperSize] || PAPER.A4;
  const accent = paper.narrow ? '#000000' : /^#[0-9a-fA-F]{6}$/.test(template.accentColor || '') ? template.accentColor : '#0f766e';
  const style = template.style || 'classic';
  const compact = style === 'compact' || paper.narrow;
  const detailed = style === 'detailed' && !paper.narrow;

  const interState = Boolean(inv.interState);
  const isCreditNote = Boolean(inv.isCreditNote);

  /* ------------------------------------------------------------------ the line table */
  const columns = [
    { key: 'name', label: 'Item', show: true },
    { key: 'hsn', label: 'HSN', show: show.hsn && !paper.narrow },
    { key: 'batch', label: 'Batch', show: show.batchExpiry && !compact },
    { key: 'expiry', label: 'Exp', show: show.batchExpiry && !compact },
    { key: 'mrp', label: 'MRP', show: show.mrp && !paper.narrow, right: true },
    { key: 'qty', label: 'Qty', show: true, right: true },
    { key: 'rate', label: 'Rate', show: true, right: true },
    { key: 'disc', label: 'Disc', show: show.discount && !paper.narrow, right: true },
    { key: 'gst', label: 'GST', show: detailed, right: true },
    { key: 'amount', label: 'Amount', show: true, right: true },
  ].filter((c) => c.show);

  const cell = (item, column) => {
    switch (column.key) {
      case 'name':
        // On a narrow roll the batch and expiry ride under the name instead of in their own columns.
        return (
          `${esc(item.name)}` +
          (compact && show.batchExpiry && item.batchNo
            ? `<br><small>B: ${esc(item.batchNo)}${item.expiryDate ? ` · Exp ${esc(dateFmt(item.expiryDate))}` : ''}</small>`
            : '')
        );
      case 'hsn':
        // saved invoice lines carry `hsnCode` (a snapshot taken at sale time); `hsn` is what the sample data uses
        return esc(item.hsnCode || item.hsn || '—');
      case 'batch':
        return esc(item.batchNo || '—');
      case 'expiry':
        return item.expiryDate ? esc(dateFmt(item.expiryDate)) : '—';
      case 'mrp':
        return money(item.mrp);
      case 'qty':
        return esc(item.quantity);
      case 'rate':
        return money(item.price);
      case 'disc':
        return item.discountPercent ? `${esc(item.discountPercent)}%` : '—';
      case 'gst':
        return `${esc(item.gstPercent ?? 0)}%`;
      case 'amount':
        return money(item.amount);
      default:
        return '';
    }
  };

  const rows = (inv.items || [])
    .map((item) => `<tr>${columns.map((c) => `<td class="${c.right ? 't' : ''}">${cell(item, c)}</td>`).join('')}</tr>`)
    .join('');

  /* ------------------------------------------------------------------ totals and tax */
  const totalLine = (label, value, options = {}) =>
    value === 0 && options.hideZero
      ? ''
      : `<tr class="${options.strong ? 'strong' : ''}"><td class="t" colspan="${Math.max(columns.length - 1, 1)}">${esc(label)}</td><td class="t">${money(value)}</td></tr>`;

  const taxRows = (inv.gstSummary || [])
    .map(
      (g) =>
        `<tr><td>${esc(g.gstPercent)}%</td><td class="t">${money(g.taxable)}</td>` +
        (interState ? `<td class="t">${money(g.igst)}</td>` : `<td class="t">${money(g.cgst)}</td><td class="t">${money(g.sgst)}</td>`) +
        '</tr>',
    )
    .join('');

  const taxTable =
    show.taxBreakup && taxRows
      ? `<table class="tax"><thead><tr><th>GST</th><th class="t">Taxable</th>${
        interState ? '<th class="t">IGST</th>' : '<th class="t">CGST</th><th class="t">SGST</th>'
      }</tr></thead><tbody>${taxRows}</tbody></table>`
      : '';

  /* ------------------------------------------------------------------ the pay-by-QR block */
  const upiUri = upiPaymentUri({
    upiId: org.bank?.upiId,
    payeeName: org.legalName || org.name,
    amount: inv.total,
    note: inv.invoiceNo,
    enabled: show.upiQr,
    isCreditNote,
  });
  const qr = upiQrSvg(upiUri, { title: `Scan to pay ${inr(inv.total)} by UPI` });
  const qrBlock = qr
    ? `<div class="qr"><div class="qrbox">${qr}</div><div><strong>Pay by UPI</strong><br><small>${esc(org.bank.upiId)}</small><br><small>Scan to pay ${money(
      inv.total,
    )}</small></div></div>`
    : '';

  const bankBlock =
    show.bankDetails && (org.bank?.accountNumber || org.bank?.ifsc)
      ? `<div class="bank"><strong>Bank details</strong><br>` +
        [
          org.bank.accountHolder ? `A/c name: ${esc(org.bank.accountHolder)}` : '',
          org.bank.bankName ? `Bank: ${esc(org.bank.bankName)}` : '',
          org.bank.accountNumber ? `A/c no: ${esc(org.bank.accountNumber)}` : '',
          org.bank.ifsc ? `IFSC: ${esc(org.bank.ifsc)}` : '',
        ]
          .filter(Boolean)
          .join('<br>') +
        '</div>'
      : '';

  const licences =
    show.drugLicenses && (org.licenses || []).length
      ? `<div class="lic">${org.licenses.map((l) => `DL ${esc(l.type)}: ${esc(l.number)}`).join(' · ')}</div>`
      : '';

  const address = [org.address?.line1, org.address?.line2, org.address?.city, org.address?.state, org.address?.pincode].filter(Boolean).join(', ');

  /* ------------------------------------------------------------------ the document */
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invoiceNo)}</title>
<style>
  ${paper.css}
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font: ${paper.base}px/1.45 ${paper.narrow ? '"Courier New", monospace' : 'system-ui, -apple-system, "Segoe UI", sans-serif'}; color: #111; margin: 0 auto; padding: ${
  preview ? '10px' : '0'
}; max-width: ${paper.width}; background: #fff; }
  h1 { font-size: ${paper.narrow ? paper.base + 1 : 16}px; margin: 0 0 2px; }
  small { color: #555; font-size: ${paper.base - 2}px; }
  .head { ${paper.narrow ? 'text-align:center;' : 'display:flex; justify-content:space-between; align-items:flex-start; gap:14px;'} border-bottom: 2px solid ${accent}; padding-bottom: 6px; margin-bottom: 8px; }
  .logo { height: ${paper.narrow ? 40 : 56}px; width: auto; max-width: ${paper.narrow ? 120 : 160}px; object-fit: contain; }
  .title { color: ${accent}; font-size: ${paper.narrow ? paper.base : 13}px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .meta { ${paper.narrow ? '' : 'display:flex; justify-content:space-between; gap:14px;'} margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { text-align: left; font-size: ${paper.base - 2}px; text-transform: uppercase; letter-spacing: .03em; padding: 4px 3px; ${
  paper.narrow ? 'border-bottom:1px dashed #000;' : `background:${accent}14; border-bottom:1.5px solid ${accent};`
} }
  td { padding: 4px 3px; ${paper.narrow ? 'border-bottom:1px dotted #bbb;' : 'border-bottom:1px solid #e3e3e3;'} vertical-align: top; }
  tr.strong td { font-weight: 700; ${paper.narrow ? '' : 'background:#fafafa;'} }
  .t { text-align: right; white-space: nowrap; }
  .tax { margin-top: 2px; ${paper.narrow ? '' : 'max-width: 60%;'} }
  .qr { display: flex; align-items: center; gap: 8px; margin: 6px 0; ${paper.narrow ? 'justify-content:center; flex-direction:column; text-align:center;' : ''} }
  .qrbox { width: ${paper.narrow ? 90 : 96}px; height: ${paper.narrow ? 90 : 96}px; }
  .bank { font-size: ${paper.base - 1}px; margin: 6px 0; }
  .lic { font-size: ${paper.base - 2}px; color: #444; }
  .words { font-size: ${paper.base - 1}px; margin: 4px 0; }
  .terms { font-size: ${paper.base - 2}px; color: #444; border-top: 1px solid #ddd; margin-top: 8px; padding-top: 5px; white-space: pre-wrap; }
  .sign { margin-top: ${paper.narrow ? 14 : 28}px; text-align: right; font-size: ${paper.base - 1}px; }
  .foot { margin-top: 8px; text-align: center; font-size: ${paper.base - 2}px; color: #666; }
  .wm { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .wm span { font-size: 54px; font-weight: 800; color: ${accent}; opacity: .07; transform: rotate(-24deg); letter-spacing: .1em; }
</style></head><body>
${preview ? '<div class="wm"><span>PREVIEW</span></div>' : ''}

<div class="head">
  <div>
    ${show.logo && org.logo ? `<img class="logo" src="${esc(org.logo)}" alt="">` : ''}
    <h1>${esc(org.legalName || org.name || 'Your pharmacy')}</h1>
    ${address ? `<small>${esc(address)}</small><br>` : ''}
    ${org.phone ? `<small>Ph ${esc(org.phone)}</small>` : ''}
    ${show.gstin && org.gstin ? `<small> · GSTIN ${esc(org.gstin)}</small>` : ''}
    ${licences}
  </div>
  <div class="${paper.narrow ? '' : 't'}">
    <div class="title">${isCreditNote ? 'Credit Note' : 'Tax Invoice'}</div>
    <strong>${esc(inv.invoiceNo)}</strong><br>
    <small>${esc(dateFmt(inv.invoiceDate || inv.createdAt))}</small>
  </div>
</div>

<div class="meta">
  <div>
    <small>Billed to</small><br>
    <strong>${esc(inv.customer?.name || 'Walk-in customer')}</strong>
    ${inv.customer?.phone ? `<br><small>${esc(inv.customer.phone)}</small>` : ''}
    ${inv.customer?.gstin ? `<br><small>GSTIN ${esc(inv.customer.gstin)}</small>` : ''}
  </div>
  ${paper.narrow ? '' : `<div class="t"><small>Payment</small><br><strong>${esc(inv.paymentType || 'Cash')}</strong>${inv.due > 0 ? `<br><small>Due ${money(inv.due)}${inv.dueDate ? ` by ${esc(dateFmt(inv.dueDate))}` : ''}</small>` : ''}</div>`}
</div>

<table>
  <thead><tr>${columns.map((c) => `<th class="${c.right ? 't' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows}</tbody>
  <tfoot>
    ${totalLine('Gross', inv.subTotal)}
    ${show.discount ? totalLine('Item discount', -(inv.itemDiscount || 0), { hideZero: true }) : ''}
    ${show.discount ? totalLine('Bill discount', -(inv.discount || 0), { hideZero: true }) : ''}
    ${totalLine('Taxable value', inv.taxableAmount)}
    ${interState ? totalLine('IGST', inv.igstTotal) : `${totalLine('CGST', inv.cgstTotal)}${totalLine('SGST', inv.sgstTotal)}`}
    ${totalLine('Round off', inv.roundOff, { hideZero: true })}
    ${totalLine(isCreditNote ? 'Refund total' : 'Total', inv.total, { strong: true })}
  </tfoot>
</table>

${taxTable}
${show.amountInWords ? `<div class="words"><strong>In words:</strong> ${esc(amountInWords(inv.total))}</div>` : ''}
${bankBlock}
${qrBlock}

${terms.terms || terms.returnPolicy || terms.declaration ? `<div class="terms">${[terms.terms, terms.returnPolicy, terms.declaration].filter(Boolean).map(esc).join('\n')}</div>` : ''}

${show.signature ? `<div class="sign">For <strong>${esc(org.legalName || org.name || '')}</strong><br><br><br>${esc(terms.signatoryName || 'Authorised signatory')}</div>` : ''}

<div class="foot">
  ${terms.footerNote ? `${esc(terms.footerNote)}<br>` : ''}
  ${show.computerGenerated ? 'This is a computer-generated invoice.' : ''}
</div>
</body></html>`;
}

/** Opens the print dialog for a rendered invoice. Returns false when the browser blocked the window. */
export function printRenderedInvoice(html) {
  const w = window.open('', '_blank', 'width=460,height=720');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  w.focus();
  // Let the layout settle before the dialog opens, or the first page can print half-measured.
  setTimeout(() => w.print(), 350);
  return true;
}
