import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const TRANSFER_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'partially_dispatched', 'in_transit', 'partially_received', 'completed', 'cancelled'];
/** Statuses in which a transfer is still open: it can still change, or its stock is still on the move. */
export const OPEN_TRANSFER_STATUSES = ['draft', 'submitted', 'approved', 'partially_dispatched', 'in_transit', 'partially_received'];
/** Statuses from which a transfer can still be cancelled: once receiving has started the units are (partly) in the destination store. */
export const CANCELLABLE_TRANSFER_STATUSES = ['draft', 'submitted', 'approved', 'partially_dispatched', 'in_transit'];
/** Statuses in which dispatched units are on the road (they have left the source store but have not arrived). */
export const IN_TRANSIT_STATUSES = ['partially_dispatched', 'in_transit', 'partially_received'];

const itemSchema = new Schema(
  {
    medicineId: { type: Types.ObjectId, ref: 'Medicine', required: true },
    batchId: { type: Types.ObjectId, ref: 'Batch', required: true }, // the SOURCE store's batch
    medicineName: { type: String, required: true }, // snapshots: the record stays readable if the catalogue changes later
    batchNumber: { type: String, required: true },
    expiryDate: { type: Date, required: true },
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger }, // the APPROVED quantity
    // How much of it has been sent so far (a transfer can be dispatched in parts). Deliberately NO default: it is written on every line at
    // the first dispatch, and a transfer dispatched before partial dispatch existed has none, which readers treat as "all of it was sent".
    dispatchedQuantity: { type: Number, min: 0 },
    // Receiving, cumulative over all receipts (no defaults for the same reason as dispatchedQuantity). Every dispatched unit ends up in
    // exactly one of: received (credited to the destination), damaged, missing — or is still expected.
    receivedQuantity: { type: Number, min: 0 },
    damagedQuantity: { type: Number, min: 0 },
    missingQuantity: { type: Number, min: 0 }, // missing or short
    unit: { type: String, trim: true, maxlength: 30 }, // snapshot of the medicine's unit (Strip, Bottle …)
    remarks: { type: String, trim: true, maxlength: 600 }, // the receiver's explanation of any damaged / missing units
  },
  { _id: false },
);

/**
 * Moving stock from one store to another.
 *
 *   draft       – being prepared; editable and deletable; no stock has moved
 *   submitted   – handed in and waiting for approval (only when the organization requires approval)
 *   approved    – cleared to go (approved by an approver, or automatically when approval is not required)
 *   rejected    – an approver said no; final
 *   partially_dispatched – some lines/quantities have been dispatched; the rest can still be dispatched
 *   in_transit  – DISPATCHED in full (or closed short): the units have left the source store's batches (ledger TRANSFER_OUT)
 *   partially_received – some units have been received (and credited, ledger TRANSFER_IN); the rest is still expected
 *   completed   – every dispatched unit is accounted for: received, or reported damaged / missing
 *   cancelled   – dropped before dispatch, or called back after it (the units return to the source store)
 *
 * Stock moves in only two steps (dispatch, receive), each ONE database transaction that can happen only once.
 */
const transferSchema = new Schema(
  {
    organizationId: orgField,
    reference: { type: String, required: true }, // TRF-0001 …
    fromBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    toBranchId: { type: Types.ObjectId, ref: 'Branch', required: true },
    transferDate: { type: Date, required: true },
    status: { type: String, enum: TRANSFER_STATUSES, default: 'draft' },
    notes: { type: String, trim: true, default: '', maxlength: 500 },
    expectedArrivalDate: { type: Date },
    internalRemarks: { type: String, trim: true, default: '', maxlength: 500 }, // for staff only: never printed on the transfer note
    items: { type: [itemSchema], validate: [(v) => v.length > 0 && v.length <= 100, 'A transfer needs between 1 and 100 lines'] },
    approvalRequired: { type: Boolean, default: false }, // whether approval was required when this transfer was submitted
    createdBy: { type: Types.ObjectId, ref: 'User' },
    submittedBy: { type: Types.ObjectId, ref: 'User' },
    submittedAt: Date,
    approvedBy: { type: Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    autoApproved: Boolean,
    rejectedBy: { type: Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectReason: { type: String, trim: true, maxlength: 300 },
    dispatchedBy: { type: Types.ObjectId, ref: 'User' }, // who made the FIRST dispatch
    dispatchedAt: Date, // when the first dispatch was made
    lastDispatchedAt: Date,
    dispatchSeq: { type: Number, default: 0 }, // number of dispatches so far; guards two dispatches racing on one transfer
    closedShort: Boolean, // the remaining quantities were dropped: only what was dispatched will be received
    receivedBy: { type: Types.ObjectId, ref: 'User' }, // who made the LATEST receipt
    receivedAt: Date, // when the latest receipt was made
    receiptSeq: { type: Number, default: 0 }, // number of receipts so far; guards two receipts racing on one transfer
    receiptClosed: Boolean, // the receiver said nothing more is coming
    cancelledBy: { type: Types.ObjectId, ref: 'User' },
    cancelledAt: Date,
    cancelReason: { type: String, trim: true, maxlength: 300 },
  },
  timestamps,
);

transferSchema.plugin(tenantScope);

transferSchema.pre('validate', function () {
  if (String(this.fromBranchId) === String(this.toBranchId)) this.invalidate('toBranchId', 'Choose a different destination store');
});

transferSchema.index({ organizationId: 1, reference: 1 }, { unique: true });
transferSchema.index({ organizationId: 1, createdAt: -1 });
transferSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
transferSchema.index({ organizationId: 1, transferDate: -1 }); // date-range filter
transferSchema.index({ organizationId: 1, fromBranchId: 1, createdAt: -1 });
transferSchema.index({ organizationId: 1, toBranchId: 1, createdAt: -1 });

export const Transfer = mongoose.model('Transfer', transferSchema);
