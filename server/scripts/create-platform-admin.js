// Usage:
//   node scripts/create-platform-admin.js --dry-run
//   node scripts/create-platform-admin.js --apply
//
// Creates the platform administrator: the one account that can create new organizations. It belongs to NO
// organization, cannot sign in to any pharmacy's workspace, and cannot read any pharmacy's data — see
// middleware/tenant.js, which refuses it on every tenant route.
//
// It reads the same shape of variables the organization seed already uses, under PLATFORM_* in server/.env:
//
//   PLATFORM_ADMIN_NAME=Platform Operator
//   PLATFORM_ADMIN_EMAIL=ops@example.com
//   PLATFORM_ADMIN_INITIAL_PASSWORD=<8-72 chars, upper + lower + number + symbol>
//
// The account is created with `mustChangePassword`, so the password typed here is only ever good for one sign-in:
// the holder must choose their own at /platform before anything else opens up.
//
// SAFE TO RE-RUN. If a user with that email already exists, nothing is created or changed — in particular no
// password is ever overwritten, so this can never be used to take over an existing account.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { User } from '../models/index.js';
import { hashPassword } from '../services/auth.service.js';
import { passwordProblem } from '../utils/password.js';

const apply = process.argv.includes('--apply');
const dryRun = !apply;
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');

  const name = (process.env.PLATFORM_ADMIN_NAME || '').trim();
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_INITIAL_PASSWORD || '';

  if (!name) throw new Error('PLATFORM_ADMIN_NAME is not set in server/.env.');
  if (!email) throw new Error('PLATFORM_ADMIN_EMAIL is not set in server/.env.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error(`PLATFORM_ADMIN_EMAIL ("${email}") is not a valid email address.`);
  if (!password) throw new Error('PLATFORM_ADMIN_INITIAL_PASSWORD is not set in server/.env.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`PLATFORM_ADMIN_INITIAL_PASSWORD is not acceptable: ${problem}.`);

  await connectDb();
  const db = mongoose.connection.db;

  say(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'APPLYING'}`);
  say(`name     ${name}`);
  say(`email    ${email}`);
  say('password <from PLATFORM_ADMIN_INITIAL_PASSWORD, never printed>');
  say('role     SUPER_ADMIN   organization: none');
  say('');

  // Email identifies an account across the whole system, so this check is global rather than per-organization.
  const existing = await db.collection('users').findOne({ email }, { projection: { role: 1, organizationId: 1 } });
  if (existing) {
    say(`A user with this email already exists (role ${existing.role}${existing.organizationId ? ', in an organization' : ', platform'}).`);
    say('Nothing was created or changed. This script never overwrites an account or its password.');
    say('');
    await disconnectDb();
    process.exit(0);
  }

  const others = await db.collection('users').countDocuments({ role: 'SUPER_ADMIN' });
  if (others) say(`note: ${others} platform administrator(s) already exist. Another one will be added.\n`);

  if (dryRun) {
    say('Safe to apply: no user holds that email address.');
    say('Re-run with --apply to create the account.');
    say('');
    await disconnectDb();
    process.exit(0);
  }

  // Created through the model, so the schema's own rules apply: SUPER_ADMIN is the one role allowed no organization.
  const user = await User.create({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: 'SUPER_ADMIN',
    isActive: true,
    mustChangePassword: true,
  });

  say(`DONE — platform administrator created (${user._id}).`);
  say('They must change the password at first sign-in; until they do, the platform area stays closed to them.');
  say('');
} catch (e) {
  exitCode = 1;
  console.error('[create-platform-admin] FAILED:', e.message);
} finally {
  await disconnectDb().catch(() => {});
  process.exit(exitCode);
}
