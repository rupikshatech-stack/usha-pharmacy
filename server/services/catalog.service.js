import mongoose from 'mongoose';
import { Attribute, Compound, INGREDIENT_ROLE_LABEL, Medicine } from '../models/index.js';
import { computeFormula, scaleFormula } from '../utils/compoundMath.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';

const CI = { locale: 'en', strength: 2 }; // case-insensitive name matching, same as the unique indexes

/* ---------------- find-or-create (used when a medicine names a category/compound) ---------------- */

/** Finds (case-insensitively) or creates the category with this name. */
export async function findOrCreateCategory(req, name, session) {
  const attributeName = name.trim();
  const find = () => Attribute.findOne({ attributeType: 'category', attributeName }).collation(CI).session(session ?? null);
  const existing = await find();
  if (existing) return existing;
  try {
    const [created] = await Attribute.create([{ attributeType: 'category', attributeName, organizationId: req.orgId }], { session });
    return created;
  } catch (e) {
    if (e.code === 11000) return find(); // created concurrently
    throw e;
  }
}

export async function findOrCreateCompound(req, name, session) {
  const compoundName = name.trim();
  const find = () => Compound.findOne({ compoundName }).collation(CI).session(session ?? null);
  const existing = await find();
  if (existing) return existing;
  try {
    const [created] = await Compound.create([{ compoundName, composition: compoundName, organizationId: req.orgId }], { session });
    return created;
  } catch (e) {
    if (e.code === 11000) return find();
    throw e;
  }
}

/* ---------------- Compounds ---------------- */

const dupMessage = (what) => `${what} with this name already exists`;
const dupError = (what, path) => new ApiError(409, dupMessage(what), [{ path, message: dupMessage(what) }], 'DUPLICATE');
const oid = (id) => new mongoose.Types.ObjectId(id);
const badId = (id) => !mongoose.isValidObjectId(id);

/**
 * A compound as the screens want it. Everything about the preparation — what to weigh for each ingredient, what the
 * base makes up, anything that does not add up — is worked out HERE on every read rather than stored, so it can never
 * disagree with the recipe it came from. A compound with no ingredients is a plain formulation label and simply has
 * no `batch`.
 */
export function presentCompound(c) {
  if (!c?.ingredients?.length) return { ...c, isPreparation: false, batch: null };
  const batch = computeFormula(c);
  return {
    ...c,
    isPreparation: true,
    ingredients: c.ingredients.map((i, n) => ({ ...i, roleLabel: INGREDIENT_ROLE_LABEL[i.role] || i.role, amount: batch.lines[n]?.amount ?? null })),
    batch: { measured: batch.measured, qsAmount: batch.qsAmount, accountedFor: batch.accountedFor, shortfall: batch.shortfall, problems: batch.problems },
    summary: c.totalQuantity ? `${c.totalQuantity} ${c.totalUnit || ''}`.trim() + (c.dosageForm ? ` ${c.dosageForm.toLowerCase()}` : '') : '',
    activeCount: c.ingredients.filter((i) => i.role === 'active').length,
  };
}

/** Ingredients may point at something the pharmacy stocks; it has to be ours, and it has to exist. */
async function checkIngredients(orgId, ingredients) {
  const ids = [...new Set((ingredients || []).map((i) => i.medicineId).filter(Boolean).map(String))];
  if (!ids.length) return;
  const found = await Medicine.countDocuments({ _id: { $in: ids }, organizationId: orgId });
  if (found !== ids.length) {
    throw new ApiError(400, 'One of the ingredients points at a medicine that does not exist.', [{ path: 'ingredients', message: 'Choose ingredients from your own inventory' }], 'UNKNOWN_INGREDIENT');
  }
}

/**
 * A preparation whose ingredients cannot fit the batch is refused: the bench would have to guess, and guessing is how
 * people are hurt. A compound with no ingredients is not a preparation and is left alone.
 */
function assertMakeable(doc) {
  if (!doc?.ingredients?.length) return;
  if (!(Number(doc.totalQuantity) > 0) || !String(doc.totalUnit || '').trim()) {
    throw new ApiError(400, 'Say how much one batch makes, and in what unit.', [{ path: 'totalQuantity', message: 'Enter how much this makes' }], 'FORMULA_INCOMPLETE');
  }
  const { problems } = computeFormula(doc);
  if (problems.length) throw new ApiError(400, problems[0], problems.map((message) => ({ path: 'ingredients', message })), 'FORMULA_NOT_MAKEABLE');
}

/** The same preparation worked out for a different batch size — what the bench needs when a prescription is not the standard size. */
export async function compoundBatch(orgId, id, quantity) {
  const c = await getCompound(orgId, id);
  if (!c.isPreparation) throw new ApiError(400, 'This compound is a formulation label, not a preparation: it has no ingredients to weigh.', undefined, 'NOT_A_PREPARATION');
  const scaled = scaleFormula(c, quantity);
  if (!scaled) throw new ApiError(400, 'Enter a batch size greater than zero.', [{ path: 'quantity', message: 'Enter a batch size greater than zero' }], 'BAD_BATCH');
  return { compoundName: c.compoundName, totalUnit: c.totalUnit, batchQuantity: Number(quantity), ...scaled };
}

/** Compounds with how many medicines use each one. Search is by name or composition. */
export async function listCompounds(orgId, { search, status, page, limit }) {
  const rx = search ? new RegExp(escapeRegex(search), 'i') : null;
  const match = { organizationId: orgId, ...(status && { status }), ...(rx && { $or: [{ compoundName: rx }, { composition: rx }] }) };
  const [result] = await Compound.aggregate([
    { $match: match },
    { $sort: { compoundName: 1, _id: 1 } },
    {
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: 'medicines',
              let: { id: '$_id', org: '$organizationId' },
              pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$compoundId', '$$id'] }, { $eq: ['$organizationId', '$$org'] }] } } }, { $count: 'n' }],
              as: '_n',
            },
          },
          { $addFields: { medicineCount: { $ifNull: [{ $first: '$_n.n' }, 0] } } },
          { $project: { _n: 0 } },
        ],
        count: [{ $count: 'n' }],
      },
    },
  ]).collation(CI);
  return paginated(result.items.map(presentCompound), { page, limit, total: result.count[0]?.n || 0 });
}

/** One compound with the medicines linked to it. */
export async function getCompound(orgId, id) {
  if (badId(id)) throw new ApiError(404, 'Compound not found');
  const c = await Compound.findOne({ _id: id, organizationId: orgId }).lean();
  if (!c) throw new ApiError(404, 'Compound not found');
  const medicines = await Medicine.find({ organizationId: orgId, compoundId: c._id })
    .select('medicineName strength dosageForm manufacturer isActive')
    .sort({ medicineName: 1 })
    .collation(CI)
    .limit(500)
    .lean();
  return { ...presentCompound(c), medicineCount: medicines.length, medicines };
}

export async function createCompound(req, data) {
  await checkIngredients(req.orgId, data.ingredients);
  assertMakeable(data);
  try {
    const [c] = await Compound.create([{ ...data, organizationId: req.orgId, createdBy: req.user._id, createdByName: req.user.name }]);
    await audit(req, { action: 'COMPOUND_CREATE', entity: 'Compound', entityId: c._id, message: `Compound added — ${c.compoundName}${c.ingredients?.length ? ` (preparation, ${c.ingredients.length} ingredients)` : ''}`, meta: { ingredients: c.ingredients?.length || 0 } });
    return presentCompound(c.toObject());
  } catch (e) {
    if (e.code === 11000) throw dupError('A compound', 'compoundName');
    throw e;
  }
}

export async function updateCompound(req, id, data) {
  if (badId(id)) throw new ApiError(404, 'Compound not found');
  const before = await Compound.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!before) throw new ApiError(404, 'Compound not found');
  await checkIngredients(req.orgId, data.ingredients);
  // whatever is being changed, the result as a whole has to be makeable
  assertMakeable({ ...before, ...data });
  try {
    const c = await Compound.findOneAndUpdate(
      { _id: id, organizationId: req.orgId },
      { $set: { ...data, updatedBy: req.user._id, updatedByName: req.user.name } },
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (!c) throw new ApiError(404, 'Compound not found');
    await audit(req, { action: 'COMPOUND_UPDATE', entity: 'Compound', entityId: c._id, message: `Compound updated — ${c.compoundName}`, meta: { changed: Object.keys(data) } });
    return presentCompound(c);
  } catch (e) {
    if (e.code === 11000) throw dupError('A compound', 'compoundName');
    throw e;
  }
}

/** Only a compound no medicine uses can be deleted; otherwise archive it (status "inactive"). */
export async function deleteCompound(req, id) {
  if (badId(id)) throw new ApiError(404, 'Compound not found');
  const c = await Compound.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!c) throw new ApiError(404, 'Compound not found');
  if (await Medicine.exists({ organizationId: req.orgId, compoundId: c._id })) {
    throw new ApiError(409, 'This compound is linked to medicines. Archive it (mark it inactive) instead of deleting.', undefined, 'IN_USE');
  }
  await Compound.deleteOne({ _id: c._id, organizationId: req.orgId });
  await audit(req, { action: 'COMPOUND_DELETE', entity: 'Compound', entityId: c._id, message: `Compound deleted — ${c.compoundName}` });
}

/** Links medicines to a compound (a medicine has at most one; linking moves it). Only this organization's medicines are touched. */
export async function linkMedicines(req, id, medicineIds) {
  if (badId(id)) throw new ApiError(404, 'Compound not found');
  const c = await Compound.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!c) throw new ApiError(404, 'Compound not found');
  if (c.status !== 'active') throw new ApiError(409, 'This compound is archived. Reactivate it before linking medicines.', undefined, 'COMPOUND_INACTIVE');
  const ids = [...new Set(medicineIds)].map(oid);
  const found = await Medicine.countDocuments({ organizationId: req.orgId, _id: { $in: ids } });
  if (found !== ids.length) throw new ApiError(404, 'One or more medicines were not found');
  await Medicine.updateMany({ organizationId: req.orgId, _id: { $in: ids } }, { $set: { compoundId: c._id } });
  // medicines with no salt text take the compound's name, so lists and search still show something meaningful
  await Medicine.updateMany({ organizationId: req.orgId, _id: { $in: ids }, $or: [{ salt: '' }, { salt: { $exists: false } }] }, { $set: { salt: c.compoundName } });
  await audit(req, { action: 'COMPOUND_LINK', entity: 'Compound', entityId: c._id, message: `${ids.length} medicine(s) linked to compound ${c.compoundName}`, meta: { medicineIds: ids } });
  return getCompound(req.orgId, id);
}

export async function unlinkMedicine(req, id, medicineId) {
  if (badId(id) || badId(medicineId)) throw new ApiError(404, 'Not found');
  const c = await Compound.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!c) throw new ApiError(404, 'Compound not found');
  const r = await Medicine.updateOne({ _id: medicineId, organizationId: req.orgId, compoundId: c._id }, { $unset: { compoundId: '' } });
  if (!r.matchedCount) throw new ApiError(404, 'That medicine is not linked to this compound');
  await audit(req, { action: 'COMPOUND_UNLINK', entity: 'Compound', entityId: c._id, message: `Medicine unlinked from compound ${c.compoundName}`, meta: { medicineId } });
  return getCompound(req.orgId, id);
}

/* ---------------- Attributes ---------------- */

/**
 * Which medicines "use" an attribute:
 *   category – medicines in that category          dosage_form / strength / unit – medicines whose value is in the list
 *   custom   – medicines that carry this attribute (a named extra field)
 */
function usageFilter(orgId, a) {
  const base = { organizationId: orgId };
  switch (a.attributeType) {
    case 'category': return { ...base, categoryId: a._id };
    case 'dosage_form': return { ...base, dosageForm: { $in: a.values } };
    case 'strength': return { ...base, strength: { $in: a.values } };
    case 'unit': return { ...base, unit: { $in: a.values } };
    default: return { ...base, attributes: { $elemMatch: { key: new RegExp(`^${escapeRegex(a.attributeName)}$`, 'i') } } };
  }
}
const usageCount = (orgId, a) => (a.attributeType !== 'category' && a.attributeType !== 'custom' && !a.values?.length ? 0 : Medicine.countDocuments(usageFilter(orgId, a)));

export async function listAttributes(orgId, { type, search, status, page, limit }) {
  const filter = {
    organizationId: orgId,
    ...(type && { attributeType: type }),
    ...(status && { status }),
    ...(search && { $or: [{ attributeName: new RegExp(escapeRegex(search), 'i') }, { values: new RegExp(escapeRegex(search), 'i') }] }),
  };
  const [rows, total] = await Promise.all([
    Attribute.find(filter).sort({ attributeType: 1, attributeName: 1 }).collation(CI).skip((page - 1) * limit).limit(limit).lean(),
    Attribute.countDocuments(filter),
  ]);
  const items = await Promise.all(rows.map(async (a) => ({ ...a, medicineCount: await usageCount(orgId, a) })));
  return paginated(items, { page, limit, total });
}

export async function createAttribute(req, data) {
  try {
    const [a] = await Attribute.create([{ ...data, organizationId: req.orgId }]);
    await audit(req, { action: 'ATTRIBUTE_CREATE', entity: 'Attribute', entityId: a._id, message: `Attribute added — ${a.attributeName} (${a.attributeType})` });
    return a;
  } catch (e) {
    if (e.code === 11000) throw dupError('An attribute of this type', 'attributeName');
    throw e;
  }
}

export async function updateAttribute(req, id, data) {
  try {
    if (badId(id)) throw new ApiError(404, 'Attribute not found');
    const before = await Attribute.findOne({ _id: id, organizationId: req.orgId }).lean();
    if (!before) throw new ApiError(404, 'Attribute not found');
    // The type is fixed once created (medicines may point at it).
    const a = await Attribute.findOneAndUpdate({ _id: id, organizationId: req.orgId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
    // Renaming a custom attribute renames it on every medicine that carries it, so nothing is orphaned.
    if (a.attributeType === 'custom' && data.attributeName && data.attributeName !== before.attributeName) {
      await Medicine.updateMany(
        { organizationId: req.orgId, 'attributes.key': before.attributeName },
        { $set: { 'attributes.$[e].key': a.attributeName } },
        { arrayFilters: [{ 'e.key': before.attributeName }] },
      );
    }
    await audit(req, {
      action: 'ATTRIBUTE_UPDATE',
      entity: 'Attribute',
      entityId: a._id,
      message: `Attribute updated — ${a.attributeName} (${Object.keys(data).join(', ')})`,
      meta: { before: { attributeName: before.attributeName, values: before.values, status: before.status }, after: { attributeName: a.attributeName, values: a.values, status: a.status } },
    });
    return a;
  } catch (e) {
    if (e.code === 11000) throw dupError('An attribute of this type', 'attributeName');
    throw e;
  }
}

/** Categories and custom attributes that medicines carry can't be deleted (disable them instead). Value lists can. */
export async function deleteAttribute(req, id) {
  if (badId(id)) throw new ApiError(404, 'Attribute not found');
  const a = await Attribute.findOne({ _id: id, organizationId: req.orgId }).lean();
  if (!a) throw new ApiError(404, 'Attribute not found');
  if ((a.attributeType === 'category' || a.attributeType === 'custom') && (await usageCount(req.orgId, a)) > 0) {
    throw new ApiError(409, `This ${a.attributeType === 'category' ? 'category' : 'attribute'} is used by medicines. Disable it instead of deleting.`, undefined, 'IN_USE');
  }
  await Attribute.deleteOne({ _id: a._id, organizationId: req.orgId });
  await audit(req, { action: 'ATTRIBUTE_DELETE', entity: 'Attribute', entityId: a._id, message: `Attribute deleted — ${a.attributeName}` });
}

/**
 * Checks the custom attributes attached to a medicine against this organization's definitions: an ACTIVE definition
 * with allowed values only accepts those values. Names with no definition (or a disabled one) stay free-form.
 */
export async function assertAttributeValues(orgId, attributes) {
  if (!attributes?.length) return;
  const defs = await Attribute.find({ organizationId: orgId, attributeType: 'custom', status: 'active', 'values.0': { $exists: true } }).lean();
  if (!defs.length) return;
  const byName = new Map(defs.map((d) => [d.attributeName.toLowerCase(), d]));
  const problems = [];
  attributes.forEach((x, i) => {
    const d = byName.get(String(x.key).toLowerCase());
    if (d && x.value !== '' && !d.values.some((v) => v.toLowerCase() === String(x.value).toLowerCase())) {
      problems.push({ path: `attributes.${i}.value`, message: `"${x.value}" is not an allowed value for ${d.attributeName}. Allowed: ${d.values.join(', ')}` });
    }
  });
  if (problems.length) throw new ApiError(400, problems[0].message, problems, 'INVALID_ATTRIBUTE_VALUE');
}
