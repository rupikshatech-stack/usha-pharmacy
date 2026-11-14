import { getStore } from '../../utils/tenantContext.js';

export class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantScopeError';
    this.status = 500; // a programming error, never a client mistake
    this.code = 'TENANT_SCOPE';
  }
}

const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
];
const UPDATE_OPS = new Set(['findOneAndUpdate', 'findOneAndReplace', 'updateOne', 'updateMany', 'replaceOne']);

/**
 * Defense-in-depth tenant isolation for Mongoose models that carry `organizationId`.
 *
 * Inside a tenant context (set by the requireTenant middleware) the plugin FORCES every
 *   - query (find/update/delete/count/distinct) to include { organizationId: <current tenant> }
 *   - aggregate() to start with { $match: { organizationId } }
 *   - new document to belong to the current tenant, and refuses documents for another tenant
 *   - update to leave organizationId alone
 * A query that explicitly names a DIFFERENT organizationId throws, so mistakes are loud.
 *
 * Options:
 *   strict (default true): with no tenant context at all, throw instead of running unscoped.
 *     Identity collections (User, Session) use strict:false because logging in necessarily looks
 *     users up before any tenant is known; they are still fully scoped whenever a tenant is active.
 *
 * Not covered: insertMany, bulkWrite and raw $lookup targets — don't use them on tenant data
 * without setting organizationId explicitly (the tests cover the supported paths).
 */
export function tenantScope(schema, { strict = true } = {}) {
  /** -> { orgId } to enforce, or null to skip (explicit bypass / lenient with no context). */
  const resolve = (what) => {
    const s = getStore();
    if (s?.bypass) return null;
    if (s?.organizationId) return { orgId: s.organizationId };
    if (!strict) return null;
    throw new TenantScopeError(`Tenant context missing for ${what}. Run inside requireTenant/runWithTenant, or unscoped() if this is intentionally cross-tenant.`);
  };

  schema.pre(QUERY_OPS, function () {
    const ctx = resolve(`${this.model.modelName}.${this.op}`);
    if (!ctx) return;

    const filter = this.getFilter();
    if (filter.organizationId !== undefined && String(filter.organizationId) !== ctx.orgId) {
      throw new TenantScopeError(`${this.model.modelName}.${this.op} asked for another organization's data`);
    }
    this.where({ organizationId: ctx.orgId });

    if (UPDATE_OPS.has(this.op)) {
      const update = this.getUpdate();
      if (update) {
        for (const target of [update, update.$set, update.$setOnInsert]) {
          if (target && 'organizationId' in target) {
            if (String(target.organizationId) !== ctx.orgId) throw new TenantScopeError('organizationId cannot be changed');
            delete target.organizationId;
          }
        }
      }
    }
  });

  schema.pre('aggregate', function () {
    const Model = this.model();
    const ctx = resolve(`${Model.modelName}.aggregate`);
    if (!ctx) return;
    // Aggregation does not cast ids for us, so cast the tenant id to a real ObjectId.
    const oid = Model.schema.path('organizationId').cast(ctx.orgId);
    this.pipeline().unshift({ $match: { organizationId: oid } });
  });

  schema.pre('validate', function () {
    const ctx = resolve(`${this.constructor.modelName} save`);
    if (!ctx) return;
    if (this.isNew) {
      if (!this.organizationId) this.organizationId = ctx.orgId;
      else if (String(this.organizationId) !== ctx.orgId) throw new TenantScopeError('Cannot create a document for another organization');
    } else if (this.isModified('organizationId') || String(this.organizationId) !== ctx.orgId) {
      throw new TenantScopeError('Cannot modify a document of another organization');
    }
  });
}
