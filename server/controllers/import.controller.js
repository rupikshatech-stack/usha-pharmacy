import * as svc from '../services/import.service.js';
import { ApiError } from '../utils/ApiError.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const template = (_req, res) => ok(res, svc.templateCsv());

/** The body is the raw CSV text (Content-Type: text/csv); the file name travels in ?fileName=. */
export async function preview(req, res) {
  if (typeof req.body !== 'string') throw new ApiError(415, 'Send the CSV file contents with Content-Type: text/csv.', undefined, 'IMPORT_FILE_TYPE');
  ok(res, await svc.previewImport(req, { text: req.body, fileName: req.query.fileName, contentType: req.headers['content-type'] }), 201);
}

export const confirm = async (req, res) => ok(res, await svc.confirmImport(req, req.params.id, req.body));
export const cancel = async (req, res) => ok(res, await svc.cancelImport(req, req.params.id));
export const history = async (req, res) => ok(res, await svc.listImports(req.orgId, req.query));
export const get = async (req, res) => ok(res, await svc.getImport(req.orgId, req.params.id));
