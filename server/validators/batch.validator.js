import { z } from 'zod';
import { BATCH_STATUSES } from '../models/Batch.js';
import { BATCH_SORTABLE, BATCH_STOCK_STATUSES, EXPIRY_FILTERS } from '../services/batchCatalog.service.js';
import { batchSchema } from './medicine.validator.js';
import { objectId, pageQuery } from './common.js';

const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const oneOf = (values) => z.preprocess(blankToUndefined, z.enum(values).optional());

export const listBatchesQuery = pageQuery(10).extend({
  search: z.string().trim().max(100).optional().default(''), // medicine name, batch number, SKU or barcode
  medicineId: z.preprocess(blankToUndefined, objectId.optional()),
  branchId: z.preprocess(blankToUndefined, objectId.optional()), // only batches held in this store
  manufacturer: z.string().trim().max(120).optional().default(''),
  expiry: oneOf(EXPIRY_FILTERS), // expired | 30 | 60 | 90 | valid
  stock: oneOf(BATCH_STOCK_STATUSES),
  archived: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['exclude', 'include', 'only']).optional().default('exclude')), // empty = default
  sortBy: z.enum(BATCH_SORTABLE).optional().default('expiryDate'),
  sortDir: z.enum(['asc', 'desc']).optional().default('asc'),
});

/** Receiving a batch from the batch page: the medicine is named in the body, the rest is the usual batch rules. */
export const createBatchSchema = z.object({ medicineId: objectId }).and(batchSchema);

/** Same permitted fields as editing from a medicine: prices, manufacturer, status, reserved quantity. */
export { updateBatchSchema } from './medicine.validator.js';

export const batchMovementsQuery = pageQuery(20);

export { BATCH_STATUSES };
