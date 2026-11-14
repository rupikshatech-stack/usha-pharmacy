import { CsvError, parseCsv } from '../utils/csv.js';

/**
 * Pure parts of the CSV inventory import: reading the file and validating each row. No database access here, so the
 * rules can be tested on their own. (Duplicate detection against existing data lives in import.service.js.)
 *
 * One CSV row = one batch of a medicine. Rows that repeat the same medicine add more batches to it. A row with no batch
 * columns just defines the medicine.
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 2000;

/** Column definitions, in template order. `aliases` are other header spellings accepted (compared without case, spaces or punctuation). */
export const COLUMNS = [
  { key: 'medicineName', required: true, aliases: ['name', 'medicine', 'productname'], example: 'Dolo 650' },
  { key: 'genericName', example: 'Paracetamol' },
  { key: 'salt', aliases: ['compound', 'saltcompound', 'composition'], example: 'Paracetamol 650 mg' },
  { key: 'manufacturer', aliases: ['company', 'mfr'], example: 'Micro Labs' },
  { key: 'category', aliases: ['categoryname'], example: 'Tablets' },
  { key: 'dosageForm', aliases: ['form'], example: 'Tablet' },
  { key: 'strength', example: '650 mg' },
  { key: 'packSize', aliases: ['pack'], example: '15 tablets' },
  { key: 'unit', example: 'Strip' },
  { key: 'sku', example: 'DOLO-650' },
  { key: 'barcode', aliases: ['ean', 'upc'], example: '8901234567890' },
  { key: 'hsnCode', aliases: ['hsn'], example: '30049099' },
  { key: 'gstPercentage', aliases: ['gst', 'gstpercent', 'gstrate'], example: '12' },
  { key: 'reorderLevel', aliases: ['reorder', 'minstock'], example: '20' },
  { key: 'description', example: '' },
  { key: 'batchNumber', aliases: ['batch', 'batchno'], example: 'BT2407A' },
  { key: 'manufacturingDate', aliases: ['mfgdate', 'manufactureddate', 'mfg'], example: '2026-01-15' },
  { key: 'expiryDate', aliases: ['expiry', 'expdate', 'exp'], example: '{expiry}' },
  { key: 'purchasePrice', aliases: ['costprice', 'purchaserate', 'cost'], example: '18.50' },
  { key: 'mrp', example: '32.00' },
  { key: 'sellingPrice', aliases: ['sellprice', 'saleprice', 'sellingrate'], example: '29.00' },
  { key: 'quantity', aliases: ['qty', 'initialquantity', 'stock'], example: '200' },
];
const BATCH_KEYS = ['batchNumber', 'manufacturingDate', 'expiryDate', 'purchasePrice', 'mrp', 'sellingPrice', 'quantity'];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_LOOKUP = new Map(COLUMNS.flatMap((c) => [c.key, ...(c.aliases || [])].map((a) => [norm(a), c.key])));

export class ImportFileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The sample file people download: header + a few rows that are valid today (expiry dates are always in the future). */
export function templateRows(now = new Date()) {
  const y = now.getUTCFullYear() + 2;
  const expiry = `${y}-06-30`;
  const expiry2 = `${y + 1}-03-31`;
  const ex = (key) => COLUMNS.find((c) => c.key === key).example.replace('{expiry}', expiry);
  const row = (over = {}) => COLUMNS.map((c) => over[c.key] ?? ex(c.key));
  return [
    COLUMNS.map((c) => c.key),
    row(),
    row({ batchNumber: 'BT2501C', manufacturingDate: '2026-04-01', expiryDate: expiry2, purchasePrice: '19.00', mrp: '33.00', sellingPrice: '30.00', quantity: '150' }),
    row({ medicineName: 'Azithral 500', genericName: 'Azithromycin', salt: 'Azithromycin 500 mg', manufacturer: 'Alembic', category: 'Tablets', strength: '500 mg', packSize: '5 tablets', sku: 'AZITH-500', barcode: '8901234567891', hsnCode: '30042019', gstPercentage: '12', reorderLevel: '10', batchNumber: '', manufacturingDate: '', expiryDate: '', purchasePrice: '', mrp: '', sellingPrice: '', quantity: '' }),
  ];
}

/** Reads the file text into [{ rowNumber, cells: {key: string} }] and the list of ignored columns. Throws ImportFileError for file-level problems. */
export function readCsv(text) {
  if (!text || !text.trim()) throw new ImportFileError('The file is empty.');
  if (text.includes('\u0000')) throw new ImportFileError('This does not look like a CSV text file.', 415);
  let table;
  try {
    table = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) throw new ImportFileError(e.message);
    throw e;
  }
  const [header, ...body] = table;
  if (!header || header.every((h) => !h.trim())) throw new ImportFileError('The first row must be the column headings.');
  if (header.length > 60) throw new ImportFileError('Too many columns for an inventory file.');

  const keys = [];
  const ignored = [];
  const seen = new Set();
  header.forEach((h, i) => {
    const key = HEADER_LOOKUP.get(norm(h));
    if (!key) {
      keys[i] = null;
      if (h.trim()) ignored.push(h.trim());
      return;
    }
    if (seen.has(key)) throw new ImportFileError(`The column "${key}" appears more than once (“${h.trim()}”).`);
    seen.add(key);
    keys[i] = key;
  });
  if (!seen.has('medicineName')) throw new ImportFileError('The file needs a "medicineName" column. Download the sample template to see the expected columns.');

  const rows = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => !c.trim())) return; // blank line
    const obj = {};
    keys.forEach((k, idx) => {
      if (k) obj[k] = (cells[idx] ?? '').trim();
    });
    rows.push({ rowNumber: i + 2, cells: obj }); // row 1 is the header, so the first data row is "row 2" like in a spreadsheet
  });
  if (rows.length === 0) throw new ImportFileError('The file has headings but no data rows.');
  if (rows.length > MAX_ROWS) throw new ImportFileError(`The file has ${rows.length} rows. Import at most ${MAX_ROWS} rows at a time.`, 413);
  return { rows, ignored, columns: [...seen] };
}

/** yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy or dd.mm.yyyy -> a real calendar date at midnight UTC, or null. */
export function parseDate(s) {
  let y;
  let m;
  let d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else if ((match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s))) [, d, m, y] = match;
  else return null;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  return date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d ? date : null;
}

const CODE = /^[A-Za-z0-9._\-/]+$/;
const startOfTodayUtc = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Validates one row's own values. Returns { errors: [{field, message}], medicine, batch } where `medicine` / `batch`
 * hold the cleaned values (batch is null when the row has no batch columns).
 */
export function validateRow(cells, now = new Date()) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const get = (k) => (cells[k] ?? '').trim();
  const text = (k, label, max) => {
    const v = get(k);
    if (v.length > max) err(k, `${label} must be ${max} characters or fewer`);
    return v;
  };

  const medicine = {
    medicineName: get('medicineName'),
    genericName: text('genericName', 'Generic name', 200),
    salt: text('salt', 'Salt / compound', 200),
    manufacturer: text('manufacturer', 'Manufacturer', 120),
    category: text('category', 'Category', 100),
    dosageForm: text('dosageForm', 'Dosage form', 60),
    strength: text('strength', 'Strength', 60),
    packSize: text('packSize', 'Pack size', 60),
    unit: text('unit', 'Unit', 30),
    description: text('description', 'Description', 2000),
    sku: get('sku'),
    barcode: get('barcode'),
    hsnCode: get('hsnCode'),
    gstPercentage: 12,
    reorderLevel: 10,
    reorderLevelBlank: true, // cleared below when the sheet gives one; the importer then uses the organization's default
  };
  if (!medicine.medicineName) err('medicineName', 'Medicine name is required');
  else if (medicine.medicineName.length > 150) err('medicineName', 'Medicine name must be 150 characters or fewer');

  for (const [k, label] of [['sku', 'SKU'], ['barcode', 'Barcode']]) {
    const v = medicine[k];
    if (!v) continue;
    if (v.length < 2) err(k, `${label} must be at least 2 characters`);
    else if (v.length > 60) err(k, `${label} must be 60 characters or fewer`);
    else if (!CODE.test(v)) err(k, `${label} can use letters, numbers and . _ - / only (no spaces)`);
  }
  if (medicine.hsnCode && !/^\d{4,8}$/.test(medicine.hsnCode)) err('hsnCode', 'HSN code must be 4 to 8 digits');

  const gstText = get('gstPercentage').replace(/%$/, '').trim();
  if (gstText !== '') {
    const gst = Number(gstText);
    if (!/^\d+(\.\d+)?$/.test(gstText) || Number.isNaN(gst)) err('gstPercentage', `GST "${get('gstPercentage')}" is not a number`);
    else if (gst > 100) err('gstPercentage', `GST ${gst} is above 100`);
    else if (Math.round(gst * 100) / 100 !== gst) err('gstPercentage', 'GST can have at most 2 decimal places');
    else medicine.gstPercentage = gst;
  }
  const reorderText = get('reorderLevel');
  if (reorderText !== '') {
    if (!/^\d+$/.test(reorderText)) err('reorderLevel', 'Reorder level must be a whole number (0 or more)');
    else if (Number(reorderText) > 1_000_000) err('reorderLevel', 'Reorder level is too large');
    else {
      medicine.reorderLevel = Number(reorderText);
      medicine.reorderLevelBlank = false;
    }
  }

  // ---- batch part
  const hasBatch = BATCH_KEYS.some((k) => get(k) !== '');
  let batch = null;
  if (hasBatch) {
    batch = { batchNumber: get('batchNumber') };
    if (!batch.batchNumber) err('batchNumber', 'Batch number is required when the row has batch details');
    else if (batch.batchNumber.length > 50) err('batchNumber', 'Batch number must be 50 characters or fewer');

    const expiryText = get('expiryDate');
    let expiry = null;
    if (!expiryText) err('expiryDate', 'Expiry date is required when the row has batch details');
    else if (!(expiry = parseDate(expiryText))) err('expiryDate', `Expiry date "${expiryText}" is not a valid date (use YYYY-MM-DD)`);
    else if (expiry <= startOfTodayUtc(now)) err('expiryDate', `Expiry date ${expiryText} is not in the future — expired stock cannot be imported`);
    batch.expiryDate = expiry;

    const mfgText = get('manufacturingDate');
    if (mfgText) {
      const mfg = parseDate(mfgText);
      if (!mfg) err('manufacturingDate', `Manufacturing date "${mfgText}" is not a valid date (use YYYY-MM-DD)`);
      else if (mfg > now) err('manufacturingDate', 'Manufacturing date cannot be in the future');
      else if (expiry && mfg >= expiry) err('manufacturingDate', 'Manufacturing date must be before the expiry date');
      else batch.manufacturingDate = mfg;
    }

    const qtyText = get('quantity');
    if (qtyText === '') err('quantity', 'Quantity is required when the row has batch details');
    else if (!/^\d+$/.test(qtyText) || Number(qtyText) < 1) err('quantity', `Quantity "${qtyText}" must be a whole number of at least 1`);
    else if (Number(qtyText) > 10_000_000) err('quantity', 'Quantity is too large');
    else batch.initialQuantity = Number(qtyText);

    const money = (k, label, required) => {
      const v = get(k).replace(/^₹/, '').replace(/,/g, '');
      if (v === '') {
        if (required) err(k, `${label} is required when the row has batch details`);
        return required ? NaN : 0;
      }
      if (!/^\d+(\.\d+)?$/.test(v)) {
        err(k, `${label} "${get(k)}" must be a number of 0 or more`);
        return NaN;
      }
      return Number(v);
    };
    batch.mrp = money('mrp', 'MRP', true);
    batch.sellingPrice = money('sellingPrice', 'Selling price', true);
    batch.purchasePrice = money('purchasePrice', 'Purchase price', false);
    if (!Number.isNaN(batch.mrp) && !Number.isNaN(batch.sellingPrice) && batch.sellingPrice > batch.mrp) err('sellingPrice', `Selling price ${batch.sellingPrice} is above the MRP ${batch.mrp}`);
  }
  return { errors, medicine, batch };
}

/** Case-insensitive key that says "this is the same product": name + strength + dosage form + manufacturer. */
export const nameKey = (m) => [m.medicineName, m.strength, m.dosageForm, m.manufacturer].map((x) => (x || '').toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
