import { Types } from 'mongoose';
import { Transfer, TransferEvent } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { getTransferSettings } from './transfer.service.js';

/**
 * Who may touch which transfer — decided on the server from the signed-in user, never from anything the browser sends.
 *  - ORG_ADMIN: every store in the organization.
 *  - Others with no stores listed on their account: every store (so existing accounts keep working).
 *  - Others with stores listed: only transfers that involve one of them; dispatching needs the SOURCE, receiving the DESTINATION.
 * Another organization's transfer is always "not found".
 */
export const branchScope = (user) => {
  if (user.role === 'ORG_ADMIN' || !user.branchIds?.length) return null; // null = unrestricted
  return user.branchIds.map(String);
};

const inScope = (scope, ...ids) => !scope || ids.some((i) => scope.includes(String(i)));

/** A Mongo filter that keeps a restricted user to transfers involving their stores (null when unrestricted). */
export const scopeFilter = (scope) => {
  if (!scope) return null;
  const ids = scope.map((s) => new Types.ObjectId(s));
  return { $or: [{ fromBranchId: { $in: ids } }, { toBranchId: { $in: ids } }] };
};

/** Loads just enough of the transfer to decide; 404 when it is not in this organization or not one of the user's stores. */
async function transferFor(req, id) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'Transfer not found');
  const t = await Transfer.findOne({ _id: id, organizationId: req.orgId }).select('fromBranchId toBranchId createdBy submittedBy status reference').lean();
  const scope = branchScope(req.user);
  if (!t || !inScope(scope, t.fromBranchId, t.toBranchId)) throw new ApiError(404, 'Transfer not found');
  return { t, scope };
}

const forbid = (message, code) => new ApiError(403, message, undefined, code);

/** `as`: 'involved' (view, approve, cancel, history, print) | 'source' (edit, submit, dispatch) | 'destination' (receive). */
export async function assertTransferAccess(req, id, as = 'involved') {
  const { t, scope } = await transferFor(req, id);
  if (as === 'source' && !inScope(scope, t.fromBranchId)) throw forbid('Only users of the source store can do this.', 'NOT_SOURCE_STORE');
  if (as === 'destination' && !inScope(scope, t.toBranchId)) throw forbid('Only users of the destination store can receive this transfer.', 'NOT_DESTINATION_STORE');
  return t;
}

/** Creating or editing a draft: the user must belong to the store the stock leaves. */
export function assertMaySendFrom(req, fromBranchId) {
  if (!inScope(branchScope(req.user), fromBranchId)) throw forbid('You can only create transfers from your own store.', 'NOT_SOURCE_STORE');
}

/** Approving: an involved store, and not your own transfer unless the organization allows it (org admins are exempt). */
export async function assertMayApprove(req, id) {
  const t = await assertTransferAccess(req, id, 'involved');
  if (req.user.role !== 'ORG_ADMIN' && [t.createdBy, t.submittedBy].some((u) => u && String(u) === String(req.user._id))) {
    const { allowSelfApproval } = await getTransferSettings(req.orgId);
    if (!allowSelfApproval) throw forbid('You cannot approve a transfer you created or submitted. Ask another approver.', 'SELF_APPROVAL');
  }
  return t;
}

/** What the signed-in user could do with this transfer — the screen uses it to show only the buttons that will work. */
export function accessFor(user, t, perms) {
  const scope = branchScope(user);
  const has = (p) => perms.includes(p);
  return {
    dispatch: has('transfer:dispatch') && inScope(scope, t.fromBranchId),
    receive: has('transfer:receive') && inScope(scope, t.toBranchId),
    edit: has('transfer:edit') && inScope(scope, t.fromBranchId),
    submit: has('transfer:submit') && inScope(scope, t.fromBranchId),
    approve: has('transfer:approve') && inScope(scope, t.fromBranchId, t.toBranchId),
    reject: has('transfer:reject') && inScope(scope, t.fromBranchId, t.toBranchId),
    cancel: has('transfer:cancel') && inScope(scope, t.fromBranchId, t.toBranchId),
    print: has('transfer:print'),
  };
}

/** History stays readable after a draft was deleted: then access is judged from the stores named in its events. */
export async function assertHistoryAccess(req, id) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'Transfer not found');
  if (await Transfer.exists({ _id: id, organizationId: req.orgId })) return assertTransferAccess(req, id);
  const scope = branchScope(req.user);
  const ev = await TransferEvent.find({ transferId: id, organizationId: req.orgId }).select('branchId').lean();
  if (!ev.length || !inScope(scope, ...ev.map((e) => e.branchId))) throw new ApiError(404, 'Transfer not found');
}
