// Usage (from server/):
//   node scripts/reset-platform-password.js --dry-run
//   node scripts/reset-platform-password.js --apply
//
// Recovery for a forgotten platform-administrator password. Run on the machine that holds server/.env and the
// database credentials; that access IS the authorization, there is no endpoint for this on purpose.
//
// Reads PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_INITIAL_PASSWORD from server/.env (set a new temporary password
// there first). It only ever touches a SUPER_ADMIN account. The account is marked mustChangePassword, so the
// temporary password works for one sign-in only; all existing sessions are revoked and any lockout is cleared.
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { hashPassword } from '../services/auth.service.js';
import { revokeUserSessions } from '../services/session.service.js';
import { passwordProblem } from '../utils/password.js';

const apply = process.argv.includes('--apply');
const say = (m = '') => console.log(m);
let exitCode = 0;

try {
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose one: --dry-run or --apply.');
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_INITIAL_PASSWORD || '';
  if (!email) throw new Error('PLATFORM_ADMIN_EMAIL is not set in server/.env.');
  if (!password) throw new Error('PLATFORM_ADMIN_INITIAL_PASSWORD is not set in server/.env.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`PLATFORM_ADMIN_INITIAL_PASSWORD is not acceptable: ${problem}.`);

  await connectDb();
  const users = mongoose.connection.db.collection('users');
  const user = await users.findOne({ email, role: 'SUPER_ADMIN' }, { projection: { _id: 1, name: 1 } });
  if (!user) throw new Error(`No platform administrator (SUPER_ADMIN) has the email ${email}.`);

  say(`\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}`);
  say(`account  ${email} (${user.name})`);
  if (!apply) {
    say('Re-run with --apply to set the temporary password from .env.\n');
  } else {
    await users.updateOne(
      { _id: user._id },
      {
        $set: { passwordHash: await hashPassword(password), mustChangePassword: true, passwordChangedAt: new Date(), failedLoginCount: 0 },
        $unset: { lockedUntil: '' },
      },
    );
    await revokeUserSessions(user._id, undefined, 'password-reset');
    say('DONE — sign in at /platform with the temporary password; you will be asked to choose a new one.\n');
  }
} catch (e) {
  exitCode = 1;
  console.error('[reset-platform-password] FAILED:', e.message);
} finally {
  await disconnectDb().catch(() => {});
  process.exit(exitCode);
}
