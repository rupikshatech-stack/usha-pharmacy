// Pure helpers for the Add / Edit medicine form. They mirror the server's rules (server/validators/medicine.validator.js)
// so people get instant feedback; the server is still the source of truth and re-checks everything.

export const LIMITS = {
  medicineName: 150,
  genericName: 200,
  salt: 200,
  manufacturer: 120,
  categoryName: 100,
  dosageForm: 60,
  strength: 60,
  packSize: 60,
  sku: 60,
  barcode: 60,
  description: 2000,
  image: 500,
  attributeKey: 60,
  attributeValue: 120,
  attributes: 20,
};

const CODE_PATTERN = /^[A-Za-z0-9._\-/]*$/;
const IMAGE_PATTERN = /^(https?:\/\/|\/)/;

/** Human labels, used in error summaries. */
export const FIELD_LABELS = {
  medicineName: 'Medicine name',
  genericName: 'Generic name',
  salt: 'Salt / compound',
  manufacturer: 'Manufacturer',
  categoryName: 'Category',
  dosageForm: 'Dosage form',
  strength: 'Strength',
  packSize: 'Pack size',
  sku: 'SKU',
  barcode: 'Barcode',
  hsnCode: 'HSN code',
  gstPercentage: 'GST percentage',
  reorderLevel: 'Reorder level',
  description: 'Description',
  image: 'Medicine image',
  attributes: 'Custom attributes',
};

/** Validates a SKU or barcode on its own (also used before asking the server about duplicates). Returns a message or ''. */
export function codeProblem(value, label) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.length < 2) return `${label} must be at least 2 characters`;
  if (v.length > LIMITS.sku) return `${label} must be ${LIMITS.sku} characters or fewer`;
  if (!CODE_PATTERN.test(v)) return `${label} can use letters, numbers and . _ - / only (no spaces)`;
  return '';
}

export const isValidImageLink = (v) => !v || IMAGE_PATTERN.test(String(v).trim());

/** Returns { fieldName: message } for everything wrong with the form values (empty object = valid). */
export function validateMedicine(m) {
  const e = {};
  const t = (k) => String(m[k] ?? '').trim();

  if (!t('medicineName')) e.medicineName = 'Medicine name is required';
  else if (t('medicineName').length > LIMITS.medicineName) e.medicineName = `Medicine name must be ${LIMITS.medicineName} characters or fewer`;

  for (const k of ['genericName', 'salt', 'manufacturer', 'categoryName', 'dosageForm', 'strength', 'packSize']) {
    if (t(k).length > LIMITS[k]) e[k] = `${FIELD_LABELS[k]} must be ${LIMITS[k]} characters or fewer`;
  }

  const sku = codeProblem(m.sku, 'SKU');
  if (sku) e.sku = sku;
  const barcode = codeProblem(m.barcode, 'Barcode');
  if (barcode) e.barcode = barcode;

  if (t('hsnCode') && !/^\d{4,8}$/.test(t('hsnCode'))) e.hsnCode = 'HSN code must be 4 to 8 digits';

  const gst = Number(m.gstPercentage);
  if (m.gstPercentage === '' || m.gstPercentage === null || Number.isNaN(gst)) e.gstPercentage = 'Enter the GST percentage';
  else if (gst < 0 || gst > 100) e.gstPercentage = 'GST must be between 0 and 100';
  else if (Math.round(gst * 100) / 100 !== gst) e.gstPercentage = 'GST can have at most 2 decimal places';

  const rl = Number(m.reorderLevel);
  if (m.reorderLevel === '' || m.reorderLevel === null || Number.isNaN(rl)) e.reorderLevel = 'Enter the reorder level';
  else if (!Number.isInteger(rl)) e.reorderLevel = 'Reorder level must be a whole number';
  else if (rl < 0) e.reorderLevel = 'Reorder level cannot be negative';
  else if (rl > 1000000) e.reorderLevel = 'Reorder level is too large';

  if (t('description').length > LIMITS.description) e.description = `Description must be ${LIMITS.description} characters or fewer`;

  if (t('image')) {
    if (!isValidImageLink(t('image'))) e.image = 'Use an http(s) link, or a path starting with /';
    else if (t('image').length > LIMITS.image) e.image = `Image link must be ${LIMITS.image} characters or fewer`;
  }

  const attrs = m.attributes || [];
  const names = attrs.map((a) => a.key.trim().toLowerCase()).filter(Boolean);
  if (attrs.length > LIMITS.attributes) e.attributes = `At most ${LIMITS.attributes} custom attributes`;
  else if (attrs.some((a) => !a.key.trim() && a.value.trim())) e.attributes = 'Every custom attribute needs a name';
  else if (new Set(names).size !== names.length) e.attributes = 'Custom attribute names must be unique';
  else if (attrs.some((a) => a.key.trim().length > LIMITS.attributeKey || a.value.trim().length > LIMITS.attributeValue)) e.attributes = 'A custom attribute is too long';

  return e;
}

/** True when the form differs from how it was opened. */
export const isDirty = (initial, current) => JSON.stringify(initial) !== JSON.stringify(current);

/**
 * Turns the form values into the API body. "Salt / compound" is one field in the form: it is stored as the
 * medicine's salt AND linked to a Compound record of the same name. Batch prices and quantities are NOT part of
 * a medicine and are never sent.
 */
export function toPayload(m) {
  const salt = m.salt.trim();
  return {
    medicineName: m.medicineName.trim(),
    genericName: m.genericName.trim(),
    salt,
    compoundName: salt,
    manufacturer: m.manufacturer.trim(),
    categoryName: m.categoryName.trim(),
    dosageForm: m.dosageForm.trim(),
    strength: m.strength.trim(),
    packSize: m.packSize.trim(),
    unit: m.unit ?? '',
    company: (m.company || '').trim(),
    packing: {
      outerUnit: (m.outerUnit || '').trim(),
      ...(m.outerQty === '' || m.outerQty === undefined ? {} : { outerQty: Number(m.outerQty) }),
      innerUnit: (m.innerUnit || '').trim(),
      ...(m.innerQty === '' || m.innerQty === undefined ? {} : { innerQty: Number(m.innerQty) }),
    },
    sku: m.sku.trim(),
    barcode: m.barcode.trim(),
    hsnCode: m.hsnCode.trim(),
    taxability: m.taxability || 'taxable',
    // exempt and nil-rated products carry no GST; the server enforces this too, so the two can never disagree
    gstPercentage: m.taxability && m.taxability !== 'taxable' ? 0 : Number(m.gstPercentage),
    ...(m.defaultMrp === '' || m.defaultMrp === undefined ? {} : { defaultMrp: Number(m.defaultMrp) }),
    ...(m.defaultPurchasePrice === '' || m.defaultPurchasePrice === undefined ? {} : { defaultPurchasePrice: Number(m.defaultPurchasePrice) }),
    reorderLevel: Number(m.reorderLevel),
    description: m.description.trim(),
    image: m.image.trim(),
    attributes: (m.attributes || []).filter((a) => a.key.trim()).map((a) => ({ key: a.key.trim(), value: a.value.trim() })),
    isActive: m.isActive !== false,
  };
}

/**
 * Maps a failed API call onto form fields. The API reports field errors as details: [{ path, message }]
 * (e.g. a duplicate SKU arrives as path "sku"). Anything that can't be placed on a field is returned as `general`.
 */
export function serverFieldErrors(err) {
  const fields = {};
  for (const d of err?.details || []) {
    let field = String(d.path || '').split('.')[0];
    if (field === 'compoundName') field = 'salt'; // the form shows the compound as "Salt / compound"
    if (field && FIELD_LABELS[field] && !fields[field]) fields[field] = d.message;
  }
  return { fields, general: Object.keys(fields).length ? '' : err?.message || 'Something went wrong' };
}

/** A fresh form (Add) or one filled from an existing medicine (Edit). */
export function initialValues(medicine) {
  const blank = {
    medicineName: '', genericName: '', salt: '', manufacturer: '', company: '', categoryName: '',
    dosageForm: '', strength: '', packSize: '', unit: '',
    outerUnit: '', outerQty: '', innerUnit: '', innerQty: '',
    sku: '', barcode: '', hsnCode: '', taxability: 'taxable', gstPercentage: 12, reorderLevel: 10,
    defaultMrp: '', defaultPurchasePrice: '',
    description: '', image: '', attributes: [], isActive: true,
  };
  if (!medicine) return blank;
  const packing = medicine.packing || {};
  return {
    ...blank,
    ...Object.fromEntries(Object.keys(blank).filter((k) => medicine[k] !== undefined && medicine[k] !== null).map((k) => [k, medicine[k]])),
    salt: medicine.salt || medicine.compoundName || '',
    outerUnit: packing.outerUnit || '',
    outerQty: packing.outerQty ?? '',
    innerUnit: packing.innerUnit || '',
    innerQty: packing.innerQty ?? '',
    defaultMrp: medicine.defaultMrp ?? '',
    defaultPurchasePrice: medicine.defaultPurchasePrice ?? '',
    attributes: (medicine.attributes || []).map((a) => ({ key: a.key, value: a.value })),
  };
}

/**
 * How one GST rate is shown, split the way a bill charges it: within a state it is halved into CGST and SGST, across a state line it is all IGST.
 * One rate is stored; this only presents it, so the three figures can never disagree with each other or with a bill.
 */
export const gstSplit = (rate) => {
  const n = Number(rate) || 0;
  return { cgst: Math.round((n / 2) * 100) / 100, sgst: Math.round((n / 2) * 100) / 100, igst: n };
};

/** "Box of 10 strips × 15 tablets" — how a pack reads, from the parts that were filled in. */
export function packingSummary({ outerUnit, outerQty, innerUnit, innerQty } = {}) {
  const inner = innerQty && innerUnit ? `${innerQty} ${innerUnit}${Number(innerQty) === 1 ? '' : 's'}` : innerUnit || '';
  if (!outerUnit && !inner) return '';
  if (!outerUnit) return inner;
  const outer = `${outerUnit}${outerQty && Number(outerQty) > 1 ? ` of ${outerQty}` : ''}`;
  return inner ? `${outer} × ${inner}` : outer;
}

/** The sellable units one outer pack holds, when both halves are known. */
export const unitsPerOuter = ({ outerQty, innerQty } = {}) => (Number(outerQty) > 0 && Number(innerQty) > 0 ? Number(outerQty) * Number(innerQty) : null);
