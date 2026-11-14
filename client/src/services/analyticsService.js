import { api } from './api';

/**
 * Business analytics. Every figure is worked out by the server from the records the rest of the system keeps; this
 * module only asks the questions. The export comes back as CSV text inside the usual envelope (as the inventory
 * import template does), so the browser's own session applies and the file is saved without a second request.
 */
export const analyticsService = {
  overview: (params) => api.get('/analytics/overview', { params }),
  insights: (params) => api.get('/analytics/insights', { params }),
  transactions: (params) => api.get('/analytics/transactions', { params }),
  exportTransactions: (params) => api.get('/analytics/transactions/export', { params }),
  sales: (params) => api.get('/analytics/sales', { params }),
  exportSales: (params) => api.get('/analytics/sales/export', { params }),
  purchases: (params) => api.get('/analytics/purchases', { params }),
  exportPurchases: (params) => api.get('/analytics/purchases/export', { params }),
  profitability: (params) => api.get('/analytics/profitability', { params }),
  exportProfitability: (params) => api.get('/analytics/profitability/export', { params }),
  inventory: (params) => api.get('/analytics/inventory', { params }),
  exportInventory: (params) => api.get('/analytics/inventory/export', { params }),
  gst: (params) => api.get('/analytics/gst', { params }),
  exportGst: (params) => api.get('/analytics/gst/export', { params }),
  customers: (params) => api.get('/analytics/customers', { params }),
  exportCustomers: (params) => api.get('/analytics/customers/export', { params }),
  suppliers: (params) => api.get('/analytics/suppliers', { params }),
  exportSuppliers: (params) => api.get('/analytics/suppliers/export', { params }),
  branches: (params) => api.get('/analytics/branches', { params }),
  exportBranches: (params) => api.get('/analytics/branches/export', { params }),
  lowStock: (params) => api.get('/analytics/low-stock', { params }),
  exportLowStock: (params) => api.get('/analytics/low-stock/export', { params }),

  // Inventory Expiry Intelligence. The summary and the register are the same question asked two ways, so they always
  // take the same store and the same filters.
  expirySummary: (params) => api.get('/analytics/expiry/summary', { params }),
  expiryBatches: (params) => api.get('/analytics/expiry/batches', { params }),
  expiryBatch: (id) => api.get(`/analytics/expiry/batches/${id}`),
  expiryTransferSuggestion: (id) => api.get(`/analytics/expiry/batches/${id}/transfer-suggestion`),
  expiryInsights: (params) => api.get('/analytics/expiry/insights', { params }),
  expiryCalendar: (params) => api.get('/analytics/expiry/calendar', { params }),
  /** The register as CSV text inside the usual envelope, so the browser's own session applies. */
  exportExpiry: (params) => api.get('/analytics/expiry/export', { params }),
  /** Dispose, flag for clearance, or open and close a supplier return — over one lot or many. */
  expiryAction: (body) => api.post('/analytics/expiry/actions', body),
  /** The organization's thresholds. Changing them changes every figure on the screen. */
  updateExpirySettings: (body) => api.put('/analytics/expiry/settings', body),
};
