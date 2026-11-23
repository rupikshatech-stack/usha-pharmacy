// The invoice renderer is the one function the live preview and the till both print with, so these tests pin the
// things that must be true of EVERY invoice: what is escaped, when a payment QR may appear, what a narrow thermal
// roll drops, and that a toggle in the settings really changes the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_INVOICE, renderInvoiceHtml } from './invoiceTemplate.js';

const org = {
  name: 'SWS Wholesale',
  legalName: 'SWS Wholesale Pvt Ltd',
  gstin: '27AAPFU0939F1ZV',
  phone: '9876543210',
  address: { line1: 'Venkatesh Imperia', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  licenses: [{ type: '20B', number: 'MH-20B-1' }],
  bank: { accountHolder: 'SWS', bankName: 'HDFC', accountNumber: '50100123456789', ifsc: 'HDFC0001234', upiId: 'sws@okhdfcbank' },
};
const render = (over = {}) => renderInvoiceHtml({ invoice: SAMPLE_INVOICE, org, settings: {}, ...over });

test('prints the header the organization configured', () => {
  const html = render();
  assert.match(html, /SWS Wholesale Pvt Ltd/, 'the legal name wins over the shop name');
  assert.match(html, /GSTIN 27AAPFU0939F1ZV/);
  assert.match(html, /DL 20B: MH-20B-1/);
  assert.match(html, /Tax Invoice/);
  assert.match(html, /INV-00042/);
});

test('escapes anything a person typed, so a customer name cannot inject markup', () => {
  const html = render({ invoice: { ...SAMPLE_INVOICE, customer: { name: '<img src=x onerror=alert(1)>', phone: '"><script>x</script>' } } });
  assert.ok(!html.includes('<img src=x'), 'no raw tag from the customer name');
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a toggle in the settings really removes the thing it names', () => {
  assert.match(render(), /HSN/);
  assert.ok(!render({ settings: { template: { show: { hsn: false } } } }).includes('<th class="">HSN</th>'));
  assert.ok(!/GSTIN 27AAPFU0939F1ZV/.test(render({ settings: { template: { show: { gstin: false } } } })), 'the organization GSTIN is gone');
  assert.ok(!/In words:/.test(render({ settings: { template: { show: { amountInWords: false } } } })));
  assert.ok(!/DL 20B/.test(render({ settings: { template: { show: { drugLicenses: false } } } })));
  assert.ok(!/computer-generated/.test(render({ settings: { template: { show: { computerGenerated: false } } } })));
});

test('writes the amount in words beside the figures, paise included', () => {
  const html = render({ invoice: { ...SAMPLE_INVOICE, total: 1234.5 } });
  assert.match(html, /One Thousand Two Hundred Thirty Four Rupees and Fifty Paise Only/);
});

test('shows the payment QR only when a UPI ID is saved, the toggle is on, and money is owed', () => {
  const on = { template: { show: { upiQr: true } } };
  assert.match(render({ settings: on }), /<svg[^>]*aria-label="Scan to pay/, 'saved UPI ID + toggle on: a QR');
  assert.ok(!/Scan to pay/.test(render({ settings: {} })), 'toggle off: no QR');
  assert.ok(!/Scan to pay/.test(render({ settings: on, org: { ...org, bank: { ...org.bank, upiId: '' } } })), 'no UPI ID: no QR');
  assert.ok(!/Scan to pay/.test(render({ settings: on, invoice: { ...SAMPLE_INVOICE, total: 0 } })), 'a zero-amount invoice: no QR');
});

test('never prints a pay-us QR on a credit note, where the money goes the other way', () => {
  const html = render({ settings: { template: { show: { upiQr: true } } }, invoice: { ...SAMPLE_INVOICE, isCreditNote: true } });
  assert.ok(!/Scan to pay/.test(html));
  assert.match(html, /Credit Note/);
  assert.match(html, /Refund total/);
});

test('prints the bank block only when asked, and only when there is a bank to print', () => {
  assert.ok(!/Bank details/.test(render()), 'off by default');
  const html = render({ settings: { template: { show: { bankDetails: true } } } });
  assert.match(html, /Bank details/);
  assert.match(html, /IFSC: HDFC0001234/);
  assert.ok(!/Bank details/.test(render({ settings: { template: { show: { bankDetails: true } } }, org: { ...org, bank: {} } })), 'nothing saved, nothing printed');
});

test('uses CGST and SGST within a state and IGST across one', () => {
  const within = render();
  assert.match(within, /CGST/);
  assert.match(within, /SGST/);
  assert.ok(!/>IGST</.test(within));
  const across = render({ invoice: { ...SAMPLE_INVOICE, interState: true, igstTotal: 45.93, gstSummary: [{ gstPercent: 12, taxable: 100, igst: 12, cgst: 0, sgst: 0 }] } });
  assert.match(across, /IGST/);
  assert.ok(!/>CGST</.test(across));
});

test('lays a narrow thermal roll out differently, not just smaller', () => {
  const a4 = render({ settings: { template: { paperSize: 'A4' } } });
  const roll = render({ settings: { template: { paperSize: 'thermal58', accentColor: '#ff0000' } } });
  assert.match(a4, /size: A4/);
  assert.match(roll, /size: 58mm auto/);
  assert.ok(!/>MRP</.test(roll), 'the MRP column does not fit on a 58 mm roll');
  assert.ok(!/>HSN</.test(roll));
  assert.ok(!roll.includes('#ff0000'), 'thermal prints in black only, so the accent colour is dropped');
  assert.match(roll, /Total/, 'but the total is always there');
});

test('puts batch and expiry under the item name where columns would not fit', () => {
  const roll = render({ settings: { template: { paperSize: 'thermal80' } } });
  assert.match(roll, /B: B2451/);
  assert.match(roll, /Exp /);
});

test('marks a preview, and never marks a real invoice', () => {
  assert.match(render({ preview: true }), /PREVIEW/);
  assert.ok(!/PREVIEW/.test(render()));
});

test('prints the terms, return policy and signatory the organization wrote', () => {
  const html = render({ settings: { terms: { terms: 'Goods once sold will not be taken back.', returnPolicy: 'Returns within 7 days.', signatoryName: 'Asha Patil', footerNote: 'Thank you!' } } });
  assert.match(html, /Goods once sold will not be taken back\./);
  assert.match(html, /Returns within 7 days\./);
  assert.match(html, /Asha Patil/);
  assert.match(html, /Thank you!/);
});

test('survives an organization that has configured nothing at all', () => {
  const html = renderInvoiceHtml({ invoice: SAMPLE_INVOICE });
  assert.match(html, /Your pharmacy/);
  assert.match(html, /Tax Invoice/);
});

test('prints a due date only when the invoice has one, and only beside a balance', () => {
  const owed = { ...SAMPLE_INVOICE, paymentType: 'Credit', due: 250, dueDate: '2026-11-20T10:00:00Z' };
  assert.match(render({ invoice: owed }), /Due [^<]* by 20 Nov 2026/);
  assert.ok(!/ by 20 Nov/.test(render({ invoice: { ...owed, dueDate: undefined } })), 'no due date, no "by"');
  assert.ok(!/Due /.test(render({ invoice: { ...owed, due: 0 } })), 'nothing due, nothing said');
});

test('prints the HSN a saved invoice line carries (hsnCode), and a dash for an old invoice that has none', () => {
  const line = (extra) => ({ name: 'Paracetamol', batchNo: 'B1', expiryDate: '2028-12-31', mrp: 112, price: 112, quantity: 2, discountPercent: 0, gstPercent: 12, amount: 224, ...extra });
  // the HSN column sits straight after the item name, so read the cell that follows each name
  const hsnOf = (items, name) => {
    const html = renderInvoiceHtml({ invoice: { ...SAMPLE_INVOICE, items }, org, settings: {} });
    return new RegExp(`<td class="">${name}</td><td class="">([^<]*)</td>`).exec(html)?.[1];
  };
  assert.equal(hsnOf([line({ hsnCode: '30049099' })], 'Paracetamol'), '30049099', 'the code stored on the line is printed');
  const two = [line({ hsnCode: '21069099' }), line({ name: 'Old', hsnCode: '' })];
  assert.equal(hsnOf(two, 'Paracetamol'), '21069099');
  assert.equal(hsnOf(two, 'Old'), '—', "an invoice from before HSN was kept prints a dash, not another medicine's code");
  assert.equal(hsnOf([line({ hsn: '30049099' })], 'Paracetamol'), '30049099', "the sample data's older field name still works");
});
