import { printRenderedInvoice, renderInvoiceHtml } from './invoiceTemplate';
import { settingsService } from '../services/settingsService';

/**
 * Prints a real invoice, using the organization's own invoice settings — the same renderer the settings screen
 * previews, so what was tuned there is what comes out of the printer.
 *
 * The settings are fetched once and kept for the session: a till prints dozens of bills an hour and the layout
 * does not change between them. If the fetch fails the invoice is still printed, with the defaults — a customer
 * waiting at the counter must never be told the bill cannot be printed because a settings request timed out.
 */
let cached = null;
let inFlight = null;

export const forgetInvoiceSettings = () => {
  cached = null;
  inFlight = null;
};

async function loadSettings() {
  if (cached) return cached;
  inFlight ||= settingsService
    .get()
    .then((d) => {
      cached = { settings: d.invoice, org: d.organization };
      return cached;
    })
    .catch(() => ({ settings: {}, org: {} }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * @param {object} inv      the invoice as the server saved it
 * @param {string} orgName  fallback name, for the rare case where settings could not be read
 * @returns {Promise<boolean>} false when the browser blocked the pop-up
 */
export async function printInvoice(inv, orgName) {
  const { settings, org } = await loadSettings();
  const html = renderInvoiceHtml({ invoice: inv, settings, org: org?.name ? org : { ...org, name: orgName } });
  return printRenderedInvoice(html);
}
