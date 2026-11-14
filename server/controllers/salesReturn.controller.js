import * as svc from '../services/salesReturn.service.js';

const ok = (res, data) => res.json({ success: true, data });

export const summary = async (req, res) => ok(res, await svc.returnsSummary(req.orgId, req.query));
export const meta = async (req, res) => ok(res, svc.returnsMeta());
export const list = async (req, res) => ok(res, await svc.listReturns(req.orgId, req.query));
export const get = async (req, res) => ok(res, await svc.getReturn(req.orgId, req.params.id));
export const searchInvoices = async (req, res) => ok(res, await svc.searchInvoices(req.orgId, req.query));
export const returnableInvoice = async (req, res) => ok(res, await svc.getReturnableInvoice(req.orgId, req.params.id));
export const create = async (req, res) => {
  const { salesReturn, replayed } = await svc.createReturn(req, req.body);
  res.status(replayed ? 200 : 201).set('Idempotent-Replayed', String(replayed)).json({ success: true, data: salesReturn });
};
export const approve = async (req, res) => ok(res, await svc.approveReturn(req, req.params.id, req.body));
export const reject = async (req, res) => ok(res, await svc.rejectReturn(req, req.params.id, req.body.reason));
export const refund = async (req, res) => ok(res, await svc.recordRefund(req, req.params.id, req.body));
export const update = async (req, res) => ok(res, await svc.updateReturn(req, req.params.id, req.body));
