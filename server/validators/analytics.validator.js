import { z } from 'zod';
import { LEDGER_PAYMENT_MODES, LEDGER_STATUSES, SORTABLE, TRANSACTION_TYPES } from '../services/analyticsLedger.service.js';
import { PURCHASE_LISTED_STATUSES, PURCHASE_SORTABLE } from '../services/analyticsPurchases.service.js';
import { SALES_PAYMENT_MODES, SALES_SORTABLE, SALES_STATUSES } from '../services/analyticsSales.service.js';
import { INVENTORY_EXPIRY_WINDOWS, INVENTORY_SORTABLE, INVENTORY_STOCK_STATUSES } from '../services/analyticsInventory.service.js';
import { GST_SORTABLE } from '../services/analyticsGst.service.js';
import { CUSTOMER_SORTABLE } from '../services/analyticsCustomers.service.js';
import { SUPPLIER_SORTABLE } from '../services/analyticsSuppliers.service.js';
import { BRANCH_SORTABLE } from '../services/analyticsBranches.service.js';
import { LOW_STOCK_SORTABLE, LOW_STOCK_STATUSES } from '../services/analyticsLowStock.service.js';
import { PAYMENT_STATUSES } from '../models/index.js';

const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const day = blank(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-09').refine(realDay, 'That is not a real calendar date'));
const orderedDays = (v) => !v.from || !v.to || v.from <= v.to;
const DAY_ORDER = { message: 'The start date must not be after the end date', path: ['to'] };

/**
 * Every analytics screen asks the same two things: which period and which store. Dates are calendar days in the
 * organization's own timezone and are inclusive at both ends.
 */
const periodShape = {
  from: day,
  to: day,
  branchId: blank(z.string().regex(/^[a-f0-9]{24}$/i, 'Choose a store from the list')),
};

export const analyticsQuery = z.object(periodShape).refine(orderedDays, DAY_ORDER);

/**
 * The Daily Transaction Report asks the same period and store, plus which kind of document, which status, which
 * payment method, a free-text search, how the list is sorted and which page. An unknown value is refused rather than
 * quietly ignored, so a filter can never appear to work when it does not.
 */
const transactionShape = {
  ...periodShape,
  type: blank(z.enum(TRANSACTION_TYPES)),
  status: blank(z.enum(LEDGER_STATUSES)),
  paymentMode: blank(z.enum(LEDGER_PAYMENT_MODES)),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  sortBy: blank(z.enum(SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const transactionsQuery = z
  .object({
    ...transactionShape,
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .refine(orderedDays, DAY_ORDER);

/** The export takes the same question as the list; it has no page of its own, because it carries every matching row. */
export const transactionsExportQuery = z.object(transactionShape).refine(orderedDays, DAY_ORDER);

/** An id as it comes out of a dropdown of the organization's own records. */
const objectId = (what) => blank(z.string().regex(/^[a-f0-9]{24}$/i, `Choose ${what} from the list`));
/** The page of a list, and how much of it. Both reports page in the database. */
const paging = {
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
};

/**
 * The Sales Report. Every filter is a value the data can actually hold — an unknown status or payment mode is refused
 * rather than quietly ignored, so a filter can never appear to work when it does not.
 */
const salesShape = {
  ...periodShape,
  status: blank(z.enum(SALES_STATUSES)),
  paymentMode: blank(z.enum(SALES_PAYMENT_MODES)),
  cashier: objectId('a person'),
  customer: blank(z.string().trim().max(100, 'Keep the customer search under 100 characters')),
  search: blank(z.string().trim().max(60, 'Keep the invoice number search under 60 characters')),
  sortBy: blank(z.enum(SALES_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const salesQuery = z.object({ ...salesShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const salesExportQuery = z.object(salesShape).refine(orderedDays, DAY_ORDER);

/** The Purchase Report. */
const purchaseShape = {
  ...periodShape,
  status: blank(z.enum(PURCHASE_LISTED_STATUSES)),
  paymentStatus: blank(z.enum(PAYMENT_STATUSES)),
  supplierId: objectId('a supplier'),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  sortBy: blank(z.enum(PURCHASE_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const purchasesQuery = z.object({ ...purchaseShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const purchasesExportQuery = z.object(purchaseShape).refine(orderedDays, DAY_ORDER);

/**
 * The Profitability report asks nothing but the period and the store: every figure on it follows from the same two
 * things, and a filter that only narrowed part of a profit statement would make the statement untrue.
 */
export const profitabilityQuery = z.object(periodShape).refine(orderedDays, DAY_ORDER);

/**
 * Inventory analytics. The period applies only to the movement figures — the stock position has no period — and the
 * rest narrows the stock register.
 */
const inventoryShape = {
  ...periodShape,
  categoryId: objectId('a category'),
  manufacturer: blank(z.string().trim().max(120, 'Keep the manufacturer under 120 characters')),
  stockStatus: blank(z.enum(INVENTORY_STOCK_STATUSES)),
  expiryWindow: blank(z.enum(INVENTORY_EXPIRY_WINDOWS)),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  sortBy: blank(z.enum(INVENTORY_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const inventoryQuery = z.object({ ...inventoryShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const inventoryExportQuery = z.object(inventoryShape).refine(orderedDays, DAY_ORDER);

/**
 * The GST report. A rate is a number the invoices actually carry, not free text: 0 to 100 with up to two decimals,
 * because GST rates are whole or half percentages and anything else cannot have been charged.
 */
const gstShape = {
  ...periodShape,
  rate: blank(z.coerce.number().min(0, 'A GST rate cannot be negative').max(100, 'A GST rate cannot be above 100%')),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  sortBy: blank(z.enum(GST_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const gstQuery = z.object({ ...gstShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const gstExportQuery = z.object(gstShape).refine(orderedDays, DAY_ORDER);

/** A switch in a query string: present and "true" means yes. Anything else is refused rather than read as no. */
const flag = blank(z.enum(['true', 'false']));

/** Customer Insights. The two switches narrow the table; neither changes a figure above it. */
const customerShape = {
  ...periodShape,
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  owing: flag,
  activeOnly: flag,
  sortBy: blank(z.enum(CUSTOMER_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const customersQuery = z.object({ ...customerShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const customersExportQuery = z.object(customerShape).refine(orderedDays, DAY_ORDER);

/** Supplier Performance. */
const supplierShape = {
  ...periodShape,
  supplierId: objectId('a supplier'),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  owing: flag,
  activeOnly: flag,
  sortBy: blank(z.enum(SUPPLIER_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

export const suppliersQuery = z.object({ ...supplierShape, ...paging }).refine(orderedDays, DAY_ORDER);
export const suppliersExportQuery = z.object(supplierShape).refine(orderedDays, DAY_ORDER);

/**
 * Branch performance. There is no paging: an organization has tens of stores, not thousands, and a comparison that
 * showed only some of them would not be a comparison.
 */
export const branchesQuery = z
  .object({ ...periodShape, sortBy: blank(z.enum(BRANCH_SORTABLE)), sortDir: blank(z.enum(['asc', 'desc'])) })
  .refine(orderedDays, DAY_ORDER);

/**
 * Business Insights. The period and the store are the whole question — an insight is a statement about a period, and
 * a filter that narrowed the evidence behind it would make the statement untrue. `limit` only trims the list.
 */
export const insightsQuery = z
  .object({ ...periodShape, limit: z.coerce.number().int().min(1).max(30).optional() })
  .refine(orderedDays, DAY_ORDER);

/**
 * The Low Stock Report. There is deliberately NO period here: the report is a position on the shelves right now,
 * so a date range would be accepted and then ignored, which is worse than refusing it. Only the store, the status,
 * a search and a category narrow it.
 */
const NO_PERIOD = 'The Low Stock Report has no date range: it is the stock position right now. Remove the dates — a range here would be ignored, and a figure nobody can reproduce is worse than a refusal.';
const refusesDates = {
  from: z.undefined({ error: NO_PERIOD }).optional(),
  to: z.undefined({ error: NO_PERIOD }).optional(),
  preset: z.undefined({ error: NO_PERIOD }).optional(),
};

const lowStockShape = {
  ...refusesDates,
  branchId: objectId('a store'),
  categoryId: objectId('a category'),
  status: blank(z.enum(LOW_STOCK_STATUSES)),
  search: blank(z.string().trim().max(100, 'Keep the search under 100 characters')),
  sortBy: blank(z.enum(LOW_STOCK_SORTABLE)),
  sortDir: blank(z.enum(['asc', 'desc'])),
};

/**
 * The register pages like the others, but allows a much larger page than the usual 100. The printed sheet is a
 * purchase worksheet and has to be the WHOLE list rather than page one of it, so the print path asks for one big
 * page. Beyond this ceiling the screen says so and points at the CSV, which carries everything.
 */
const lowStockPaging = {
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(10),
};

export const lowStockQuery = z.object({ ...lowStockShape, ...lowStockPaging });
export const lowStockExportQuery = z.object(lowStockShape);
