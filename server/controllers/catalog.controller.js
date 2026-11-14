import * as svc from '../services/catalog.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const listCompounds = async (req, res) => ok(res, await svc.listCompounds(req.orgId, req.query));
export const getCompound = async (req, res) => ok(res, await svc.getCompound(req.orgId, req.params.id));
/** The preparation worked out for a batch size that is not the standard one. */
export const compoundBatch = async (req, res) => ok(res, await svc.compoundBatch(req.orgId, req.params.id, req.query.quantity));
export const linkMedicines = async (req, res) => ok(res, await svc.linkMedicines(req, req.params.id, req.body.medicineIds));
export const unlinkMedicine = async (req, res) => ok(res, await svc.unlinkMedicine(req, req.params.id, req.params.medicineId));
export const createCompound = async (req, res) => ok(res, await svc.createCompound(req, req.body), 201);
export const updateCompound = async (req, res) => ok(res, await svc.updateCompound(req, req.params.id, req.body));
export const deleteCompound = async (req, res) => {
  await svc.deleteCompound(req, req.params.id);
  ok(res, undefined);
};

export const listAttributes = async (req, res) => ok(res, await svc.listAttributes(req.orgId, req.query));
export const createAttribute = async (req, res) => ok(res, await svc.createAttribute(req, req.body), 201);
export const updateAttribute = async (req, res) => ok(res, await svc.updateAttribute(req, req.params.id, req.body));
export const deleteAttribute = async (req, res) => {
  await svc.deleteAttribute(req, req.params.id);
  ok(res, undefined);
};
