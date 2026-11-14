import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { requirePermission as can } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { analyticsQuery, branchesQuery, customersExportQuery, customersQuery, gstExportQuery, gstQuery, insightsQuery, lowStockExportQuery, lowStockQuery, inventoryExportQuery, inventoryQuery, profitabilityQuery, purchasesExportQuery, purchasesQuery, salesExportQuery, salesQuery, suppliersExportQuery, suppliersQuery, transactionsExportQuery, transactionsQuery } from '../validators/analytics.validator.js';
import { batchIdParam, expiryActionBody, expiryBatchesQuery, expiryCalendarQuery, expiryExportQuery, expiryInsightsQuery, expirySettingsBody, expirySummaryQuery } from '../validators/analyticsExpiry.validator.js';
import * as ctrl from '../controllers/analytics.controller.js';

/**
 * Business analytics (/api/analytics). Reading a report needs `reports:read` — this project's existing permission for
 * exactly this, rather than a second vocabulary. Every figure is aggregated in the database for the signed-in
 * organization only, and a person who is assigned to particular stores sees only those stores' figures.
 */
const router = Router();
router.use(...tenantGuard);

router.get('/overview', can('reports:read'), validate(analyticsQuery, 'query'), h(ctrl.overview));

/** Business Insights: what this period's figures say, as rules over the reports' own numbers. */
router.get('/insights', can('reports:read'), validate(insightsQuery, 'query'), h(ctrl.businessInsights));

// The Daily Transaction Report. `/export` is declared first so it is never read as a filter value.
router.get('/transactions/export', can('reports:read'), validate(transactionsExportQuery, 'query'), h(ctrl.transactionsExport));
router.get('/transactions', can('reports:read'), validate(transactionsQuery, 'query'), h(ctrl.transactions));

// The Sales and Purchase reports. As above, `/export` comes first so it is never read as part of a filtered path.
router.get('/sales/export', can('reports:read'), validate(salesExportQuery, 'query'), h(ctrl.salesExport));
router.get('/sales', can('reports:read'), validate(salesQuery, 'query'), h(ctrl.salesReport));
router.get('/purchases/export', can('reports:read'), validate(purchasesExportQuery, 'query'), h(ctrl.purchaseExport));
router.get('/purchases', can('reports:read'), validate(purchasesQuery, 'query'), h(ctrl.purchaseReport));

// Profitability and Inventory analytics. `/export` first, as above.
router.get('/profitability/export', can('reports:read'), validate(profitabilityQuery, 'query'), h(ctrl.profitabilityExport));
router.get('/profitability', can('reports:read'), validate(profitabilityQuery, 'query'), h(ctrl.profitability));
router.get('/inventory/export', can('reports:read'), validate(inventoryExportQuery, 'query'), h(ctrl.inventoryExport));
router.get('/inventory', can('reports:read'), validate(inventoryQuery, 'query'), h(ctrl.inventoryReport));

// The Low Stock Report. A position, not a period: it takes a store, never a date range.
router.get('/low-stock/export', can('reports:read'), validate(lowStockExportQuery, 'query'), h(ctrl.lowStockExport));
router.get('/low-stock', can('reports:read'), validate(lowStockQuery, 'query'), h(ctrl.lowStockReport));

// The GST report. An operational summary of the tax each document recorded — never a return.
router.get('/gst/export', can('reports:read'), validate(gstExportQuery, 'query'), h(ctrl.gstExport));
router.get('/gst', can('reports:read'), validate(gstQuery, 'query'), h(ctrl.gstReport));

// Customer, supplier and branch analytics. `/export` first, as everywhere above.
router.get('/customers/export', can('reports:read'), validate(customersExportQuery, 'query'), h(ctrl.customerExport));
router.get('/customers', can('reports:read'), validate(customersQuery, 'query'), h(ctrl.customerReport));
router.get('/suppliers/export', can('reports:read'), validate(suppliersExportQuery, 'query'), h(ctrl.supplierExport));
router.get('/suppliers', can('reports:read'), validate(suppliersQuery, 'query'), h(ctrl.supplierReport));
router.get('/branches/export', can('reports:read'), validate(branchesQuery, 'query'), h(ctrl.branchExport));
router.get('/branches', can('reports:read'), validate(branchesQuery, 'query'), h(ctrl.branchComparison));

/**
 * Inventory Expiry Intelligence. Reading it is a report like any other (`reports:read`), scoped to the organization and
 * to the stores the person is assigned to. The actions it offers move stock and so live behind their own permissions;
 * they are added in the next part of this module.
 */
router.get('/expiry/summary', can('reports:read'), validate(expirySummaryQuery, 'query'), h(ctrl.expirySummary));
router.get('/expiry/insights', can('reports:read'), validate(expiryInsightsQuery, 'query'), h(ctrl.expiryInsights));
router.get('/expiry/calendar', can('reports:read'), validate(expiryCalendarQuery, 'query'), h(ctrl.expiryCalendar));
// `/export` is declared before the register so it is never read as a filter value on it.
router.get('/expiry/export', can('reports:read'), validate(expiryExportQuery, 'query'), h(ctrl.expiryExport));
router.get('/expiry/batches', can('reports:read'), validate(expiryBatchesQuery, 'query'), h(ctrl.expiryBatches));
router.get('/expiry/batches/:id', can('reports:read'), validate(batchIdParam, 'params'), h(ctrl.expiryBatchDetail));
router.get('/expiry/batches/:id/transfer-suggestion', can('reports:read'), validate(batchIdParam, 'params'), h(ctrl.expiryTransferSuggestion));

/**
 * The actions. `inventory:write` is the floor for all of them; writing stock off additionally needs
 * `inventory:delete`, which the service checks — reading a report and destroying stock are not the same privilege.
 */
router.post('/expiry/actions', can('inventory:write'), validate(expiryActionBody), h(ctrl.expiryAction));

/** The thresholds every figure on the screen depends on. Changing settings is its own privilege. */
router.put('/expiry/settings', can('settings:manage'), validate(expirySettingsBody), h(ctrl.expirySettingsUpdate));

export default router;
