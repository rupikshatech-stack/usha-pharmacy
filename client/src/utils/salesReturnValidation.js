// Rules and arithmetic for the "Process New Return" form. The server re-checks everything; this only lets people see problems early.

export const CONDITION_LABEL = {
  good: 'Good — sealed and in date',
  damaged: 'Damaged',
  expired: 'Expired',
  compromised: 'Packaging opened or compromised',
};

/**
 * Refund value of `q` more units of a line of `originalQuantity` units of which `already` came back before, in rupees. Same cumulative
 * whole-paisa rounding as the server, so returns made in pieces add up to the line's total exactly.
 */
export const returnAmount = (lineTotalPaise, originalQuantity, q, already = 0) => {
  const n = Number(q);
  if (!Number.isInteger(n) || n < 1 || !originalQuantity) return 0;
  return (Math.round(((already + n) * lineTotalPaise) / originalQuantity) - Math.round((already * lineTotalPaise) / originalQuantity)) / 100;
};

/** The form's lines, from an invoice the server described (one per invoice line, none selected yet). */
export const linesFromInvoice = (invoice) =>
  (invoice?.lines || []).map((l) => ({
    key: `${l.batchId}:${l.medicineId}`,
    ...l,
    selected: false,
    quantity: '',
    condition: 'good',
    restock: false,
    verified: false,
  }));

export const selectedLines = (lines) => lines.filter((l) => l.selected);

export const lineAmount = (l) => returnAmount(l.lineTotalPaise, l.originalQuantity, l.quantity, l.previouslyReturned || 0);

/** The refund the form starts with: the whole value, but never more than the customer paid (and has not already had refunded). */
export const defaultRefund = (invoice, total) => (total > 0 ? Math.min(total, typeof invoice?.refundableLeft === 'number' ? invoice.refundableLeft : total) : 0);

/** Total value of the selected, valid lines, in rupees (summed in paise). */
export const returnTotal = (lines) => Math.round(selectedLines(lines).reduce((p, l) => p + Math.round(lineAmount(l) * 100), 0)) / 100;

/** Can this line's units go back on the shelf? The reason, the condition and the batch all have to allow it. */
export function restockBlock(line, reason, noRestockReasons = ['expired', 'damaged']) {
  if (noRestockReasons.includes(reason)) return 'Expired and damaged returns can never be added back to sellable stock.';
  if (line.condition !== 'good') return 'Only units in good condition can be restocked.';
  if (!line.canRestock) return line.batchExpired ? 'This batch has expired, so its units cannot go back into stock.' : 'This batch is not active, so its units cannot go back into stock.';
  return '';
}

/** Keeps a line's restock choice consistent when the reason or condition changes: a blocked line is never restocked. */
export const normalizeRestock = (line, reason, noRestockReasons) => (restockBlock(line, reason, noRestockReasons) ? { ...line, restock: false, verified: false } : line);

export const blankRefund = () => ({ method: 'Cash', amount: '', amountTouched: false, status: 'pending', reference: '', remarks: '' });

const REFERENCE_METHODS = ['UPI', 'Card', 'Bank Transfer'];
const isMoney = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());

/** Returns { field: message }; empty means the form can be sent. Fields: invoice, lines, line.<key>.quantity, line.<key>.verified, reason, refund.amount … */
export function validateReturn({ invoice, lines, reason, notes = '', refund }, noRestockReasons) {
  const e = {};
  if (!invoice) e.invoice = 'Choose the original invoice.';
  const chosen = selectedLines(lines);
  if (invoice && chosen.length === 0) e.lines = 'Choose at least one product to return.';
  for (const l of chosen) {
    const q = Number(l.quantity);
    const k = `line.${l.key}`;
    if (l.quantity === '' || l.quantity === null) e[`${k}.quantity`] = 'Enter a quantity.';
    else if (!Number.isInteger(q)) e[`${k}.quantity`] = 'Use a whole number.';
    else if (q < 1) e[`${k}.quantity`] = 'Return at least 1 unit.';
    else if (q > l.returnableQuantity) e[`${k}.quantity`] = `Only ${l.returnableQuantity} can still be returned (bought ${l.originalQuantity}, already returned ${l.previouslyReturned}).`;
    if (l.restock) {
      const why = restockBlock(l, reason, noRestockReasons);
      if (why) e[`${k}.restock`] = why;
      else if (!l.verified) e[`${k}.verified`] = 'Confirm the units were inspected before restocking them.';
    }
  }
  if (!reason) e.reason = 'Choose why the products are being returned.';
  if (String(notes).length > 300) e.notes = 'Use 300 characters or fewer.';

  const total = returnTotal(lines);
  if (chosen.length) {
    if (refund.amount === '' || refund.amount === null) e['refund.amount'] = 'Enter the refund amount.';
    else if (!isMoney(refund.amount)) e['refund.amount'] = 'Use a number with at most 2 decimals.';
    else if (Math.round(Number(refund.amount) * 100) > Math.round(total * 100)) e['refund.amount'] = `The refund cannot be more than the value of the returned products (₹${total.toFixed(2)}).`;
    else if (invoice && typeof invoice.refundableLeft === 'number' && Math.round(Number(refund.amount) * 100) > Math.round(invoice.refundableLeft * 100)) e['refund.amount'] = `The customer has paid only ₹${invoice.refundableLeft.toFixed(2)} that can still be refunded on this invoice.`;
    else if (Math.round(Number(refund.amount) * 100) < Math.round(total * 100) && !refund.remarks.trim()) e['refund.remarks'] = 'Explain why less than the full value is being refunded.';
  }
  if (refund.status === 'completed' && REFERENCE_METHODS.includes(refund.method) && !refund.reference.trim()) e['refund.reference'] = `Enter the ${refund.method} transaction or reference ID for a completed refund.`;
  if (refund.reference.length > 100) e['refund.reference'] = 'Use 100 characters or fewer.';
  if (refund.remarks.length > 300) e['refund.remarks'] = 'Use 300 characters or fewer.';
  return e;
}

/** The request body: ids, quantities and choices only. Prices, amounts, status and organization are the server's to decide. */
export function toPayload({ invoice, lines, reason, notes, refund }, idempotencyKey) {
  return {
    invoiceId: invoice._id,
    reason,
    notes: String(notes || '').trim(),
    items: selectedLines(lines).map((l) => ({
      medicineId: l.medicineId,
      batchId: l.batchId,
      quantity: Number(l.quantity),
      condition: l.condition,
      restock: Boolean(l.restock),
      verified: Boolean(l.restock && l.verified),
    })),
    refund: { method: refund.method, amount: Number(refund.amount), status: refund.status, reference: refund.reference.trim(), remarks: refund.remarks.trim() },
    idempotencyKey,
  };
}

/** Maps a server error (details like items.1.quantity) back onto the form's fields. */
export function fieldErrorsFromServer(err, lines) {
  const chosen = selectedLines(lines);
  const fields = {};
  for (const d of err?.details || []) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(d.path || '');
    const key = m ? `line.${chosen[Number(m[1])]?.key}.${m[2] === 'batchId' ? 'quantity' : m[2]}` : d.path === 'items' ? 'lines' : d.path;
    if (key && !fields[key]) fields[key] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}
