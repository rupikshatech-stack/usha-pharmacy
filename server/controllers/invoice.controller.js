import * as svc from '../services/invoice.service.js';
import { paginated } from '../utils/pagination.js';
import { withPrintBlock } from '../utils/invoicePrint.js';

export async function create(req, res) {
  const { invoice, replayed } = await svc.createInvoice(req, req.body);
  // 201 for a new invoice; 200 when an idempotent retry returns the invoice that already exists.
  // The seller's details for the printed invoice travel with it, so the till never has to ask for them (see utils/invoicePrint.js).
  res.status(replayed ? 200 : 201).set('Idempotent-Replayed', String(replayed)).json({ success: true, data: withPrintBlock(invoice, req.tenant.organization) });
}

export async function list(req, res) {
  const { items, total } = await svc.listInvoices(req.orgId, req.query);
  res.json({ success: true, data: paginated(items, { page: req.query.page, limit: req.query.limit, total }) });
}

export async function get(req, res) {
  res.json({ success: true, data: withPrintBlock(await svc.getInvoice(req.orgId, req.params.id), req.tenant.organization) });
}
