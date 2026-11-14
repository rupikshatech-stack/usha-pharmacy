import { ApiError } from '../../utils/ApiError.js';
import { documentAiProvider } from './documentAiService.js';

/**
 * OCR, provider-neutral. The rest of the application (uploading, processing, the screens) only ever talks to this file, so adding or swapping a provider
 * never touches them. A provider is an object:
 *
 *   { key, label, implemented, setup, missing(): string[], isConfigured(): boolean, processorInfo(): object,
 *     process({ buffer, mimeType, fileName }) -> Promise<OcrResult> }
 *
 * and OcrResult is the one shape every provider returns (what it cannot read is left null or out; nothing is ever guessed or "improved"):
 *
 *   { text, pageCount,
 *     pages:  [{ pageNumber, width, height, unit, rotation, language, qualityScore, defects, confidence, text, lines: [{ text, confidence, box }] }],
 *     tables: [{ pageNumber, index, headerRows: [[{ text, rowSpan, colSpan, confidence }]], bodyRows, rowCount, columnCount, confidence, box }],
 *     entities, fields, lineItems,   // only when the provider detects named fields (an invoice parser); otherwise empty / null
 *     warnings: [string] }
 *
 * To add AWS Textract or Azure AI Document Intelligence: write a provider with that shape and add it to PROVIDERS. Nothing else changes.
 */
export const PROVIDERS = { [documentAiProvider.key]: documentAiProvider };
export const DEFAULT_PROVIDER = documentAiProvider.key;

/** The provider named by OCR_PROVIDER (Google Document AI when unset). Read on every call. */
export function selectedProvider() {
  const name = (process.env.OCR_PROVIDER || DEFAULT_PROVIDER).trim();
  return { name, provider: PROVIDERS[name] ?? null };
}

/** What the screens need to know: is OCR ready, and if not, exactly which settings are missing (names only, never values). */
export function ocrStatus() {
  const { name, provider } = selectedProvider();
  const missing = provider?.implemented ? provider.missing() : [];
  const configured = Boolean(provider?.implemented && provider.isConfigured());
  let setup;
  if (!configured) {
    if (!provider) setup = `OCR_PROVIDER="${name}" is not a known OCR provider. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`;
    else setup = `${provider.label} is not set up yet. ${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${provider.setup}`;
  }
  return { configured, provider: provider ? name : null, label: provider?.label || null, missing, available: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label })), setup };
}

/** Reads one file with the chosen provider. Refuses honestly when it is not set up, and refuses files no provider should be sent. */
export async function runOcr({ buffer, mimeType, fileName }, accepted = ['application/pdf', 'image/png', 'image/jpeg']) {
  if (!accepted.includes(mimeType)) throw new ApiError(415, 'Only PDF, PNG and JPEG documents can be read.', undefined, 'OCR_UNSUPPORTED_TYPE');
  const { name, provider } = selectedProvider();
  const status = ocrStatus();
  if (!status.configured) throw new ApiError(501, `No OCR service is connected. ${status.setup}`, undefined, 'OCR_NOT_CONFIGURED');
  const started = Date.now();
  const result = await provider.process({ buffer, mimeType, fileName });
  if (!result || typeof result.text !== 'string') throw new ApiError(502, 'The OCR service did not return any text.', undefined, 'OCR_BAD_RESPONSE');
  if (!result.text.trim()) throw new ApiError(422, 'No text could be recognized in this document. It may be blank, too blurry, or not a readable invoice.', undefined, 'OCR_EMPTY');
  return { provider: name, processor: provider.processorInfo(), durationMs: Date.now() - started, ...result };
}
