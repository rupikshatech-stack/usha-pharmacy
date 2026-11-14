// Usage: npm run migrate   (runs after migrate-transfers.js)
// Gives every supplier that predates the Suppliers module its own code (SUP-0001 …), per organization, so suppliers can be searched and quoted by code.
// Idempotent: a supplier that already has a code is left alone, and the counter continues from the highest code in use.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';

const say = (m) => console.log(`[migrate] ${m}`);
let exitCode = 0;

try {
  await connectDb();
  const db = mongoose.connection.db;
  const suppliers = db.collection('suppliers');
  const counters = db.collection('counters');

  let given = 0;
  const orgIds = await suppliers.distinct('organizationId');
  for (const organizationId of orgIds) {
    // continue from whatever is already used, whether it came from this script or from the application
    const used = await suppliers.find({ organizationId, code: { $type: 'string' } }, { projection: { code: 1 } }).toArray();
    let next = used.reduce((max, s) => Math.max(max, Number(/^SUP-(\d+)$/.exec(s.code || '')?.[1] || 0)), 0);

    const todo = await suppliers.find({ organizationId, $or: [{ code: { $exists: false } }, { code: null }, { code: '' }] }, { projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    for (const s of todo) {
      next += 1;
      await suppliers.updateOne({ _id: s._id }, { $set: { code: `SUP-${String(next).padStart(4, '0')}` } });
      given += 1;
    }
    // the application's counter must not hand out a number this script has already used
    await counters.updateOne({ organizationId, key: 'supplier' }, { $max: { seq: next } }, { upsert: true });
  }
  say(`supplier codes given: ${given} (across ${orgIds.length} organization(s))`);

  try {
    await suppliers.createIndex({ organizationId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
    say('supplier code index is in place');
  } catch (e) {
    say(`could not build the supplier code index: ${e.message}`);
    exitCode = 1;
  }
} catch (e) {
  console.error('[migrate] suppliers failed:', e);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
