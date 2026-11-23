import { Batch, Invoice, Medicine, Organization, nextSeq } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { audit } from './audit.service.js';
import { Branch } from '../models/index.js';
import { defaultBranchId, inBranch } from './branch.service.js';
import { branchScope } from './transferAccess.js';
import { recordMovement } from './ledger.service.js';
import { sellableBatchFilter, sellableUnitsExpr } from './stock.service.js';
import { withTransaction } from './transaction.service.js';
import { computeBill, roundOffFor, rupees } from '../utils/billMath.js';
import { issueNumber } from './documentNumbering.service.js';
import { stateOfGstin, sellerSnapshotOf } from '../utils/invoicePrint.js';

/** A sale is inter-state when the customer's state is known and differs from ours (the state is the first two digits of a GSTIN). */
function interStateSale(org, customer) {
  const ours = stateOfGstin(org?.gstin);
  const theirs = stateOfGstin(customer?.gstin);
  return Boolean(ours && theirs && ours !== theirs);
}

/**
 * Creates an invoice atomically: allocates stock FEFO (earliest expiry first) from SELLABLE batches only
 * (active, not expired, unreserved units), deducts each batch with a guard in the update itself so stock
 * can never go negative, appends one ledger entry per batch touched, and writes the invoice and its audit
 * entries — all in ONE transaction. Prices, tax and totals are computed HERE; the client only says what was
 * selected. Selling prices are GST-inclusive, so the tax is split out of the price (utils/billMath.js) and the
 * total is the same number it would have been before tax was ever shown.
 */
async function createInvoiceOnce(req, { customer, items, discount, paymentType, paid, idempotencyKey }) {
  // Merge duplicate lines for the same medicine.
  const wanted = new Map();
  for (const it of items) {
    const prev = wanted.get(it.medicineId);
    if (prev) prev.quantity += it.quantity;
    else wanted.set(it.medicineId, { ...it });
  }

  return withTransaction(async (session) => {
    // The organization's own rules for this sale. Read first, so a sale that is going to be refused is refused before
    // any stock has been touched rather than after it has been allocated and rolled back.
    const org = await Organization.findById(req.orgId, 'name legalName phone gstin address licenses bank settings timezone').lean();
    const billing = org?.settings?.general?.billing || {};

    /**
     * Some organizations will not sell on credit to somebody they cannot ring. It is a setting, OFF by default,
     * because a credit sale has never needed a phone number here and switching it on for everybody would change
     * billing for an organization that never asked. The server decides — the Selling Point only reflects it.
     */
    if (paymentType === 'Credit' && billing.requireCustomerPhoneOnCredit && !String(customer?.phone || '').trim()) {
      throw new ApiError(400, 'A credit sale needs the customer’s phone number: this organization requires one so that what is owed can be chased.', [{ path: 'customer.phone', message: 'Enter the customer’s 10-digit phone number' }], 'CUSTOMER_PHONE_REQUIRED');
    }

    const lines = [];
    const movements = []; // ledger entries, written once the invoice id exists
    const sold = []; // { medicine, qty } per medicine, to detect reorder-level crossings
    const now = new Date();
    // The Selling Point sells from the cashier's own store. Someone assigned to no store (an administrator) sells from
     // the default one, which is how it always worked.
     const scope = branchScope(req.user);
     const defaultStore = await defaultBranchId(req.orgId, session);
     const sellFrom = scope?.length ? scope[0] : defaultStore;
     const store = await Branch.findOne({ _id: sellFrom, organizationId: req.orgId }, 'name status').session(session).lean();
     if (!store) throw new ApiError(409, 'Your store could not be found.', undefined, 'BRANCH_NOT_FOUND');
     if (store.status && store.status !== 'active') throw new ApiError(409, `${store.name} is inactive, so nothing can be sold from it.`, undefined, 'BRANCH_INACTIVE');

    for (const it of wanted.values()) {
      const medicine = await Medicine.findOne({ _id: it.medicineId, organizationId: req.orgId }, null, { session }).lean();
      if (!medicine) throw new ApiError(404, 'A selected medicine no longer exists');
      if (!medicine.isActive) throw new ApiError(409, `${medicine.medicineName} is discontinued`);

      const batches = await Batch.find({ organizationId: req.orgId, medicineId: medicine._id, ...sellableBatchFilter(now), ...inBranch(sellFrom, defaultStore) }, null, { session }).sort({ expiryDate: 1 });

      let remaining = it.quantity;
      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(batch.availableQuantity - batch.reservedQuantity, remaining);
        // The guard lives in the update: it only applies if, at this instant, the batch is still active, unexpired
        // and has at least `take` unreserved units. Two simultaneous sales can't both take the last units.
        const updated = await Batch.findOneAndUpdate(
          { _id: batch._id, organizationId: req.orgId, status: 'active', expiryDate: { $gt: now }, $expr: { $gte: [sellableUnitsExpr, take] } },
          { $inc: { availableQuantity: -take } },
          { returnDocument: 'after', session },
        );
        if (!updated) throw new ApiError(409, `Stock changed for ${medicine.medicineName}. Please retry.`);
        remaining -= take;
        lines.push({
          medicineId: medicine._id,
          batchId: batch._id,
          // snapshots: the invoice keeps what was sold even if the catalogue or the batch changes later
          name: medicine.medicineName,
          genericName: medicine.genericName || '',
          sku: medicine.sku || '',
          hsnCode: medicine.hsnCode || '',
          batchNo: batch.batchNumber,
          expiryDate: batch.expiryDate,
          mrp: batch.mrp,
          quantity: take,
          price: batch.sellingPrice,
          discountPercent: it.discountPercent,
          gstPercent: medicine.gstPercentage ?? 0,
        });
        movements.push({ medicineId: medicine._id, batchId: batch._id, type: 'SALE', quantity: -take, balanceAfter: updated.availableQuantity, refType: 'Invoice' });
      }
      if (remaining > 0) throw new ApiError(409, `Insufficient stock for ${medicine.medicineName} (short by ${remaining})`);
      sold.push({ medicine, qty: it.quantity });
    }

    // the whole bill in one place, in whole paise: item discounts, the bill discount shared across the lines, the tax inside each price
    const interState = interStateSale(org, customer);
    const bill = computeBill({
      items: lines.map((l) => ({ quantity: l.quantity, price: l.price, discountPercent: l.discountPercent, gstPercent: l.gstPercent })),
      discount,
      interState,
      // Off, unless the organization turned rounding on; then to the nearest ₹1 (what it always did) or ₹0.50. The
      // Selling Point asks the very same function, so the cart and the saved invoice cannot disagree.
      roundOff: roundOffFor(org?.settings),
      paid: paymentType === 'Credit' ? (paid ?? 0) : undefined,
    });
    lines.forEach((l, i) => {
      const b = bill.lines[i];
      l.amount = rupees(b.final); // what this line came to, inclusive of tax
      l.billDiscountShare = rupees(b.billDiscount);
      l.taxableAmount = rupees(b.taxable);
      l.cgst = rupees(b.cgst);
      l.sgst = rupees(b.sgst);
      l.igst = rupees(b.igst);
      l.taxAmount = rupees(b.tax);
    });
    const subTotal = rupees(bill.subtotal);
    const billDiscount = rupees(bill.billDiscount);
    const total = rupees(bill.total);
    const paidAmount = paymentType === 'Credit' ? rupees(bill.paid) : total;
    const due = paymentType === 'Credit' ? rupees(bill.due) : 0;
    // A due date only when there is something due, the sale is on credit AND the organization set a credit period.
    const creditDays = Number(billing.defaultCreditDays) || 0;
    const dueDate = paymentType === 'Credit' && due > 0 && creditDays > 0 ? new Date(now.getTime() + creditDays * 86400000) : undefined;

    /**
     * The invoice number, from the organization's own numbering settings. With the default configuration this is
     * exactly what it has always been — counter key 'invoice', format INV-00001 — so nothing changes for anybody
     * who never opens the settings screen. The sequence comes from an atomic increment inside THIS transaction:
     * if the sale rolls back, so does the number.
     */
    const issued = await issueNumber({ orgId: req.orgId, org, series: 'sales', branchId: sellFrom, session });
    const invoiceNo = issued.number;

    const [inv] = await Invoice.create(
      [
        {
          organizationId: req.orgId,
          invoiceNo,
          branchId: sellFrom,
          branchName: store.name,
          customer,
          items: lines,
          subTotal,
          itemDiscount: rupees(bill.itemDiscountTotal),
          discount: billDiscount,
          taxableAmount: rupees(bill.taxableTotal),
          cgstTotal: rupees(bill.cgstTotal),
          sgstTotal: rupees(bill.sgstTotal),
          igstTotal: rupees(bill.igstTotal),
          taxTotal: rupees(bill.taxTotal),
          interState,
          gstSummary: bill.gstSummary.map((g) => ({ gstPercent: g.gstPercent, taxable: rupees(g.taxable), cgst: rupees(g.cgst), sgst: rupees(g.sgst), igst: rupees(g.igst), tax: rupees(g.tax) })),
          roundOff: rupees(bill.roundOff),
          total,
          paymentType,
          paid: paidAmount,
          due,
          ...(dueDate && { dueDate }),
          status: 'completed',
          invoiceDate: now, // UTC instant of the sale; reports bucket it into the organization's local day/month
          ...(idempotencyKey && { idempotencyKey }),
          createdBy: req.user._id,
          seller: sellerSnapshotOf(org), // frozen with the sale: a later edit to the organization never rewrites this invoice
        },
      ],
      { session },
    );

    for (const m of movements) await recordMovement(req, session, { ...m, refId: inv._id }); // append-only ledger, in order

    await audit(
      req,
      { action: 'INVOICE_CREATE', entity: 'Invoice', entityId: inv._id, message: `Invoice ${invoiceNo} processed`, meta: { total, taxTotal: rupees(bill.taxTotal), interState } },
      session,
    );

    // Low-stock alert: record an event when THIS sale takes a medicine from at/above its reorder level to below it
    // (once per crossing, not on every later sale). Uses the same "available = sellable stock" rule as the dashboard.
    for (const { medicine, qty } of sold) {
      if (!(medicine.reorderLevel > 0)) continue;
      const [agg] = await Batch.aggregate([
        { $match: { organizationId: req.orgId, medicineId: medicine._id, ...sellableBatchFilter(now) } },
        { $group: { _id: null, qty: { $sum: sellableUnitsExpr } } },
      ]).session(session);
      const after = agg?.qty ?? 0;
      const before = after + qty;
      if (before >= medicine.reorderLevel && after < medicine.reorderLevel) {
        await audit(
          req,
          {
            action: 'LOW_STOCK_ALERT',
            entity: 'Medicine',
            entityId: medicine._id,
            message: `Low stock alert — ${medicine.medicineName} (${after} left, reorder level ${medicine.reorderLevel})`,
            meta: { available: after, reorderLevel: medicine.reorderLevel },
          },
          session,
        );
      }
    }
    return inv;
  });
}

const findByKey = (req, key) => Invoice.findOne({ organizationId: req.orgId, idempotencyKey: key }).select('+seller').lean();

/**
 * Creates an invoice, safely repeatable: if the client sends the same idempotencyKey again (a
 * double-click, a network retry) the ORIGINAL invoice is returned and nothing is created or
 * deducted a second time. Returns { invoice, replayed }.
 */
export async function createInvoice(req, input) {
  const key = input.idempotencyKey;
  if (key) {
    const existing = await findByKey(req, key);
    if (existing) return { invoice: existing, replayed: true };
  }
  try {
    return { invoice: await createInvoiceOnce(req, input), replayed: false };
  } catch (err) {
    // Two identical requests racing: the unique index lets exactly one win; the loser returns the winner's invoice.
    if (key && err?.code === 11000) {
      const existing = await findByKey(req, key);
      if (existing) return { invoice: existing, replayed: true };
    }
    throw err;
  }
}

export async function listInvoices(orgId, { search, page, limit }) {
  const filter = { organizationId: orgId };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ invoiceNo: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
  }
  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-items').lean(),
    Invoice.countDocuments(filter),
  ]);
  return { items, total };
}

export async function getInvoice(orgId, id) {
  const invoice = await Invoice.findOne({ _id: id, organizationId: orgId }).select('+seller').lean();
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  return invoice;
}
