import { posProducts } from '../services/medicine.service.js';
import { posContextFor } from '../utils/invoicePrint.js';

export async function products(req, res) {
  res.json({ success: true, data: await posProducts(req.orgId, req.query.q) });
}

/**
 * What the till's preview needs from the organization before any invoice exists (the seller's state, whether the bill is
 * rounded). Open to anyone who can sell, so it does not depend on `settings:read`, which a cashier usually does not have.
 */
export async function context(req, res) {
  res.json({ success: true, data: posContextFor(req.tenant.organization) });
}
