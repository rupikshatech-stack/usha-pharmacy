import mongoose from 'mongoose';
import { Schema, Types, orgField, timestamps } from './shared.js';
import { tenantScope } from './plugins/tenantScope.js';

export const CREDIT_TXN_TYPES = ['CREDIT_APPROVAL', 'MANUAL_ADJUSTMENT'];
export const CREDIT_TXN_LABEL = { CREDIT_APPROVAL: 'Credits added (request approved)', MANUAL_ADJUSTMENT: 'Manual adjustment' };

/**
 * The credit ledger: one entry for every change to anyone's credit balance, with the balance before and after. It is **append-only** — the only way a balance
 * moves is by writing an entry here inside the same database transaction, so the balance on the user and the sum of the ledger can never drift apart. Nothing
 * can edit or delete an entry (the hooks below refuse), and `credits` is signed, so a future deduction is a negative entry rather than a rewritten one.
 */
class CreditTransactionImmutableError extends Error {
  constructor() {
    super('Credit ledger entries cannot be changed or deleted. Append a correcting entry instead.');
    this.name = 'CreditTransactionImmutableError';
    this.status = 409;
  }
}

const creditTransactionSchema = new Schema(
  {
    organizationId: orgField,
    txnNo: { type: String, required: true }, // CT-0001 … per organization: the transaction id people see
    userId: { type: Types.ObjectId, ref: 'User', required: true }, // whose balance moved
    userName: String,
    requestId: { type: Types.ObjectId, ref: 'CreditRequest' }, // the credit request this came from (absent for a manual adjustment)
    requestNo: String,
    type: { type: String, enum: CREDIT_TXN_TYPES, required: true },
    credits: { type: Number, required: true }, // signed: + added, - taken away
    previousBalance: { type: Number, required: true, min: 0 },
    newBalance: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, maxlength: 300 },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true }, // the administrator who caused it
    createdByName: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
creditTransactionSchema.plugin(tenantScope);

const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
creditTransactionSchema.pre(BLOCKED, function () {
  throw new CreditTransactionImmutableError();
});
creditTransactionSchema.pre('save', function () {
  if (!this.isNew) throw new CreditTransactionImmutableError();
});
creditTransactionSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new CreditTransactionImmutableError();
});

creditTransactionSchema.index({ organizationId: 1, txnNo: 1 }, { unique: true });
creditTransactionSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
creditTransactionSchema.index({ organizationId: 1, createdAt: -1 });
// one approval of a request can add credits ONCE, whatever else goes wrong
creditTransactionSchema.index({ organizationId: 1, requestId: 1, type: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'objectId' } } });

export const CreditTransaction = mongoose.model('CreditTransaction', creditTransactionSchema);
