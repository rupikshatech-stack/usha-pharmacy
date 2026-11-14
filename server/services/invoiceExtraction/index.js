import { ApiError } from '../../utils/ApiError.js';
import { httpProvider } from './providers/http.js';
import { plannedProvider } from './providers/planned.js';

/**
 * Reading an invoice is delegated to ONE provider, chosen by AI_BILLING_PROVIDER, so the rest of the application (upload, scanning, review, draft
 * orders, the screens) never changes when the provider does. A provider is an object:
 *
 *   {
 *     label: 'Shown to the user',
 *     implemented: boolean,          // false = a place-holder for a planned integration
 *     isConfigured(): boolean,       // are its settings present?
 *     setup: 'What to set',          // shown when it is not configured
 *     extract({ buffer, mimeType, fileName, signal }) -> Promise<RawInvoice>
 *   }
 *
 * and RawInvoice is the one shape every provider must return (anything it cannot read is simply left out; nothing is ever guessed):
 *
 *   { supplier: { name, gstin, phone, address }, invoiceNo, invoiceDate (yyyy-mm-dd), confidence (0..1),
 *     items: [{ name, sku, manufacturer, batchNumber, manufacturingDate, expiryDate, quantity, freeQuantity, rate, mrp,
 *               discountPercent, gstPercent, amount, confidence }],
 *     totals: { subtotal, taxableAmount, cgst, sgst, igst, additionalCharges, grandTotal } }
 *
 * Phase 2 adds Google Document AI, AWS Textract or Azure AI Document Intelligence by turning the matching place-holder in providers/planned.js into a
 * real provider that maps that service's response onto RawInvoice. Nothing else needs to change.
 */
export const PROVIDERS = {
  http: httpProvider,
  'google-document-ai': plannedProvider('Google Document AI', 'GOOGLE_DOCUMENT_AI_PROCESSOR'),
  'aws-textract': plannedProvider('AWS Textract', 'AWS_TEXTRACT_REGION'),
  'azure-document-intelligence': plannedProvider('Azure AI Document Intelligence', 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'),
};

/** The provider named by AI_BILLING_PROVIDER ("http" when only AI_BILLING_URL is set), or null when nothing is chosen. Read on every call. */
export function selectedProvider() {
  const name = (process.env.AI_BILLING_PROVIDER || (process.env.AI_BILLING_URL ? 'http' : '')).trim();
  return name ? { name, provider: PROVIDERS[name] ?? null } : { name: '', provider: null };
}

/** What the screens need to know: is a provider chosen, is it ready, and what to do if not. */
export function providerStatus() {
  const { name, provider } = selectedProvider();
  const configured = Boolean(provider?.implemented && provider.isConfigured());
  let setup;
  if (!configured) {
    if (!name) setup = 'No invoice-reading service is chosen. Set AI_BILLING_URL (an HTTP service) or AI_BILLING_PROVIDER in the server environment.';
    else if (!provider) setup = `AI_BILLING_PROVIDER="${name}" is not a known provider. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`;
    else if (!provider.implemented) setup = `${provider.label} is planned for Phase 2 and is not connected yet. ${provider.setup}`;
    else setup = provider.setup;
  }
  return {
    configured,
    provider: name || null,
    label: provider?.label || null,
    implemented: Boolean(provider?.implemented),
    available: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label, implemented: p.implemented })),
    setup,
  };
}

/** Reads one file with the chosen provider; refuses honestly when none is ready. */
export async function extractWithProvider(input) {
  const { name, provider } = selectedProvider();
  const status = providerStatus();
  if (!status.configured) throw new ApiError(501, `No invoice-reading service is connected. ${status.setup}`, undefined, 'AI_NOT_CONFIGURED');
  const raw = await provider.extract(input);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) throw new ApiError(502, 'The invoice-reading service did not return the invoice lines.', undefined, 'AI_BAD_RESPONSE');
  return { provider: name, raw };
}
