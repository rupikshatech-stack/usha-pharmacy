// Pure helpers for the Inter Store Transfer pages. They mirror the server's rules (validators/transfer.validator.js,
// services/transfer.service.js) for instant feedback; the server checks everything again and is the source of truth.

export const NOTES_MAX = 500;
export const MAX_LINES = 100;

export const todayKey = (now = new Date()) => new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/** yyyy-mm-dd that exists on the calendar (30 Feb would roll over to 2 Mar, so compare after the round trip). */
const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const blankTransfer = (fromBranchId = '', now = new Date()) => ({ fromBranchId, toBranchId: '', transferDate: todayKey(now), expectedArrivalDate: '', notes: '', internalRemarks: '', lines: [] });

/** A line is one batch of the source store plus how many units to move. `available` / `info` come from the picker and are only for display. */
export const newLine = (batch, quantity = 1) => ({
  batchId: batch._id,
  quantity: String(quantity),
  medicineName: batch.medicineName,
  subtitle: [batch.strength, batch.dosageForm].filter(Boolean).join(' · '),
  batchNumber: batch.batchNumber,
  expiryDate: batch.expiryDate,
  available: batch.sellableQuantity ?? batch.availableQuantity,
});

/** How close a batch is to expiring, for colouring its date: 'expired' / 'soon' (within 30 days) / 'watch' (within 90) / 'ok'. */
export function expiryTone(expiryDate, now = new Date()) {
  const days = Math.ceil((new Date(expiryDate).getTime() - now.getTime()) / 86400000);
  if (days <= 0) return 'expired';
  if (days <= 30) return 'soon';
  if (days <= 90) return 'watch';
  return 'ok';
}

/** Step a quantity up or down, keeping it a whole number between 1 and what is available. */
export function stepQuantity(current, delta, available) {
  const n = Number.isInteger(Number(current)) && current !== '' ? Number(current) : 0;
  const max = available == null ? Infinity : Math.max(1, available);
  return String(Math.min(max, Math.max(1, n + delta)));
}

/** { field: message } where line problems use the key `line.N`. An empty object means the form can be submitted. */
export function validateTransfer(t) {
  const e = {};
  if (!t.fromBranchId) e.fromBranchId = 'Choose the store the stock is leaving';
  if (!t.toBranchId) e.toBranchId = 'Choose the store the stock is going to';
  else if (t.toBranchId === t.fromBranchId) e.toBranchId = 'Choose a different destination store';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.transferDate || '')) e.transferDate = 'Choose the transfer date';
  else if (!isRealDate(t.transferDate)) e.transferDate = 'Not a real calendar date';
  if (t.notes.length > NOTES_MAX) e.notes = `Notes must be ${NOTES_MAX} characters or fewer`;
  if ((t.internalRemarks || '').length > NOTES_MAX) e.internalRemarks = `Internal remarks must be ${NOTES_MAX} characters or fewer`;
  if (t.expectedArrivalDate) {
    if (!isRealDate(t.expectedArrivalDate)) e.expectedArrivalDate = 'Not a real calendar date';
    else if (!e.transferDate && t.expectedArrivalDate < t.transferDate) e.expectedArrivalDate = 'The expected arrival cannot be before the transfer date';
  }

  if (t.lines.length === 0) e.lines = 'Add at least one batch to transfer';
  else if (t.lines.length > MAX_LINES) e.lines = `A transfer can have at most ${MAX_LINES} lines`;
  t.lines.forEach((l, i) => {
    const q = l.quantity === '' ? NaN : Number(l.quantity);
    if (Number.isNaN(q)) e[`line.${i}`] = 'Enter a quantity';
    else if (!Number.isInteger(q)) e[`line.${i}`] = 'Quantity must be a whole number';
    else if (q < 1) e[`line.${i}`] = 'Quantity must be at least 1';
    else if (l.available != null && q > l.available) e[`line.${i}`] = `Only ${l.available} unit${l.available === 1 ? '' : 's'} available`;
  });
  return e;
}

/** The API body. Prices and names are not sent: the server reads them from its own batch records. */
export const toPayload = (t) => ({
  fromBranchId: t.fromBranchId,
  toBranchId: t.toBranchId,
  transferDate: t.transferDate,
  expectedArrivalDate: t.expectedArrivalDate || undefined,
  notes: t.notes.trim(),
  internalRemarks: (t.internalRemarks || '').trim(),
  items: t.lines.map((l) => ({ batchId: l.batchId, quantity: Number(l.quantity) })),
});

/** The form filled from an existing draft. */
export const fromTransfer = (tr) => ({
  fromBranchId: String(tr.fromBranchId),
  toBranchId: String(tr.toBranchId),
  transferDate: String(tr.transferDate).slice(0, 10),
  expectedArrivalDate: tr.expectedArrivalDate ? String(tr.expectedArrivalDate).slice(0, 10) : '',
  notes: tr.notes || '',
  internalRemarks: tr.internalRemarks || '',
  lines: tr.items.map((i) => ({ batchId: String(i.batchId), quantity: String(i.quantity), medicineName: i.medicineName, subtitle: i.subtitle || '', batchNumber: i.batchNumber, expiryDate: i.expiryDate, available: i.availableNow ?? null })),
});

export const isDirty = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

/** Maps the server's error details onto form fields ("items.2.quantity" -> "line.2"). */
export function serverErrors(err) {
  const fields = {};
  for (const d of err?.details || []) {
    const m = /^items\.(\d+)\./.exec(d.path || '');
    const key = m ? `line.${m[1]}` : d.path === 'items' ? 'lines' : d.path === 'branchId' ? 'toBranchId' : d.path;
    if (key && !fields[key]) fields[key] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}

/**
 * What can be done with a transfer in each state. Preparing, submitting, dispatching, receiving and cancelling need
 * "transfer:manage"; approving and rejecting need "transfer:approve" (checked by the server too).
 */
export const ACTIONS = {
  draft: ['edit', 'delete', 'submit'],
  submitted: ['approve', 'reject', 'cancel'],
  approved: ['dispatch', 'cancel'],
  partially_dispatched: ['dispatch', 'cancel'], // some lines have gone; the rest can still be dispatched
  in_transit: ['receive', 'cancel'],
  partially_received: ['receive'], // some units are already in the destination store, so it can no longer be cancelled
  rejected: [],
  completed: [],
  cancelled: [],
};

/** Is this action possible in this status at all? */
export const can = (status, action) => (ACTIONS[status] || []).includes(action);

/** Is it possible AND is this user allowed to do it? `permissions` is the user's permission list. */
export const permissionFor = (action) => PERMISSION_FOR[action] || 'transfer:manage';
const PERMISSION_FOR = { approve: 'transfer:approve', reject: 'transfer:reject', dispatch: 'transfer:dispatch', receive: 'transfer:receive', submit: 'transfer:submit', edit: 'transfer:edit', delete: 'transfer:edit', cancel: 'transfer:cancel' };
// the server sends the effective list (which already includes these), but "transfer:manage" and "transfer:approve" alone are honoured too
const COVERED_BY = { 'transfer:submit': ['transfer:manage'], 'transfer:edit': ['transfer:manage'], 'transfer:cancel': ['transfer:manage'], 'transfer:create': ['transfer:manage'], 'transfer:reject': ['transfer:approve'] };
export const hasPermission = (permissions, p) => (permissions || []).some((x) => x === p || (COVERED_BY[p] || []).includes(x));
export const allowed = (permissions, status, action) => can(status, action) && hasPermission(permissions, permissionFor(action));

/** The one destructive-looking row action: a draft is deleted, anything still open is cancelled. */
export const removeAction = (status) => (status === 'draft' ? 'delete' : can(status, 'cancel') ? 'cancel' : null);

export const STATUS_LABEL = {
  draft: 'Draft',
  submitted: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  partially_dispatched: 'Partially dispatched',
  in_transit: 'In transit',
  partially_received: 'Partially received',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const STATUS_HELP = {
  draft: 'Being prepared. No stock has moved.',
  submitted: 'Waiting for approval. No stock has moved.',
  approved: 'Approved and ready to dispatch. No stock has moved yet.',
  rejected: 'Rejected. No stock moved.',
  partially_dispatched: 'Some lines have been dispatched. Dispatch the rest, or cancel to return what was sent.',
  in_transit: 'Dispatched. The units have left the source store and are in transit.',
  partially_received: 'Some units have been received. The rest is still expected.',
  completed: 'Every dispatched unit is accounted for: received, or reported damaged or missing.',
  cancelled: 'Cancelled.',
};

const units = (t) => `${t.totalUnits} unit${t.totalUnits === 1 ? '' : 's'}`;

/** The wording of each confirmation: what will happen to stock, said plainly. `reason` says whether a reason is asked for. */
export const ACTION_COPY = {
  submit: (t, settings = {}) => ({
    title: 'Submit this transfer?',
    label: 'Submit transfer',
    danger: false,
    message: settings.approvalRequired
      ? `${t.reference} will be sent for approval. No stock moves until it is approved and dispatched.`
      : `${t.reference} will be approved straight away (approval is not required). No stock moves until you dispatch it.`,
  }),
  approve: (t) => ({ title: 'Approve this transfer?', label: 'Approve', danger: false, message: `${t.fromBranch.name} will be cleared to dispatch ${units(t)} to ${t.toBranch.name}. No stock moves until it is dispatched.` }),
  reject: (t) => ({ title: 'Reject this transfer?', label: 'Reject transfer', danger: true, reason: 'required', message: `${t.reference} will be rejected and can't be used again. No stock has moved. Tell the requester why.` }),
  dispatch: (t) => ({ title: 'Dispatch this transfer?', label: 'Dispatch stock', danger: false, message: `Stock will leave ${t.fromBranch.name} now and be marked in transit to ${t.toBranch.name}. You can still cancel it until it is received.` }),
  receive: (t) => ({ title: 'Receive this transfer?', label: 'Receive stock', danger: false, message: `Stock will be added to ${t.toBranch.name} only when you confirm what arrived.` }),
  cancel: (t) => ({
    title: 'Cancel this transfer?',
    label: 'Cancel transfer',
    danger: true,
    reason: 'optional',
    message: t.status === 'in_transit' || t.status === 'partially_dispatched' ? `The units already dispatched will be returned to ${t.fromBranch.name}.` : 'The transfer will be marked cancelled. No stock has moved.',
  }),
  delete: (t) => ({ title: 'Delete this draft?', label: 'Delete', danger: true, message: `Draft ${t.reference} will be permanently deleted. No stock has moved, so nothing changes in your inventory.` }),
};

/** The transfer as CSV rows (header block, then the lines) for "Download". */
export function transferCsvRows(t, organizationName = '') {
  return [
    ['Stock transfer', t.reference],
    ['Organization', organizationName],
    ['Status', STATUS_LABEL[t.status] || t.status],
    ['From store', t.fromBranch?.name],
    ['To store', t.toBranch?.name],
    ['Transfer date', String(t.transferDate).slice(0, 10)],
    ['Created by', t.createdByName || ''],
    ['Notes', t.notes || ''],
    [],
    ['Medicine', 'Batch number', 'Expiry date', 'Quantity'],
    ...t.items.map((i) => [i.medicineName, i.batchNumber, String(i.expiryDate).slice(0, 10), i.quantity]),
    [],
    ['Total units', '', '', t.totalUnits],
  ];
}

/* ------------------------------------------------------------------------------------------------ dispatch screen */

/** The lines of the dispatch screen, from a transfer the server returned (items carry approved / dispatched / remaining / availableNow). */
export function dispatchLines(transfer) {
  return transfer.items
    .filter((i) => (i.remainingQuantity ?? i.quantity - (i.dispatchedQuantity || 0)) > 0)
    .map((i) => {
      const approved = i.quantity;
      const dispatched = i.dispatchedQuantity || 0;
      const remaining = i.remainingQuantity ?? approved - dispatched;
      const available = i.availableNow ?? null;
      // by default send as much as is approved and in stock
      return { batchId: String(i.batchId), medicineName: i.medicineName, batchNumber: i.batchNumber, expiryDate: i.expiryDate, approved, dispatched, remaining, available, quantity: String(available == null ? remaining : Math.min(remaining, available)) };
    });
}

/** { 'line.N': message, lines: message } — an empty object means the dispatch can be confirmed. Lines left at 0 are simply not sent. */
export function validateDispatch(lines) {
  const e = {};
  lines.forEach((l, i) => {
    const q = l.quantity === '' ? NaN : Number(l.quantity);
    if (Number.isNaN(q)) e['line.' + i] = 'Enter a quantity (0 to skip this line)';
    else if (!Number.isInteger(q)) e['line.' + i] = 'Quantity must be a whole number';
    else if (q < 0) e['line.' + i] = 'Quantity cannot be negative';
    else if (q > l.remaining) e['line.' + i] = 'Cannot dispatch more than the ' + l.remaining + ' still to send (approved ' + l.approved + ')';
    else if (l.available != null && q > l.available) e['line.' + i] = 'Only ' + l.available + ' unit' + (l.available === 1 ? '' : 's') + ' available in stock';
  });
  if (!Object.keys(e).length && !lines.some((l) => Number(l.quantity) > 0)) e.lines = 'Enter a quantity for at least one line';
  return e;
}

/** How many units of a line are still to be sent after this dispatch. */
export const remainingAfter = (line) => Math.max(0, line.remaining - (Number(line.quantity) || 0));

/** Will anything be left unsent after this dispatch? (then the user may choose to close the transfer short) */
export const leavesRemainder = (lines) => lines.some((l) => remainingAfter(l) > 0);

/** The API body. Lines at 0 are left out; the key makes a repeated click or retry harmless. */
export function toDispatchPayload(lines, { closeShort = false, idempotencyKey, notes = '' } = {}) {
  return {
    items: lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ batchId: l.batchId, quantity: Number(l.quantity) })),
    closeShort: Boolean(closeShort) && leavesRemainder(lines),
    notes: notes.trim(),
    idempotencyKey,
  };
}

/* ------------------------------------------------------------------------------------------------ receiving screen */

/** The lines of the receiving screen, from a transfer the server returned (each item carries dispatched / received / damaged / missing / remainingToReceive). */
export function receiveLines(transfer) {
  return transfer.items
    .filter((i) => (i.remainingToReceive ?? 0) > 0)
    .map((i) => ({
      batchId: String(i.batchId),
      medicineName: i.medicineName,
      batchNumber: i.batchNumber,
      unit: i.unit || '',
      dispatched: i.dispatchedQuantity,
      previouslyReceived: i.receivedQuantity || 0,
      previouslyReported: (i.damagedQuantity || 0) + (i.missingQuantity || 0),
      remaining: i.remainingToReceive,
      quantity: String(i.remainingToReceive), // what was received: by default everything that is still expected
      damaged: '0',
      missing: '0',
      remarks: '',
    }));
}

const whole = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/** Units the receiver has accounted for on a line in this receipt (good + damaged + missing). */
export const countedOn = (l) => [l.quantity, l.damaged, l.missing].reduce((sum, v) => sum + (Number.isFinite(whole(v)) ? whole(v) : 0), 0);

/** How many units are still expected on a line after this receipt. */
export const stillExpected = (l) => Math.max(0, l.remaining - countedOn(l));

export const hasLineDiscrepancy = (l) => (whole(l.damaged) || 0) > 0 || (whole(l.missing) || 0) > 0;

/**
 * { 'line.N': message, lines: message, remarks: message } — empty means the receipt can be confirmed.
 * Rules: each count is a whole number >= 0; received + damaged + missing cannot exceed what is still expected on the line;
 * damaged or missing units need remarks; closing the receipt needs an overall explanation.
 */
export function validateReceipt(lines, { closeReceipt = false, remarks = '' } = {}) {
  const e = {};
  lines.forEach((l, i) => {
    const k = 'line.' + i;
    const [r, d, m] = [whole(l.quantity), whole(l.damaged), whole(l.missing)];
    if ([r, d, m].some((v) => Number.isNaN(v))) e[k] = 'Enter a number in every box (0 if none)';
    else if ([r, d, m].some((v) => !Number.isInteger(v))) e[k] = 'Quantities must be whole numbers';
    else if ([r, d, m].some((v) => v < 0)) e[k] = 'Quantities cannot be negative';
    else if (r > l.remaining) e[k] = 'Cannot receive more than the ' + l.remaining + ' still expected (dispatched ' + l.dispatched + ', already received ' + l.previouslyReceived + ')';
    else if (r + d + m > l.remaining) e[k] = 'Received + damaged + missing (' + (r + d + m) + ') is more than the ' + l.remaining + ' still expected';
    else if ((d > 0 || m > 0) && String(l.remarks || '').trim().length < 3) e[k + '.remarks'] = 'Explain the damaged or missing units';
  });
  if (closeReceipt && String(remarks).trim().length < 3) e.remarks = 'Explain why the rest is not coming';
  if (!Object.keys(e).length && !closeReceipt && !lines.some((l) => countedOn(l) > 0)) e.lines = 'Enter what arrived on at least one line';
  return e;
}

/** Will anything still be expected after this receipt? (then the receiver may close it) */
export const leavesExpected = (lines) => lines.some((l) => stillExpected(l) > 0);

/** The API body. Lines with nothing counted are left out; the key makes a repeated click or retry harmless. */
export function toReceivePayload(lines, { closeReceipt = false, remarks = '', idempotencyKey } = {}) {
  return {
    items: lines
      .filter((l) => countedOn(l) > 0)
      .map((l) => ({ batchId: l.batchId, receivedQuantity: whole(l.quantity) || 0, damagedQuantity: whole(l.damaged) || 0, missingQuantity: whole(l.missing) || 0, remarks: String(l.remarks || '').trim() })),
    closeReceipt: Boolean(closeReceipt) && leavesExpected(lines),
    remarks: String(remarks).trim(),
    idempotencyKey,
  };
}

/** A status that still has units on the road. */
export const awaitsReceipt = (status) => ['in_transit', 'partially_received'].includes(status);
