import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The "current tenant" for whatever code is running, carried through async calls.
 * It is set ONLY by the server (the requireTenant middleware, from the authenticated user's
 * database record) — never from request input.
 */
const als = new AsyncLocalStorage();

// Mongoose queries are lazy: `Model.find()` does nothing until awaited. Awaiting the callback's result
// INSIDE the context guarantees a query returned from fn() runs while the tenant is still set.
const inside = (store, fn) =>
  als.run(store, async () => {
    return await fn();
  });

/** Run fn with `organizationId` as the current tenant. Always returns a Promise. */
export const runWithTenant = (organizationId, fn) => inside({ organizationId: String(organizationId) }, fn);

/**
 * Run fn with tenant scoping switched OFF. Use only for the few places that legitimately work across
 * tenants (e.g. a platform script). Greppable on purpose: every use should be justified in review.
 */
export const unscoped = (fn) => inside({ bypass: true }, fn);

export const currentTenantId = () => als.getStore()?.organizationId || null;
export const isUnscoped = () => als.getStore()?.bypass === true;
export const getStore = () => als.getStore();

/** Express-style helper: continue the request inside the tenant context (synchronously, so `next()` runs inside it). */
export const enterTenant = (organizationId, next) => als.run({ organizationId: String(organizationId) }, () => next());
