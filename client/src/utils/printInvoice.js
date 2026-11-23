import { printRenderedInvoice, renderInvoiceHtml } from './invoiceTemplate';
import { invoiceService } from '../services/invoiceService';

/**
 * Prints a real invoice with the seller's own details and the organization's own invoice layout.
 *
 * Those arrive WITH the invoice, in its `print` block, built by the server from the organization. The browser used to fetch them
 * from GET /settings, which needs `settings:read` and masks the bank account number: a billing-only user was refused, the print fell
 * back to the bare organization name, and the invoice went to the customer without a GSTIN. Printing now needs nothing beyond being
 * able to see the invoice itself.
 *
 * The invoice you get back from creating one carries the block. A row from the invoice LIST does not (the list stays lean), so that
 * one is fetched on its own first.
 *
 * @param {object} inv  an invoice from POST /invoices or GET /invoices/:id, or a row of GET /invoices
 * @returns {Promise<boolean>} false when the browser blocked the pop-up
 */
export async function printInvoice(inv) {
  const { print, ...invoice } = inv.print ? inv : await invoiceService.get(inv._id);
  const html = renderInvoiceHtml({ invoice, settings: print.settings, org: print.organization });
  return printRenderedInvoice(html);
}
