import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const CREDIT_STATUSES = ['pending', 'approved', 'rejected'];
export const CREDIT_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

/**
 * A request for credits: someone paid an amount (in rupees), uploaded a screenshot of the payment, and an administrator will decide how many credits it is
 * worth. It starts Pending. The credits that were approved are filled in by the administrator at review time (`approvedCredits`); `suggestedCredits` is only
 * what the conversion rate at the time of the request would give, so the requester can see an estimate. Nothing here moves any balance.
 * The screenshot is kept in the upload store (never served directly); the record keeps its details and a SHA-256 so the same payment proof cannot be used
 * for two live requests.
 */
const creditRequestSchema = new Schema(
  {
    organizationId: orgField,
    requestNo: { type: String, required: true }, // CR-0001 … per organization
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    userName: String,
    userEmail: String,
    amount: { type: Number, required: true, min: 0.01 }, // rupees paid, as the requester states
    rateAtRequest: { type: Number, required: true, min: 0.01 }, // rupees per credit when the request was made
    suggestedCredits: { type: Number, required: true, min: 0 }, // whole credits the requested amount would give at that rate (rounded down): an estimate, not a decision
    screenshot: {
      storageKey: { type: String, required: true },
      fileName: { type: String, required: true, maxlength: 150 },
      mimeType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
      size: { type: Number, required: true, min: 1 },
      sha256: { type: String, required: true },
    },
    status: { type: String, enum: CREDIT_STATUSES, default: 'pending' },
    approvedAmount: { type: Number, min: 0.01 }, // the payment amount the administrator approved (may differ from `amount`); the credits come from THIS
    approvedRate: { type: Number, min: 0.01 }, // rupees per credit in force when it was approved: kept so the calculation can always be repeated
    approvedCredits: { type: Number, min: 0 }, // whole credits awarded = floor(approvedAmount / approvedRate), worked out by the server
    remainderAmount: { type: Number, min: 0 }, // rupees left over after whole credits (not converted)
    reviewedBy: { type: Types.ObjectId, ref: 'User' },
    reviewedByName: String,
    reviewedAt: Date,
    remarks: { type: String, trim: true, maxlength: 300 }, // the administrator's note
    idempotencyKey: { type: String, maxlength: 100 },
    history: { type: [new Schema({ action: String, at: Date, by: Types.ObjectId, byName: String, note: String }, { _id: false })], default: [] }, // the log of what happened
  },
  timestamps,
);
creditRequestSchema.plugin(tenantScope);

creditRequestSchema.index({ organizationId: 1, requestNo: 1 }, { unique: true });
creditRequestSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
creditRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
creditRequestSchema.index({ organizationId: 1, userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }); // a repeated submission is the same request
creditRequestSchema.index({ organizationId: 1, 'screenshot.sha256': 1 }, { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }); // one payment proof, one live request

export const CreditRequest = mongoose.model('CreditRequest', creditRequestSchema);
