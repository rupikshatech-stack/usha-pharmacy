/**
 * Helpers for the goods receipt form. The server decides everything that matters (limits, batches, expiry, stock); these only turn a draft into editable
 * text and back, work out what a line comes to for display, and warn early about what the server would refuse. What the invoice says and what actually
 * arrived are separate fields: nothing here ever copies one into the other.
 */

const text = (v) => (v === null || v === undefined ? '' : String(v));
const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const n0 = (v) => num(v) ?? 0;
const isWhole = (v) => /^\d+$/.test(String(v).trim());
const isMoney = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());

/** Units that arrived (paid + free) and the accepted ones that may enter sellable stock: arrived - rejected - damaged. */
export function lineFigures(l) {
  const arrived = n0(l.receivedQuantity) + n0(l.receivedFree);
  return { arrived, accepted: Math.max(0, arrived - n0(l.rejectedQuantity) - n0(l.damagedQuantity)) };
}

/** A draft from the server as form text. A quantity that has not been entered stays EMPTY: it is never filled from the invoice. */
export function toForm(draft) {
  return {
    notes: draft.notes || '',
    revision: draft.revision,
    items: draft.items.map((l) => ({
      _id: l._id,
      medicineId: String(l.medicineId),
      name: l.name,
      unit: l.unit || '',
      itemId: l.itemId || '',
      invoice: l.invoice || {},
      receivedQuantity: text(l.receivedQuantity),
      receivedFree: text(l.receivedFree),
      rejectedQuantity: text(l.rejectedQuantity ?? 0),
      damagedQuantity: text(l.damagedQuantity ?? 0),
      batchNumber: l.batchNumber || '',
      manufacturingDate: l.manufacturingDate || '',
      expiryDate: l.expiryDate || '',
      purchasePrice: text(l.purchasePrice),
      mrp: text(l.mrp),
      sellingPrice: text(l.sellingPrice),
      remarks: l.remarks || '',
    })),
  };
}

/** The form back to what the server takes: counts and prices as numbers (null when empty), dates as given. */
export function toPayload(form) {
  return {
    notes: form.notes,
    expectedRevision: form.revision,
    items: form.items.map((l) => ({
      ...(l._id ? { _id: l._id } : { medicineId: l.medicineId }),
      receivedQuantity: num(l.receivedQuantity),
      receivedFree: num(l.receivedFree),
      rejectedQuantity: num(l.rejectedQuantity) ?? 0,
      damagedQuantity: num(l.damagedQuantity) ?? 0,
      batchNumber: l.batchNumber,
      manufacturingDate: l.manufacturingDate || null,
      expiryDate: l.expiryDate || null,
      purchasePrice: num(l.purchasePrice),
      mrp: num(l.mrp),
      sellingPrice: num(l.sellingPrice),
      remarks: l.remarks,
    })),
  };
}

export const isDirty = (form, saved) => JSON.stringify(form) !== JSON.stringify(saved);

/** What is wrong with a line as typed (the server checks again): { field: message }. Empty = fine. */
export function lineProblems(l, today = new Date().toISOString().slice(0, 10)) {
  const e = {};
  for (const [k, label] of [
    ['receivedQuantity', 'Received quantity'],
    ['receivedFree', 'Free quantity'],
    ['rejectedQuantity', 'Rejected quantity'],
    ['damagedQuantity', 'Damaged quantity'],
  ]) {
    if (String(l[k]).trim() !== '' && !isWhole(l[k])) e[k] = `${label}: use a whole number.`;
  }
  if (String(l.receivedQuantity).trim() === '') e.receivedQuantity = 'Enter how many arrived (0 if none). It is not assumed from the invoice.';
  if (String(l.receivedFree).trim() === '' && n0(l.invoice?.freeQuantity) > 0) e.receivedFree = 'Enter how many free units arrived (0 if none).';
  if (Object.keys(e).length) return e;
  const { arrived, accepted } = lineFigures(l);
  if (arrived === 0) return e;
  if (n0(l.rejectedQuantity) + n0(l.damagedQuantity) > arrived) e.rejectedQuantity = 'Rejected and damaged units cannot be more than the units that arrived.';
  if (n0(l.rejectedQuantity) + n0(l.damagedQuantity) > 0 && !String(l.remarks).trim()) e.remarks = 'Say why units were rejected or damaged.';
  for (const k of ['purchasePrice', 'mrp', 'sellingPrice']) if (String(l[k]).trim() !== '' && !isMoney(l[k])) e[k] = 'Use an amount like 12.50.';
  if (accepted > 0) {
    if (!String(l.batchNumber).trim()) e.batchNumber = 'Enter the batch number.';
    if (!l.expiryDate) e.expiryDate = 'Enter the expiry date.';
    else if (l.expiryDate <= today) e.expiryDate = 'Expired medicine cannot enter sellable stock: record those units as rejected.';
    if (l.manufacturingDate && l.expiryDate && l.manufacturingDate >= l.expiryDate) e.manufacturingDate = 'Must be before the expiry date.';
  }
  return e;
}

/** Totals across the lines for the confirmation summary. */
export function totals(form) {
  const f = form.items.map(lineFigures);
  const sum = (k) => form.items.reduce((a, l) => a + n0(l[k]), 0);
  return {
    invoice: form.items.reduce((a, l) => a + n0(l.invoice?.quantity) + n0(l.invoice?.freeQuantity), 0),
    arrived: f.reduce((a, x) => a + x.arrived, 0),
    accepted: f.reduce((a, x) => a + x.accepted, 0),
    rejected: sum('rejectedQuantity'),
    damaged: sum('damagedQuantity'),
  };
}

/** Lines whose arrived quantity differs from the invoice's, so the summary can show them plainly. */
export const differences = (form) =>
  form.items
    .filter((l) => String(l.receivedQuantity).trim() !== '' && lineFigures(l).arrived !== n0(l.invoice?.quantity) + n0(l.invoice?.freeQuantity))
    .map((l) => ({ name: l.name, invoice: n0(l.invoice?.quantity) + n0(l.invoice?.freeQuantity), arrived: lineFigures(l).arrived }));

/** Can the form be confirmed as typed? (Only a hint for the button: the server decides.) */
export const canConfirm = (form) => form.items.length > 0 && form.items.every((l) => Object.keys(lineProblems(l)).length === 0) && totals(form).arrived > 0;

/** A second line for the same product (another batch): everything about the delivery empty, the invoice figures none. */
export const extraBatch = (l) => ({
  medicineId: l.medicineId,
  name: l.name,
  unit: l.unit,
  itemId: '',
  invoice: {},
  receivedQuantity: '',
  receivedFree: '0',
  rejectedQuantity: '0',
  damagedQuantity: '0',
  batchNumber: '',
  manufacturingDate: '',
  expiryDate: '',
  purchasePrice: l.purchasePrice,
  mrp: l.mrp,
  sellingPrice: l.sellingPrice,
  remarks: '',
});

/** What the final review's purchase-order step offers, in words. */
export const purchaseMode = (p) => (p ? (p.mode === 'linked' ? `Linked to ${p.orderNo}` : `Order ${p.orderNo} created`) : 'No purchase order yet');
