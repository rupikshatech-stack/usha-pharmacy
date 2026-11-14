import { posProducts } from '../services/medicine.service.js';

export async function products(req, res) {
  res.json({ success: true, data: await posProducts(req.orgId, req.query.q) });
}
