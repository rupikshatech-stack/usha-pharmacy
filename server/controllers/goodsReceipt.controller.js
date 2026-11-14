import * as grn from '../services/purchase/goodsReceiptService.js';
import * as pi from '../services/purchase/purchaseIntegrationService.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// goods receipts (/api/goods-receipts)
export const create = async (req, res) => {
  const d = await grn.createDraft(req, req.body);
  ok(res, d, 201);
};
export const list = async (req, res) => ok(res, await grn.listGoodsReceipts(req, req.query));
export const get = async (req, res) => ok(res, await grn.getGoodsReceipt(req, req.params.id));
export const update = async (req, res) => ok(res, await grn.updateDraft(req, req.params.id, req.body));
export const confirm = async (req, res) => ok(res, await grn.confirmDraft(req, req.params.id, req.body));
export const reverse = async (req, res) => ok(res, await grn.reverse(req, req.params.id, req.body));

// purchases (/api/purchases)
export const history = async (req, res) => ok(res, await pi.purchaseHistory(req, req.params.id));

// AI Billing -> purchasing (/api/ai-billing/:id/…)
export const finalReview = async (req, res) => ok(res, await pi.finalReview(req, req.params.id));
export const verify = async (req, res) => ok(res, await pi.verifyInvoice(req, req.params.id, req.body));
export const orderOptions = async (req, res) => ok(res, await pi.purchaseOrderOptions(req, req.params.id, req.query));
export const createPurchaseOrder = async (req, res) => {
  const r = await pi.createPurchaseOrder(req, req.params.id, req.body);
  ok(res, r, r.replayed ? 200 : 201);
};
export const linkPurchaseOrder = async (req, res) => ok(res, await pi.linkPurchaseOrder(req, req.params.id, req.body));
