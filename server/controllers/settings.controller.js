import * as settings from '../services/settings.service.js';
import * as files from '../services/settingsFiles.service.js';
import { hasPermission } from '../config/permissions.js';

const ok = (res, data) => res.json({ success: true, data });

/** Whether this person may change settings, which also decides whether they see the bank account number whole. */
const canManage = (req) => hasPermission(req.user, 'settings:manage');

/** Everything all three tabs need, in one request. */
export const get = async (req, res) => ok(res, await settings.getSettings(req.tenant.organization, { canManage: canManage(req) }));

export const saveOrganization = async (req, res) => ok(res, await settings.saveOrganization(req, req.body));
export const saveInvoice = async (req, res) => ok(res, await settings.saveInvoice(req, req.body));
export const saveGeneral = async (req, res) => ok(res, await settings.saveGeneral(req, req.body));
export const resetInvoice = async (req, res) => ok(res, await settings.resetInvoice(req, req.body));

/** The next number a series will issue — read only; nothing here increments a counter. */
export const previewNumber = async (req, res) => ok(res, await settings.previewNumber(req.tenant.organization, req.query));

/* ------------------------------------------------------------------ files */

/** The bytes are the request body; the type is decided by the bytes, not by the header or the name. */
const bodyOf = (req) => (Buffer.isBuffer(req.body) ? req.body : undefined);
const declaredType = (req) => (req.headers['content-type'] || '').split(';')[0];
/** The original name, only for the audit entry and the licence list — never for anything on disk. */
const nameOf = (req) => req.headers['x-file-name'] || '';

export const uploadLogo = async (req, res) =>
  res.status(201).json({ success: true, data: await files.uploadLogo(req, { buffer: bodyOf(req), contentType: declaredType(req), fileName: nameOf(req) }) });

export const deleteLogo = async (req, res) => ok(res, await files.deleteLogo(req));

export const uploadDocument = async (req, res) =>
  res.status(201).json({ success: true, data: await files.uploadDocument(req, { buffer: bodyOf(req), contentType: declaredType(req), fileName: nameOf(req) }) });

/** Served as itself, never sniffed, never executed, and cacheable only by the person who asked for it. */
const serve = (res, f, disposition) => {
  res.set({
    'Content-Type': f.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...(disposition ? { 'Content-Disposition': disposition } : {}),
  });
  res.send(f.buffer);
};

export const getLogo = async (req, res) => serve(res, await files.getLogo(req, req.params.file));
// A licence scan is downloaded rather than rendered in place: a PDF opened inline is a document the browser runs.
export const getDocument = async (req, res) => serve(res, await files.getDocument(req, req.params.file), `inline; filename="licence-${req.params.file}"`);
