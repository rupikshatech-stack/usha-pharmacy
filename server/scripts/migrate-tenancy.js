// Usage: npm run migrate
// Upgrades an existing database to the multi-tenant schema. Safe to run repeatedly (idempotent):
//   - organizations: adds slug (unique) and the profile fields
//   - users: status -> isActive, MANAGER/CASHIER -> new role names, adds permissions
//   - creates/updates all indexes
// Works on the raw collections, so it can run while models enforce tenant scoping.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { Organization, User, Medicine, Batch, Invoice, StockMovement, AuditLog, Counter, Session } from '../models/index.js';
import { slugify } from '../utils/slug.js';

const ROLE_MAP = { MANAGER: 'BRANCH_MANAGER', CASHIER: 'BILLING_STAFF' };
const log = [];
const say = (m) => {
  log.push(m);
  console.log(`[migrate] ${m}`);
};

let exitCode = 0;
try {
  await connectDb();
  const db = mongoose.connection.db;

  // ---- organizations
  const orgs = db.collection('organizations');
  const used = new Set((await orgs.find({ slug: { $type: 'string' } }, { projection: { slug: 1 } }).toArray()).map((o) => o.slug));
  let orgFixed = 0;
  for (const o of await orgs.find({}).toArray()) {
    const set = {};
    if (!o.slug) {
      const base = slugify(o.name);
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      set.slug = slug;
    }
    for (const [k, v] of Object.entries({ email: '', phone: '', gstin: '', logo: '', status: 'active' })) if (o[k] === undefined) set[k] = v;
    if (!o.address) set.address = { line1: '', line2: '', city: '', state: '', pincode: '', country: 'India' };
    if (Object.keys(set).length) {
      await orgs.updateOne({ _id: o._id }, { $set: set });
      orgFixed++;
    }
  }
  say(`organizations updated: ${orgFixed}`);

  // ---- users
  const users = db.collection('users');
  let userFixed = 0;
  for (const u of await users.find({}).toArray()) {
    const set = {};
    const unset = {};
    if (u.isActive === undefined) set.isActive = u.status ? u.status === 'active' : true;
    if ('status' in u) unset.status = '';
    if (ROLE_MAP[u.role]) set.role = ROLE_MAP[u.role];
    if (!Array.isArray(u.permissions)) set.permissions = [];
    if (u.mustChangePassword === undefined) set.mustChangePassword = false;
    const op = {};
    if (Object.keys(set).length) op.$set = set;
    if (Object.keys(unset).length) op.$unset = unset;
    if (Object.keys(op).length) {
      await users.updateOne({ _id: u._id }, op);
      userFixed++;
    }
  }
  say(`users updated: ${userFixed}`);

  // ---- indexes (drops indexes no longer in the schema, creates the new compound ones)
  for (const M of [Organization, User, Medicine, Batch, Invoice, StockMovement, AuditLog, Counter, Session]) {
    await M.syncIndexes();
    say(`indexes synced: ${M.modelName}`);
  }
  say('done');
} catch (err) {
  console.error(`[migrate] Failed: ${err.message}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
