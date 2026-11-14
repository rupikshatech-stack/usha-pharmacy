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

  const result = await createOrganizationWithAdmin({
    organization: { name: orgName, email },
    admin: { name, email, passwordHash, mustChangePassword: requirePasswordChange },
    reuseExistingByName: true,
  });

  return { created: true, email, ...result, mustChangePassword: requirePasswordChange };
}

/**
 * An organization, its five built-in roles, and its first ORG_ADMIN — created together or not at all.
 *
 * This is the single place a pharmacy comes into existence. `npm run seed` reaches it from environment variables;
 * the platform screen reaches it from a form. Both get the identical result, which is the point: there is no
 * "the way the first one was made" and "the way the rest are made" that can drift apart.
 *
 * All of it is ONE transaction. A half-made organization - one with no administrator, or with an administrator but
 * no roles - would be worse than none, because the only account that could repair it is the one that failed to be
 * created.
 *
 * `reuseExistingByName` exists for the seed path only, where an interrupted earlier run may have left the
 * organization behind. The platform path passes false: there, a name that already exists is a mistake to report,
 * not something to silently join.
 */
export async function createOrganizationWithAdmin({ organization, admin, reuseExistingByName = false }) {
  return withTransaction(async (session) => {
    let org = reuseExistingByName ? await Organization.findOne({ name: organization.name }).session(session) : null;
    if (!org) {
      [org] = await Organization.create([{ ...organization, slug: await uniqueSlug(organization.name, session) }], { session });
    }

    // The five built-in roles, as ROWS, in the same transaction: a fresh organization must look exactly like a
    // migrated one, or its Roles screen opens empty while everybody signs in fine on the built-in fallback.
    const roles = await runWithTenant(org._id, () => ensureSystemRoles({ orgId: org._id, session }));

    const [user] = await User.create(
      [{ organizationId: org._id, ...admin, role: 'ORG_ADMIN', isActive: true }],
      { session },
    );

    return { org, user, orgName: org.name, slug: org.slug, roles: roles.created };
  });
}
