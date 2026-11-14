import { ApiError } from '../../../utils/ApiError.js';

const fail = (status, message, code) => new ApiError(status, message, undefined, code);

/**
 * A generic HTTP provider: any service (your own, or a thin wrapper around an OCR / AI product) that accepts the file as the request body and
 * answers with the RawInvoice JSON (see invoiceExtraction/index.js). Settings are read on every call:
 *   AI_BILLING_URL      – the endpoint
 *   AI_BILLING_API_KEY  – optional, sent as "Authorization: Bearer <key>"
 */
export const httpProvider = {
  label: 'HTTP invoice-reading service',
  implemented: true,
  setup: 'Set AI_BILLING_URL (and optionally AI_BILLING_API_KEY) in the server environment.',
  isConfigured: () => Boolean((process.env.AI_BILLING_URL || '').trim()),
  async extract({ buffer, mimeType, fileName = 'invoice', signal }) {
    const url = (process.env.AI_BILLING_URL || '').trim();
    const key = (process.env.AI_BILLING_API_KEY || '').trim();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': mimeType, 'X-File-Name': encodeURIComponent(fileName), ...(key && { Authorization: `Bearer ${key}` }) },
        body: buffer,
        signal: signal || AbortSignal.timeout(60000),
      });
      if (!res.ok) throw fail(502, `The invoice-reading service answered with an error (${res.status}).`, 'AI_SERVICE_FAILED');
      return await res.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof SyntaxError) throw fail(502, 'The invoice-reading service sent something that is not valid JSON.', 'AI_BAD_RESPONSE');
      throw fail(502, 'The invoice-reading service could not be reached.', 'AI_SERVICE_FAILED');
    }
  },
};
