import { Invoice } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { branchMatch, bucketPlan, change, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';

/**
 * Customer Insights.
 *
 * WHAT A CUSTOMER IS HERE, because it decides every figure on the screen: this system has no customer record. A sale
 * carries the customer's name and phone number ON the invoice, so a customer is identified by PHONE NUMBER — the one
 * field a person keeps between visits and the one the counter actually asks for. Two visits under the same number are
 * one customer; the same name typed twice with no number is not a customer at all, it is two anonymous sales.
 *
 * Sales with no phone number are therefore NOT counted as a customer, not even as one big customer. They are summed
 * into a single "Not identified" row, marked as such, and left out of every count, every ranking and every average,
 * because a counter sale to a stranger tells you nothing about loyalty. `summary.walkIn` says how much trade that
 * was, so the share of business that is anonymous is visible rather than hidden.
 *
 * THE DEFINITIONS
 *   Total customers        Distinct phone numbers with at least one completed invoice EVER. A standing figure, not a
 *                          period one, so it carries no comparison.
 *   Active customers       Those who bought at least once in the period.
 *   New customers          Those whose FIRST EVER completed invoice falls inside the period. Looking only at the
 *                          period could not tell a new customer from a returning one.
 *   Repeat customers       Active customers with two or more invoices in the period.
 *   Customer sales         Σ invoice.total in the period from identified customers. GST-inclusive, as billed.
 *   Outstanding            Σ invoice.due as it stands NOW over all that customer's completed invoices — a balance,
 *                          not a period figure, which is what "what do they owe me" means.
 *
 * HOW IT IS COMPUTED: one aggregation. Every completed invoice of the organization (restricted to the stores the
 * person may report on) is grouped by phone number ONCE, producing a row per customer that carries both the all-time
 * figures and the period ones; the summary, the rankings, the frequency spread, the growth curve and the paged table
 * are then all `$facet` branches over those same rows. That is why the figures cannot disagree with each other, and
 * why a balance can sit beside a period figure without a second trip to the database.
 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const CUSTOMER_SORTABLE = ['spent', 'orders', 'last', 'due', 'name'];
const SORT_FIELD = { spent: 'spentPeriod', orders: 'ordersPeriod', last: 'lastPurchase', due: 'due', name: 'name' };

/** How many invoices in the period, grouped the way a shopkeeper thinks about it. */
const FREQUENCY_BANDS = [
  { key: 'once', label: 'Bought once', min: 1, max: 1 },
  { key: 'twice', label: 'Twice', min: 2, max: 2 },
  { key: 'few', label: '3 to 5 times', min: 3, max: 5 },
  { key: 'many', label: '6 to 10 times', min: 6, max: 10 },
  { key: 'regular', label: 'More than 10 times', min: 11, max: Number.MAX_SAFE_INTEGER },
];

const bandOf = (n) => FREQUENCY_BANDS.find((b) => n >= b.min && n <= b.max)?.key || null;

/** The identity of the customer on an invoice: their phone number, or nothing at all. */
const PHONE = { $trim: { input: { $ifNull: ['$customer.phone', ''] } } };

/** Whether an invoice falls inside the period being reported on. */
const inPeriod = (period) => ({ $and: [{ $gte: ['$invoiceDate', period.start] }, { $lt: ['$invoiceDate', period.end] }] });

/* ------------------------------------------------------------------ the one aggregation */

/**
 * A row per customer, carrying both their all-time figures and their figures for the period. Only completed invoices
 * count: a cancelled bill was never a purchase, so it must not make somebody look like a customer.
 */
function customerRows(period) {
  const within = inPeriod(period);
  return [
    {
      $group: {
        _id: PHONE,
        /**
         * The most recent spelling of the name wins: people correct a misspelling on the next visit. It has to be
         * `$top` sorted by the invoice date — `$last` would be whichever document the group happened to see last,
         * which is not an order at all and would make the name on screen arbitrary.
         */
        name: { $top: { output: '$customer.name', sortBy: { invoiceDate: -1 } } },
        gstin: { $top: { output: { $ifNull: ['$customer.gstin', ''] }, sortBy: { invoiceDate: -1 } } },
        ordersAll: { $sum: 1 },
        spentAll: { $sum: { $ifNull: ['$total', 0] } },
        due: { $sum: { $ifNull: ['$due', 0] } },
        firstPurchase: { $min: '$invoiceDate' },
        lastPurchase: { $max: '$invoiceDate' },
        ordersPeriod: { $sum: { $cond: [within, 1, 0] } },
        spentPeriod: { $sum: { $cond: [within, { $ifNull: ['$total', 0] }, 0] } },
        unitsPeriod: { $sum: { $cond: [within, { $sum: '$items.quantity' }, 0] } },
        duePeriod: { $sum: { $cond: [within, { $ifNull: ['$due', 0] }, 0] } },
      },
    },
    {
      $set: {
        phone: '$_id',
        identified: { $gt: [{ $strLenCP: '$_id' }, 0] },
        isNew: { $and: [{ $gte: ['$firstPurchase', period.start] }, { $lt: ['$firstPurchase', period.end] }] },
        active: { $gt: ['$ordersPeriod', 0] },
      },
    },
  ];
}

const IDENTIFIED = { $match: { identified: true } };

/** The summary: counts of customers by kind, and what they spent. Anonymous sales are summed on their own. */
const summaryFacet = () => [
  {
    $group: {
      _id: null,
      totalCustomers: { $sum: { $cond: ['$identified', 1, 0] } },
      active: { $sum: { $cond: [{ $and: ['$identified', '$active'] }, 1, 0] } },
      newCustomers: { $sum: { $cond: [{ $and: ['$identified', '$isNew'] }, 1, 0] } },
      repeat: { $sum: { $cond: [{ $and: ['$identified', { $gte: ['$ordersPeriod', 2] }] }, 1, 0] } },
      customerSales: { $sum: { $cond: ['$identified', '$spentPeriod', 0] } },
      customerOrders: { $sum: { $cond: ['$identified', '$ordersPeriod', 0] } },
      outstanding: { $sum: { $cond: ['$identified', '$due', 0] } },
      owing: { $sum: { $cond: [{ $and: ['$identified', { $gt: ['$due', 0] }] }, 1, 0] } },
      walkInSales: { $sum: { $cond: ['$identified', 0, '$spentPeriod'] } },
      walkInOrders: { $sum: { $cond: ['$identified', 0, '$ordersPeriod'] } },
      walkInDue: { $sum: { $cond: ['$identified', 0, '$due'] } },
    },
  },
];

/* ------------------------------------------------------------------ the report */

function filtersFrom(query) {
  return {
    search: query.search ? String(query.search).trim() : null,
    owing: query.owing === 'true' || query.owing === true,
    activeOnly: query.activeOnly === 'true' || query.activeOnly === true,
  };
}

/** The filters that narrow the table, applied to the grouped customer rows. */
function tableMatch(f) {
  const match = { identified: true };
  if (f.owing) match.due = { $gt: 0 };
  if (f.activeOnly) match.active = true;
  if (f.search) {
    const re = new RegExp(escapeRe(f.search), 'i');
    match.$or = [{ name: re }, { phone: re }];
  }
  return [{ $match: match }];
}

const readRow = (r) => ({
  phone: r.phone || null,
  name: r.name || 'Walk-in Customer',
  gstin: r.gstin || null,
  identified: Boolean(r.identified),
  orders: r.ordersPeriod || 0,
  spent: round2(r.spentPeriod),
  units: r.unitsPeriod || 0,
  ordersAll: r.ordersAll || 0,
  spentAll: round2(r.spentAll),
  due: round2(r.due),
  firstPurchase: r.firstPurchase || null,
  lastPurchase: r.lastPurchase || null,
  isNew: Boolean(r.isNew),
  active: Boolean(r.active),
});

/**
 * Customer Insights: who bought, how often, what they are worth and what they owe.
 *
 * `canSeeContacts` decides whether phone numbers and GSTINs are returned at all: a person who may read reports is not
 * automatically allowed to walk away with the customer list. Without that permission the figures are identical and
 * the contact details are withheld, which is the honest version of a restriction — not a quietly different report.
 */
export async function getCustomerReport(org, user, query = {}, { canSeeContacts = true } = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const plan = bucketPlan(period, tz);
  const f = filtersFrom(query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = CUSTOMER_SORTABLE.includes(query.sortBy) ? query.sortBy : 'spent';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [facet] = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', ...branchMatch(branches) } },
    ...customerRows(period),
    {
      $facet: {
        summary: summaryFacet(),
        top: [IDENTIFIED, { $match: { spentPeriod: { $gt: 0 } } }, { $sort: { spentPeriod: -1 } }, { $limit: 10 }],
        frequency: [IDENTIFIED, { $match: { ordersPeriod: { $gt: 0 } } }, { $group: { _id: '$ordersPeriod', customers: { $sum: 1 }, spent: { $sum: '$spentPeriod' } } }],
        // Growth is first-ever purchases, bucketed: it is the only honest reading of "new customers over time".
        growth: [
          IDENTIFIED,
          { $match: { isNew: true } },
          { $group: { _id: plan.truncate('$firstPurchase'), customers: { $sum: 1 }, spent: { $sum: '$spentPeriod' } } },
        ],
        rows: [...tableMatch(f), { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        total: [...tableMatch(f), { $count: 'n' }],
        walkIn: [{ $match: { identified: false } }],
      },
    },
  ]).allowDiskUse(true);

  const s = facet?.summary?.[0] || {};
  const total = facet?.total?.[0]?.n || 0;

  // The frequency spread, in bands. Every band is returned, including the empty ones, so the shape is comparable
  // between periods rather than changing which bars exist.
  const byBand = new Map(FREQUENCY_BANDS.map((b) => [b.key, { ...b, customers: 0, spent: 0 }]));
  for (const row of facet?.frequency || []) {
    const band = byBand.get(bandOf(row._id));
    if (band) {
      band.customers += row.customers;
      band.spent += row.spent;
    }
  }
  const frequency = [...byBand.values()].map(({ min, max, ...b }) => ({ ...b, spent: round2(b.spent) }));

  const growthBy = new Map((facet?.growth || []).map((r) => [plan.keyOf(r._id), r]));
  const walkIn = facet?.walkIn?.[0];

  const hide = (row) => (canSeeContacts ? row : { ...row, phone: null, gstin: null });
  const kpi = (key, label, value, prev, description, format = 'money') => ({ key, label, value, previous: prev, change: prev === null ? null : change(value, prev), description, format });

  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz },
    filters: { ...f, branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: { sortBy: CUSTOMER_SORTABLE.map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) })) },
    permissions: { contacts: canSeeContacts },
    kpis: [
      kpi('totalCustomers', 'Total customers', s.totalCustomers || 0, null, 'Distinct phone numbers that have ever bought. A standing figure, so it carries no comparison with the previous period.', 'number'),
      kpi('activeCustomers', 'Active customers', s.active || 0, null, 'Customers who bought at least once in this period.', 'number'),
      kpi('newCustomers', 'New customers', s.newCustomers || 0, null, 'Customers whose first ever purchase falls inside this period.', 'number'),
      kpi('repeatCustomers', 'Repeat customers', s.repeat || 0, null, 'Customers who bought two or more times in this period.', 'number'),
      kpi('customerSales', 'Customer sales', round2(s.customerSales), null, 'What identified customers were billed in the period, including GST. Sales with no phone number are reported separately.'),
      kpi('averageSpend', 'Average per customer', s.active ? round2((s.customerSales || 0) / s.active) : 0, null, 'Customer sales divided by the number of active customers.'),
      kpi('outstanding', 'Outstanding customer credit', round2(s.outstanding), null, `What customers still owe across all their completed invoices — a balance as it stands now, not a figure for the period. ${(s.owing || 0).toLocaleString('en-IN')} customers owe something.`),
      kpi('walkInSales', 'Sales not identified', round2(s.walkInSales), null, 'Counter sales with no phone number. They cannot be attributed to a customer, so they are excluded from every count and ranking above.'),
    ],
    summary: {
      totalCustomers: s.totalCustomers || 0,
      active: s.active || 0,
      newCustomers: s.newCustomers || 0,
      repeat: s.repeat || 0,
      repeatShare: s.active ? Math.round(((s.repeat || 0) / s.active) * 1000) / 10 : 0,
      customerSales: round2(s.customerSales),
      customerOrders: s.customerOrders || 0,
      outstanding: round2(s.outstanding),
      owing: s.owing || 0,
      walkIn: { sales: round2(s.walkInSales), orders: s.walkInOrders || 0, due: round2(s.walkInDue) },
    },
    charts: {
      topCustomers: (facet?.top || []).map((r) => hide(readRow(r))),
      frequency,
      growth: {
        bucket: plan.bucket,
        points: plan.keys.map(({ key, at }) => ({ key, at: at.toISOString(), customers: growthBy.get(key)?.customers || 0, spent: round2(growthBy.get(key)?.spent) })),
      },
    },
    walkInRow: walkIn ? readRow(walkIn) : null,
    items: (facet?.rows || []).map((r) => hide(readRow(r))),
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    notes: {
      identity: 'A customer is identified by phone number, because that is what this system records on a sale — there are no customer accounts. Two visits under one number are one customer.',
      anonymous: 'Sales with no phone number are not counted as a customer, not even collectively. They are reported on their own line so the anonymous share of trade is visible.',
      outstanding: 'Outstanding is a balance over all of that customer\'s completed invoices as they stand now, which is why it does not move when you change the period.',
      contacts: canSeeContacts ? null : 'You do not have permission to see customer contact details, so phone numbers and GSTINs are withheld. Every figure is the same.',
    },
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const columnsFor = (canSeeContacts) =>
  [
    ['Customer', (r) => r.name],
    ...(canSeeContacts ? [['Phone', (r) => r.phone || ''], ['GSTIN', (r) => r.gstin || '']] : []),
    ['Invoices in period', (r) => r.orders],
    ['Spent in period (INR)', (r) => r.spent.toFixed(2)],
    ['Units in period', (r) => r.units],
    ['Invoices all time', (r) => r.ordersAll],
    ['Spent all time (INR)', (r) => r.spentAll.toFixed(2)],
    ['First purchase', (r, tz) => (r.firstPurchase ? localDateTime(r.firstPurchase, tz) : '')],
    ['Last purchase', (r, tz) => (r.lastPurchase ? localDateTime(r.lastPurchase, tz) : '')],
    ['Outstanding now (INR)', (r) => r.due.toFixed(2)],
    ['New in period', (r) => (r.isNew ? 'Yes' : 'No')],
  ];

/** Every customer the filters match, as CSV. Contact details are withheld unless the person may see them. */
export async function exportCustomerReport(org, user, query = {}, { canSeeContacts = true } = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const f = filtersFrom(query);
  const sortBy = CUSTOMER_SORTABLE.includes(query.sortBy) ? query.sortBy : 'spent';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const rows = await Invoice.aggregate([
    { $match: { organizationId: orgId, status: 'completed', ...branchMatch(branches) } },
    ...customerRows(period),
    ...tableMatch(f),
    { $sort: { [SORT_FIELD[sortBy]]: dir, _id: dir } },
    { $limit: EXPORT_MAX_ROWS + 1 },
  ]).allowDiskUse(true);

  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} customers. Narrow the list with a search or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = rows.map(readRow).map((r) => (canSeeContacts ? r : { ...r, phone: null, gstin: null }));
  const columns = columnsFor(canSeeContacts);
  const head = exportHeader({
    title: 'Customer Insights',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['Customer identity', 'Phone number recorded on the invoice'],
      ['Contact details', canSeeContacts ? 'Included' : 'Withheld — you do not have permission to see them'],
      ['Search', f.search || '—'],
      ['Only customers who owe', f.owing ? 'Yes' : 'No'],
      ['Only customers active in the period', f.activeOnly ? 'Yes' : 'No'],
      ['Note', 'Spent figures are GST-inclusive, as billed. Outstanding is a balance as at the time of export, not a figure for the period.'],
    ],
    rows: items.length,
  });
  return {
    csv: toCsv([...head, columns.map(([h]) => h), ...items.map((r) => columns.map(([, read]) => read(r, tz)))]),
    fileName: `usha-customers-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
