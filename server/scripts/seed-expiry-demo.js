// Usage: npm run seed:expiry [-- --org="Usha Pharmacy"] [--reset]
//
// Realistic demonstration data for Inventory Expiry Intelligence: medicines, suppliers, lots across EVERY risk level,
// and — crucially — the sales history behind them, because without sales the velocity is nought and every lot looks
// like a total write-off. The point of this data is to show the report distinguishing a fast-moving lot that will
// clear itself from a slow-moving one of the same age that will not.
//
// Safe to re-run: everything it creates is named with the `EXP-` prefix and is matched before being created, so a
// second run updates rather than duplicates. `--reset` removes what an earlier run made and builds it again.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { Attribute, Batch, Branch, Invoice, Medicine, Organization, Supplier, User } from '../models/index.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { replaceDemoSales } from './lib/demoSales.js';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const RESET = process.argv.includes('--reset');
const say = (m) => console.log(`[seed:expiry] ${m}`);

const DAY = 86400000;
const now = new Date();
/** An expiry `days` from today, stored the way the rest of the system stores one: midnight UTC on the day itself. */
const expiryIn = (days) => {
  const d = new Date(now.getTime() + days * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const ago = (days) => new Date(now.getTime() - days * DAY);
const rupees = (n) => Math.round(n * 100) / 100;

/**
 * The cast. `sells` is units a day the demo will actually bill, which is what drives the velocity the report measures
 * — so the risk levels below are produced by the data, not asserted by this script.
 */
const MEDICINES = [
  { name: 'EXP-Paracetamol 650mg', generic: 'Paracetamol', maker: 'Cipla', category: 'Tablets', schedule: 'OTC', hsn: '30049099', strength: '650mg', pack: '15 tablets', cost: 1.2, mrp: 2.5, sells: 40 },
  { name: 'EXP-Amoxicillin 500mg', generic: 'Amoxicillin', maker: 'Sun Pharma', category: 'Capsules', schedule: 'H', hsn: '30042019', strength: '500mg', pack: '10 capsules', cost: 4.5, mrp: 9.0, sells: 12 },
  { name: 'EXP-Azithromycin 500mg', generic: 'Azithromycin', maker: 'Sun Pharma', category: 'Tablets', schedule: 'H', hsn: '30042019', strength: '500mg', pack: '3 tablets', cost: 18.0, mrp: 34.0, sells: 3 },
  { name: 'EXP-Insulin Glargine', generic: 'Insulin Glargine', maker: 'Biocon', category: 'Injections', schedule: 'H', hsn: '30043110', strength: '100IU/ml', pack: '1 vial', cost: 620.0, mrp: 980.0, sells: 0.4 },
  { name: 'EXP-Alprazolam 0.5mg', generic: 'Alprazolam', maker: 'Torrent', category: 'Tablets', schedule: 'H1', hsn: '30049061', strength: '0.5mg', pack: '10 tablets', cost: 2.8, mrp: 6.5, sells: 1.5 },
  { name: 'EXP-Cough Syrup 100ml', generic: 'Dextromethorphan', maker: 'Zydus', category: 'Syrups', schedule: 'OTC', hsn: '30049011', strength: '100ml', pack: '1 bottle', cost: 48.0, mrp: 92.0, sells: 6 },
  { name: 'EXP-Vitamin D3 60k', generic: 'Cholecalciferol', maker: 'Mankind', category: 'Capsules', schedule: 'OTC', hsn: '30045010', strength: '60000IU', pack: '4 capsules', cost: 9.0, mrp: 21.0, sells: 0 },
];

const SUPPLIERS = [
  { name: 'EXP-Medilink Distributors', type: 'distributor', terms: 'net30' },
  { name: 'EXP-Krishna Pharma Agency', type: 'stockist', terms: 'net15' },
  { name: 'EXP-Surya Wholesale Drugs', type: 'wholesaler', terms: 'net45' },
];

/**
 * The lots. Each row says which medicine, how far off its expiry is, how much is on hand and which supplier — and a
 * note saying what it is MEANT to demonstrate, so the output can be read against the intention.
 *   [medicine index, days to expiry, quantity, supplier index (null = none recorded), what it shows]
 */
const LOTS = [
  [0, -45, 900, 0, 'expired with a lot of stock still on it — Critical, and past the supplier window'],
  [0, -10, 120, 0, 'recently expired — Critical, and still inside the return window'],
  [0, 12, 1400, 1, 'fast mover, near date, but 40/day clears it — should NOT read as a big loss'],
  [0, 240, 6000, 1, 'fast mover, far date — Safe'],
  [1, 9, 300, 0, 'moderate mover under 15 days — part of it will not clear'],
  [1, 70, 800, 2, 'the lot behind it: gets only the demand the first one leaves'],
  [2, 25, 400, 2, 'slow mover under 30 days — most of it will not clear, and it is worth real money'],
  [2, 150, 200, 2, 'same medicine, far date — carries the leftover demand'],
  [3, 20, 60, null, 'high value, very slow, NO SUPPLIER recorded — nothing to recover'],
  [3, 400, 40, 0, 'high value but far off — Safe'],
  [4, 5, 250, 1, 'Schedule H1, days away, barely moves — Critical'],
  [5, 55, 180, null, 'mid-range, no supplier, under 90 days'],
  [6, 35, 500, 2, 'sells nothing at all — the whole lot is projected loss'],
  [6, -120, 90, 2, 'long expired, well outside the return window'],
];

let exitCode = 0;
try {
  await connectDb();

  const orgName = arg('org');
  const org = orgName ? await Organization.findOne({ name: orgName }) : await Organization.findOne().sort({ createdAt: 1 });
  if (!org) throw new Error('No organization found. Run `npm run seed` first.');
  const orgId = org._id;
  say(`organization: ${org.name}`);

  // Everything below writes tenant-owned records, which the tenant-scope plugin requires a context for.
  await runWithTenant(orgId, async () => {

  const user = await User.findOne({ organizationId: orgId, role: 'ORG_ADMIN' }).sort({ createdAt: 1 });
  const branch = (await Branch.findOne({ organizationId: orgId, isDefault: true })) || (await Branch.findOne({ organizationId: orgId }));
  if (!branch) throw new Error('No store found for this organization. Create one first.');
  say(`store: ${branch.name}`);

  if (RESET) {
    const names = MEDICINES.map((m) => m.name);
    const meds = await Medicine.find({ organizationId: orgId, medicineName: { $in: names } }).select('_id').lean();
    const ids = meds.map((m) => m._id);
    const removed = await Promise.all([
      Batch.deleteMany({ organizationId: orgId, medicineId: { $in: ids } }),
      Promise.resolve({ deletedCount: 0 }), // demo invoices are replaced below, by replaceDemoSales, which also returns their serials
      Medicine.deleteMany({ organizationId: orgId, _id: { $in: ids } }),
      Supplier.deleteMany({ organizationId: orgId, name: { $in: SUPPLIERS.map((s) => s.name) } }),
    ]);
    say(`reset: removed ${removed[0].deletedCount} lots, ${removed[1].deletedCount} invoices, ${removed[2].deletedCount} medicines, ${removed[3].deletedCount} suppliers`);
  }

  // ---- categories, suppliers, medicines
  const categories = new Map();
  for (const name of [...new Set(MEDICINES.map((m) => m.category))]) {
    const doc = await Attribute.findOneAndUpdate(
      { organizationId: orgId, attributeType: 'category', attributeName: name },
      { $setOnInsert: { organizationId: orgId, attributeType: 'category', attributeName: name } },
      { upsert: true, returnDocument: 'after' },
    );
    categories.set(name, doc._id);
  }
  say(`categories ready: ${categories.size}`);

  const suppliers = [];
  for (const s of SUPPLIERS) {
    suppliers.push(
      await Supplier.findOneAndUpdate(
        { organizationId: orgId, name: s.name },
        { $setOnInsert: { organizationId: orgId, name: s.name, supplierType: s.type, contactPerson: 'Demo Contact', phone: '9000000000', procurement: { paymentTerms: s.terms } } },
        { upsert: true, returnDocument: 'after' },
      ),
    );
  }
  say(`suppliers ready: ${suppliers.length}`);

  const medicines = [];
  for (const m of MEDICINES) {
    medicines.push(
      await Medicine.findOneAndUpdate(
        { organizationId: orgId, medicineName: m.name },
        {
          $set: {
            genericName: m.generic,
            manufacturer: m.maker,
            categoryId: categories.get(m.category),
            scheduleCategory: m.schedule,
            hsnCode: m.hsn,
            strength: m.strength,
            packSize: m.pack,
            unit: 'units',
            defaultMrp: m.mrp,
            defaultPurchasePrice: m.cost,
            isActive: true,
          },
          $setOnInsert: { organizationId: orgId, medicineName: m.name },
        },
        { upsert: true, returnDocument: 'after' },
      ),
    );
  }
  say(`medicines ready: ${medicines.length}`);

  // ---- the lots
  let made = 0;
  let updated = 0;
  const createdBatches = [];
  for (const [mi, days, qty, si, note] of LOTS) {
    const m = MEDICINES[mi];
    const medicine = medicines[mi];
    const batchNumber = `EXP-${String(mi).padStart(2, '0')}-${days >= 0 ? 'P' : 'M'}${Math.abs(days)}`;
    const existing = await Batch.findOne({ organizationId: orgId, medicineId: medicine._id, batchNumber, branchId: branch._id });
    if (existing) {
      // Expiry and the opening quantity are immutable on a Batch, so a re-run only refreshes what can change.
      existing.availableQuantity = qty;
      existing.purchasePrice = m.cost;
      existing.mrp = m.mrp;
      existing.sellingPrice = rupees(m.mrp * 0.92);
      existing.supplierId = si === null ? undefined : suppliers[si]._id;
      await existing.save();
      updated += 1;
      createdBatches.push({ batch: existing, note });
      continue;
    }
    const batch = await Batch.create({
      organizationId: orgId,
      medicineId: medicine._id,
      batchNumber,
      manufacturer: m.maker,
      expiryDate: expiryIn(days),
      purchasePrice: m.cost,
      sellingPrice: rupees(m.mrp * 0.92),
      mrp: m.mrp,
      initialQuantity: qty,
      availableQuantity: qty,
      branchId: branch._id,
      supplierId: si === null ? undefined : suppliers[si]._id,
      status: 'active',
    });
    made += 1;
    createdBatches.push({ batch, note });
  }
  say(`lots created: ${made}, refreshed: ${updated}`);

  // ---- the sales history that gives each medicine a velocity
  // One invoice a day for the last 90 days (the longest velocity window anyone can configure), each carrying the
  // medicines that sell, at the daily rate above. Lines point at a real lot so the rest of the system stays coherent.
  const lotFor = (mi) => createdBatches.find(({ batch }) => String(batch.medicineId) === String(medicines[mi]._id))?.batch;
  const invoices = [];
  for (let d = 90; d >= 1; d--) {
    const items = [];
    for (let mi = 0; mi < MEDICINES.length; mi++) {
      const rate = MEDICINES[mi].sells;
      if (!rate) continue;
      // A fractional rate means it does not sell every day: 0.4/day is two days in five.
      const quantity = rate >= 1 ? Math.round(rate) : d % Math.round(1 / rate) === 0 ? 1 : 0;
      if (!quantity) continue;
      const batch = lotFor(mi);
      if (!batch) continue;
      const price = rupees(MEDICINES[mi].mrp * 0.92);
      items.push({
        medicineId: medicines[mi]._id,
        batchId: batch._id,
        name: MEDICINES[mi].name,
        batchNo: batch.batchNumber,
        quantity,
        price,
        amount: rupees(price * quantity),
        mrp: MEDICINES[mi].mrp,
        expiryDate: batch.expiryDate,
        gstPercent: 12,
        taxableAmount: rupees((price * quantity) / 1.12),
        taxAmount: rupees(price * quantity - (price * quantity) / 1.12),
      });
    }
    if (!items.length) continue;
    const total = rupees(items.reduce((n, i) => n + i.amount, 0));
    invoices.push({
      key: String(d).padStart(3, '0'),
      customer: { name: 'Demo Counter Sale' },
      items,
      subTotal: total,
      taxableAmount: rupees(items.reduce((n, i) => n + i.taxableAmount, 0)),
      taxTotal: rupees(items.reduce((n, i) => n + i.taxAmount, 0)),
      total,
      paid: total,
      due: 0,
      paymentType: 'Cash',
      status: 'completed',
      invoiceDate: ago(d),
    });
  }
  // Numbered through the real series formatter and counter, like any invoice: INV-00008, INV-00009, ... in whatever
  // format this organization has configured. (They used to be EXP-DEMO-001..090, which sat in the sales scope beside
  // real invoices and once raised a real counter to 90.)
  const orgDoc = await Organization.findById(orgId).lean(); // plain, with its numbering settings
  const sales = await replaceDemoSales({ orgId, org: orgDoc, branch, userId: user?._id, drafts: invoices });
  if (sales.note) say(`sales history: ${sales.note}`);
  else say(`sales history: ${sales.created} completed invoices over the last 90 days, numbered ${sales.first} to ${sales.last}${sales.removed ? ` (replaced ${sales.removed}${sales.rewound ? ', serials returned to the series first' : ''})` : ''}`);

  say('');
  say('What this data is meant to show:');
  for (const { batch, note } of createdBatches) {
    const days = Math.round((batch.expiryDate - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);
    say(`  ${batch.batchNumber.padEnd(14)} ${String(days).padStart(5)}d  qty ${String(batch.availableQuantity).padStart(5)}  — ${note}`);
  }
  say('');
  say('Open Business Analytics → Expiry Intelligence, or call GET /api/analytics/expiry/summary.');
  });
} catch (e) {
  console.error(`[seed:expiry] failed: ${e.message}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
