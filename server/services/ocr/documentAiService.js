import fs from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import { ApiError } from '../../utils/ApiError.js';

/**
 * Google Cloud Document AI as an OCR provider. Server-side only: the credentials never leave this process and are never logged or returned.
 *
 * Settings (all read from the environment on every call):
 *   GOOGLE_CLOUD_PROJECT_ID             – the Google Cloud project
 *   GOOGLE_DOCUMENT_AI_LOCATION         – the processor's region, e.g. "us" or "eu"
 *   GOOGLE_DOCUMENT_AI_PROCESSOR_ID     – the processor (an OCR, Form or Invoice parser processor)
 *   GOOGLE_APPLICATION_CREDENTIALS      – path to a service-account key file (JSON); it needs the "Document AI API User" role
 *   GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION  optional – pin a processor version
 *   GOOGLE_DOCUMENT_AI_IMAGE_QUALITY      optional – "true" asks for image-quality scores (processors that support it)
 *   GOOGLE_DOCUMENT_AI_ENDPOINT           optional – override the API address (tests, private endpoints)
 *   OCR_TIMEOUT_MS                        optional – how long to wait for Google (default 120000)
 *
 * It calls the documented REST method  POST https://{location}-documentai.googleapis.com/v1/projects/{p}/locations/{l}/processors/{id}:process
 * (online processing: Google's own limits apply — 20 MB and, for most processors, 15 pages per document) and signs in with a service-account key
 * (a signed JWT exchanged for a short-lived token, cached until it expires). It returns the provider-neutral OcrResult described in ocrService.js.
 */
const REQUIRED = { GOOGLE_CLOUD_PROJECT_ID: 'project', GOOGLE_DOCUMENT_AI_LOCATION: 'location', GOOGLE_DOCUMENT_AI_PROCESSOR_ID: 'processor', GOOGLE_APPLICATION_CREDENTIALS: 'keyFile' };
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const val = (k) => (process.env[k] || '').trim();
const settings = () => ({
  project: val('GOOGLE_CLOUD_PROJECT_ID'), location: val('GOOGLE_DOCUMENT_AI_LOCATION'), processor: val('GOOGLE_DOCUMENT_AI_PROCESSOR_ID'), keyFile: val('GOOGLE_APPLICATION_CREDENTIALS'),
  version: val('GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION'), quality: val('GOOGLE_DOCUMENT_AI_IMAGE_QUALITY') === 'true', endpointOverride: val('GOOGLE_DOCUMENT_AI_ENDPOINT'),
  timeoutMs: Number(val('OCR_TIMEOUT_MS')) || 120000,
});
const fail = (status, message, code) => new ApiError(status, message, undefined, code);

/** The names (never the values) of the settings that are still missing. */
export const missingSettings = () => Object.keys(REQUIRED).filter((k) => !val(k));

/* ------------------------------------------------------------------------------------------------ signing in */

let cached = null; // { key: client_email, token, expiresAt }

async function accessToken(s, signal) {
  let key;
  try {
    key = JSON.parse(await fs.readFile(s.keyFile, 'utf8'));
  } catch {
    throw fail(502, 'The Google credentials file could not be read. Check GOOGLE_APPLICATION_CREDENTIALS.', 'OCR_CREDENTIALS');
  }
  if (!key.client_email || !key.private_key) throw fail(502, 'The Google credentials file is not a service-account key (it has no client_email / private_key).', 'OCR_CREDENTIALS');
  if (cached && cached.key === key.client_email && cached.expiresAt - 60000 > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  let assertion;
  try {
    assertion = jwt.sign({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }, key.private_key, { algorithm: 'RS256' });
  } catch {
    throw fail(502, 'The Google credentials file has an unusable private key.', 'OCR_CREDENTIALS');
  }
  let res;
  try {
    res = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal });
  } catch (e) {
    throw fail(502, e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Google sign-in timed out.' : 'Google sign-in could not be reached.', 'OCR_UNAVAILABLE');
  }
  if (!res.ok) throw fail(502, `Google refused the service account's sign-in (${res.status}). Check that the key is valid and the account is enabled.`, 'OCR_AUTH_FAILED');
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) throw fail(502, 'Google sign-in did not return an access token.', 'OCR_AUTH_FAILED');
  cached = { key: key.client_email, token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return cached.token;
}
/** Forgets the cached sign-in (after Google rejects it, and in tests). */
export const forgetToken = () => {
  cached = null;
};

/* ------------------------------------------------------------------------------------------------ reading Google's answer */

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r4 = (n) => Math.round(n * 10000) / 10000;
const ROTATION = { PAGE_UP: 0, PAGE_RIGHT: 90, PAGE_DOWN: 180, PAGE_LEFT: 270 };
const MAX_LINES_PER_PAGE = 3000;

/** The text a layout points at: Google gives positions in the whole-document text, not the text itself. */
const anchored = (text, a) => (a?.textSegments || []).map((s) => text.slice(Number(s.startIndex || 0), Number(s.endIndex))).join('');
const boxOf = (layout) => (layout?.boundingPoly?.normalizedVertices || []).map((v) => [r4(v.x || 0), r4(v.y || 0)]);
const pageNo = (e) => {
  const ref = e.pageAnchor?.pageRefs?.[0];
  return ref ? Number(ref.page || 0) + 1 : null; // an entity's page is an index from 0, left out when it is 0
};
const cleanCell = (s) => s.replace(/\s+/g, ' ').trim();

function readPage(doc, p, index) {
  const text = doc.text || '';
  const units = p.lines?.length ? p.lines : p.paragraphs?.length ? p.paragraphs : p.blocks || [];
  const lines = units.slice(0, MAX_LINES_PER_PAGE).map((l) => ({ text: anchored(text, l.layout?.textAnchor).replace(/\n+$/, ''), confidence: num(l.layout?.confidence), box: boxOf(l.layout) })).filter((l) => l.text.trim());
  const pageText = lines.length ? lines.map((l) => l.text).join('\n') : anchored(text, p.layout?.textAnchor).trim();
  const confidences = lines.map((l) => l.confidence).filter((c) => c !== null);
  const q = p.imageQualityScores;
  return {
    pageNumber: num(p.pageNumber) || index + 1,
    width: num(p.dimension?.width), height: num(p.dimension?.height), unit: p.dimension?.unit || null,
    rotation: ROTATION[p.layout?.orientation] ?? null,
    language: p.detectedLanguages?.[0]?.languageCode || null,
    qualityScore: q ? num(q.qualityScore) : null,
    defects: (q?.detectedDefects || []).map((d) => ({ type: d.type, confidence: num(d.confidence) })),
    confidence: confidences.length ? r4(confidences.reduce((a, b) => a + b, 0) / confidences.length) : num(p.layout?.confidence),
    text: pageText,
    lines,
  };
}

function readTables(doc, p, index) {
  const text = doc.text || '';
  const cells = (rows) => (rows || []).map((row) => (row.cells || []).map((c) => ({ text: cleanCell(anchored(text, c.layout?.textAnchor)), rowSpan: num(c.rowSpan) || 1, colSpan: num(c.colSpan) || 1, confidence: num(c.layout?.confidence) })));
  return (p.tables || []).map((t, n) => {
    const headerRows = cells(t.headerRows);
    const bodyRows = cells(t.bodyRows);
    const width = Math.max(0, ...[...headerRows, ...bodyRows].map((r) => r.reduce((a, c) => a + c.colSpan, 0)));
    return { pageNumber: num(p.pageNumber) || index + 1, index: n, headerRows, bodyRows, rowCount: headerRows.length + bodyRows.length, columnCount: width, confidence: num(t.layout?.confidence), box: boxOf(t.layout) };
  });
}

const entityOf = (text, e) => ({
  type: e.type, text: cleanCell(e.mentionText || anchored(text, e.textAnchor) || ''), normalized: e.normalizedValue?.text ?? null, confidence: num(e.confidence), pageNumber: pageNo(e),
  ...(e.properties?.length && { properties: e.properties.map((x) => entityOf(text, x)) }),
});

// Document AI invoice-parser entity types, arranged under invoice field names. Anything the provider did not detect stays null: never filled in.
const FIELD_OF = {
  supplier_name: 'supplierName', supplier_address: 'supplierAddress', supplier_tax_id: 'supplierGstin', supplier_phone: 'supplierPhone', supplier_email: 'supplierEmail',
  invoice_id: 'invoiceNumber', invoice_date: 'invoiceDate', due_date: 'dueDate', purchase_order: 'purchaseOrderNumber',
  net_amount: 'subtotal', total_tax_amount: 'totalTax', total_amount: 'grandTotal', freight_amount: 'otherCharges', currency: 'currency',
};
export const FIELD_NAMES = ['supplierName', 'supplierAddress', 'supplierGstin', 'supplierPhone', 'supplierEmail', 'invoiceNumber', 'invoiceDate', 'dueDate', 'purchaseOrderNumber', 'subtotal', 'totalTax', 'grandTotal', 'otherCharges', 'currency'];
const LINE_PART = { 'line_item/description': 'description', 'line_item/product_code': 'productCode', 'line_item/quantity': 'quantity', 'line_item/unit': 'unit', 'line_item/unit_price': 'unitPrice', 'line_item/amount': 'amount' };

function readEntities(doc) {
  const text = doc.text || '';
  const entities = (doc.entities || []).map((e) => entityOf(text, e));
  const fields = Object.fromEntries(FIELD_NAMES.map((f) => [f, null]));
  const lineItems = [];
  for (const e of entities) {
    if (FIELD_OF[e.type] && fields[FIELD_OF[e.type]] === null && e.text) fields[FIELD_OF[e.type]] = { value: e.text, normalized: e.normalized, confidence: e.confidence, pageNumber: e.pageNumber };
    if (e.type === 'line_item') {
      const li = { text: e.text, confidence: e.confidence, pageNumber: e.pageNumber };
      for (const p of e.properties || []) if (LINE_PART[p.type]) li[LINE_PART[p.type]] = { value: p.text, normalized: p.normalized, confidence: p.confidence };
      lineItems.push(li);
    }
  }
  return { entities, fields, lineItems };
}

/** Google's Document → the provider-neutral OcrResult (raw and unverified; nothing is invented, absent things are null or missing). */
export function normalizeDocument(doc) {
  const pages = (doc.pages || []).map((p, i) => readPage(doc, p, i));
  const tables = (doc.pages || []).flatMap((p, i) => readTables(doc, p, i));
  const { entities, fields, lineItems } = readEntities(doc);
  const warnings = [];
  for (const p of pages) {
    if (p.qualityScore !== null && p.qualityScore < 0.5) warnings.push(`Page ${p.pageNumber} looks blurry or low quality (score ${p.qualityScore}). The text may be unreliable.`);
    if (p.defects.some((d) => (d.confidence ?? 1) >= 0.5)) warnings.push(`Page ${p.pageNumber} has image defects (${p.defects.filter((d) => (d.confidence ?? 1) >= 0.5).map((d) => d.type.replace(/^quality\/defect_/, '')).join(', ')}).`);
    if (p.rotation) warnings.push(`Page ${p.pageNumber} was rotated (${p.rotation}°). The text below is as Google read it.`);
    if (!p.text.trim()) warnings.push(`No text was found on page ${p.pageNumber}.`);
    else if (p.confidence !== null && p.confidence < 0.7) warnings.push(`Page ${p.pageNumber} was read with low confidence (${Math.round(p.confidence * 100)}%). Check it against the document.`);
  }
  return { text: doc.text || '', pageCount: pages.length, pages, tables, entities, fields, lineItems, warnings };
}

/* ------------------------------------------------------------------------------------------------ the provider */

const explain = (status, body) => {
  const msg = body?.error?.message ? ` (${String(body.error.message).slice(0, 200)})` : '';
  if (status === 400) return fail(422, `Google Document AI could not process this document${msg || ''}. It may exceed the page limit, or not be a readable PDF or image.`, 'OCR_REJECTED');
  if (status === 401) return fail(502, 'Google Document AI did not accept the sign-in. The credentials may be wrong or expired.', 'OCR_AUTH_FAILED');
  if (status === 403) return fail(502, `Google Document AI refused access${msg || ''}. Check that the Document AI API is enabled and the service account has the "Document AI API User" role.`, 'OCR_AUTH_FAILED');
  if (status === 404) return fail(502, 'Google Document AI could not find the processor. Check the project, location and processor id.', 'OCR_PROCESSOR_NOT_FOUND');
  if (status === 429) return fail(502, 'Google Document AI is rate-limiting requests (quota exceeded). Try again in a few minutes.', 'OCR_QUOTA');
  return fail(502, `Google Document AI answered with an error (${status}). Try again shortly.`, 'OCR_UNAVAILABLE');
};

export const documentAiProvider = {
  key: 'google-document-ai',
  label: 'Google Document AI',
  implemented: true,
  missing: missingSettings,
  isConfigured: () => missingSettings().length === 0,
  setup: 'Set GOOGLE_CLOUD_PROJECT_ID, GOOGLE_DOCUMENT_AI_LOCATION, GOOGLE_DOCUMENT_AI_PROCESSOR_ID and GOOGLE_APPLICATION_CREDENTIALS in the server environment (see the README for how to create the processor and key).',
  processorInfo: () => {
    const s = settings();
    return { processorId: s.processor, location: s.location, version: s.version || null };
  },
  async process({ buffer, mimeType }) {
    const s = settings();
    const signal = AbortSignal.timeout(s.timeoutMs);
    const token = await accessToken(s, signal);
    const base = s.endpointOverride || `https://${s.location}-documentai.googleapis.com`;
    const path = `/v1/projects/${encodeURIComponent(s.project)}/locations/${encodeURIComponent(s.location)}/processors/${encodeURIComponent(s.processor)}${s.version ? `/processorVersions/${encodeURIComponent(s.version)}` : ''}:process`;
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawDocument: { content: buffer.toString('base64'), mimeType }, skipHumanReview: true, ...(s.quality && { processOptions: { ocrConfig: { enableImageQualityScores: true } } }) }),
        signal,
      });
    } catch (e) {
      throw fail(502, e.name === 'TimeoutError' || e.name === 'AbortError' ? `Google Document AI did not answer within ${Math.round(s.timeoutMs / 1000)} seconds.` : 'Google Document AI could not be reached.', 'OCR_UNAVAILABLE');
    }
    if (res.status === 401) forgetToken(); // the cached sign-in was refused: sign in afresh next time
    if (!res.ok) throw explain(res.status, await res.json().catch(() => null));
    let body;
    try {
      body = await res.json();
    } catch {
      throw fail(502, 'Google Document AI sent something that is not valid JSON.', 'OCR_BAD_RESPONSE');
    }
    if (!body?.document || typeof body.document !== 'object') throw fail(502, 'Google Document AI did not return a document.', 'OCR_BAD_RESPONSE');
    return normalizeDocument(body.document);
  },
};
