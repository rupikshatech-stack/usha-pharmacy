import { ApiError } from '../../utils/ApiError.js';
import { EXTRACTION_SCHEMA, geminiSchema, openAiSchema } from './invoiceExtractionSchema.js';

/**
 * Turning OCR output into a structured invoice with a language model. Server-side only: the API key never leaves this process, is never logged and is
 * never part of an error message. The model only ever sees the OCR text and tables (not the file) and is told, in the prompt AND by the response schema,
 * to leave anything it cannot see as null. Whatever it returns is untrusted: invoiceExtractionSchema.normalizeExtraction checks it strictly afterwards.
 *
 * Providers (chosen by AI_EXTRACTION_PROVIDER; Gemini when unset and its key is present, otherwise OpenAI when that key is present):
 *   gemini  – GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.5-flash), GEMINI_ENDPOINT (optional override)
 *   openai  – OPENAI_API_KEY, OPENAI_MODEL (default gpt-4.1-mini), OPENAI_ENDPOINT (optional override)
 *   AI_EXTRACTION_TIMEOUT_MS (default 120000)
 * A provider is { key, label, keyName, model(), call({ system, user, signal }) -> { text, usage, model } }. Adding another one touches nothing else.
 */
const val = (k) => (process.env[k] || '').trim();
const fail = (status, message, code) => new ApiError(status, message, undefined, code);
const timeoutMs = () => Number(val('AI_EXTRACTION_TIMEOUT_MS')) || 120000;
const MAX_PROMPT_CHARS = 150000;

const explain = (label, status, body) => {
  const detail = String(body?.error?.message || '').slice(0, 160);
  const msg = detail ? ` (${detail.replace(/(key|token)[=:\s]+\S+/gi, '$1 …')})` : '';
  if (status === 400) return fail(502, `${label} could not process the request${msg}.`, 'AI_REJECTED');
  if (status === 401 || status === 403) return fail(502, `${label} did not accept the API key. Check it and that it is allowed to use the model.`, 'AI_AUTH_FAILED');
  if (status === 404) return fail(502, `${label} could not find the model. Check the model name in the server settings.`, 'AI_MODEL_NOT_FOUND');
  if (status === 429) return fail(502, `${label} is rate-limiting requests (quota exceeded). Try again in a few minutes.`, 'AI_QUOTA');
  return fail(502, `${label} answered with an error (${status}). Try again shortly.`, 'AI_UNAVAILABLE');
};

async function post(label, url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    throw fail(502, e.name === 'TimeoutError' || e.name === 'AbortError' ? `${label} did not answer within ${Math.round(timeoutMs() / 1000)} seconds.` : `${label} could not be reached.`, e.name === 'TimeoutError' || e.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE');
  }
  if (!res.ok) throw explain(label, res.status, await res.json().catch(() => null));
  try {
    return await res.json();
  } catch {
    throw fail(502, `${label} sent something that is not valid JSON.`, 'AI_BAD_RESPONSE');
  }
}

const gemini = {
  key: 'gemini',
  label: 'Google Gemini',
  keyName: 'GEMINI_API_KEY',
  model: () => val('GEMINI_MODEL') || 'gemini-2.5-flash',
  async call({ system, user, signal }) {
    const model = this.model();
    const base = val('GEMINI_ENDPOINT') || 'https://generativelanguage.googleapis.com';
    const body = await post(
      this.label,
      `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': val('GEMINI_API_KEY') },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: geminiSchema(), maxOutputTokens: 32768 },
      },
      signal,
    );
    const cand = body?.candidates?.[0];
    if (!cand) throw fail(502, `${this.label} returned no answer${body?.promptFeedback?.blockReason ? ` (blocked: ${body.promptFeedback.blockReason})` : ''}.`, 'AI_REFUSED');
    if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
      throw fail(502, cand.finishReason === 'MAX_TOKENS' ? `${this.label}'s answer was cut off because the invoice is too long.` : `${this.label} stopped early (${cand.finishReason}).`, cand.finishReason === 'MAX_TOKENS' ? 'AI_BAD_RESPONSE' : 'AI_REFUSED');
    }
    const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
    return { text, model: body.modelVersion || model, usage: body.usageMetadata ? { inputTokens: body.usageMetadata.promptTokenCount ?? null, outputTokens: body.usageMetadata.candidatesTokenCount ?? null } : null };
  },
};

const openai = {
  key: 'openai',
  label: 'OpenAI',
  keyName: 'OPENAI_API_KEY',
  model: () => val('OPENAI_MODEL') || 'gpt-4.1-mini',
  async call({ system, user, signal }) {
    const model = this.model();
    const base = val('OPENAI_ENDPOINT') || 'https://api.openai.com';
    const body = await post(
      this.label,
      `${base}/v1/chat/completions`,
      { Authorization: `Bearer ${val('OPENAI_API_KEY')}` },
      {
        model,
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'supplier_invoice', strict: true, schema: openAiSchema() } },
        max_completion_tokens: 16384,
      },
      signal,
    );
    const choice = body?.choices?.[0];
    if (!choice) throw fail(502, `${this.label} returned no answer.`, 'AI_BAD_RESPONSE');
    if (choice.message?.refusal) throw fail(502, `${this.label} declined to answer.`, 'AI_REFUSED');
    if (choice.finish_reason === 'length') throw fail(502, `${this.label}'s answer was cut off because the invoice is too long.`, 'AI_BAD_RESPONSE');
    return { text: choice.message?.content || '', model: body.model || model, usage: body.usage ? { inputTokens: body.usage.prompt_tokens ?? null, outputTokens: body.usage.completion_tokens ?? null } : null };
  },
};

export const AI_PROVIDERS = { gemini, openai };

/** The provider named by AI_EXTRACTION_PROVIDER; with none named, the one whose key is present (Gemini first). Read on every call. */
export function selectedAiProvider() {
  const named = val('AI_EXTRACTION_PROVIDER').toLowerCase();
  const name = named || (val('GEMINI_API_KEY') ? 'gemini' : val('OPENAI_API_KEY') ? 'openai' : 'gemini');
  return { name, provider: AI_PROVIDERS[name] ?? null };
}

/** Is AI extraction ready, and if not, exactly what to set (names only, never values). */
export function aiStatus() {
  const { name, provider } = selectedAiProvider();
  const configured = Boolean(provider && val(provider.keyName));
  return {
    configured,
    provider: provider ? name : null,
    label: provider?.label || null,
    model: provider ? provider.model() : null,
    missing: provider && !configured ? [provider.keyName] : [],
    available: Object.values(AI_PROVIDERS).map((p) => ({ key: p.key, label: p.label })),
    setup: configured ? undefined : provider ? `Set ${provider.keyName} (and optionally the model) in the server environment — see the README.` : `AI_EXTRACTION_PROVIDER="${name}" is not a known provider. Use one of: ${Object.keys(AI_PROVIDERS).join(', ')}.`,
  };
}

/* ------------------------------------------------------------------------------------------------ the prompt */

const SYSTEM = `You read supplier invoices of Indian pharmaceutical wholesalers (GST tax invoices) from OCR output, and return them as JSON that follows the given schema exactly.

Rules — they matter more than completeness:
1. Use ONLY the OCR text and tables you are given. Never use outside knowledge to fill a value in.
2. If a value is not printed in the OCR output, return null for it. NEVER invent, infer or "complete" batch numbers, expiry dates, rates, GSTINs, invoice numbers or any other value. A blank cell is null, not zero.
3. Return ONE item per product row, in the order they appear, across all pages. Never merge two rows and never split one row. Do not return headings, sub-totals, tax summaries or notes as items.
4. Keep the product name/description as printed (do not correct spelling or expand abbreviations). Put the verbatim OCR text of the whole row in sourceText and its page in page.
5. Do not confuse similar columns: MRP is the retail price printed on the pack; the purchase rate (PTR / PTS / Rate) is what the buyer pays. Quantity is the billed quantity; free / bonus quantity (Free, Scheme, Bonus) is separate and must not be added to it. Only fill receivedQuantity if the invoice itself shows a received quantity.
6. Amounts and quantities are plain numbers (no currency symbols, no thousands separators). Percentages are numbers (12 means 12%). Dates are YYYY-MM-DD; if only month and year are printed (for example 08/27 or Aug-2027) use YYYY-MM.
7. Line-level figures belong to the item; invoice-level figures (total discount, freight, packing, round off, tax totals, grand total) belong to totals. Do not copy a total into an item or an item figure into the totals, and do not count a discount or a tax twice.
8. The supplier is the party that ISSUES the invoice (the seller), not the buyer / consignee. gstin is the supplier's.
9. If something is unclear, ambiguous, cut off, handwritten or inconsistent, still return what is printed, and add a short note about it to warnings.`;

const rowText = (cells) => cells.map((c) => c.text.replace(/\s+/g, ' ').trim()).join(' | ');

/** The OCR result as the text the model reads: the text of each page, then each table row by row. Very long invoices are cut, and the cut is reported. */
export function buildPrompt(ocr) {
  const parts = [];
  const pages = ocr.pages?.length ? ocr.pages : [{ pageNumber: 1, text: ocr.text }];
  for (const p of pages) {
    parts.push(`=== PAGE ${p.pageNumber} (text) ===\n${p.text || ''}`);
    for (const t of (ocr.tables || []).filter((x) => x.pageNumber === p.pageNumber)) {
      parts.push(`--- TABLE ${t.index + 1} on page ${p.pageNumber} (cells separated by " | ") ---\n${[...t.headerRows, ...t.bodyRows].map(rowText).join('\n')}`);
    }
  }
  let user = parts.join('\n\n');
  let truncated = false;
  if (user.length > MAX_PROMPT_CHARS) {
    user = user.slice(0, MAX_PROMPT_CHARS);
    truncated = true;
  }
  return { system: SYSTEM, user: `Extract the supplier invoice from this OCR output.\n\n${user}`, truncated };
}

/** Pulls the JSON out of a model's text (some models fence it in ``` marks despite instructions). */
export function parseJsonAnswer(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!s) throw fail(502, 'The AI service returned an empty answer.', 'AI_BAD_RESPONSE');
  try {
    return JSON.parse(s);
  } catch {
    throw fail(502, 'The AI service did not return valid JSON.', 'AI_BAD_RESPONSE');
  }
}

/** Reads one OCR result with the chosen model. Refuses honestly when no provider is set up. The answer is returned as parsed JSON — still unchecked. */
export async function extractInvoice(ocr) {
  const { name, provider } = selectedAiProvider();
  const status = aiStatus();
  if (!status.configured) throw fail(501, `AI extraction is not set up. ${status.setup}`, 'AI_EXTRACTION_NOT_CONFIGURED');
  if (!ocr?.text || !String(ocr.text).trim()) throw fail(422, 'There is no OCR text to read.', 'OCR_NOT_READY');
  const { system, user, truncated } = buildPrompt(ocr);
  const started = Date.now();
  const out = await provider.call({ system, user, signal: AbortSignal.timeout(timeoutMs()) });
  return { provider: name, model: out.model, usage: out.usage, durationMs: Date.now() - started, truncated, raw: parseJsonAnswer(out.text) };
}

export { EXTRACTION_SCHEMA };
