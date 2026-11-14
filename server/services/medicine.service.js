import mongoose from 'mongoose';
import { Attribute, Batch, Compound, Invoice, Medicine, Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { audit } from './audit.service.js';
import { createBatchInTx, listBatches } from './batch.service.js';
import { branchExpr, defaultBranchId } from './branch.service.js';
import { assertAttributeValues, findOrCreateCategory, findOrCreateCompound } from './catalog.service.js';
import { STOCK_RANK, deriveStock, inventoryStatsStages, sellableUnitsExpr } from './stock.service.js';
import { withTransaction } from './transaction.service.js';

const CI = { locale: 'en', strength: 2 };

/** Adds the human-readable category / compound names to each medicine in a pipeline. */
const nameLookups = [
  { $lookup: { from: 'attributes', localField: 'categoryId', foreignField: '_id', as: '_cat' } },
  { $lookup: { from: 'compounds', localField: 'compoundId', foreignField: '_id', as: '_cmp' } },
  { $addFields: { categoryName: { $ifNull: [{ $first: '$_cat.attributeName' }, ''] }, compoundName: { $ifNull: [{ $first: '$_cmp.compoundName' }, ''] } } },
  { $project: { _cat: 0, _cmp: 0 } },
];

/** Turns categoryName/compoundName into ids (creating them if new) and checks explicit ids belong to this organization. */
async function resolveRefs(req, input, session) {
  const { categoryName, compoundName, ...fields } = input;
  await assertAttributeValues(req.orgId, fields.attributes); // custom attributes must use their allowed values

  if (fields.categoryId) {
    const ok = await Attribute.exists({ _id: fields.categoryId, attributeType: 'category' }).session(session ?? null);
    if (!ok) throw new ApiError(400, 'Unknown category', undefined, 'UNKNOWN_CATEGORY');
  } else if (categoryName !== undefined) {
    fields.categoryId = categoryName.trim() ? (await findOrCreateCategory(req, categoryName, session))._id : null;
  }

  if (fields.compoundId) {
    const ok = await Compound.exists({ _id: fields.compoundId }).session(session ?? null);
    if (!ok) throw new ApiError(400, 'Unknown compound', undefined, 'UNKNOWN_COMPOUND');
  } else if (compoundName !== undefined) {
    fields.compoundId = compoundName.trim() ? (await findOrCreateCompound(req, compoundName, session))._id : null;
  }

  // Exempt and nil-rated products carry no GST. Forcing the rate to zero HERE means every screen and every bill reads one number and none of them can disagree.
  if (fields.taxability && fields.taxability !== 'taxable') fields.gstPercentage = 0;
  // The printed pack follows the packing when that is given, so the two can never contradict each other on a label.
  const pk = fields.packing;
  if (pk && pk.innerQty && pk.innerUnit) fields.packSize = `${pk.innerQty} ${pk.innerUnit}${pk.innerQty === 1 ? '' : 's'}`;
  return fields;
}

const duplicateField = (e) => {
  const key = Object.keys(e.keyPattern || {}).find((k) => k !== 'organizationId');
  const field = (path, message, code) => new ApiError(409, message, [{ path, message }], code); // `details` lets the form show it on the right field
  if (key === 'barcode') return field('barcode', 'Another medicine already uses this barcode.', 'DUPLICATE_BARCODE');
  if (key === 'sku') return field('sku', 'Another medicine already uses this SKU.', 'DUPLICATE_SKU');
  return new ApiError(409, 'A record with these details already exists.', undefined, 'DUPLICATE');
};

/**
 * The inventory list. Stock figures and the status (in_stock / low_stock / out_of_stock / expired) are CALCULATED from
 * batch data in the same query, so filtering, sorting and paging by them is done in the database, page by page.
 * Archived medicines are hidden unless asked for (archived: 'include' | 'only').
 */
export async function listMedicines(orgId, { search, page, limit, categoryId, manufacturer, stock, archived = 'exclude', sortBy, sortDir }) {
  const filter = { organizationId: orgId };
  if (categoryId) filter.categoryId = new mongoose.Types.ObjectId(categoryId);
  if (manufacturer) filter.manufacturer = manufacturer;
  if (archived === 'exclude') filter.isActive = true;
  else if (archived === 'only') filter.isActive = false;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    const batchHits = await Batch.distinct('medicineId', { organizationId: orgId, batchNumber: rx });
    filter.$or = [
      { medicineName: rx },
      { genericName: rx },
      { salt: rx },
      { hsnCode: rx },
      { manufacturer: rx },
      { barcode: rx },
      { sku: rx },
      { _id: { $in: batchHits } },
    ];
  }

  const needsNameBeforeSort = sortBy === 'categoryName';
  const [result] = await Medicine.aggregate(
    [
      { $match: filter },
      ...inventoryStatsStages(new Date()),
      ...(stock ? [{ $match: { stockStatus: stock } }] : []),
      ...(sortBy === 'stockStatus' ? [{ $addFields: { stockRank: { $switch: { branches: Object.entries(STOCK_RANK).map(([k, v]) => ({ case: { $eq: ['$stockStatus', k] }, then: v })), default: 9 } } } }] : []),
      ...(needsNameBeforeSort ? nameLookups : []),
      {
        $facet: {
          items: [
            { $sort: { [sortBy === 'stockStatus' ? 'stockRank' : sortBy]: sortDir === 'asc' ? 1 : -1, _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            ...(needsNameBeforeSort ? [] : nameLookups),
          ],
          count: [{ $count: 'n' }],
        },
      },
    ],
    { collation: CI },
  );
  return { items: result.items, total: result.count[0]?.n || 0 };
}

/**
 * Is this SKU / barcode already used by another medicine in the organization (case-insensitive)?
 * `excludeId` is the medicine being edited, so it never conflicts with itself.
 * Only the id and name of the clashing medicine are returned, and only from the caller's own organization.
 */
export async function findDuplicates(orgId, { sku, barcode, excludeId }) {
  const look = async (field, value) => {
    if (!value) return null;
    const filter = { organizationId: orgId, [field]: value, ...(excludeId && { _id: { $ne: new mongoose.Types.ObjectId(excludeId) } }) };
    const m = await Medicine.findOne(filter).collation(CI).select('medicineName isActive').lean();
    return m ? { id: m._id, name: m.medicineName, archived: !m.isActive } : null;
  };
  const [bySku, byBarcode] = await Promise.all([look('sku', sku), look('barcode', barcode)]);
  return { sku: bySku, barcode: byBarcode };
}

/** Values for filter dropdowns and form suggestions. */
export async function getFacets(orgId) {
  const [categories, manufacturers, companies, usedForms, usedUnits, compounds, lists, customDefs] = await Promise.all([
    Attribute.find({ organizationId: orgId, attributeType: 'category', status: 'active' }).sort({ attributeName: 1 }).collation(CI).select('attributeName').lean(),
    Medicine.distinct('manufacturer', { organizationId: orgId }),
    Medicine.distinct('company', { organizationId: orgId }),
    Medicine.distinct('dosageForm', { organizationId: orgId }),
    Medicine.distinct('unit', { organizationId: orgId }),
    Compound.find({ organizationId: orgId, status: 'active' }).sort({ compoundName: 1 }).collation(CI).select('compoundName').lean(),
    Attribute.find({ organizationId: orgId, attributeType: { $in: ['dosage_form', 'unit', 'strength'] }, status: 'active' }).select('attributeType values').lean(),
    Attribute.find({ organizationId: orgId, attributeType: 'custom', status: 'active' }).sort({ attributeName: 1 }).collation(CI).select('attributeName values').lean(),
  ]);
  const merge = (used, type) => [...new Set([...used, ...lists.filter((l) => l.attributeType === type).flatMap((l) => l.values)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    categories: categories.map((c) => ({ id: c._id, name: c.attributeName })),
    compounds: compounds.map((c) => ({ id: c._id, name: c.compoundName })),
    manufacturers: manufacturers.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    companies: companies.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    dosageForms: merge(usedForms, 'dosage_form'),
    units: merge(usedUnits, 'unit'),
    strengths: merge([], 'strength'),
    // organization-defined extra fields a medicine can carry (values = allowed values; empty means free text)
    attributeDefs: customDefs.map((d) => ({ id: d._id, name: d.attributeName, values: d.values })),
  };
}

export async function getMedicine(orgId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid identifier', undefined, 'INVALID_ID');
  const [medicine] = await Medicine.aggregate([{ $match: { _id: new mongoose.Types.ObjectId(id), organizationId: orgId } }, ...nameLookups]);
  if (!medicine) throw new ApiError(404, 'Medicine not found');
  const batches = await listBatches(orgId, medicine._id);
  return { ...medicine, batches, ...deriveStock(batches, medicine.reorderLevel) };
}

export async function createMedicine(req, input) {
  const { batch, ...rest } = input;
  try {
    return await withTransaction(async (session) => {
      const fields = await resolveRefs(req, rest, session);
      if (fields.reorderLevel === undefined) {
        // Not given on the form: start from the organization's own default (Common Settings; 10 unless it was changed).
        const org = await Organization.findById(req.orgId, 'settings.general.inventory').lean();
        fields.reorderLevel = org?.settings?.general?.inventory?.defaultLowStockThreshold ?? 10;
      }
      const [m] = await Medicine.create([{ ...fields, organizationId: req.orgId }], { session });
      if (batch) await createBatchInTx(req, m, batch, session);
      await audit(req, { action: 'MEDICINE_CREATE', entity: 'Medicine', entityId: m._id, message: `Medicine added — ${m.medicineName}` }, session);
      return m;
    });
  } catch (e) {
    if (e.code === 11000) throw duplicateField(e);
    throw e;
  }
}

export async function updateMedicine(req, id, input) {
  try {
    const fields = await resolveRefs(req, input);
    const before = await Medicine.findOne({ _id: id, organizationId: req.orgId }).select('isActive').lean();
    if (!before) throw new ApiError(404, 'Medicine not found');
    const update = { $set: fields };
    if (fields.isActive === false && before.isActive) Object.assign(fields, { archivedAt: new Date(), archivedBy: req.user._id });
    if (fields.isActive === true && !before.isActive) update.$unset = { archivedAt: '', archivedBy: '' };

    const medicine = await Medicine.findOneAndUpdate({ _id: id, organizationId: req.orgId }, update, { returnDocument: 'after', runValidators: true });
    if (!medicine) throw new ApiError(404, 'Medicine not found');
    const toggled = before.isActive !== medicine.isActive;
    await audit(req, {
      action: toggled ? (medicine.isActive ? 'MEDICINE_RESTORE' : 'MEDICINE_ARCHIVE') : 'MEDICINE_UPDATE',
      entity: 'Medicine',
      entityId: medicine._id,
      message: toggled ? `Medicine ${medicine.isActive ? 'restored' : 'archived'} — ${medicine.medicineName}` : `Medicine updated — ${medicine.medicineName}`,
    });
    return medicine;
  } catch (e) {
    if (e.code === 11000) throw duplicateField(e);
    throw e;
  }
}

/**
 * DELETE = soft delete. A medicine with any history (batches, stock ledger, invoices) is ARCHIVED: hidden from sale and
 * from the default list, but kept forever and restorable. Only a medicine that never had any history is physically deleted.
 * Returns { deleted, archived } so the caller can say which happened.
 */
export async function removeMedicine(req, id) {
  const medicine = await Medicine.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!medicine) throw new ApiError(404, 'Medicine not found');

  const [hasBatches, hasSales] = await Promise.all([
    Batch.exists({ organizationId: req.orgId, medicineId: medicine._id }),
    Invoice.exists({ organizationId: req.orgId, 'items.medicineId': medicine._id }),
  ]);

  if (!hasBatches && !hasSales) {
    await withTransaction(async (session) => {
      await Medicine.deleteOne({ _id: medicine._id, organizationId: req.orgId }, { session });
      await audit(req, { action: 'MEDICINE_DELETE', entity: 'Medicine', entityId: medicine._id, message: `Medicine deleted — ${medicine.medicineName}` }, session);
    });
    return { deleted: true, archived: false };
  }

  if (medicine.isActive) {
    await withTransaction(async (session) => {
      await Medicine.updateOne({ _id: medicine._id, organizationId: req.orgId }, { $set: { isActive: false, archivedAt: new Date(), archivedBy: req.user._id } }, { session });
      await audit(req, { action: 'MEDICINE_ARCHIVE', entity: 'Medicine', entityId: medicine._id, message: `Medicine archived — ${medicine.medicineName}` }, session);
    });
  }
  return { deleted: false, archived: true };
}

/** Brings an archived medicine back. */
export async function restoreMedicine(req, id) {
  const medicine = await Medicine.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!medicine) throw new ApiError(404, 'Medicine not found');
  if (medicine.isActive) throw new ApiError(409, 'This medicine is not archived.', undefined, 'NOT_ARCHIVED');
  await withTransaction(async (session) => {
    await Medicine.updateOne({ _id: medicine._id, organizationId: req.orgId }, { $set: { isActive: true }, $unset: { archivedAt: '', archivedBy: '' } }, { session });
    await audit(req, { action: 'MEDICINE_RESTORE', entity: 'Medicine', entityId: medicine._id, message: `Medicine restored — ${medicine.medicineName}` }, session);
  });
  return getMedicine(req.orgId, id);
}

/** Sellable medicines (active, with sellable stock) and their earliest-expiry batch, for the Selling Point grid. */
export async function posProducts(orgId, q) {
  const sellFrom = await defaultBranchId(orgId); // the Selling Point sells from the default store
  const filter = { organizationId: orgId, isActive: true };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ medicineName: rx }, { genericName: rx }, { salt: rx }, { hsnCode: rx }, { manufacturer: rx }, { barcode: rx }, { sku: rx }];
  }
  const now = new Date();
  return Medicine.aggregate([
    { $match: filter },
    { $sort: { medicineName: 1 } },
    { $limit: 60 },
    {
      $lookup: {
        from: 'batches',
        let: { id: '$_id', org: '$organizationId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$medicineId', '$$id'] },
                  { $eq: ['$organizationId', '$$org'] },
                  branchExpr(sellFrom, sellFrom),
                  { $eq: ['$status', 'active'] },
                  { $gt: ['$expiryDate', now] },
                  { $gt: [sellableUnitsExpr, 0] },
                ],
              },
            },
          },
          { $sort: { expiryDate: 1 } },
          { $addFields: { sellableQuantity: sellableUnitsExpr } },
          { $project: { batchNumber: 1, expiryDate: 1, sellingPrice: 1, mrp: 1, sellableQuantity: 1 } },
        ],
        as: 'batches',
      },
    },
    { $addFields: { availableStock: { $sum: '$batches.sellableQuantity' }, nextBatch: { $first: '$batches' } } },
    // the GST rate and the pack come too: the Selling Point shows the tax inside the price as the cart is built, and the batch it will sell from
    { $project: { medicineName: 1, genericName: 1, manufacturer: 1, gstPercentage: 1, taxability: 1, unit: 1, packSize: 1, availableStock: 1, nextBatch: 1, batches: 1 } },
  ]);
}
