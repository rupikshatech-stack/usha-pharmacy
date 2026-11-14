import * as svc from '../services/order.service.js';
import { assertMayUseBranch, assertOrderAccess, orderScopeFilter } from '../services/orderAccess.js';
import { hasPermission } from '../config/permissions.js';

const ok = (res, data) => res.json({ success: true, data });

export const list = async (req, res) => ok(res, await svc.listOrders(req.orgId, req.query, orderScopeFilter(req.user)));
export const get = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.getOrder(req.orgId, req.params.id));
};
export const meta = async (req, res) => ok(res, await svc.orderMeta(req.orgId));
export const products = async (req, res) => ok(res, await svc.searchOrderProducts(req.orgId, req.query));
export const create = async (req, res) => {
  await assertMayUseBranch(req, req.body.branchId);
  const { order, replayed } = await svc.createOrder(req, req.body);
  res.status(replayed ? 200 : 201).set('Idempotent-Replayed', String(replayed)).json({ success: true, data: order });
};
export const getSettings = async (req, res) => ok(res, await svc.getOrderSettings(req.orgId));
export const putSettings = async (req, res) => ok(res, await svc.updateOrderSettings(req, req.body));
export const submit = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.submitOrder(req, req.params.id));
};
export const approve = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.approveOrder(req, req.params.id));
};
export const reject = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.rejectOrder(req, req.params.id, req.body.reason));
};
export const markOrdered = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.markOrdered(req, req.params.id));
};
export const cancel = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.cancelOrder(req, req.params.id, req.body.reason));
};
export const receivable = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.getReceivable(req.orgId, req.params.id));
};
export const receive = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  const { receipt, order, replayed } = await svc.receiveOrder(req, req.params.id, req.body);
  res.status(replayed ? 200 : 201).set('Idempotent-Replayed', String(replayed)).json({ success: true, data: { receipt, order, duplicate: replayed } });
};
export const receipts = async (req, res) => {
  if (req.query.orderId) await assertOrderAccess(req, req.query.orderId);
  ok(res, await svc.listReceipts(req.orgId, req.query, orderScopeFilter(req.user)));
};
export const update = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  await assertMayUseBranch(req, req.body.branchId);
  ok(res, await svc.updateOrder(req, req.params.id, req.body));
};
export const print = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.getOrderPrint(req, req.params.id));
};
export const summary = async (req, res) => ok(res, await svc.orderSummary(req.orgId, new Date(), orderScopeFilter(req.user)));
export const remove = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  await svc.deleteOrder(req, req.params.id);
  ok(res, undefined);
};
export const setStatus = async (req, res) => {
  await assertOrderAccess(req, req.params.id);
  ok(res, await svc.setOrderStatus(req, req.params.id, req.body, (perm) => hasPermission(req.user, perm)));
};
