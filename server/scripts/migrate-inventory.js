// Usage: npm run migrate   (runs after migrate-tenancy.js and migrate-dashboard.js)
// Converts existing inventory data to the new inventory schema. Idempotent.
//   medicines : name -> medicineName, gstRate -> gstPercentage, status -> isActive,
//               category/compound text -> Attribute(category) / Compound records (categoryId / compoundId),
//               generic name copied from salt
//   batches   : batchNo -> batchNumber, quantity -> availableQuantity (+ initialQuantity, reservedQuantity, status)
//   ledger    : adds the running balance (balanceAfter) to old entries (the only edit ever made to old entries)
//   indexes   : synced
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { Attribute, Batch, Compound, Medicine, StockMovement } from '../models/index.js';

const say = (m) => console.log(`[migrate] ${m}`);
const CI = { locale: 'en', strength: 2 };
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const medicines = db.collection('medicines');
  const batches = db.collection('batches');
  const movements = db.collection('stockmovements');
  const attributes = db.collection('attributes');
  const compounds = db.collection('compounds');
  const now = new Date();

  // ---- categories & compounds: one record per distinct text value per organization
  const ensure = async (coll, org, nameField, name, extra = {}) => {
    const clean = String(name).trim();
    const found = await coll.findOne({ organizationId: org, ...extra.match, [nameField]: clean }, { collation: CI });
    if (found) return found._id;
    const doc = { organizationId: org, [nameField]: clean, status: 'active', createdAt: now, updatedAt: now, ...extra.doc };
    return (await coll.insertOne(doc)).insertedId;
  };

  let medFixed = 0;
  for (const m of await medicines.find({ $or: [{ medicineName: { $exists: false } }, { name: { $exists: true } }] }).toArray()) {
    const set = {};
    const unset = {};

    if (m.medicineName === undefined) set.medicineName = m.name || 'Unnamed medicine';
    if (m.genericName === undefined) set.genericName = m.salt || '';
    if (m.gstPercentage === undefined) set.gstPercentage = m.gstRate ?? 12;
    if (m.isActive === undefined) set.isActive = m.status ? m.status === 'CONTINUE' : true;
    if (m.description === undefined) set.description = '';
    if (m.image === undefined) set.image = '';

    if (m.category && String(m.category).trim() && !m.categoryId) {
      set.categoryId = await ensure(attributes, m.organizationId, 'attributeName', m.category, { match: { attributeType: 'category' }, doc: { attributeType: 'category', values: [] } });
    }
    if (m.compound && String(m.compound).trim() && !m.compoundId) {
      set.compoundId = await ensure(compounds, m.organizationId, 'compoundName', m.compound, { doc: { composition: String(m.compound).trim(), description: '' } });
    }
    for (const k of ['name', 'gstRate', 'status', 'category', 'compound', 'mrp']) if (k in m) unset[k] = '';

    const op = {};
    if (Object.keys(set).length) op.$set = set;
    if (Object.keys(unset).length) op.$unset = unset;
    if (Object.keys(op).length) {
      await medicines.updateOne({ _id: m._id }, op);
      medFixed++;
    }
  }
  say(`medicines converted: ${medFixed}`);

  // ---- batches
  const medicineById = new Map((await medicines.find({}, { projection: { manufacturer: 1 } }).toArray()).map((m) => [String(m._id), m]));
  const purchased = new Map((await movements.aggregate([{ $match: { type: 'PURCHASE' } }, { $group: { _id: '$batchId', qty: { $sum: '$quantity' } } }]).toArray()).map((r) => [String(r._id), r.qty]));
  let batchFixed = 0;
  for (const b of await batches.find({ $or: [{ batchNumber: { $exists: false } }, { availableQuantity: { $exists: false } }, { batchNo: { $exists: true } }, { quantity: { $exists: true } }] }).toArray()) {
    const available = b.availableQuantity ?? b.quantity ?? 0;
    const set = {};
    if (b.batchNumber === undefined) set.batchNumber = b.batchNo;
    if (b.availableQuantity === undefined) set.availableQuantity = available;
    if (b.initialQuantity === undefined) set.initialQuantity = Math.max(purchased.get(String(b._id)) ?? available, available);
    if (b.reservedQuantity === undefined) set.reservedQuantity = 0;
    if (b.status === undefined) set.status = 'active';
    if (b.manufacturer === undefined) set.manufacturer = medicineById.get(String(b.medicineId))?.manufacturer || '';
    const op = { ...(Object.keys(set).length && { $set: set }), $unset: { ...(b.batchNo !== undefined && { batchNo: '' }), ...(b.quantity !== undefined && { quantity: '' }) } };
    if (!Object.keys(op.$unset).length) delete op.$unset;
    if (Object.keys(op).length) {
      await batches.updateOne({ _id: b._id }, op);
      batchFixed++;
    }
  }
  say(`batches converted: ${batchFixed}`);

  // ---- ledger: running balance on old entries (raw driver: the only maintenance edit the ledger ever receives)
  let ledgerFixed = 0;
  const running = new Map();
  for await (const mv of movements.find({}).sort({ createdAt: 1, _id: 1 })) {
    const key = String(mv.batchId);
    const bal = (running.get(key) ?? 0) + mv.quantity;
    running.set(key, bal);
    if (mv.balanceAfter === undefined) {
      await movements.updateOne({ _id: mv._id }, { $set: { balanceAfter: Math.max(0, bal) } });
      ledgerFixed++;
    }
  }
  say(`ledger entries given a running balance: ${ledgerFixed}`);

  // ---- a barcode / SKU now identifies ONE medicine per organization. Pre-existing duplicates would block the unique
  // index, so keep the code on the oldest medicine, clear it on the others, and say exactly what changed.
  for (const field of ['barcode', 'sku']) {
    const dups = await medicines
      .aggregate([
        { $match: { [field]: { $type: 'string', $gt: '' } } },
        { $sort: { createdAt: 1, _id: 1 } },
        { $group: { _id: { org: '$organizationId', value: `$${field}` }, ids: { $push: '$_id' }, names: { $push: '$medicineName' } } },
        { $match: { 'ids.1': { $exists: true } } },
      ])
      .toArray();
    for (const d of dups) {
      const [keep, ...rest] = d.ids;
      await medicines.updateMany({ _id: { $in: rest } }, { $set: { [field]: '' } });
      say(`duplicate ${field} "${d._id.value}": kept on "${d.names[0]}" (${keep}), cleared on ${rest.length} other medicine(s): ${d.names.slice(1).join(', ')}`);
    }
  }

  // ---- indexes (drops the old ones, builds the new compound/unique ones)
  for (const M of [Medicine, Batch, StockMovement, Compound, Attribute]) {
    try {
      await M.syncIndexes();
      say(`indexes synced: ${M.modelName}`);
    } catch (e) {
      exitCode = 1;
      console.error(`[migrate] index sync failed for ${M.modelName}: ${e.message}`);
    }
  }
  say(exitCode ? 'finished with errors' : 'done');
} catch (err) {
  console.error(`[migrate] Failed: ${err.message}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
