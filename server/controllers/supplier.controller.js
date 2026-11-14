import * as svc from '../services/supplier.service.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const list = async (req, res) => ok(res, await svc.listSuppliers(req.orgId, req.query));
export const get = async (req, res) => ok(res, await svc.getSupplier(req.orgId, req.params.id));
export const purchases = async (req, res) => ok(res, await svc.supplierPurchases(req.orgId, req.params.id, req.query));
export const create = async (req, res) => ok(res, await svc.createSupplier(req, req.body), 201);
export const update = async (req, res) => ok(res, await svc.updateSupplier(req, req.params.id, req.body));
export const preferred = async (req, res) => ok(res, await svc.setPreferred(req, req.params.id, req.body.preferred));
export const status = async (req, res) => ok(res, await svc.setSupplierStatus(req, req.params.id, req.body.status === 'active'));
export const remove = async (req, res) => {
  await svc.deleteSupplier(req, req.params.id);
  ok(res, { deleted: true });
};
