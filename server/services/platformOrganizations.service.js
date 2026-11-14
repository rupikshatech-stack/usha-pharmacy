import crypto from 'node:crypto';
import { AuditLog, Organization, User } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/regex.js';
import { paginated } from '../utils/pagination.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { createOrganizationWithAdmin } from './seed.service.js';
import { hashPassword } from './auth.service.js';

/**
 * Onboarding a new pharmacy: the organization, its five built-in roles, and its first administrator.
 *
 * It does no creating of its own. The work happens in `createOrganizationWithAdmin`, the same single transaction
 * `npm run seed` uses, so a pharmacy onboarded from the platform screen is indistinguishable from the one this
 * system started with — same roles, same permissions, same shape.
 *
 * What this file adds is the things a form needs and a seed script does not: refusing a duplicate before anything
 * is written, generating a password nobody chose, and recording that a pharmacy was created.
 */

/**
 * A temporary password that is actually random, and that passes the same policy a person's password must.
 *
 * Built from four explicit alphabets so it cannot fail the policy by chance (crypto.randomBytes could in principle
 * produce sixteen lowercase letters), shuffled so the guaranteed characters are not always in the same positions,
 * and drawn from `crypto` rather than Math.random because this briefly IS the credential to a pharmacy's records.
 * Ambiguous glyphs are left out: somebody reads this down a telephone.
 */
export function temporaryPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#$%&*!?'];
  const pick = (alphabet) => alphabet[crypto.randomInt(alphabet.length)];
  const chars = [...sets.map(pick), ...Array.from({ length: 10 }, () => pick(sets.join('')))];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** How the screen sees an organization in the list. Deliberately thin: this is not a window into their data. */
const present = (org, adminCount) => ({
  id: String(org._id),
  name: org.name,
  slug: org.slug,
  businessCategory: org.businessCategory,
  email: org.email || '',
  phone: org.phone || '',
  city: org.address?.city || '',
  state: org.address?.state || '',
  owner: [org.owner?.firstName, org.owner?.lastName].filter(Boolean).join(' '),
  ownerEmail: org.owner?.email || '',
  status: org.status,
  administrators: adminCount,
  createdAt: org.createdAt,
});

/**
 * The pharmacies on this installation. It lists names and contact details so an operator can see what they have
 * onboarded and avoid creating a duplicate — never anything from inside an organization.
 */
export async function listOrganizations({ search, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { slug: rx }, { email: rx }, { 'owner.email': rx }];
  }
  const [rows, total] = await Promise.all([
    Organization.find(filter).collation({ locale: 'en', strength: 2 }).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Organization.countDocuments(filter),
  ]);

  const counts = await User.aggregate([
    { $match: { organizationId: { $in: rows.map((r) => r._id) }, role: 'ORG_ADMIN' } },
    { $group: { _id: '$organizationId', n: { $sum: 1 } } },
  ]);
  const byOrg = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));

  return paginated(rows.map((r) => present(r, byOrg[String(r._id)] || 0)), { page, limit, total });
}

/**
 * Creates a pharmacy and its first administrator.
 *
 * The duplicate checks run BEFORE the transaction opens and are also backed by unique indexes underneath, so a
 * clash is reported as the mistake it is rather than surfacing as a database error. Two different things are
 * checked because they fail for two different reasons: a name collision usually means "you already onboarded
 * them", and an email collision means "this person already has an account somewhere on this installation".
 */
export async function createOrganization(req, body) {
  const name = String(body.name).trim();
  const ownerEmail = String(body.owner.email).trim().toLowerCase();

  const clash = await Organization.findOne({ name }).collation({ locale: 'en', strength: 2 }).select('_id name').lean();
  if (clash) {
    throw new ApiError(409, `A pharmacy called "${name}" already exists on this installation.`, [{ path: 'name', message: 'That name is taken' }], 'ORGANIZATION_EXISTS');
  }
  if (await User.findOne({ email: ownerEmail }).select('_id').lean()) {
    throw new ApiError(409, `${ownerEmail} already has an account on this installation. One email address can belong to one account only.`, [{ path: 'owner.email', message: 'That email is taken' }], 'EMAIL_TAKEN');
  }

  // Generated here, shown to the operator once, and never stored in the clear or written to a log.
  const password = temporaryPassword();
  const ownerName = [body.owner.firstName, body.owner.lastName].filter(Boolean).join(' ').trim() || 'Administrator';

  const { org, user } = await createOrganizationWithAdmin({
    organization: {
      name,
      email: body.email || ownerEmail,
      phone: body.phone || body.owner.phone || '',
      businessCategory: body.businessCategory || 'retail',
      address: body.address || {},
      owner: {
        firstName: body.owner.firstName || '',
        lastName: body.owner.lastName || '',
        email: ownerEmail,
        phone: body.owner.phone || '',
      },
    },
    admin: {
      name: ownerName,
      email: ownerEmail,
      passwordHash: await hashPassword(password),
      // The operator typed none of this; the pharmacy chooses its own password the first time it signs in.
      mustChangePassword: true,
    },
  });

  /**
   * The audit row goes to the NEW organization, not to the platform log.
   *
   * It is the first event in that pharmacy's own history — "this is when and by whom you were set up" — and it is
   * the only platform action that has an organization to belong to. Their own administrators can read it, which is
   * right: being told who created your account is not a leak.
   */
  await runWithTenant(org._id, () =>
    AuditLog.create({
      organizationId: org._id,
      userId: req.user._id,
      userName: `${req.user.name} (platform)`,
      action: 'ORGANIZATION_CREATED',
      entity: 'Organization',
      entityId: org._id,
      message: `Pharmacy "${org.name}" created, with ${user.email} as its first administrator`,
      meta: { slug: org.slug, businessCategory: org.businessCategory, adminEmail: user.email, createdByPlatformUser: String(req.user._id) },
      ip: req.ip,
    }),
  );

  return {
    organization: present(org.toObject ? org.toObject() : org, 1),
    administrator: { id: String(user._id), name: user.name, email: user.email },
    // Shown once, on screen, for the operator to pass on. It is not emailed and cannot be retrieved again.
    temporaryPassword: password,
    note: 'Give these to the pharmacy yourself. The password is shown only now and is never stored or sent — they must change it the first time they sign in.',
  };
}
