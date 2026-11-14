import mongoose from 'mongoose';
import { Branch, GoodsReceiptReversal, Invoice, Medicine, Order, SalesReturn } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { exportHeader, fileStamp, localDateTime, toCsv } from '../utils/csv.js';
import { orgTimezone } from './organization.service.js';
import { ACCEPTED_RETURNS, PURCHASE_STATUSES, branchMatch, reportableBranches, resolvePeriod, round2 } from './analytics.service.js';
import { storeLabel } from './analyticsSales.service.js';

/**
 * The GST report: the tax the business CHARGED, the tax it PAID, and what that leaves — read from the tax figures the
 * documents themselves recorded, never recalculated from today's rates.
 *
 * WHERE EVERY FIGURE COMES FROM
 *
 *   Output tax (sales)        The per-line snapshots on completed invoices: `items.taxableAmount`, `items.cgst`,
 *                             `items.sgst`, `items.igst`, `items.taxAmount`, grouped by the line's own
 *                             `items.gstPercent`. Retail prices here are GST-INCLUSIVE, so the tax was split out of
 *                             the price when the bill was made (see utils/billMath.js) and this report only adds up
 *                             what was stored. A cancelled or reversed invoice charged nobody any tax and is excluded.
 *   Sales return adjustment   Returns carry NO tax breakdown of their own, so this one figure is DERIVED, and the
 *                             response says so: the refund value of each returned line is tax-inclusive, and the rate
 *                             comes from the original invoice line it is returned against —
 *                               tax = amount × rate ÷ (100 + rate)
 *                             split CGST/SGST or IGST exactly as the original invoice was. Nothing is assumed about
 *                             the rate: a line whose invoice line cannot be found is reported at rate 0 and counted
 *                             in `notes.unmatchedReturnLines` rather than guessed at.
 *   Input tax (purchases)     `items.gstAmount` on orders actually placed, grouped by the line's `gstPercent`, plus
 *                             GST charged on shipping and other charges (`charges.gstAmount`), which is shown as its
 *                             own row because it belongs to no product rate. Orders do NOT record a CGST/SGST split —
 *                             there is no inter-state flag on a purchase — so input tax is a single figure and
 *                             `notes.inputSplit` says why.
 *   Purchase return adj.      A reversed goods receipt, valued as the Daily Transaction Report values it (units
 *                             removed × the unit cost on the order line), with that line's own rate split back out.
 *   Net tax position          (output tax − sales return adjustment) − (input tax − purchase return adjustment).
 *
 * ROUNDING: an invoice's `roundOff` is not tax. Σ taxable + Σ tax is the payable before rounding; the summary reports
 * `roundOff` on its own so the figures reconcile against the invoice totals rather than appearing a rupee out.
 *
 * HSN: invoice lines do not snapshot an HSN code, so the HSN summary joins to the catalogue and therefore reflects
 * the HSN code recorded on each medicine NOW. `notes.hsnSource` states this; a medicine with no code is grouped under
 * "Not recorded" rather than dropped.
 *
 * THIS IS AN OPERATIONAL SUMMARY, not a return. It says so on screen and in every export: reconcile it against the
 * accounting records before filing anything.
 */
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const GST_SORTABLE = ['date', 'invoiceNo', 'taxable', 'tax', 'total'];
const SORT_FIELD = { date: 'invoiceDate', invoiceNo: 'invoiceNo', taxable: 'taxableAmount', tax: 'taxTotal', total: 'total' };

/** The tax inside a GST-inclusive amount, to two decimals. */
const taxOfInclusive = (amount, rate) => ({
  $round: [{ $cond: [{ $gt: [rate, 0] }, { $divide: [{ $multiply: [amount, rate] }, { $add: [100, rate] }] }, 0] }, 2],
});

function filtersFrom(query) {
  return {
    rate: query.rate === undefined || query.rate === '' ? null : Number(query.rate),
    search: query.search ? String(query.search).trim() : null,
  };
}

const salesMatch = (orgId, period, branches) => ({
  organizationId: orgId,
  status: 'completed',
  invoiceDate: { $gte: period.start, $lt: period.end },
  ...branchMatch(branches),
});

/* ------------------------------------------------------------------ output tax */

/**
 * The tax charged on sales, by rate, from the line snapshots. Also returns the invoice-level totals and the
 * inter-state split, so the summary reconciles against the invoices themselves.
 */
async function outputTax(orgId, period, branches, f) {
  const [facet] = await Invoice.aggregate([
    { $match: salesMatch(orgId, period, branches) },
    {
      $facet: {
        invoiceTotals: [
          {
            $group: {
              _id: null,
              invoices: { $sum: 1 },
              taxable: { $sum: { $ifNull: ['$taxableAmount', 0] } },
              cgst: { $sum: { $ifNull: ['$cgstTotal', 0] } },
              sgst: { $sum: { $ifNull: ['$sgstTotal', 0] } },
              igst: { $sum: { $ifNull: ['$igstTotal', 0] } },
              tax: { $sum: { $ifNull: ['$taxTotal', 0] } },
              roundOff: { $sum: { $ifNull: ['$roundOff', 0] } },
              total: { $sum: { $ifNull: ['$total', 0] } },
              interStateInvoices: { $sum: { $cond: ['$interState', 1, 0] } },
              withGstin: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$customer.gstin', ''] } }, 0] }, 1, 0] } },
            },
          },
        ],
        byRate: [
          { $unwind: '$items' },
          ...(f.rate === null ? [] : [{ $match: { 'items.gstPercent': f.rate } }]),
          {
            $group: {
              _id: { $ifNull: ['$items.gstPercent', 0] },
              taxable: { $sum: { $ifNull: ['$items.taxableAmount', 0] } },
              cgst: { $sum: { $ifNull: ['$items.cgst', 0] } },
              sgst: { $sum: { $ifNull: ['$items.sgst', 0] } },
              igst: { $sum: { $ifNull: ['$items.igst', 0] } },
              tax: { $sum: { $ifNull: ['$items.taxAmount', 0] } },
              lines: { $sum: 1 },
              units: { $sum: { $ifNull: ['$items.quantity', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]).allowDiskUse(true);

  const t = facet?.invoiceTotals?.[0];
  return {
    totals: {
      invoices: t?.invoices || 0,
      taxable: round2(t?.taxable),
      cgst: round2(t?.cgst),
      sgst: round2(t?.sgst),
      igst: round2(t?.igst),
      tax: round2(t?.tax),
      roundOff: round2(t?.roundOff),
      total: round2(t?.total),
      interStateInvoices: t?.interStateInvoices || 0,
      withGstin: t?.withGstin || 0,
    },
    byRate: (facet?.byRate || []).map((r) => ({
      rate: r._id,
      taxable: round2(r.taxable),
      cgst: round2(r.cgst),
      sgst: round2(r.sgst),
      igst: round2(r.igst),
      tax: round2(r.tax),
      lines: r.lines,
      units: r.units,
    })),
  };
}

/** The HSN-wise summary. The code comes from the catalogue, because invoice lines do not snapshot it. */
async function hsnSummary(orgId, period, branches, f, limit = 100) {
  const rows = await Invoice.aggregate([
    { $match: salesMatch(orgId, period, branches) },
    { $unwind: '$items' },
    ...(f.rate === null ? [] : [{ $match: { 'items.gstPercent': f.rate } }]),
    { $lookup: { from: 'medicines', localField: 'items.medicineId', foreignField: '_id', as: '_m', pipeline: [{ $project: { hsnCode: 1, unit: 1 } }] } },
    { $set: { _m: { $first: '$_m' } } },
    {
      $group: {
        _id: { hsn: { $ifNull: ['$_m.hsnCode', ''] }, rate: { $ifNull: ['$items.gstPercent', 0] } },
        unit: { $first: { $ifNull: ['$_m.unit', ''] } },
        units: { $sum: { $ifNull: ['$items.quantity', 0] } },
        taxable: { $sum: { $ifNull: ['$items.taxableAmount', 0] } },
        cgst: { $sum: { $ifNull: ['$items.cgst', 0] } },
        sgst: { $sum: { $ifNull: ['$items.sgst', 0] } },
        igst: { $sum: { $ifNull: ['$items.igst', 0] } },
        tax: { $sum: { $ifNull: ['$items.taxAmount', 0] } },
      },
    },
    { $sort: { taxable: -1 } },
    { $limit: limit },
  ]).allowDiskUse(true);

  return rows.map((r) => ({
    hsn: r._id.hsn || null,
    hsnLabel: r._id.hsn || 'Not recorded',
    rate: r._id.rate,
    unit: r.unit,
    units: r.units,
    taxable: round2(r.taxable),
    cgst: round2(r.cgst),
    sgst: round2(r.sgst),
    igst: round2(r.igst),
    tax: round2(r.tax),
  }));
}

/* ------------------------------------------------------------------ the sales return adjustment */

/**
 * What the returns take back out of the output tax. Derived, because a return records no tax of its own: the rate is
 * read off the invoice line the units are returned against, and the tax split out of the tax-inclusive refund value.
 */
async function salesReturnTax(orgId, period, branches, f) {
  const RATE = { $ifNull: ['$_line.gstPercent', 0] };
  const rows = await SalesReturn.aggregate([
    { $match: { organizationId: orgId, status: { $in: ACCEPTED_RETURNS }, returnDate: { $gte: period.start, $lt: period.end } } },
    {
      $lookup: {
        from: 'invoices',
        localField: 'invoiceId',
        foreignField: '_id',
        as: '_inv',
        pipeline: [{ $project: { branchId: 1, interState: 1, 'items.medicineId': 1, 'items.batchId': 1, 'items.gstPercent': 1 } }],
      },
    },
    { $set: { _inv: { $first: '$_inv' } } },
    ...(branches ? [{ $match: { '_inv.branchId': { $in: branches } } }] : []),
    { $unwind: '$items' },
    {
      $set: {
        _line: {
          $first: {
            $filter: {
              input: { $ifNull: ['$_inv.items', []] },
              as: 'it',
              cond: { $and: [{ $eq: ['$$it.medicineId', '$items.medicineId'] }, { $eq: ['$$it.batchId', '$items.batchId'] }] },
            },
          },
        },
      },
    },
    ...(f.rate === null ? [] : [{ $match: { '_line.gstPercent': f.rate } }]),
    { $set: { _rate: RATE, _tax: taxOfInclusive({ $ifNull: ['$items.amount', 0] }, RATE) } },
    {
      $group: {
        _id: '$_rate',
        value: { $sum: { $ifNull: ['$items.amount', 0] } },
        tax: { $sum: '$_tax' },
        cgst: { $sum: { $cond: ['$_inv.interState', 0, { $divide: ['$_tax', 2] }] } },
        igst: { $sum: { $cond: ['$_inv.interState', '$_tax', 0] } },
        lines: { $sum: 1 },
        units: { $sum: { $ifNull: ['$items.quantity', 0] } },
        // `$first` of an empty match is null, and a return against a deleted invoice has no `_line` at all.
        unmatched: { $sum: { $cond: [{ $in: [{ $type: '$_line' }, ['missing', 'null']] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).allowDiskUse(true);

  const byRate = rows.map((r) => ({
    rate: r._id,
    value: round2(r.value),
    taxable: round2(r.value - r.tax),
    cgst: round2(r.cgst),
    sgst: round2(r.cgst), // the two halves are equal by construction; the odd paisa stays with the original invoice
    igst: round2(r.igst),
    tax: round2(r.tax),
    lines: r.lines,
    units: r.units,
  }));
  const sum = (k) => round2(byRate.reduce((n, r) => n + r[k], 0));
  return {
    byRate,
    totals: { value: sum('value'), taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), tax: sum('tax') },
    unmatchedLines: rows.reduce((n, r) => n + (r.unmatched || 0), 0),
  };
}

/* ------------------------------------------------------------------ input tax */

/** The GST on what was bought, by rate, plus the GST charged on shipping and other charges. */
async function inputTax(orgId, period, branches, f) {
  const match = { organizationId: orgId, status: { $in: PURCHASE_STATUSES }, orderDate: { $gte: period.start, $lt: period.end }, ...branchMatch(branches) };
  const [facet] = await Order.aggregate([
    { $match: match },
    {
      $facet: {
        orderTotals: [
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              taxable: { $sum: { $subtract: [{ $ifNull: ['$subtotal', 0] }, { $ifNull: ['$discountTotal', 0] }] } },
              tax: { $sum: { $add: [{ $ifNull: ['$gstTotal', 0] }, { $ifNull: ['$charges.gstAmount', 0] }] } },
              chargesTax: { $sum: { $ifNull: ['$charges.gstAmount', 0] } },
              total: { $sum: { $ifNull: ['$grandTotal', 0] } },
            },
          },
        ],
        byRate: [
          { $unwind: '$items' },
          ...(f.rate === null ? [] : [{ $match: { 'items.gstPercent': f.rate } }]),
          {
            $group: {
              _id: { $ifNull: ['$items.gstPercent', 0] },
              taxable: { $sum: { $subtract: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$items.discountAmount', 0] }] } },
              tax: { $sum: { $ifNull: ['$items.gstAmount', 0] } },
              lines: { $sum: 1 },
              units: { $sum: { $ifNull: ['$items.quantity', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]).allowDiskUse(true);

  const t = facet?.orderTotals?.[0];
  return {
    totals: {
      orders: t?.orders || 0,
      taxable: round2(t?.taxable),
      tax: round2(t?.tax),
      chargesTax: round2(t?.chargesTax),
      total: round2(t?.total),
    },
    byRate: (facet?.byRate || []).map((r) => ({ rate: r._id, taxable: round2(r.taxable), tax: round2(r.tax), lines: r.lines, units: r.units })),
  };
}

/**
 * The tax inside a reversed goods receipt. The value is the one the Daily Transaction Report uses — units removed at
 * the unit cost on the order line — and the rate is that same line's, split back out of it.
 */
const reversalTax = () => ({
  $round: [
    {
      $reduce: {
        input: { $ifNull: ['$lines', []] },
        initialValue: { value: 0, tax: 0 },
        in: {
          $let: {
            vars: {
              item: { $first: { $filter: { input: { $ifNull: ['$_ord.items', []] }, as: 'it', cond: { $eq: ['$$it.medicineId', '$$this.medicineId'] } } } },
            },
            in: {
              $let: {
                vars: {
                  lineValue: {
                    $multiply: [
                      { $ifNull: ['$$this.paid', { $ifNull: ['$$this.quantity', 0] }] },
                      { $cond: [{ $gt: [{ $ifNull: ['$$item.quantity', 0] }, 0] }, { $divide: [{ $ifNull: ['$$item.total', 0] }, '$$item.quantity'] }, 0] },
                    ],
                  },
                  rate: { $ifNull: ['$$item.gstPercent', 0] },
                },
                in: {
                  value: { $add: ['$$value.value', '$$lineValue'] },
                  tax: {
                    $add: [
                      '$$value.tax',
                      { $cond: [{ $gt: ['$$rate', 0] }, { $divide: [{ $multiply: ['$$lineValue', '$$rate'] }, { $add: [100, '$$rate'] }] }, 0] },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    2,
  ],
});

/** What reversed deliveries take back out of the input tax. */
async function purchaseReturnTax(orgId, period, branches) {
  const [r] = await GoodsReceiptReversal.aggregate([
    { $match: { organizationId: orgId, reversedAt: { $gte: period.start, $lt: period.end } } },
    {
      $lookup: {
        from: 'orders',
        localField: 'orderId',
        foreignField: '_id',
        as: '_ord',
        pipeline: [{ $project: { branchId: 1, 'items.medicineId': 1, 'items.quantity': 1, 'items.total': 1, 'items.gstPercent': 1 } }],
      },
    },
    { $set: { _ord: { $first: '$_ord' } } },
    ...(branches ? [{ $match: { '_ord.branchId': { $in: branches } } }] : []),
    { $set: { _r: reversalTax() } },
    { $group: { _id: null, value: { $sum: '$_r.value' }, tax: { $sum: '$_r.tax' }, count: { $sum: 1 } } },
  ]).allowDiskUse(true);
  const value = round2(r?.value);
  const tax = round2(r?.tax);
  return { value, tax, taxable: round2(value - tax), count: r?.count || 0 };
}

/* ------------------------------------------------------------------ the invoice-level detail */

const INVOICE_ROW = {
  $project: {
    _id: 0,
    id: '$_id',
    invoiceNo: 1,
    date: '$invoiceDate',
    customerName: { $ifNull: ['$customer.name', 'Walk-in Customer'] },
    customerGstin: { $ifNull: ['$customer.gstin', ''] },
    branchId: 1,
    branchName: 1,
    interState: { $ifNull: ['$interState', false] },
    taxable: { $ifNull: ['$taxableAmount', 0] },
    cgst: { $ifNull: ['$cgstTotal', 0] },
    sgst: { $ifNull: ['$sgstTotal', 0] },
    igst: { $ifNull: ['$igstTotal', 0] },
    tax: { $ifNull: ['$taxTotal', 0] },
    roundOff: { $ifNull: ['$roundOff', 0] },
    total: { $ifNull: ['$total', 0] },
    rates: { $setUnion: [{ $ifNull: ['$items.gstPercent', []] }, []] },
  },
};

/** One page of invoices with their tax, for the detail table and the export. */
async function invoiceDetail(orgId, period, branches, f, { sortBy, dir, page, limit, rowsOnly = false, maxRows = 0 }) {
  const match = { ...salesMatch(orgId, period, branches) };
  if (f.rate !== null) match['items.gstPercent'] = f.rate;
  if (f.search) {
    const re = new RegExp(escapeRe(f.search), 'i');
    match.$or = [{ invoiceNo: re }, { 'customer.gstin': re }, { 'customer.name': re }];
  }
  const sort = { [SORT_FIELD[sortBy]]: dir, _id: dir };

  if (rowsOnly) {
    const rows = await Invoice.aggregate([{ $match: match }, { $sort: sort }, ...(maxRows ? [{ $limit: maxRows }] : []), INVOICE_ROW]).allowDiskUse(true);
    return { rows, total: rows.length };
  }
  const [facet] = await Invoice.aggregate([
    { $match: match },
    { $facet: { rows: [{ $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }, INVOICE_ROW], total: [{ $count: 'n' }] } },
  ]).allowDiskUse(true);
  return { rows: facet?.rows || [], total: facet?.total?.[0]?.n || 0 };
}

/** Store names for the rows on one page. */
async function decorate(orgId, rows) {
  const ids = [...new Set(rows.map((r) => r.branchId).filter(Boolean).map(String))];
  const stores = ids.length ? await Branch.find({ organizationId: orgId, _id: { $in: ids.map(oid) } }).select('name').lean() : [];
  const names = new Map(stores.map((b) => [String(b._id), b.name]));
  return rows.map((r) => ({
    ...r,
    branchName: names.get(String(r.branchId)) || r.branchName || null,
    taxable: round2(r.taxable),
    cgst: round2(r.cgst),
    sgst: round2(r.sgst),
    igst: round2(r.igst),
    tax: round2(r.tax),
    total: round2(r.total),
  }));
}

/** The GST rates actually charged in the period, so the rate filter offers only rates that exist. */
async function rateOptions(orgId, period, branches) {
  const rates = await Invoice.distinct('items.gstPercent', salesMatch(orgId, period, branches));
  return rates
    .filter((r) => r !== null && r !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
    .map((value) => ({ value: String(value), label: `${value}%` }));
}

/* ------------------------------------------------------------------ the report */

const DISCLAIMER =
  'This is an operational summary built from the tax recorded on each document. It is not a GST return: reconcile it against your accounting records before filing.';

/** The GST report: output tax, input tax, what the returns adjust, and the net position. */
export async function getGstReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const f = filtersFrom(query);
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 25;
  const sortBy = GST_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const [output, returns, input, purchaseReturns, hsn, detail, rates] = await Promise.all([
    outputTax(orgId, period, branches, f),
    salesReturnTax(orgId, period, branches, f),
    inputTax(orgId, period, branches, f),
    purchaseReturnTax(orgId, period, branches),
    hsnSummary(orgId, period, branches, f),
    invoiceDetail(orgId, period, branches, f, { sortBy, dir, page, limit }),
    rateOptions(orgId, period, branches),
  ]);

  const outputNet = round2(output.totals.tax - returns.totals.tax);
  const inputNet = round2(input.totals.tax - purchaseReturns.tax);
  const net = round2(outputNet - inputNet);

  return {
    period: { from: period.start.toISOString(), to: period.end.toISOString(), days: period.days, timezone: tz },
    filters: { ...f, rate: f.rate === null ? null : String(f.rate), branchId: query.branchId || null, sortBy, sortDir: dir === 1 ? 'asc' : 'desc' },
    options: { rates, sortBy: GST_SORTABLE.map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) })) },
    organization: { name: org.name || '', gstin: org.gstin || null, state: org.address?.state || null },
    summary: {
      output: {
        label: 'Tax charged on sales',
        invoices: output.totals.invoices,
        taxable: output.totals.taxable,
        cgst: output.totals.cgst,
        sgst: output.totals.sgst,
        igst: output.totals.igst,
        tax: output.totals.tax,
        roundOff: output.totals.roundOff,
        total: output.totals.total,
        interStateInvoices: output.totals.interStateInvoices,
        withGstin: output.totals.withGstin,
      },
      salesReturns: { label: 'Less tax on sales returns', ...returns.totals, derived: true },
      outputNet: { label: 'Net output tax', tax: outputNet },
      input: {
        label: 'Tax paid on purchases',
        orders: input.totals.orders,
        taxable: input.totals.taxable,
        tax: input.totals.tax,
        chargesTax: input.totals.chargesTax,
        total: input.totals.total,
      },
      purchaseReturns: { label: 'Less tax on purchase returns', value: purchaseReturns.value, taxable: purchaseReturns.taxable, tax: purchaseReturns.tax, count: purchaseReturns.count, derived: true },
      inputNet: { label: 'Net input tax', tax: inputNet },
      net: { label: net >= 0 ? 'Net tax payable' : 'Net input tax credit', tax: Math.abs(net), signed: net, payable: net >= 0 },
    },
    byRate: output.byRate,
    returnsByRate: returns.byRate,
    inputByRate: input.byRate,
    hsn,
    items: await decorate(orgId, detail.rows),
    page,
    limit,
    pages: Math.max(1, Math.ceil(detail.total / limit)),
    total: detail.total,
    notes: {
      disclaimer: DISCLAIMER,
      inclusivePricing: 'Selling prices here are GST-inclusive, so tax was split out of the price when each bill was made. Tax is never added on top of an invoice total.',
      roundOff: 'An invoice\'s round-off is not tax. Taxable plus tax is the payable before rounding, so round-off is reported on its own line.',
      returnsDerived: 'Sales returns record no tax of their own. The adjustment above is worked out from the refund value and the rate on the invoice line each unit was returned against.',
      inputSplit: 'Purchases do not record a CGST/SGST/IGST split — there is no inter-state flag on an order — so input tax is reported as one figure.',
      hsnSource: 'HSN codes come from the medicine records as they stand now; invoice lines do not store an HSN code of their own.',
      unmatchedReturnLines: returns.unmatchedLines
        ? `${returns.unmatchedLines} returned line${returns.unmatchedLines === 1 ? '' : 's'} could not be matched to an invoice line, so no rate could be read and the tax on them is reported as zero rather than guessed.`
        : null,
      netPosition: 'The net position counts only what this system records. It takes no account of opening credit, reverse charge, ineligible credit or anything recorded elsewhere.',
    },
  };
}

/* ------------------------------------------------------------------ the export */

export const EXPORT_MAX_ROWS = 20000;

const COLUMNS = [
  ['Invoice No', (r) => r.invoiceNo],
  ['Date', (r, tz) => localDateTime(r.date, tz)],
  ['Customer', (r) => r.customerName],
  ['Customer GSTIN', (r) => r.customerGstin],
  ['Store', (r) => r.branchName],
  ['Supply', (r) => (r.interState ? 'Inter-state' : 'Intra-state')],
  ['GST rates', (r) => (r.rates || []).map((x) => `${x}%`).join(' / ')],
  ['Taxable (INR)', (r) => r.taxable.toFixed(2)],
  ['CGST (INR)', (r) => r.cgst.toFixed(2)],
  ['SGST (INR)', (r) => r.sgst.toFixed(2)],
  ['IGST (INR)', (r) => r.igst.toFixed(2)],
  ['Total tax (INR)', (r) => r.tax.toFixed(2)],
  ['Round off (INR)', (r) => Number(r.roundOff || 0).toFixed(2)],
  ['Invoice total (INR)', (r) => r.total.toFixed(2)],
];

/**
 * The GST report as a CSV file: the summary, the rate breakdown and the HSN summary in the heading, then every
 * invoice the filters match. The disclaimer is the first line, so a printed or forwarded copy cannot be mistaken
 * for a return.
 */
export async function exportGstReport(org, user, query = {}) {
  const orgId = org._id;
  const tz = orgTimezone(org);
  const period = resolvePeriod(query, tz, new Date());
  const branches = reportableBranches(user, query.branchId);
  const f = filtersFrom(query);
  const sortBy = GST_SORTABLE.includes(query.sortBy) ? query.sortBy : 'date';
  const dir = query.sortDir === 'asc' ? 1 : -1;

  const report = await getGstReport(org, user, { ...query, page: 1, limit: 1 });
  const { rows } = await invoiceDetail(orgId, period, branches, f, { sortBy, dir, page: 1, limit: 0, rowsOnly: true, maxRows: EXPORT_MAX_ROWS + 1 });
  if (rows.length > EXPORT_MAX_ROWS) {
    throw new ApiError(
      400,
      `That is more than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} invoices. Choose a shorter period or a single store and export again.`,
      undefined,
      'EXPORT_TOO_LARGE',
    );
  }
  const items = await decorate(orgId, rows);
  const s = report.summary;

  const head = exportHeader({
    title: 'GST Report',
    org,
    store: await storeLabel(orgId, query.branchId, branches),
    period,
    tz,
    filters: [
      ['IMPORTANT', DISCLAIMER],
      ['Organization GSTIN', org.gstin || 'Not recorded'],
      ['GST rate filter', f.rate === null ? 'All rates' : `${f.rate}%`],
      ['Search', f.search || '—'],
      [],
      ['Taxable sales (INR)', s.output.taxable.toFixed(2)],
      ['CGST on sales (INR)', s.output.cgst.toFixed(2)],
      ['SGST on sales (INR)', s.output.sgst.toFixed(2)],
      ['IGST on sales (INR)', s.output.igst.toFixed(2)],
      ['Total tax on sales (INR)', s.output.tax.toFixed(2)],
      ['Less tax on sales returns (INR)', s.salesReturns.tax.toFixed(2)],
      ['Net output tax (INR)', s.outputNet.tax.toFixed(2)],
      ['Taxable purchases (INR)', s.input.taxable.toFixed(2)],
      ['Input tax on purchases (INR)', s.input.tax.toFixed(2)],
      ['Less tax on purchase returns (INR)', s.purchaseReturns.tax.toFixed(2)],
      ['Net input tax (INR)', s.inputNet.tax.toFixed(2)],
      [s.net.payable ? 'Net tax payable (INR)' : 'Net input tax credit (INR)', s.net.tax.toFixed(2)],
      [],
      ['Rate', 'Taxable (INR)', 'CGST (INR)', 'SGST (INR)', 'IGST (INR)', 'Tax (INR)', 'Lines'],
      ...report.byRate.map((r) => [`${r.rate}%`, r.taxable.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2), r.igst.toFixed(2), r.tax.toFixed(2), r.lines]),
      [],
      ['HSN', 'Rate', 'Units', 'Taxable (INR)', 'CGST (INR)', 'SGST (INR)', 'IGST (INR)', 'Tax (INR)'],
      ...report.hsn.map((r) => [r.hsnLabel, `${r.rate}%`, r.units, r.taxable.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2), r.igst.toFixed(2), r.tax.toFixed(2)]),
      [],
    ],
    rows: items.length,
  });

  return {
    csv: toCsv([...head, COLUMNS.map(([h]) => h), ...items.map((r) => COLUMNS.map(([, read]) => read(r, tz)))]),
    fileName: `usha-gst-${fileStamp(tz)}.csv`,
    rows: items.length,
  };
}
