// Pure helpers for the batch pages. They mirror the server's batch rules (validators/medicine.validator.js) for
// instant feedback; the server remains the source of truth.

const todayKey = (now = new Date()) => now.toISOString().slice(0, 10);
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

export const blankBatch = {
  medicineId: '', batchNumber: '', manufacturer: '', manufacturingDate: '', expiryDate: '',
  purchasePrice: '', mrp: '', sellingPrice: '', initialQuantity: '',
};

/** Errors for the "Add batch" form: { field: message }. Dates are yyyy-mm-dd strings. */
export function validateNewBatch(b, now = new Date()) {
  const e = {};
  if (!b.medicineId) e.medicineId = 'Choose the medicine this batch belongs to';
  if (!b.batchNumber.trim()) e.batchNumber = 'Batch number is required';
  else if (b.batchNumber.trim().length > 50) e.batchNumber = 'Batch number must be 50 characters or fewer';

  if (!b.expiryDate) e.expiryDate = 'Expiry date is required';
  else if (b.expiryDate <= todayKey(now)) e.expiryDate = 'Expiry date must be in the future';

  if (b.manufacturingDate) {
    if (b.manufacturingDate > todayKey(now)) e.manufacturingDate = 'Manufacturing date cannot be in the future';
    else if (b.expiryDate && b.manufacturingDate >= b.expiryDate) e.manufacturingDate = 'Manufacturing date must be before the expiry date';
  }

  const qty = num(b.initialQuantity);
  if (Number.isNaN(qty)) e.initialQuantity = 'Enter the quantity received';
  else if (!Number.isInteger(qty)) e.initialQuantity = 'Quantity must be a whole number';
  else if (qty < 1) e.initialQuantity = 'Quantity must be at least 1';

  const mrp = num(b.mrp);
  const sell = num(b.sellingPrice);
  const buy = b.purchasePrice === '' ? 0 : num(b.purchasePrice);
  if (Number.isNaN(mrp)) e.mrp = 'Enter the MRP';
  else if (mrp < 0) e.mrp = 'MRP cannot be negative';
  if (Number.isNaN(sell)) e.sellingPrice = 'Enter the selling price';
  else if (sell < 0) e.sellingPrice = 'Selling price cannot be negative';
  else if (!e.mrp && sell > mrp) e.sellingPrice = 'Selling price cannot exceed the MRP';
  if (Number.isNaN(buy) || buy < 0) e.purchasePrice = 'Purchase price cannot be negative';
  if (b.manufacturer.length > 120) e.manufacturer = 'Manufacturer must be 120 characters or fewer';
  return e;
}

/** The API body for a new batch (blank optional fields are left out). */
export function newBatchPayload(b) {
  return {
    medicineId: b.medicineId,
    batchNumber: b.batchNumber.trim(),
    manufacturer: b.manufacturer.trim() || undefined,
    manufacturingDate: b.manufacturingDate || undefined,
    expiryDate: b.expiryDate,
    purchasePrice: b.purchasePrice === '' ? 0 : Number(b.purchasePrice),
    mrp: Number(b.mrp),
    sellingPrice: Number(b.sellingPrice),
    initialQuantity: Number(b.initialQuantity),
  };
}

/** Errors for editing the permitted fields of an existing batch. */
export function validateBatchEdit(v, batch) {
  const e = {};
  const mrp = num(v.mrp);
  const sell = num(v.sellingPrice);
  const buy = v.purchasePrice === '' ? 0 : num(v.purchasePrice);
  if (Number.isNaN(mrp) || mrp < 0) e.mrp = 'Enter the MRP (0 or more)';
  if (Number.isNaN(sell) || sell < 0) e.sellingPrice = 'Enter the selling price (0 or more)';
  else if (!e.mrp && sell > mrp) e.sellingPrice = 'Selling price cannot exceed the MRP';
  if (Number.isNaN(buy) || buy < 0) e.purchasePrice = 'Purchase price cannot be negative';
  if (v.manufacturer.length > 120) e.manufacturer = 'Manufacturer must be 120 characters or fewer';
  const reserved = num(v.reservedQuantity);
  if (Number.isNaN(reserved) || !Number.isInteger(reserved) || reserved < 0) e.reservedQuantity = 'Enter a whole number (0 or more)';
  else if (reserved > batch.availableQuantity) e.reservedQuantity = `Cannot exceed the ${batch.availableQuantity} units on hand`;
  if (v.status === 'archived' && batch.availableQuantity !== 0) e.status = `A batch with ${batch.availableQuantity} unit(s) on hand can't be archived`;
  return e;
}

/** Only what actually changed, ready for PATCH /api/batches/:id. */
export function batchEditPayload(v, batch) {
  const next = {
    purchasePrice: Number(v.purchasePrice || 0),
    sellingPrice: Number(v.sellingPrice),
    mrp: Number(v.mrp),
    manufacturer: v.manufacturer.trim(),
    reservedQuantity: Number(v.reservedQuantity),
    status: v.status,
  };
  return Object.fromEntries(Object.entries(next).filter(([k, val]) => String(val) !== String(batch[k] ?? (k === 'manufacturer' ? '' : ''))));
}

/** How urgent a batch's expiry is: drives the colour of the expiry cell. */
export function expiryUrgency(batch) {
  if (batch.isExpired) return 'expired';
  if (batch.availableQuantity <= 0 || batch.status === 'archived') return 'none';
  if (batch.daysToExpiry <= 30) return 'critical';
  if (batch.daysToExpiry <= 60) return 'soon';
  if (batch.daysToExpiry <= 90) return 'watch';
  return 'ok';
}

export const expiryNote = (batch) => {
  if (batch.isExpired) return `Expired ${Math.abs(batch.daysToExpiry)} day${Math.abs(batch.daysToExpiry) === 1 ? '' : 's'} ago`;
  return batch.daysToExpiry <= 90 ? `${batch.daysToExpiry} day${batch.daysToExpiry === 1 ? '' : 's'} left` : '';
};
