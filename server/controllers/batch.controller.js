import { addBatch, updateBatch } from '../services/batch.service.js';
import { batchManufacturers, expirySummary, getBatch, listAllBatches } from '../services/batchCatalog.service.js';
import { listMovements } from '../services/ledger.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export async function list(req, res) {
  ok(res, await listAllBatches(req.orgId, req.query));
}

export async function summary(req, res) {
  const [counts, manufacturers] = await Promise.all([expirySummary(req.orgId), batchManufacturers(req.orgId)]);
  ok(res, { ...counts, manufacturers });
}

export async function get(req, res) {
  ok(res, await getBatch(req.orgId, req.params.id));
}

export async function create(req, res) {
  const { medicineId, ...data } = req.body;
  ok(res, await addBatch(req, medicineId, data), 201);
}

export async function update(req, res) {
  const batch = await getBatch(req.orgId, req.params.id);
  await updateBatch(req, batch.medicineId, req.params.id, req.body);
  ok(res, await getBatch(req.orgId, req.params.id));
}

/** The batch's stock movement history (ledger), newest first. */
export async function movements(req, res) {
  const batch = await getBatch(req.orgId, req.params.id);
  ok(res, await listMovements(req.orgId, { batchId: String(batch._id), page: req.query.page, limit: req.query.limit }));
}
