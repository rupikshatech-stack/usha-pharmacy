import * as branches from '../services/branch.service.js';
import * as svc from '../services/transfer.service.js';
import * as access from '../services/transferAccess.js';
import { effectivePermissions } from '../config/permissions.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const scopeOf = (req) => access.scopeFilter(access.branchScope(req.user));

export const list = async (req, res) => ok(res, await svc.listTransfers(req.orgId, req.query, scopeOf(req)));
export const get = async (req, res) => {
  const found = await access.assertTransferAccess(req, req.params.id);
  const t = await svc.getTransfer(req.orgId, req.params.id);
  ok(res, { ...t, access: access.accessFor(req.user, found, effectivePermissions(req.user)) }); // what THIS user may do with it
};
export const create = async (req, res) => {
  access.assertMaySendFrom(req, req.body.fromBranchId);
  ok(res, await svc.createTransfer(req, req.body), 201);
};
export const update = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id, 'source');
  access.assertMaySendFrom(req, req.body.fromBranchId);
  ok(res, await svc.updateTransfer(req, req.params.id, req.body));
};
export const remove = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id, 'source');
  await svc.deleteTransfer(req, req.params.id);
  ok(res, undefined);
};
export const summary = async (req, res) => ok(res, await svc.transferSummary(req.orgId, scopeOf(req)));
export const getSettings = async (req, res) => ok(res, await svc.getTransferSettings(req.orgId));
export const putSettings = async (req, res) => ok(res, await svc.updateTransferSettings(req, req.body));
export const submit = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id, 'source');
  ok(res, await svc.submitTransfer(req, req.params.id));
};
export const approve = async (req, res) => {
  await access.assertMayApprove(req, req.params.id);
  ok(res, await svc.approveTransfer(req, req.params.id));
};
export const reject = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id);
  ok(res, await svc.rejectTransfer(req, req.params.id, req.body.reason));
};
export const dispatch = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id, 'source');
  ok(res, await svc.dispatchTransfer(req, req.params.id, req.body)); // `duplicate: true` = a repeat of a dispatch already made
};
export const receive = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id, 'destination');
  ok(res, await svc.receiveTransfer(req, req.params.id, req.body)); // `duplicate: true` = a repeat of a receipt already made
};
export const events = async (req, res) => {
  await access.assertHistoryAccess(req, req.params.id);
  ok(res, await svc.listTransferEvents(req.orgId, req.params.id, req.query));
};
export const print = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id);
  ok(res, await svc.getTransferPrint(req, req.params.id));
};
export const cancel = async (req, res) => {
  await access.assertTransferAccess(req, req.params.id);
  ok(res, await svc.cancelTransfer(req, req.params.id, req.body.reason));
};
export const notifications = async (req, res) => ok(res, await svc.transferNotifications(req, access.branchScope(req.user), effectivePermissions(req.user)));
export const inTransit = async (req, res) => ok(res, await svc.unitsInTransit(req.orgId, scopeOf(req)));

/* stores */
export const listStores = async (req, res) => ok(res, await branches.listBranches(req.orgId, req.query.__paged ? { paged: true, ...req.query } : {}));
export const getStore = async (req, res) => ok(res, await branches.getBranch(req.orgId, req.params.id));
export const createStore = async (req, res) => ok(res, await branches.createBranch(req, req.body), 201);
export const updateStore = async (req, res) => ok(res, await branches.updateBranch(req, req.params.id, req.body));
export const deleteStore = async (req, res) => {
  await branches.deleteBranch(req, req.params.id);
  ok(res, undefined);
};
