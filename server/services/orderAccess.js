import { Types } from 'mongoose';
import { Order } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { defaultBranchId } from './branch.service.js';
import { branchScope } from './transferAccess.js';

/**
 * Branch-level access to supplier orders, decided on the server from the signed-in user (never from anything the browser sends), the same
 * rule as transfers: an organization admin, and anyone with no stores listed on their account, work with every store; anyone with stores
 * listed only sees and acts on orders delivering to one of them. An order from before orders named a store counts as visible to everyone.
 * Another organization's order is always "not found".
 */
export const orderScopeFilter = (user) => {
  const scope = branchScope(user);
  if (!scope) return null;
  return { $or: [{ branchId: { $in: scope.map((s) => new Types.ObjectId(s)) } }, { branchId: { $exists: false } }] };
};
const hasBranch = (scope, branchId) => !scope || !branchId || scope.includes(String(branchId));

/** The order, or 404 when it is not in this organization or not at one of the user's stores. */
export async function assertOrderAccess(req, id) {
  if (!Types.ObjectId.isValid(String(id))) throw new ApiError(404, 'Order not found');
  const o = await Order.findOne({ _id: id, organizationId: req.orgId }).select('branchId').lean();
  if (!o || !hasBranch(branchScope(req.user), o.branchId)) throw new ApiError(404, 'Order not found');
  return o;
}

/** Ordering for a store: the user must belong to it (the main store when none is named). */
export async function assertMayUseBranch(req, branchId) {
  const scope = branchScope(req.user);
  if (!scope) return;
  const id = branchId || String(await defaultBranchId(req.orgId));
  if (!scope.includes(String(id))) throw new ApiError(403, 'You can only work with orders for your own store.', [{ path: 'branchId', message: 'That is not one of your stores.' }], 'NOT_YOUR_STORE');
}
