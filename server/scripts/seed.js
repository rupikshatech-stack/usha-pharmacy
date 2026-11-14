// Usage: npm run seed
// Creates the initial organization and ORG_ADMIN from the ADMIN_* variables in server/.env.
// Safe to re-run: it never overwrites or duplicates an existing account.
import { connectDb, disconnectDb } from '../config/db.js';
import { seedAdmin } from '../services/seed.service.js';

let exitCode = 0;
try {
  await connectDb();
  const r = await seedAdmin();
  if (r.created) {
    console.log(`[seed] Created organization "${r.orgName}" and administrator ${r.email}.`);
    if (r.mustChangePassword) console.log('[seed] The administrator must change the password at first sign-in.');
  } else {
    console.log(`[seed] ${r.reason}`);
  }
} catch (err) {
  console.error(`[seed] Failed: ${err.message}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
