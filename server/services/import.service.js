import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Batch, ImportJob, Medicine, Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { toCsv } from '../utils/csv.js';
import { paginated } from '../utils/pagination.js';
import { audit } from './audit.service.js';
import { createBatchInTx } from './batch.service.js';
import { defaultBranchId, inBranch } from './branch.service.js';
import { findOrCreateCategory, findOrCreateCompound } from './catalog.service.js';
import { ImportFileError, MAX_FILE_BYTES, nameKey, readCsv, templateRows, validateRow } from './importValidation.js';
import { withTransaction } from './transaction.service.js';

/**
 * CSV inventory import.
 *
 *  1. PREVIEW  – the browser sends the CSV text. The server parses it, validates EVERY row, checks duplicates inside the
 *                file and against this organization's existing data, and stores the outcome as an ImportJob. Nothing is
 *                written to the inventory.
 *  2. CONFIRM  – by job id only (the browser sends no data). The server re-validates the stored rows against the data as it
 *                is NOW, then imports.
 *
 * Transaction strategy: the unit of work is ONE MEDICINE — the medicine (if new) plus all its batches, their opening
 * ledger entries and the audit entry commit together in a single MongoDB transaction, or not at all. A medicine that
 * fails rolls back alone and is reported; it never leaves half a medicine behind, and it doesn't stop the others.
 * Every row of the file ends up with a status: imported, skipped (already exists), invalid (never attempted) or failed
 * (attempted, rolled back) — so the result always says exactly which records succeeded.
 *
 * Duplicates: re-importing the same file is safe. A medicine that exists (matched by SKU, barcode or name+strength+form
 * +manufacturer) is never re-created or changed, and a batch number that already exists for it is skipped.
 */

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const CI = { locale: 'en', strength: 2 };
const lc = (s) => (s || '').toLowerCase();

export function templateCsv() {
  return { fileName: 'usha-inventory-import-template.csv', csv: toCsv(templateRows()) };
}

/* ------------------------------------------------------------------------------------------------ analysis */

/**
 * Validates parsed rows against themselves and the database. Returns the per-row results (what the user sees), plus a
 * plan: one entry per medicine with the rows to write.
 */
export async function analyze(orgId, parsedRows, now = new Date()) {
  const items = parsedRows.map((r) => ({ rowNumber: r.rowNumber, ...validateRow(r.cells, now) }));
  const err = (item, field, message) => item.errors.push({ field, message });

  // ---- 1. consistency inside the file
  const groups = new Map(); // nameKey -> group
  const skuOwner = new Map();
  const barcodeOwner = new Map();
  const batchSeen = new Map();
  for (const item of items) {
    if (!item.medicine.medicineName) continue;
    const key = nameKey(item.medicine);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, name: item.medicine.medicineName, sku: '', barcode: '', items: [] }));
    g.items.push(item);

    for (const [field, label, owner] of [['sku', 'SKU', skuOwner], ['barcode', 'Barcode', barcodeOwner]]) {
      const v = item.medicine[field];
      if (!v || item.errors.some((e) => e.field === field)) continue;
      const other = owner.get(lc(v));
      if (other && other.key !== key) {
        err(item, field, `${label} ${v} is also used by a different medicine in row ${other.row} of this file`);
      } else if (g[field] && g[field] !== lc(v)) {
        err(item, field, `This medicine already has a different ${label} in this file; a medicine can have only one ${label}`);
      } else {
        if (!other) owner.set(lc(v), { key, row: item.rowNumber }); // remember the FIRST row that used it
        g[field] = lc(v);
        g[`${field}Raw`] = v;
      }
    }
    if (item.batch?.batchNumber && !item.errors.some((e) => e.field === 'batchNumber')) {
      const bk = `${key}|${item.batch.batchNumber}`;
      if (batchSeen.has(bk)) err(item, 'batchNumber', `Duplicate batch: row ${batchSeen.get(bk)} already has batch ${item.batch.batchNumber} for this medicine`);
      else batchSeen.set(bk, item.rowNumber);
    }
  }

  // ---- 2. match against existing medicines of THIS organization
  const gs = [...groups.values()];
  const skus = [...new Set(gs.map((g) => g.skuRaw).filter(Boolean))];
  const barcodes = [...new Set(gs.map((g) => g.barcodeRaw).filter(Boolean))];
  const names = [...new Set(gs.map((g) => g.name))];
  const existing = names.length
    ? await Medicine.find({ organizationId: orgId, $or: [{ sku: { $in: skus } }, { barcode: { $in: barcodes } }, { medicineName: { $in: names } }] })
        .collation(CI)
        .select('medicineName strength dosageForm manufacturer sku barcode isActive')
        .lean()
    : [];
  const bySku = new Map(existing.filter((m) => m.sku).map((m) => [lc(m.sku), m]));
  const byBarcode = new Map(existing.filter((m) => m.barcode).map((m) => [lc(m.barcode), m]));
  const byKey = new Map(existing.map((m) => [nameKey(m), m]));

  for (const g of gs) {
    const bySkuHit = g.sku && bySku.get(g.sku);
    const byBarcodeHit = g.barcode && byBarcode.get(g.barcode);
    const fail = (field, message) => g.items.forEach((it) => err(it, field, message));
    let match = null;

    if (bySkuHit && byBarcodeHit && String(bySkuHit._id) !== String(byBarcodeHit._id)) {
      fail('sku', `SKU ${g.skuRaw} belongs to "${bySkuHit.medicineName}" but barcode ${g.barcodeRaw} belongs to "${byBarcodeHit.medicineName}"`);
    } else if ((match = bySkuHit || byBarcodeHit)) {
      const field = bySkuHit ? 'sku' : 'barcode';
      if (lc(match.medicineName) !== lc(g.name)) {
        fail(field, `${field === 'sku' ? 'SKU' : 'Barcode'} ${field === 'sku' ? g.skuRaw : g.barcodeRaw} already belongs to the existing medicine "${match.medicineName}"`);
        match = null;
      }
    } else if ((match = byKey.get(g.key))) {
      if (g.sku && match.sku && lc(match.sku) !== g.sku) {
        fail('sku', `"${match.medicineName}" already exists with SKU ${match.sku}, but the file says ${g.skuRaw}`);
        match = null;
      }
    }
    if (match && !match.isActive) {
      fail('medicineName', `"${match.medicineName}" is archived. Restore it before importing stock for it`);
      match = null;
    }
    g.existing = match;
  }

  // ---- 3. batches that already exist for matched medicines
  const matchedIds = [...new Set(gs.filter((g) => g.existing).map((g) => g.existing._id))];
  const numbers = [...new Set(gs.filter((g) => g.existing).flatMap((g) => g.items.map((i) => i.batch?.batchNumber).filter(Boolean)))];
  const mainStore = await defaultBranchId(orgId);
  const haveBatches = matchedIds.length && numbers.length ? await Batch.find({ organizationId: orgId, medicineId: { $in: matchedIds }, batchNumber: { $in: numbers }, ...inBranch(mainStore, mainStore) }).select('medicineId batchNumber').lean() : [];
  const batchExists = new Set(haveBatches.map((b) => `${b.medicineId}|${b.batchNumber}`));

  // ---- 4. final status of every row, and the plan
  const plan = [];
  for (const g of gs) {
    const ok = g.items.filter((i) => i.errors.length === 0);
    const entry = { key: g.key, existing: g.existing, medicine: null, rows: [] };
    let creator = null;
    for (const it of items.filter((x) => g.items.includes(x))) {
      if (it.errors.length) continue;
      if (g.existing) {
        if (!it.batch) {
          it.status = 'skipped';
          it.message = 'The medicine already exists, so nothing was changed';
        } else if (batchExists.has(`${g.existing._id}|${it.batch.batchNumber}`)) {
          it.status = 'skipped';
          it.message = `Batch ${it.batch.batchNumber} already exists for this medicine`;
        } else {
          it.status = 'valid';
          it.action = 'add_batch';
        }
      } else if (!creator && ok.includes(it)) {
        creator = it;
        it.status = 'valid';
        it.action = it.batch ? 'create_medicine_with_batch' : 'create_medicine';
        entry.medicine = it.medicine;
      } else if (it.batch) {
        it.status = 'valid';
        it.action = 'add_batch';
      } else {
        it.status = 'skipped';
        it.message = `The medicine is already defined by row ${creator.rowNumber}`;
      }
      if (it.status === 'valid') entry.rows.push(it);
    }
    if (entry.rows.length) plan.push(entry);
  }

  const results = items.map((it) => ({
    row: it.rowNumber,
    status: it.errors.length ? 'invalid' : it.status || 'invalid',
    action: it.errors.length ? undefined : it.action,
    medicineName: it.medicine.medicineName,
    sku: it.medicine.sku || undefined,
    barcode: it.medicine.barcode || undefined,
    batchNumber: it.batch?.batchNumber || undefined,
    errors: it.errors,
    message: it.errors.length ? it.errors.map((e) => e.message).join('; ') : it.message,
  }));
  // a row whose name is blank is in no group, and has errors already -> 'invalid' above
  return { results, plan, items };
}

const count = (results, status) => results.filter((r) => r.status === status).length;
const summaryOf = (results) => ({
  total: results.length,
  valid: count(results, 'valid') + count(results, 'imported') + count(results, 'failed'),
  invalid: count(results, 'invalid'),
  skipped: count(results, 'skipped'),
  imported: count(results, 'imported'),
  failed: count(results, 'failed'),
});

/* ------------------------------------------------------------------------------------------------ preview */

const present = (job) => {
  const o = job.toObject ? job.toObject() : job;
  delete o.parsedRows;
  return o;
};

export async function previewImport(req, { text, fileName, contentType }) {
  const name = (fileName || '').trim();
  if (!/\.csv$/i.test(name)) throw new ApiError(415, 'Only .csv files can be imported.', undefined, 'IMPORT_FILE_TYPE');
  if (contentType && !/^(text\/csv|text\/plain|application\/csv|application\/vnd\.ms-excel)/i.test(contentType)) {
    throw new ApiError(415, 'Only .csv files can be imported.', undefined, 'IMPORT_FILE_TYPE');
  }
  const size = Buffer.byteLength(text || '', 'utf8');
  if (size > MAX_FILE_BYTES) throw new ApiError(413, `The file is ${(size / 1048576).toFixed(1)} MB. The limit is ${MAX_FILE_BYTES / 1048576} MB.`, undefined, 'IMPORT_FILE_SIZE');

  let parsed;
  try {
    parsed = readCsv(text);
  } catch (e) {
    if (e instanceof ImportFileError) throw new ApiError(e.status, e.message, undefined, 'IMPORT_FILE');
    throw e;
  }
  const { results } = await analyze(req.orgId, parsed.rows);
  const checksum = crypto.createHash('sha256').update(text).digest('hex');

  const warnings = [];
  if (parsed.ignored.length) warnings.push(`Ignored unknown column${parsed.ignored.length > 1 ? 's' : ''}: ${parsed.ignored.join(', ')}`);
  const before = await ImportJob.findOne({ organizationId: req.orgId, checksum, status: { $in: ['completed', 'completed_with_errors'] } }).sort({ completedAt: -1 }).select('completedAt').lean();
  if (before) warnings.push(`This exact file was already imported on ${before.completedAt.toISOString().slice(0, 10)}. Rows that exist already will be skipped.`);

  const job = await ImportJob.create({
    organizationId: req.orgId,
    fileName: name.slice(0, 255),
    fileSize: size,
    checksum,
    status: 'previewed',
    summary: summaryOf(results),
    warnings,
    rows: results,
    parsedRows: parsed.rows,
    createdBy: req.user._id,
  });
  return present(job);
}

/* ------------------------------------------------------------------------------------------------ confirm */

const friendlyDbError = (e) =>
  e?.code === 11000
    ? 'Another record with the same SKU, barcode or batch number was created while importing. Run the import again — records that exist are skipped.'
    : e?.name === 'ValidationError'
      ? Object.values(e.errors)[0]?.message || e.message
      : e?.message || 'Unexpected error';

/** Writes one medicine (and its batches) in a single transaction, setting the status of each of its rows. */
async function importGroup(req, entry, jobId) {
  const outcome = { medicine: 0, batches: 0, rows: [] };
  await withTransaction(async (session) => {
    outcome.medicine = 0;
    outcome.batches = 0;
    outcome.rows = []; // reset: the transaction function may be retried

    let medicine;
    if (entry.existing) {
      medicine = await Medicine.findOne({ _id: entry.existing._id, organizationId: req.orgId }, null, { session }).lean();
      if (!medicine || !medicine.isActive) throw new ApiError(409, 'The medicine was archived or removed during the import.');
    } else {
      const m = entry.medicine;
      const fields = {
        organizationId: req.orgId,
        medicineName: m.medicineName, genericName: m.genericName, salt: m.salt, manufacturer: m.manufacturer, dosageForm: m.dosageForm,
        strength: m.strength, packSize: m.packSize, unit: m.unit, hsnCode: m.hsnCode, gstPercentage: m.gstPercentage,
        reorderLevel: m.reorderLevel, description: m.description, sku: m.sku, barcode: m.barcode, attributes: [], isActive: true,
      };
      // A sheet that leaves the column blank gets the organization's default reorder level (10 unless it was changed).
      if (m.reorderLevelBlank) {
        const org = await Organization.findById(req.orgId, 'settings.general.inventory', { session }).lean();
        fields.reorderLevel = org?.settings?.general?.inventory?.defaultLowStockThreshold ?? 10;
      }
      if (m.category) fields.categoryId = (await findOrCreateCategory(req, m.category, session))._id;
      if (m.salt && m.salt.length <= 150) fields.compoundId = (await findOrCreateCompound(req, m.salt, session))._id;
      [medicine] = await Medicine.create([fields], { session });
      outcome.medicine = 1;
    }

    for (const item of entry.rows) {
      if (item.action === 'create_medicine') {
        outcome.rows.push({ item, status: 'imported', message: 'Medicine created' });
        continue;
      }
      const mainStore = await defaultBranchId(req.orgId, session);
      const dupe = await Batch.exists({ organizationId: req.orgId, medicineId: medicine._id, batchNumber: item.batch.batchNumber, ...inBranch(mainStore, mainStore) }).session(session);
      if (dupe) {
        outcome.rows.push({ item, status: 'skipped', message: `Batch ${item.batch.batchNumber} already exists for this medicine` });
        continue;
      }
      await createBatchInTx(req, medicine, item.batch, session);
      outcome.batches += 1;
      outcome.rows.push({ item, status: 'imported', message: item.action === 'create_medicine_with_batch' ? 'Medicine and batch created' : 'Batch added' });
    }
    await audit(
      req,
      {
        action: 'INVENTORY_IMPORT',
        entity: 'Medicine',
        entityId: medicine._id,
        message: `Imported from CSV — ${medicine.medicineName} (${outcome.medicine ? 'new medicine, ' : ''}${outcome.batches} batch${outcome.batches === 1 ? '' : 'es'})`,
        meta: { importId: jobId },
      },
      session,
    );
  });
  return outcome;
}

export async function confirmImport(req, id, { skipInvalid = false } = {}) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Import not found');
  const found = await ImportJob.findOne({ _id: id, organizationId: req.orgId }).select('status createdAt').lean();
  if (!found) throw new ApiError(404, 'Import not found');
  if (found.status !== 'previewed') {
    throw new ApiError(409, found.status === 'cancelled' ? 'This import was cancelled. Upload the file again.' : 'This import has already been confirmed. Each upload can be imported only once.', undefined, 'IMPORT_NOT_PENDING');
  }
  if (Date.now() - found.createdAt.getTime() > PREVIEW_TTL_MS) {
    await ImportJob.updateOne({ _id: id, organizationId: req.orgId, status: 'previewed' }, { $set: { status: 'cancelled', error: 'Preview expired' }, $unset: { parsedRows: '' } });
    throw new ApiError(410, 'This preview is more than 24 hours old. Upload the file again.', undefined, 'IMPORT_EXPIRED');
  }

  // Claim the job atomically, so two clicks (or two tabs) can never import it twice.
  const job = await ImportJob.findOneAndUpdate(
    { _id: id, organizationId: req.orgId, status: 'previewed' },
    { $set: { status: 'importing', confirmedBy: req.user._id, confirmedAt: new Date() } },
    { returnDocument: 'after' },
  ).select('+parsedRows');
  if (!job) throw new ApiError(409, 'This import has already been confirmed.', undefined, 'IMPORT_NOT_PENDING');

  let analysis;
  try {
    analysis = await analyze(req.orgId, job.parsedRows);
  } catch (e) {
    await ImportJob.updateOne({ _id: id, organizationId: req.orgId }, { $set: { status: 'previewed' } });
    throw e;
  }
  const invalid = count(analysis.results, 'invalid');
  if (invalid > 0 && !skipInvalid) {
    await ImportJob.updateOne({ _id: id, organizationId: req.orgId }, { $set: { status: 'previewed', rows: analysis.results, summary: summaryOf(analysis.results) } });
    throw new ApiError(409, `${invalid} row${invalid === 1 ? ' has' : 's have'} errors. Fix the file, or confirm again to import only the valid rows.`, undefined, 'IMPORT_HAS_INVALID');
  }

  // ---- write, one medicine at a time; every row ends with a status
  const { results, plan } = analysis;
  const byRow = new Map(results.map((r) => [r.row, r]));
  let medicinesCreated = 0;
  let batchesCreated = 0;
  let stopped = null;
  let faults = 0; // unexpected failures in a row (not data problems): three in a row means the database is unwell, so stop

  for (const entry of plan) {
    if (stopped) break;
    try {
      const out = await importGroup(req, entry, job._id);
      faults = 0;
      medicinesCreated += out.medicine;
      batchesCreated += out.batches;
      for (const { item, status, message } of out.rows) Object.assign(byRow.get(item.rowNumber), { status, message });
    } catch (e) {
      const message = friendlyDbError(e);
      for (const item of entry.rows) Object.assign(byRow.get(item.rowNumber), { status: 'failed', message: `Rolled back: ${message}` });
      const dataProblem = e instanceof ApiError || e?.code === 11000 || e?.name === 'ValidationError';
      faults = dataProblem ? 0 : faults + 1;
      if (faults >= 3) stopped = e; // the rest is reported as "not processed"
    }
  }
  for (const r of results) {
    if (r.status === 'valid') Object.assign(r, { status: 'failed', message: 'Not processed: the import stopped before this row' });
  }

  const summary = summaryOf(results);
  const status = stopped && summary.imported === 0 ? 'failed' : summary.invalid > 0 || summary.failed > 0 ? 'completed_with_errors' : 'completed';
  const done = await ImportJob.findOneAndUpdate(
    { _id: id, organizationId: req.orgId },
    { $set: { status, rows: results, summary, medicinesCreated, batchesCreated, completedAt: new Date(), ...(stopped && { error: friendlyDbError(stopped) }) }, $unset: { parsedRows: '' } },
    { returnDocument: 'after' },
  );
  await audit(req, {
    action: 'INVENTORY_IMPORT',
    entity: 'ImportJob',
    entityId: job._id,
    message: `CSV import ${job.fileName}: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.invalid} invalid, ${summary.failed} failed (of ${summary.total})`,
    meta: { importId: job._id, ...summary, medicinesCreated, batchesCreated },
  });
  return present(done);
}

export async function cancelImport(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Import not found');
  if (!(await ImportJob.exists({ _id: id, organizationId: req.orgId }))) throw new ApiError(404, 'Import not found');
  const job = await ImportJob.findOneAndUpdate({ _id: id, organizationId: req.orgId, status: 'previewed' }, { $set: { status: 'cancelled' }, $unset: { parsedRows: '' } }, { returnDocument: 'after' });
  if (!job) throw new ApiError(409, 'Only an import that has not been confirmed can be cancelled.', undefined, 'IMPORT_NOT_PENDING');
  return present(job);
}

/* ------------------------------------------------------------------------------------------------ history */

export async function listImports(orgId, { page, limit }) {
  const [items, total] = await Promise.all([
    ImportJob.find({ organizationId: orgId, status: { $ne: 'cancelled' } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-rows -parsedRows')
      .populate({ path: 'createdBy', select: 'name', options: { lean: true } })
      .lean(),
    ImportJob.countDocuments({ organizationId: orgId, status: { $ne: 'cancelled' } }),
  ]);
  return paginated(items, { page, limit, total });
}

export async function getImport(orgId, id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Import not found');
  const job = await ImportJob.findOne({ _id: id, organizationId: orgId }).populate({ path: 'createdBy', select: 'name' });
  if (!job) throw new ApiError(404, 'Import not found');
  return present(job);
}
