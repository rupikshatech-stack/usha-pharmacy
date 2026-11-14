import * as svc from '../services/analytics.service.js';
import * as ledger from '../services/analyticsLedger.service.js';
import * as sales from '../services/analyticsSales.service.js';
import * as purchases from '../services/analyticsPurchases.service.js';
import * as profit from '../services/analyticsProfit.service.js';
import * as inventory from '../services/analyticsInventory.service.js';
import * as gst from '../services/analyticsGst.service.js';
import * as customers from '../services/analyticsCustomers.service.js';
import * as suppliers from '../services/analyticsSuppliers.service.js';
import * as branchReport from '../services/analyticsBranches.service.js';
import * as insights from '../services/analyticsInsights.service.js';
import * as lowStock from '../services/analyticsLowStock.service.js';
import { hasPermission } from '../config/permissions.js';
import * as expiry from '../services/analyticsExpiry.service.js';
import * as expiryActions from '../services/expiryActions.service.js';
import * as expiryReports from '../services/expiryReports.service.js';

const ok = (res, data) => res.json({ success: true, data });

/** The analytics overview: headline figures, the same figures for the previous period, the revenue series and the transaction mix. */
export const overview = async (req, res) => ok(res, await svc.getOverview(req.tenant.organization, req.user, req.query));

/** One page of the Daily Transaction Report, with the summary for the whole filtered set. */
export const transactions = async (req, res) => ok(res, await ledger.getTransactions(req.tenant.organization, req.user, req.query));

/**
 * The same report as a CSV file. The file travels as text inside the usual envelope (as the inventory import template
 * does) so the browser's own session and CSRF handling apply and the client saves it without a second request.
 */
export const transactionsExport = async (req, res) => ok(res, await ledger.exportTransactions(req.tenant.organization, req.user, req.query));

/** The Sales Report: one page of invoices, the figures for the whole filtered set, and the cuts behind the charts. */
export const salesReport = async (req, res) => ok(res, await sales.getSalesReport(req.tenant.organization, req.user, req.query));

/** The Sales Report as a CSV file, carrying every invoice the filters match rather than the page on screen. */
export const salesExport = async (req, res) => ok(res, await sales.exportSalesReport(req.tenant.organization, req.user, req.query));

/** The Purchase Report: one page of supplier orders, with its figures and cuts. */
export const purchaseReport = async (req, res) => ok(res, await purchases.getPurchaseReport(req.tenant.organization, req.user, req.query));

/** The Purchase Report as a CSV file, carrying every order the filters match. */
export const purchaseExport = async (req, res) => ok(res, await purchases.exportPurchaseReport(req.tenant.organization, req.user, req.query));

/* ------------------------------------------------------------------ Inventory Expiry Intelligence */

/** The figures above the register: what is expired or expiring, what it is worth, and what is likely to be lost. */
export const expirySummary = async (req, res) => ok(res, await expiry.getExpirySummary(req.tenant.organization, req.user, req.query));

/** One page of the Risk Inventory Register, with the totals for the whole filtered set and any group subtotals. */
export const expiryBatches = async (req, res) => ok(res, await expiry.getExpiryBatches(req.tenant.organization, req.user, req.query));

/** Everything behind one row of the register: the lot, how it has sold, its stock ledger and its audit trail. */
export const expiryBatchDetail = async (req, res) => ok(res, await expiryActions.getBatchDetail(req.tenant.organization, req.user, req.params.id));

/** Which store would be most likely to sell this lot in time. Advice only — nothing is moved. */
export const expiryTransferSuggestion = async (req, res) => ok(res, await expiryActions.transferSuggestion(req.tenant.organization, req.user, req.params.id));

/** Dispose, flag for clearance, or open and close a supplier return — over one lot or many. */
export const expiryAction = async (req, res) => ok(res, await expiryActions.runExpiryAction(req, req.body));

/** The charts beside the register: the wave by month, who the money sits with, and what was really written off. */
export const expiryInsights = async (req, res) => ok(res, await expiryReports.getExpiryInsights(req.tenant.organization, req.user, req.query));

/** One month of expiries, day by day, for the heatmap. */
export const expiryCalendar = async (req, res) => ok(res, await expiryReports.getExpiryCalendar(req.tenant.organization, req.user, req.query));

/** The register as a CSV file, carrying every lot the filters match rather than the page on screen. */
export const expiryExport = async (req, res) => ok(res, await expiryReports.exportExpiryRegister(req.tenant.organization, req.user, req.query));

/** The organization's own expiry thresholds. Changing them changes every figure on the screen, so it is audited. */
export const expirySettingsUpdate = async (req, res) => ok(res, await expiryReports.updateExpirySettings(req, req.body));

/** The Profitability report: the trading statement for the period, and where the margin comes from. */
export const profitability = async (req, res) => ok(res, await profit.getProfitabilityReport(req.tenant.organization, req.user, req.query));

/** Every medicine sold in the period with its own margin, as a CSV file. */
export const profitabilityExport = async (req, res) => ok(res, await profit.exportProfitabilityReport(req.tenant.organization, req.user, req.query));

/** Inventory analytics: the stock position now, movement over the period, and one page of the stock register. */
export const inventoryReport = async (req, res) => ok(res, await inventory.getInventoryReport(req.tenant.organization, req.user, req.query));

/** The whole stock register the filters match, as a CSV file. */
export const inventoryExport = async (req, res) => ok(res, await inventory.exportInventoryReport(req.tenant.organization, req.user, req.query));

/** The GST report: tax charged, tax paid, what the returns adjust, and the net position. */
export const gstReport = async (req, res) => ok(res, await gst.getGstReport(req.tenant.organization, req.user, req.query));

/** The same report as a CSV file, with the summary, the rate breakdown and the HSN summary in its heading. */
export const gstExport = async (req, res) => ok(res, await gst.exportGstReport(req.tenant.organization, req.user, req.query));

/**
 * Customer Insights. Contact details are only returned to somebody who may already read the invoices those details
 * come from (`billing:read`) — the report is otherwise identical, rather than quietly different.
 */
const contactScope = (req) => ({ canSeeContacts: hasPermission(req.user, 'billing:read') });

export const customerReport = async (req, res) => ok(res, await customers.getCustomerReport(req.tenant.organization, req.user, req.query, contactScope(req)));
export const customerExport = async (req, res) => ok(res, await customers.exportCustomerReport(req.tenant.organization, req.user, req.query, contactScope(req)));

/** Supplier Performance: who the stock comes from, what comes back, and what is still owed. */
export const supplierReport = async (req, res) => ok(res, await suppliers.getSupplierReport(req.tenant.organization, req.user, req.query));
export const supplierExport = async (req, res) => ok(res, await suppliers.exportSupplierReport(req.tenant.organization, req.user, req.query));

/** Branch performance: every store the person may report on, side by side. */
export const branchComparison = async (req, res) => ok(res, await branchReport.getBranchReport(req.tenant.organization, req.user, req.query));
export const branchExport = async (req, res) => ok(res, await branchReport.exportBranchReport(req.tenant.organization, req.user, req.query));

/** Business Insights: deterministic rules over the same figures the reports show, most serious first. */
export const businessInsights = async (req, res) => ok(res, await insights.getInsights(req.tenant.organization, req.user, req.query));

/** The Low Stock Report: what to order now. A position, so it takes a store rather than a period. */
export const lowStockReport = async (req, res) => ok(res, await lowStock.getLowStockReport(req.tenant.organization, req.user, req.query));
export const lowStockExport = async (req, res) => ok(res, await lowStock.exportLowStockReport(req.tenant.organization, req.user, req.query));
