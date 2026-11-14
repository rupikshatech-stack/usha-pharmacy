import * as productImage from '../services/productImage.service.js';
import { ApiError } from '../utils/ApiError.js';
import * as svc from '../services/medicine.service.js';
import * as batches from '../services/batch.service.js';
import { paginated } from '../utils/pagination.js';

export async function list(req, res) {
  const { items, total } = await svc.listMedicines(req.orgId, req.query);
  res.json({ success: true, data: paginated(items, { page: req.query.page, limit: req.query.limit, total }) });
}

export async function facets(req, res) {
  res.json({ success: true, data: await svc.getFacets(req.orgId) });
}

export async function duplicates(req, res) {
  res.json({ success: true, data: await svc.findDuplicates(req.orgId, req.query) });
}

export async function get(req, res) {
  res.json({ success: true, data: await svc.getMedicine(req.orgId, req.params.id) });
}

export async function create(req, res) {
  res.status(201).json({ success: true, data: await svc.createMedicine(req, req.body) });
}

export async function update(req, res) {
  res.json({ success: true, data: await svc.updateMedicine(req, req.params.id, req.body) });
}

/** Soft delete: archives a medicine that has history, physically deletes one that never had any. */
export async function remove(req, res) {
  const result = await svc.removeMedicine(req, req.params.id);
  res.json({ success: true, data: result });
}

export async function restore(req, res) {
  res.json({ success: true, data: await svc.restoreMedicine(req, req.params.id) });
}

/* ---- batches of a medicine ---- */

export async function listBatches(req, res) {
  res.json({ success: true, data: await batches.listBatches(req.orgId, req.params.id) });
}

export async function addBatch(req, res) {
  res.status(201).json({ success: true, data: await batches.addBatch(req, req.params.id, req.body) });
}

export async function updateBatch(req, res) {
  res.json({ success: true, data: await batches.updateBatch(req, req.params.id, req.params.batchId, req.body) });
}

/* ---------------------------------------------------------------- product photographs */

/** The picture is the request body. What it really is comes from its first bytes, never from the header or a file name. */
export const uploadImage = async (req, res) => {
  const type = (req.headers['content-type'] || '').split(';')[0];
  if (type && !productImage.IMAGE_TYPES.includes(type)) throw new ApiError(415, 'The image must be a JPG, JPEG, PNG or WEBP file.', [{ path: 'image', message: 'Use a JPG, PNG or WEBP image' }], 'IMAGE_UNSUPPORTED_TYPE');
  const saved = await productImage.uploadProductImage(req, { buffer: Buffer.isBuffer(req.body) ? req.body : undefined, contentType: productImage.IMAGE_TYPES.includes(type) ? type : undefined });
  res.status(201).json({ success: true, data: saved });
};

/** Served as itself, never sniffed, never executed, and cacheable only by the person who asked for it. */
export const getImage = async (req, res) => {
  const f = await productImage.getProductImage(req, req.params.file);
  res.set({
    'Content-Type': f.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.send(f.buffer);
};
