import { env } from '../config/env.js';
import { Organization, User } from '../models/index.js';
import { passwordProblem } from '../utils/password.js';
import { slugify } from '../utils/slug.js';
import { hashPassword } from './auth.service.js';
import { withTransaction } from './transaction.service.js';
import { ensureSystemRoles } from './roles.service.js';
import { runWithTenant } from '../utils/tenantContext.js';

/** A slug no other organization uses: "usha-pharmacy", then "usha-pharmacy-2", … */
export async function uniqueSlug(name, session) {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await Organization.exists({ slug }).session(session ?? null))) return slug;
  }
}

/**
 * Creates the initial organization + ORG_ADMIN. Safe to run repeatedly: if a user with that email
 * already exists nothing is created or changed (so a seed run can never overwrite a password or
 * produce a duplicate account). The password is hashed with bcrypt and never logged.
 */
export async function seedAdmin() {
  const { email, name, orgName, initialPassword, requirePasswordChange } = env.admin;

  if (await User.exists({ email })) return { created: false, email, reason: 'A user with this email already exists; nothing was changed.' };

  if (!initialPassword) throw new Error('ADMIN_INITIAL_PASSWORD is not set. Add it to server/.env (see .env.example).');
  const problem = passwordProblem(initialPassword);
  if (problem) throw new Error(`ADMIN_INITIAL_PASSWORD is not acceptable: ${problem}.`);

  const passwordHash = await hashPassword(initialPassword);

  const result = await withTransaction(async (session) => {
    // Reuse the organization if an earlier, interrupted run created it.
    let org = await Organization.findOne({ name: orgName }).session(session);
    if (!org) {
      [org] = await Organization.create([{ name: orgName, slug: await uniqueSlug(orgName, session), email }], { session });
    }
    // The five built-in roles, as ROWS, in the same transaction: a fresh install must look exactly like a migrated
    // one, or its Roles screen opens empty while everybody signs in fine on the built-in fallback.
    const roles = await runWithTenant(org._id, () => ensureSystemRoles({ orgId: org._id, session }));

    await User.create(
      [{ organizationId: org._id, name, email, passwordHash, role: 'ORG_ADMIN', isActive: true, mustChangePassword: requirePasswordChange }],
      { session },
    );
    return { orgName: org.name, slug: org.slug, roles: roles.created };
  });

  return { created: true, email, ...result, mustChangePassword: requirePasswordChange };
}
