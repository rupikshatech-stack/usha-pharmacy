// Rules and arithmetic for the Goods Received form. The server checks everything again and is the only one that adds stock;
// this lets people see the problems (and the "actual received" number) as they type.

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
const isWhole = (v) => /^\d+$/.test(String(v).trim());
const isMoney = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());
const isoDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** The form's lines from what the server described. By default everything still expected is taken as arriving now. */
export const receiveLinesFrom = (receivable) =>
  (receivable?.lines || [])
    .filter((l) => l.remainingQuantity > 0)
    .map((l) => ({
      ...l,
      key: String(l.medicineId),
      quantity: String(l.remainingPaid),
      freeQuantity: String(l.remainingFree),
      rejectedQuantity: '0',
      damagedQuantity: '0',
      batchNumber: '',
      manufacturingDate: '',
      expiryDate: '',
      purchasePrice: l.rate > 0 ? String(l.rate) : '',
      mrp: l.mrp ? String(l.mrp) : '',
      sellingPrice: l.sellingPrice ? String(l.sellingPrice) : '',
      remarks: '',
    }));

export const arriving = (l) => num(l.quantity) + num(l.freeQuantity);
/** What goes into sellable stock: the units that arrived, less those rejected or damaged. */
export const accepted = (l) => Math.max(0, arriving(l) - num(l.rejectedQuantity) - num(l.damagedQuantity));
export const stillExpected = (l) => Math.max(0, l.remainingQuantity - arriving(l));
/** A line with nothing arriving is left out of the delivery. */
export const delivered = (lines) => lines.filter((l) => arriving(l) > 0);
/** Is the batch number one already in stock for this product? (Its expiry is then fixed.) */
export const existingBatch = (l) => (l.batches || []).find((b) => b.batchNumber.trim().toLowerCase() === l.batchNumber.trim().toLowerCase() && l.batchNumber.trim() !== '');

export function validateReceipt(lines, today = isoDay()) {
  const e = {};
  const sent = delivered(lines);
  if (!sent.length) e.lines = 'Enter the quantities that arrived for at least one product.';
  for (const l of lines) {
    const k = `line.${l.key}`;
    const q = String(l.quantity).trim();
    const f = String(l.freeQuantity).trim();
    if (!isWhole(q)) e[`${k}.quantity`] = /^-/.test(q) ? 'Cannot be negative.' : q === '' ? 'Enter a quantity (0 if none arrived).' : 'Use a whole number.';
    else if (num(q) > l.remainingPaid) e[`${k}.quantity`] = `Only ${l.remainingPaid} more ${l.remainingPaid === 1 ? 'unit is' : 'units are'} expected. You can't receive more than was ordered.`;
    if (!isWhole(f)) e[`${k}.freeQuantity`] = /^-/.test(f) ? 'Cannot be negative.' : 'Use a whole number.';
    else if (num(f) > l.remainingFree) e[`${k}.freeQuantity`] = `Only ${l.remainingFree} free ${l.remainingFree === 1 ? 'unit is' : 'units are'} still expected.`;
    if (arriving(l) <= 0) continue; // nothing arrived: the rest of the line is not sent
    for (const [field, label] of [['rejectedQuantity', 'rejected'], ['damagedQuantity', 'damaged']]) {
      if (!isWhole(l[field])) e[`${k}.${field}`] = /^-/.test(String(l[field])) ? 'Cannot be negative.' : 'Use a whole number.';
    }
    if (!e[`${k}.rejectedQuantity`] && !e[`${k}.damagedQuantity`]) {
      if (num(l.rejectedQuantity) + num(l.damagedQuantity) > arriving(l)) e[`${k}.rejectedQuantity`] = `Rejected and damaged units can't be more than the ${arriving(l)} that arrived.`;
      else if (num(l.rejectedQuantity) + num(l.damagedQuantity) > 0 && !l.remarks.trim()) e[`${k}.remarks`] = 'Say why units were rejected or damaged.';
    }
    if (accepted(l) > 0 && !e[`${k}.quantity`] && !e[`${k}.freeQuantity`]) {
      if (!l.batchNumber.trim()) e[`${k}.batchNumber`] = 'Enter the batch number.';
      if (!l.expiryDate) e[`${k}.expiryDate`] = 'Enter the expiry date.';
      else if (l.expiryDate <= today) e[`${k}.expiryDate`] = 'Expired stock can’t be added to sellable inventory. Record those units as rejected instead.';
      else if (existingBatch(l) && isoDay(existingBatch(l).expiryDate) !== l.expiryDate) e[`${k}.expiryDate`] = `This batch is already in stock with expiry ${isoDay(existingBatch(l).expiryDate)}.`;
      if (l.manufacturingDate && l.manufacturingDate > today) e[`${k}.manufacturingDate`] = 'Cannot be in the future.';
      else if (l.manufacturingDate && l.expiryDate && l.manufacturingDate >= l.expiryDate) e[`${k}.manufacturingDate`] = 'Must be before the expiry date.';
      if (l.purchasePrice !== '' && !isMoney(l.purchasePrice)) e[`${k}.purchasePrice`] = /^-/.test(String(l.purchasePrice)) ? 'Cannot be negative.' : 'Use at most 2 decimals.';
      if (!existingBatch(l)) {
        if (!isMoney(l.mrp)) e[`${k}.mrp`] = 'Enter the MRP for the new batch.';
        if (!isMoney(l.sellingPrice)) e[`${k}.sellingPrice`] = 'Enter the selling price for the new batch.';
        else if (isMoney(l.mrp) && num(l.sellingPrice) > num(l.mrp)) e[`${k}.sellingPrice`] = 'Cannot be more than the MRP.';
      }
    }
  }
  return e;
}

/** The request body: only products with something arriving. Stock, status and numbers are the server's to decide. */
export function toReceivePayload(lines, { remarks = '', idempotencyKey } = {}) {
  return {
    items: delivered(lines).map((l) => ({
      medicineId: l.medicineId,
      quantity: num(l.quantity),
      freeQuantity: num(l.freeQuantity),
      rejectedQuantity: num(l.rejectedQuantity),
      damagedQuantity: num(l.damagedQuantity),
      batchNumber: l.batchNumber.trim(),
      ...(l.manufacturingDate && { manufacturingDate: l.manufacturingDate }),
      ...(l.expiryDate && { expiryDate: l.expiryDate }),
      ...(l.purchasePrice !== '' && { purchasePrice: num(l.purchasePrice) }),
      ...(l.mrp !== '' && { mrp: num(l.mrp) }),
      ...(l.sellingPrice !== '' && { sellingPrice: num(l.sellingPrice) }),
      remarks: l.remarks.trim(),
    })),
    remarks: remarks.trim(),
    idempotencyKey,
  };
}

/** Maps a server error (details like items.1.expiryDate) back onto the form's lines. */
export function receiveErrorsFromServer(err, lines) {
  const sent = delivered(lines);
  const fields = {};
  for (const d of err?.details || []) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(d.path || '');
    const key = m ? `line.${sent[Number(m[1])]?.key}.${m[2] === 'medicineId' ? 'quantity' : m[2]}` : d.path === 'items' ? 'lines' : d.path;
    if (key && !fields[key]) fields[key] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}
