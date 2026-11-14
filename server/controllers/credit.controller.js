import { ApiError } from '../utils/ApiError.js';
import * as credit from '../services/credit.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const settings = async (req, res) => ok(res, await credit.getCreditSettings(req.orgId));
export const updateSettings = async (req, res) => ok(res, await credit.updateCreditSettings(req, req.body));

/** The screenshot is the request body (an image); the amount and file name come in the query, the repeat-protection key in a header. */
export const submit = async (req, res) => {
  const type = (req.headers['content-type'] || '').split(';')[0];
  if (type && !credit.IMAGE_TYPES.includes(type)) throw new ApiError(415, 'The screenshot must be a JPG, JPEG, PNG or WEBP image.', [{ path: 'screenshot', message: 'Use a JPG, PNG or WEBP image' }], 'CREDIT_UNSUPPORTED_TYPE');
  const r = await credit.createRequest(req, {
    buffer: Buffer.isBuffer(req.body) ? req.body : undefined, amount: req.query.amount, fileName: String(req.query.fileName || 'screenshot'), contentType: credit.IMAGE_TYPES.includes(type) ? type : undefined,
    idempotencyKey: req.headers['idempotency-key'] || req.query.key,
  });
  ok(res, r.request, r.replayed ? 200 : 201);
};
export const list = async (req, res) => ok(res, await credit.listRequests(req, req.query));
export const get = async (req, res) => ok(res, await credit.getRequest(req, req.params.id));
export const summary = async (req, res) => ok(res, await credit.creditSummary(req, req.query));
export const approve = async (req, res) => ok(res, await credit.approveRequest(req, req.params.id, req.body));
/** The signed-in person's credit balance (the header shows it); an administrator may ask for someone else's with ?userId=. */
export const balance = async (req, res) => ok(res, await credit.getBalance(req, req.query));
export const transactions = async (req, res) => ok(res, await credit.listTransactions(req, req.query));
/** Decided requests of the signed-in person, for the notification menu (derived from the requests themselves). */
export const notifications = async (req, res) => ok(res, await credit.creditNotifications(req));
export const reject = async (req, res) => ok(res, await credit.rejectRequest(req, req.params.id, req.body));

/** The stored screenshot, to its owner and to administrators. Served as itself, never sniffed, never cached. */
export const screenshot = async (req, res) => {
  const f = await credit.getScreenshot(req, req.params.id);
  res.set({
    'Content-Type': f.mimeType,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.send(f.buffer);
};
